import fs from 'fs';
import { chromium } from 'playwright-core';

// Clean-slate scraper. easyapi's run log proved the recipe: render
// tiktok.com/search/live, wait for the grid, then scroll — each scroll fires
// /api/search/live/full/ returning ~12 rooms until the list is exhausted
// (~85 for "chill"). No auth, no manual signed fetch, no webcast endpoint.
// We intercept those API responses and parse the raw room objects.

const DEBUG = process.env.DEBUG !== 'FALSE' && process.env.DEBUG !== 'false';
const GET_IMAGES = process.env.GET_IMAGES === 'true' || process.env.GET_IMAGES === 'TRUE';

const TIKTOK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function makeLogger() {
  const lines = [];
  const log = (...args) => {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.log(msg);
    lines.push(`${new Date().toISOString()} ${msg}`);
  };
  const dbg = (...args) => { if (DEBUG) log(...args); };
  return { log, dbg, lines };
}

function liveSearchUrl(keyword) {
  return `https://www.tiktok.com/search/live?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
}

async function launchBrowser() {
  const proxyServer = process.env.PROXY_SERVER;
  const proxyUsername = process.env.PROXY_USERNAME;
  const proxyPassword = process.env.PROXY_PASSWORD;
  console.log('[proxy] server:', proxyServer || 'NONE');
  console.log('[proxy] username:', proxyUsername ? proxyUsername.slice(0, 20) + '…' : 'NONE');

  const proxy = proxyServer ? {
    server: `http://${proxyServer}`,
    username: proxyUsername,
    password: proxyPassword,
  } : undefined;

  // Headful Chromium under Xvfb — matches easyapi's working stack. Headful is
  // important: TikTok serves the full live grid to a real-looking browser and
  // the gated/blank variant to obvious headless automation.
  if (DEBUG) {
    try {
      const exe = chromium.executablePath();
      console.log(`[launch] executablePath=${exe} exists=${fs.existsSync(exe)}`);
    } catch (e) {
      console.log(`[launch] executablePath unresolved: ${e?.message}`);
    }
    console.log(`[launch] DISPLAY=${process.env.DISPLAY || 'unset'} PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH || 'unset'}`);
  }
  const browser = await chromium.launch({
    headless: false,
    timeout: 45000,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1920,1080',
    ],
    ...(proxy ? { proxy } : {}),
  });
  console.log('[proxy] chromium launched ok');
  return browser;
}

async function newTikTokContext(browser) {
  fs.mkdirSync('output', { recursive: true });
  const context = await browser.newContext({
    userAgent: TIKTOK_USER_AGENT,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
  });
  // Hide the obvious automation tells before any page script runs.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return context;
}

async function dismissLoginPopup(page, dbg) {
  // Escape closes the login modal in place; clicking the generic Close button
  // can redirect to /search/user, so prefer Escape.
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  } catch { /* ignore */ }
  for (const sel of ['[data-e2e="modal-close-inner-button"]', '[data-e2e="close-login-modal"]']) {
    try {
      await page.locator(sel).click({ timeout: 1200 });
      dbg(`[popup] dismissed via ${sel}`);
      await page.waitForTimeout(500);
      return;
    } catch { /* not present */ }
  }
}

// Parse the raw room objects from /api/search/live/full/ responses, including
// PK battle / league info. Dedupes by username into the shared map.
function makeRoomParser(intercepted) {
  return function parseItems(items, source) {
    let added = 0;
    for (const item of items) {
      try {
        const raw = JSON.parse(item?.live_info?.raw_data || '{}');
        const owner = raw?.owner || {};
        const username = owner?.display_id || owner?.unique_id || '';
        if (!username || intercepted.has(username)) continue;

        const linkMic = raw?.link_mic || {};
        const battleInfo = linkMic?.battle_info || null;
        const ownerIdStr = String(owner?.id_str || owner?.id || '');
        let battle = null;
        if (battleInfo?.battle_id_str) {
          const leagueMap = battleInfo.league_info_map || {};
          const armiesMap = battleInfo.armies || {};
          const scoresArr = linkMic.battle_scores || [];
          const myScoreEntry = scoresArr.find(s => String(s.user_id) === ownerIdStr || String(s.user_id_str) === ownerIdStr);
          const myArmy = armiesMap[ownerIdStr] || {};
          const myLeagueEntry = leagueMap[ownerIdStr]?.league_info || {};
          battle = {
            battleId: battleInfo.battle_id_str,
            league: myLeagueEntry?.display_text?.content || null,
            leagueIcon: myLeagueEntry?.icon?.url_list?.[0] || null,
            score: myScoreEntry?.score ?? myArmy?.hostScore ?? null,
            hostScore: myArmy?.hostScore ?? null,
            startTime: battleInfo.battle_settings?.start_time_ms || null,
            duration: battleInfo.battle_settings?.duration || null,
          };
        }

        intercepted.set(username, {
          id: raw?.id_str || raw?.id || '',
          username,
          nickname: owner?.nickname || '',
          title: raw?.title || '',
          viewers: raw?.user_count || 0,
          totalViewers: raw?.stats?.total_user || 0,
          comments: raw?.stats?.comment_count || 0,
          shares: raw?.stats?.share_count || 0,
          followers: owner?.follow_info?.follower_count || 0,
          avatar: owner?.avatar_thumb?.url_list?.[0] || '',
          cover: raw?.cover?.url_list?.[0] || '',
          streamSnapshot: raw?.stream_snapshot?.urls?.[0] || raw?.stream_snapshot?.url_list?.[0] || null,
          liveUrl: `https://www.tiktok.com/@${username}/live`,
          battle,
          source,
        });
        added++;
      } catch { /* skip malformed */ }
    }
    return added;
  };
}

async function scrapeKeywordOnce(keyword, context, log, dbg) {
  const startTime = Date.now();
  let screenshotBase64 = null;
  const page = await context.newPage();

  try {
    const intercepted = new Map();
    const parseItems = makeRoomParser(intercepted);

    // Intercept the live-search API responses fired on load + each scroll.
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('/api/search/live/full/')) return;
      try {
        const json = await response.json();
        const items = json?.data || [];
        if (!Array.isArray(items) || items.length === 0) return;
        const added = parseItems(items, 'scroll');
        if (added > 0) dbg(`[api] +${added} rooms (total=${intercepted.size}) hasMore=${json?.has_more}`);
      } catch { /* non-JSON or already consumed */ }
    });

    const url = liveSearchUrl(keyword);
    dbg(`[scrape] keyword="${keyword}" goto ${url.slice(0, 70)}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await dismissLoginPopup(page, dbg);

    // If TikTok bounced us to /search/user, go back to the live tab.
    if (!page.url().includes('/search/live')) {
      log(`[scrape] redirected to ${page.url().slice(0, 60)} — re-navigating`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
    }

    // Give the initial grid time to render + fire its first API pages
    // (easyapi waits ~12s after load before scrolling).
    await page.waitForTimeout(9000);
    const bodyLen = await page.evaluate(() => document.body?.innerText?.length || 0);
    dbg(`[scrape] after load: bodyLen=${bodyLen} rooms=${intercepted.size}`);

    // Native scroll loop — the only path that gets the full result set.
    const MAX_SCROLLS = 30;
    const MAX_ROOMS = 300;
    let stale = 0;
    for (let s = 0; s < MAX_SCROLLS && intercepted.size < MAX_ROOMS; s++) {
      const prev = intercepted.size;
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(3000);
      if (intercepted.size === prev) {
        stale++;
        // Allow a couple of empty scrolls before declaring the end.
        if (stale >= 3) { log(`[scrape] reached end of results after ${s + 1} scrolls`); break; }
      } else {
        stale = 0;
        dbg(`[scrape] scroll ${s + 1}: +${intercepted.size - prev} (total=${intercepted.size})`);
      }
    }

    const rooms = Array.from(intercepted.values());

    if (GET_IMAGES && rooms.length > 0) {
      await embedImages(rooms, dbg);
    }

    try {
      screenshotBase64 = (await page.screenshot({ type: 'png', timeout: 8000 })).toString('base64');
    } catch { dbg('[scrape] screenshot failed'); }

    const durationMs = Date.now() - startTime;
    log(`[scrape] done keyword="${keyword}" rooms=${rooms.length} duration=${(durationMs / 1000).toFixed(1)}s`);
    return {
      keyword,
      collected_at: new Date().toISOString(),
      durationMs,
      mode: 'scroll',
      roomCount: rooms.length,
      rooms,
      screenshotBase64,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errMsg = err?.message || String(err);
    log(`[scrape] error keyword="${keyword}" error=${errMsg}`);
    return {
      keyword,
      collected_at: new Date().toISOString(),
      durationMs,
      mode: 'failed',
      error: errMsg,
      roomCount: 0,
      rooms: [],
      screenshotBase64,
    };
  } finally {
    try { await page.close(); } catch { /* already closed */ }
  }
}

async function embedImages(rooms, dbg) {
  async function toBase64(url) {
    if (!url) return null;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': TIKTOK_USER_AGENT, 'Referer': 'https://www.tiktok.com/' } });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
      return `data:${mime};base64,` + buf.toString('base64');
    } catch { return null; }
  }
  await Promise.all(rooms.map(async (room) => {
    room.streamSnapshotBase64 = await toBase64(room.streamSnapshot);
    room.avatarBase64 = await toBase64(room.avatar);
  }));
  dbg(`[images] embedded ${rooms.filter(r => r.streamSnapshotBase64).length}/${rooms.length} snapshots`);
}

export async function scrapeAllKeywords(keywords) {
  const { log, dbg, lines } = makeLogger();
  console.log('[run] launching browser…');
  const browser = await launchBrowser();
  const context = await newTikTokContext(browser);
  console.log(`[run] scraping ${keywords.length} keyword(s)`);

  const results = [];
  try {
    for (const keyword of keywords) {
      const result = await scrapeKeywordOnce(keyword, context, log, dbg);
      results.push({ ...result, runLog: lines.slice() });
    }
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
  return results;
}

export async function debugTikTokPage(keyword = 'Live') {
  const { log, dbg } = makeLogger();
  const browser = await launchBrowser();
  const context = await newTikTokContext(browser);
  try {
    const result = await scrapeKeywordOnce(keyword, context, log, dbg);
    return {
      checked_at: new Date().toISOString(),
      keyword,
      roomCount: result.roomCount,
      rooms: result.rooms,
      screenshotBase64: result.screenshotBase64,
    };
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
}

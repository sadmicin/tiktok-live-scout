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

// Build a Playwright proxy config. Two providers, selected by env:
//
//  Apify Proxy (preferred — set APIFY_PROXY_PASSWORD):
//    server   = http://proxy.apify.com:8000
//    username = groups-RESIDENTIAL,country-US,session-<id>   ← session pins the IP
//    password = <Apify proxy password from console>
//
//  IPRoyal / generic (fallback — set PROXY_SERVER/USERNAME/PASSWORD):
//    used as-is. Rotating by default on our current plan.
//
// `sessionId` makes the exit IP sticky for the lifetime of one browser: every
// request in a run exits from the same residential IP (what TikTok wants to
// see), and a relaunch passes a new id to deliberately rotate.
function buildProxy(sessionId) {
  const apifyPassword = process.env.APIFY_PROXY_PASSWORD;
  if (apifyPassword) {
    const server = process.env.APIFY_PROXY_SERVER || 'proxy.apify.com:8000';
    const country = process.env.APIFY_PROXY_COUNTRY || 'US';
    const username = `groups-RESIDENTIAL,country-${country},session-${sessionId}`;
    return { server: `http://${server}`, username, password: apifyPassword, label: `apify(${country})` };
  }
  const proxyServer = process.env.PROXY_SERVER;
  if (!proxyServer) return undefined;
  return {
    server: `http://${proxyServer}`,
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
    label: 'generic',
  };
}

async function launchBrowser(sessionId) {
  const built = buildProxy(sessionId);
  const proxy = built && { server: built.server, username: built.username, password: built.password };
  console.log('[proxy] provider:', built?.label || 'NONE');
  console.log('[proxy] server:', built?.server || 'NONE');
  console.log('[proxy] username:', built?.username ? built.username.slice(0, 32) + '…' : 'NONE');
  console.log('[proxy] session:', sessionId || 'none');
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

// Visit the homepage first so the context picks up ttwid / msToken / etc.
// Landing cold on a /search/live URL looks like a bot; arriving with cookies
// from a homepage visit looks like a returning visitor and is less likely to
// trigger the login gate.
async function warmSession(context, log) {
  const page = await context.newPage();
  try {
    await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    const cookies = await context.cookies('https://www.tiktok.com');
    log(`[warm] homepage loaded, cookies: ${cookies.map(c => c.name).join(',').slice(0, 120)}`);
  } catch (e) {
    log(`[warm] homepage warm-up failed (continuing): ${e?.message?.split('\n')[0]}`);
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
}

// The login modal ("Log in to search for popular content") appears LATE —
// it pops when the search content loads, not on page load. A one-shot dismiss
// right after goto runs before the modal exists and the grid stays blocked.
// So: dismiss whenever it's visible, and call this repeatedly during the run.
async function dismissLoginPopup(page, dbg) {
  const modal = page.locator('#loginContainer, [data-e2e="login-modal"]').first();
  try {
    if (!(await modal.isVisible({ timeout: 500 }))) return false;
  } catch { return false; }
  // Escape closes the modal in place; clicking the generic Close button
  // can redirect to /search/user, so prefer Escape.
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    if (!(await modal.isVisible({ timeout: 300 }).catch(() => false))) {
      dbg('[popup] dismissed via Escape');
      return true;
    }
  } catch { /* ignore */ }
  for (const sel of ['[data-e2e="modal-close-inner-button"]', '[data-e2e="close-login-modal"]', '#loginContainer [aria-label="Close"]']) {
    try {
      await page.locator(sel).click({ timeout: 1200 });
      dbg(`[popup] dismissed via ${sel}`);
      await page.waitForTimeout(500);
      return true;
    } catch { /* not present */ }
  }
  return false;
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

    // Dismissing the login modal bounces the page to the Users tab (with or
    // without a URL change). Re-assert the LIVE tab by clicking it in place —
    // a full re-goto re-triggers the modal cycle.
    async function ensureLiveTab() {
      const onLive = page.url().includes('/search/live');
      const tabSelected = await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('[role="tab"], a'));
        const live = tabs.find(t => t.textContent?.trim() === 'LIVE');
        return live ? (live.getAttribute('aria-selected') === 'true' || live.className.includes('active')) : null;
      }).catch(() => null);
      if (onLive && tabSelected !== false) return;
      log(`[scrape] bounced off live tab (url=${page.url().slice(0, 60)}) — clicking LIVE tab`);
      try {
        await page.locator('a[href*="/search/live"], [role="tab"]:has-text("LIVE")').first().click({ timeout: 3000 });
        await page.waitForTimeout(3000);
      } catch {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
      }
    }

    // Give the initial grid time to render + fire its first API pages
    // (easyapi waits ~12s after load before scrolling). The login modal pops
    // somewhere in this window, so keep checking for it rather than sleeping.
    for (let w = 0; w < 4; w++) {
      await page.waitForTimeout(3000);
      if (await dismissLoginPopup(page, dbg)) {
        log('[popup] login modal dismissed');
        await ensureLiveTab();
      }
    }
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
      // The modal can reappear mid-scroll and freeze the grid. A dismissal
      // means the grid was blocked — re-assert the tab and restart the stale
      // countdown so the deferred fetch gets time to land.
      if (await dismissLoginPopup(page, dbg)) {
        log('[popup] login modal dismissed mid-scroll');
        await ensureLiveTab();
        stale = -2;
      }
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

function newSessionId() {
  // Apify session ids: alphanumeric, max 50 chars. Keep it short + unique.
  return 'r' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function isTunnelError(msg) {
  const e = (msg || '').toLowerCase();
  return e.includes('err_tunnel_connection_failed')
    || e.includes('err_proxy_connection_failed')
    || e.includes('err_empty_response')
    || e.includes('err_connection_closed')
    || e.includes('err_connection_reset');
}

export async function scrapeAllKeywords(keywords) {
  const { log, dbg, lines } = makeLogger();
  let sessionId = newSessionId();
  console.log('[run] launching browser…');
  let browser = await launchBrowser(sessionId);
  let context = await newTikTokContext(browser);
  await warmSession(context, log);
  console.log(`[run] scraping ${keywords.length} keyword(s)`);

  const results = [];
  try {
    for (const keyword of keywords) {
      let result;
      // Up to 2 attempts per keyword. A tunnel/proxy failure means the exit IP
      // died — relaunch with a NEW session id to get a fresh residential IP.
      for (let attempt = 1; attempt <= 2; attempt++) {
        result = await scrapeKeywordOnce(keyword, context, log, dbg);
        if (result.mode !== 'failed' || !isTunnelError(result.error)) break;
        if (attempt < 2) {
          sessionId = newSessionId();
          log(`[run] tunnel failure on "${keyword}" — relaunching with new session ${sessionId}`);
          try { await browser.close(); } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 2000));
          browser = await launchBrowser(sessionId);
          context = await newTikTokContext(browser);
          await warmSession(context, log);
        }
      }
      results.push({ ...result, runLog: lines.slice() });
    }
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
  return results;
}

export async function debugTikTokPage(keyword = 'Live') {
  const { log, dbg } = makeLogger();
  const browser = await launchBrowser(newSessionId());
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

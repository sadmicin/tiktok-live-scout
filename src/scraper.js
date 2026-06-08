import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const DEBUG = process.env.DEBUG !== 'FALSE' && process.env.DEBUG !== 'false';
const GET_IMAGES = process.env.GET_IMAGES === 'true' || process.env.GET_IMAGES === 'TRUE';

function makeLogger() {
  const lines = [];
  const log = (...args) => {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(msg);
    lines.push(line);
  };
  // debug-only log: captured in runLog but only printed to console in DEBUG mode
  const dbg = (...args) => {
    if (!DEBUG) return;
    log(...args);
  };
  return { log, dbg, lines };
}

const STORAGE_STATE_PATH = path.join(process.cwd(), 'output', 'tiktok-guest-state.json');

const TIKTOK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function hasGuestState() {
  if (!fs.existsSync(STORAGE_STATE_PATH)) return false;
  try {
    const ageSec = (Date.now() - fs.statSync(STORAGE_STATE_PATH).mtimeMs) / 1000;
    if (ageSec > 7200) {
      console.log(`[state] guest state is ${Math.round(ageSec/60)}m old — discarding`);
      fs.unlinkSync(STORAGE_STATE_PATH);
      return false;
    }
  } catch {}
  return true;
}

function liveSearchUrl(keyword) {
  return `https://www.tiktok.com/search/live?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
}

function parseTikTokCount(value) {
  if (!value) return 0;
  const cleaned = String(value).trim().replace(/,/g, '');
  const match = cleaned.match(/^([0-9]+(?:\.[0-9]+)?)([KMB])?$/i);
  if (!match) return 0;
  const number = Number(match[1]);
  const suffix = (match[2] || '').toUpperCase();
  const multiplier = suffix === 'B' ? 1_000_000_000 : suffix === 'M' ? 1_000_000 : suffix === 'K' ? 1_000 : 1;
  return Math.round(number * multiplier);
}

async function launchBrowser() {
  const proxyServer = process.env.PROXY_SERVER;
  const proxyUsername = process.env.PROXY_USERNAME;
  const proxyPassword = process.env.PROXY_PASSWORD;

  console.log('[proxy] server:', proxyServer || 'NONE — set PROXY_SERVER env var');
  console.log('[proxy] username:', proxyUsername ? proxyUsername.slice(0, 20) + '…' : 'NONE');

  // Connect to Bright Data proxy over plain HTTP regardless of port —
  // the SSL capability refers to target sites, not the proxy connection itself.
  const proxyUrl = proxyServer ? `http://${proxyServer}` : null;

  return chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors',
    ],
    ...(proxyUrl ? {
      proxy: {
        server: proxyUrl,
        username: proxyUsername,
        password: proxyPassword,
      }
    } : {})
  });
}

async function newTikTokContext(browser) {
  fs.mkdirSync('output', { recursive: true });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1920, height: 1080 },
    userAgent: TIKTOK_USER_AGENT,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'accept-language': 'en-US,en;q=0.9',
    },
    ...(hasGuestState() ? { storageState: STORAGE_STATE_PATH } : {})
  });

  return context;
}

async function dismissLoginPopup(page) {
  await page.waitForTimeout(2000);
  try {
    await page.locator('[aria-label="Close"]').click({ timeout: 4000 });
    console.log('Dismissed login popup');
    await page.waitForTimeout(1000);
  } catch {
    // no popup
  }
}

// Extract live stream cards from the current page DOM.
// Returns array of { username, title, viewers, viewersRaw, liveUrl, avatarSrc }
function extractLiveCards() {
  const results = new Map();

  // TikTok search/live cards have links to /@username/live
  const liveLinks = Array.from(document.querySelectorAll('a[href*="/live"]'));

  for (const link of liveLinks) {
    const href = link.href || '';
    // Match /@username/live
    const m = href.match(/\/@([^/?#]+)\/live/);
    if (!m) continue;
    const username = m[1];
    if (results.has(username)) continue;

    // Walk up to find the card container
    let card = link;
    for (let i = 0; i < 8; i++) {
      card = card.parentElement;
      if (!card) break;
      // Stop at a reasonably-sized container
      if (card.querySelectorAll('a').length >= 1 && card.innerText && card.innerText.length > 10) break;
    }
    if (!card) card = link;

    const text = (card.innerText || '').trim();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    // Viewer count: look for patterns like "1.2K watching", "5K viewers", or just numbers near "watching"
    let viewersRaw = null;
    let viewers = 0;
    for (const line of lines) {
      const vm = line.match(/^([\d.]+[KMB]?)\s*(watching|viewers?|views?)?$/i);
      if (vm) {
        viewersRaw = vm[1];
        const n = parseFloat(viewersRaw);
        const s = (viewersRaw.slice(-1) || '').toUpperCase();
        viewers = Math.round(n * (s === 'B' ? 1e9 : s === 'M' ? 1e6 : s === 'K' ? 1e3 : 1));
        break;
      }
    }

    // Title: first meaningful line that isn't the username or viewer count
    const title = lines.find(l => l !== username && l !== `@${username}` && l !== viewersRaw && l.length > 1 && !/^\d/.test(l)) || '';

    // Avatar image
    const img = card.querySelector('img');
    const avatarSrc = img?.src || img?.currentSrc || null;

    results.set(username, {
      username,
      title,
      viewers,
      viewersRaw,
      liveUrl: `https://www.tiktok.com/@${username}/live`,
      avatarSrc,
      cardText: text.slice(0, 400),
    });
  }

  return Array.from(results.values());
}

async function scrollAndCollect(page, log, scrollRounds = 12) {
  const seen = new Map();

  const harvest = async (round) => {
    const cards = await page.evaluate(extractLiveCards);
    let newCount = 0;
    for (const card of cards) {
      if (!seen.has(card.username)) {
        seen.set(card.username, card);
        newCount++;
      }
    }
    log(`[scroll] round ${round}: +${newCount} new, total=${seen.size}`);
    return newCount;
  };

  // Initial harvest after page load
  await harvest(0);

  for (let i = 1; i <= scrollRounds; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(1800);
    // Extra wait every 4 rounds to let lazy-loaded content appear
    if (i % 4 === 0) await page.waitForTimeout(1500);
    await harvest(i);
  }

  return Array.from(seen.values());
}

async function scrapeTikTokLiveOnce(keyword, context, log, dbg) {
  const startTime = Date.now();
  let screenshotBase64 = null;

  try {
    const page = await context.newPage();

    const intercepted = new Map(); // username -> room, deduped

    function parseItemsIntoIntercepted(items, source) {
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
        } catch {}
      }
      return added;
    }

page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('tiktok.com') || !url.includes('/api/')) return;
      // Log every API URL so we can see what TikTok is calling
      log(`[api] ${url.slice(0, 150)}`);
      if (!url.includes('/api/search/') && !(url.includes('live') && url.includes('list'))) return;
      try {
        const json = await response.json();
        const items = json?.data || json?.live_list || json?.item_list || json?.lives || [];
        if (!Array.isArray(items) || items.length === 0) return;
        log(`[intercept] api hit: ${items.length} items, hasRaw=${items.some(i => i?.live_info?.raw_data)} url=${url.slice(0, 80)}`);
        if (!items.some(i => i?.live_info?.raw_data)) return;
        const added = parseItemsIntoIntercepted(items, 'intercepted');
        if (added > 0) log(`[intercept] +${added} rooms (total=${intercepted.size})`);
      } catch {}
    });

    const liveUrl = `https://www.tiktok.com/search/live?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;

    if (hasGuestState()) {
      // Fast path: cookies already set, go straight to live search
      dbg(`[scrape] fast path — navigating directly to live search`);
      await page.goto(liveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);
    } else {
      // Slow path: no session yet — navigate to search, dismiss popup, click live tab
      const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
      dbg(`[scrape] slow path — no guest state`);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await dismissLoginPopup(page);
      await page.waitForTimeout(3000);

      let liveTabClicked = false;
      try {
        const liveTabLink = page.locator('a[href*="/search/live"]').first();
        await liveTabLink.click({ timeout: 8000 });
        liveTabClicked = true;
        dbg('[scrape] clicked /search/live anchor');
      } catch {}

      if (!liveTabClicked) {
        await page.goto(liveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
      await page.waitForTimeout(3000);
    }

    dbg('[scrape] current url:', page.url());

    if (DEBUG) {
      const pageDiag = await page.evaluate(() => {
        const allLinks = Array.from(document.querySelectorAll('a[href]'));
        const hrefs = [...new Set(allLinks.map(a => a.href.replace(/\?.*$/, '')))].slice(0, 60);
        return {
          url: location.href,
          title: document.title,
          anchorCount: allLinks.length,
          hrefs,
          bodyTextLength: document.body?.innerText?.length || 0,
          bodyTextSample: (document.body?.innerText || '').slice(0, 800),
          hasLiveHrefs: allLinks.some(a => /\/@[^/]+\/live/.test(a.href)),
        };
      });
      dbg('[diag]', JSON.stringify(pageDiag));
    }

    // Wait briefly for TikTok cookies/tokens to be set during page load
    await page.waitForTimeout(2000);

    // Fetch live search results directly from the browser context.
    // This uses the browser's cookie jar (msToken, ttwid, etc.) so TikTok
    // sees a credentialed same-origin request — works even when the page renders blank.
    const MAX_ROOMS = 200;
    const MAX_PAGES = 8;
    const fetchParams = {
      keyword,
      count: '30',
      aid: '1988',
      app_language: 'en',
      app_name: 'tiktok_web',
      browser_language: 'en-US',
      browser_name: 'Mozilla',
      browser_online: 'true',
      browser_platform: 'Win32',
      browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      channel: 'tiktok_web',
      cookie_enabled: 'true',
      device_platform: 'web_pc',
      from_page: 'search',
      os: 'windows',
      region: 'US',
      tz_name: 'America/New_York',
    };

    for (let p = 0; p < MAX_PAGES && intercepted.size < MAX_ROOMS; p++) {
      const offset = p * 30;
      const result = await page.evaluate(async ({ fp, off }) => {
        try {
          const params = new URLSearchParams({ ...fp, offset: String(off) });
          const res = await fetch(`/api/search/live/full/?${params}`, { credentials: 'include' });
          if (!res.ok) return { error: res.status };
          const json = await res.json();
          // Return cursor/search_id for continuity — TikTok uses these to paginate
          return {
            ok: true,
            hasMore: json?.has_more,
            cursor: json?.cursor ?? null,
            searchId: json?.extra?.search_id || json?.search_id || null,
            data: json?.data || [],
            rawKeys: Object.keys(json || {}),
          };
        } catch (e) { return { error: String(e) }; }
      }, { fp: fetchParams, off: offset });

      if (result.error) {
        log(`[fetch] page ${p+1} offset=${offset} error=${result.error}`);
        break;
      }
      const added = parseItemsIntoIntercepted(result.data || [], 'fetch');
      log(`[fetch] page ${p+1} offset=${offset}: +${added} new (total=${intercepted.size}) hasMore=${result.hasMore} cursor=${result.cursor} searchId=${result.searchId} keys=${result.rawKeys?.join(',')}`);
      if (!result.hasMore) break;

      // Thread TikTok's session tokens into subsequent requests
      if (result.cursor !== null) fetchParams.offset = String(result.cursor);
      if (result.searchId) fetchParams.search_id = result.searchId;
      await page.waitForTimeout(300);
    }

    const fetchedRooms = Array.from(intercepted.values());
    log(`[scrape] keyword="${keyword}" total=${fetchedRooms.length} rooms`);

    // TODO: store images in Cloudflare R2 for permanent URLs instead of base64
    // See TODO.md — needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET env vars
    if (GET_IMAGES && fetchedRooms.length > 0) {
      async function fetchImageBase64(url) {
        if (!url) return null;
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': TIKTOK_USER_AGENT, 'Referer': 'https://www.tiktok.com/' },
          });
          if (!res.ok) return null;
          const buf = Buffer.from(await res.arrayBuffer());
          const mime = res.headers.get('content-type') || 'image/jpeg';
          return `data:${mime.split(';')[0]};base64,` + buf.toString('base64');
        } catch { return null; }
      }

      await Promise.all(fetchedRooms.map(async (room) => {
        room.streamSnapshotBase64 = await fetchImageBase64(room.streamSnapshot || null);
        room.avatarBase64 = await fetchImageBase64(room.avatar || null);
      }));

      const embedded = fetchedRooms.filter(r => r.streamSnapshotBase64).length;
      dbg(`[images] embedded ${embedded}/${fetchedRooms.length} snapshots`);
    }

    const rooms = fetchedRooms;

    // Save updated guest state
    await context.storageState({ path: STORAGE_STATE_PATH });
    try {
      screenshotBase64 = (await page.screenshot({ fullPage: false, type: 'png', timeout: 8000 })).toString('base64');
    } catch { dbg('[scrape] screenshot failed, continuing'); }

    await page.close();

    const durationMs = Date.now() - startTime;
    log(`[scrape] done keyword="${keyword}" rooms=${rooms.length} duration=${(durationMs/1000).toFixed(1)}s`);
    return {
      keyword,
      collected_at: new Date().toISOString(),
      durationMs,
      mode: 'fetch',
      roomCount: rooms.length,
      rooms,
      screenshotBase64,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    log(`[scrape] error keyword="${keyword}" duration=${(durationMs/1000).toFixed(1)}s error=${err.message}`);
    return {
      keyword,
      collected_at: new Date().toISOString(),
      durationMs,
      mode: 'failed',
      error: err.message,
      roomCount: 0,
      rooms: [],
      screenshotBase64,
    };
  }
}

function isTunnelError(error) {
  return (error || '').toLowerCase().includes('tunnel');
}

export async function scrapeTikTokLive(keyword, context, maxRetries = 3) {
  const { log, dbg, lines: runLog } = makeLogger();
  const startTime = Date.now();
  log(`[scrape] start keyword="${keyword}"`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await scrapeTikTokLiveOnce(keyword, context, log, dbg);
    if (result.mode !== 'failed' || !isTunnelError(result.error)) {
      return { ...result, runLog };
    }
    log(`[scrape] tunnel failure attempt ${attempt}/${maxRetries}, retrying...`);
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000 * attempt));
  }

  const durationMs = Date.now() - startTime;
  log(`[scrape] all ${maxRetries} attempts failed for keyword="${keyword}"`);
  return {
    keyword,
    collected_at: new Date().toISOString(),
    durationMs,
    mode: 'failed',
    error: 'Max retries exceeded — tunnel failures',
    roomCount: 0,
    rooms: [],
    runLog,
    screenshotBase64: null,
  };
}

export async function scrapeAllKeywords(keywords, maxRetries = 3) {
  let browser = await launchBrowser();
  let context = await newTikTokContext(browser);
  console.log(`[run] browser launched, scraping ${keywords.length} keyword(s)`);

  const results = [];
  try {
    for (const keyword of keywords) {
      const result = await scrapeTikTokLive(keyword, context, maxRetries);
      results.push(result);
      // Tunnel failure exhausted all retries — relaunch browser for remaining keywords
      if (result.mode === 'failed' && isTunnelError(result.error)) {
        console.log('[run] tunnel failure, relaunching browser for remaining keywords');
        try { await browser.close(); } catch {}
        browser = await launchBrowser();
        context = await newTikTokContext(browser);
      }
    }
  } finally {
    try { await browser.close(); } catch {}
  }

  return results;
}

export async function debugTikTokPage(keyword = 'battle') {
  const browser = await launchBrowser();
  const context = await newTikTokContext(browser);
  const page = await context.newPage();
  const url = liveSearchUrl(keyword);

  let gotoError = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissLoginPopup(page);
    await page.waitForTimeout(5000);
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(3000);
  } catch (err) {
    gotoError = err.message;
  }

  const cards = await page.evaluate(extractLiveCards);
  const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
  await browser.close();

  return {
    checked_at: new Date().toISOString(),
    keyword,
    requestedUrl: url,
    gotoError,
    roomCount: cards.length,
    rooms: cards,
    screenshotBase64: screenshot.toString('base64'),
  };
}

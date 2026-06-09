import fs from 'fs';
import path from 'path';
import { firefox } from 'playwright-core';
import { launchOptions } from 'camoufox-js';

// Camoufox is a Firefox-based anti-detect browser. Unlike Chromium+stealth,
// it patches fingerprints at the C++ level (0% detection in current benchmarks),
// which is what's needed to get TikTok's search/live page to actually render.

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

  // Connect to the IPRoyal residential proxy over plain HTTP.
  const proxy = proxyServer ? {
    server: `http://${proxyServer}`,
    username: proxyUsername,
    password: proxyPassword,
  } : undefined;

  console.log('[proxy] launching Camoufox (firefox anti-detect)…');
  // geoip:true makes Camoufox derive timezone, locale and geolocation from the
  // proxy's exit IP so the fingerprint is internally consistent — key for trust.
  // humanize adds human-like cursor movement. os:'windows' matches our UA story.
  const baseOpts = {
    headless: false, // run under Xvfb (xvfb-run in start script)
    os: 'windows',
    humanize: true,
    ...(proxy ? { proxy } : {}),
  };
  let camoufoxOpts;
  try {
    camoufoxOpts = await launchOptions({ ...baseOpts, geoip: !!proxy });
  } catch (err) {
    // GeoIP DB may not be present — fall back without it rather than aborting.
    console.log('[proxy] geoip unavailable, launching without it:', err?.message || err);
    camoufoxOpts = await launchOptions(baseOpts);
  }

  const browser = await firefox.launch({
    ...camoufoxOpts,
    timeout: 60000,
    ...(proxy ? { proxy } : {}),
  });
  console.log('[proxy] camoufox launched ok');
  return browser;
}

async function newTikTokContext(browser) {
  fs.mkdirSync('output', { recursive: true });

  // Let Camoufox own the fingerprint (UA, locale, timezone, headers, viewport).
  // Overriding userAgent / sec-ch-ua here would create a Chromium-on-Firefox
  // mismatch that defeats the whole point of the anti-detect browser.
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
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
      dbg(`[scrape] fast path`);
      await page.goto(liveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
    } else {
      dbg(`[scrape] slow path`);
      await page.goto(liveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000); // extra time for signing scripts to load
    }

    const bodyLen = await page.evaluate(() => document.body?.innerText?.length || 0);
    log(`[scrape] url=${page.url().slice(0,80)} bodyLen=${bodyLen}`);

    // Check for TikTok's X-Bogus/signing globals — they load even on blank pages
    const signingInfo = await page.evaluate(() => {
      const keys = Object.keys(window);
      const relevant = keys.filter(k => /bogus|acrawl|sign|xbogus|byted|msdk|tiktok|webpack/i.test(k));
      const hasByted = typeof window.byted_acrawler !== 'undefined';
      const bytedKeys = hasByted ? Object.keys(window.byted_acrawler) : [];
      // Check Next.js / webpack chunk globals TikTok uses
      const webpackKey = keys.find(k => k.startsWith('webpackChunk'));
      const hasNextData = typeof window.__NEXT_DATA__ !== 'undefined';
      // Try to probe the encrypt function signature
      const encryptType = hasByted ? typeof window.byted_acrawler.encrypt : 'n/a';
      const signType = hasByted ? typeof window.byted_acrawler.sign : 'n/a';
      return { relevant, hasByted, bytedKeys, webpackKey: webpackKey || null, hasNextData, encryptType, signType };
    });
    log(`[signing] hasByted=${signingInfo.hasByted} bytedKeys=${signingInfo.bytedKeys.join(',')} encrypt=${signingInfo.encryptType} sign=${signingInfo.signType}`);

    const MAX_ROOMS = 200;
    const MAX_PAGES = 8;

    if (bodyLen > 50) {
      // Page rendered — use scroll-based pagination so TikTok's own scroll handler
      // fires API requests with proper security tokens on each scroll
      log('[scrape] page rendered — using scroll-based pagination');
      // Wait for the initial API response to land before we start scrolling.
      // The first /api/search/live/full/ fires on page load; give it up to 6s.
      await page.waitForTimeout(6000);
      log(`[scrape] after initial wait: intercepted=${intercepted.size}`);
      const MAX_SCROLLS = 15;
      for (let s = 0; s < MAX_SCROLLS && intercepted.size < MAX_ROOMS; s++) {
        const prevSize = intercepted.size;
        await page.mouse.wheel(0, 1500);
        await page.waitForTimeout(2500);
        if (s % 3 === 2) await page.waitForTimeout(1000); // occasional extra wait
        if (s > 0 && intercepted.size === prevSize) {
          log('[scrape] no new rooms after scroll, stopping');
          break;
        }
        if (intercepted.size > prevSize) log(`[scrape] scroll ${s+1}: +${intercepted.size - prevSize} new (total=${intercepted.size})`);
      }
    } else {
      // Page blank — use page.evaluate fetch with browser cookie jar as fallback
      log('[scrape] page blank — using evaluate fetch fallback');
      // Extract msToken from cookies — TikTok includes it as a URL param in its own requests
      const msToken = await page.evaluate(() =>
        document.cookie.match(/msToken=([^;]+)/)?.[1] || ''
      );

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
        focus_state: 'true',
        from_page: 'search',
        history_len: '2',
        is_fullscreen: 'false',
        is_page_visible: 'true',
        os: 'windows',
        priority_region: '',
        referer: '',
        region: 'US',
        screen_height: '1080',
        screen_width: '1920',
        tz_name: 'America/New_York',
        webcast_language: 'en',
        ...(msToken ? { msToken } : {}),
      };
      log(`[fetch] msToken=${msToken ? msToken.slice(0, 20) + '…' : 'none'}`);
      for (let p = 0; p < MAX_PAGES && intercepted.size < MAX_ROOMS; p++) {
        const offset = p * 30;
        let result;
        try {
          result = await page.evaluate(async ({ fp, off }) => {
            try {
              const params = new URLSearchParams({ ...fp, offset: String(off) });
              let url = `/api/search/live/full/?${params}`;

              // Sign with byted_acrawler if available — unlocks page 2+
              let signed = false;
              let signDebug = null;
              if (window.byted_acrawler) {
                try {
                  const fullUrl = location.origin + url;
                  const s = window.byted_acrawler.frontierSign?.(fullUrl)
                         ?? window.byted_acrawler.encrypt?.({ url: fullUrl })
                         ?? null;
                  signDebug = JSON.stringify(s);
                  if (s) {
                    const bogus = s['X-Bogus'] ?? s.xBogus ?? s.bogus ?? null;
                    const sig   = s['_signature'] ?? s.signature ?? null;
                    if (bogus) url += `&X-Bogus=${encodeURIComponent(bogus)}`;
                    if (sig)   url += `&_signature=${encodeURIComponent(sig)}`;
                    signed = !!(bogus || sig);
                  }
                } catch (e) { signDebug = 'err:' + e.message; }
              }

              const res = await fetch(url, {
                credentials: 'include',
                headers: { 'Referer': location.href, 'Accept': '*/*' },
              });
              if (!res.ok) return { error: res.status };
              const json = await res.json();
              return { ok: true, hasMore: json?.has_more, cursor: json?.cursor ?? null, data: json?.data || [], signed, signDebug };
            } catch (e) { return { error: String(e) }; }
          }, { fp: fetchParams, off: offset });
        } catch (evalErr) {
          log(`[fetch] offset=${offset} context destroyed, keeping ${intercepted.size} rooms`);
          break;
        }
        if (result.error) { log(`[fetch] offset=${offset} error=${result.error}`); break; }
        const added = parseItemsIntoIntercepted(result.data || [], 'fetch');
        if (p <= 1) log(`[fetch] offset=${offset} signDebug=${result.signDebug}`);
        log(`[fetch] offset=${offset}: +${added} new (total=${intercepted.size}) hasMore=${result.hasMore} signed=${result.signed}`);
        if (!result.hasMore) break;
        await page.waitForTimeout(400);
      }
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
    const errMsg = err.message || String(err);
    const errStack = err.stack?.split('\n').slice(0,3).join(' | ') || '';
    log(`[scrape] error keyword="${keyword}" duration=${(durationMs/1000).toFixed(1)}s error=${errMsg} stack=${errStack}`);
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
  }
}

function isTunnelError(error) {
  const e = (error || '').toLowerCase();
  return e.includes('tunnel') || e.includes('proxy') || e.includes('err_') || e.includes('connection refused') || e.includes('econnrefused') || e.includes('socket');
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
  console.log('[run] launching browser…');
  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    console.error('[run] BROWSER LAUNCH FAILED:', err?.message || err);
    console.error('[run] stack:', err?.stack?.split('\n').slice(0, 5).join(' | '));
    throw err;
  }
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

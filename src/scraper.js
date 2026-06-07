import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const STORAGE_STATE_PATH = path.join(process.cwd(), 'output', 'tiktok-guest-state.json');

const TIKTOK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ROOM_HINT_WORDS = [
  'id_str',
  'title',
  'user_count',
  'owner',
  'display_id',
  'nickname',
  'avatar_thumb',
  'avatar_medium',
  'link_mic',
  'battle_settings',
  'stats'
];

function hasGuestState() {
  return fs.existsSync(STORAGE_STATE_PATH);
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
  const multiplier = suffix === 'B' ? 1000000000 : suffix === 'M' ? 1000000 : suffix === 'K' ? 1000 : 1;
  return Math.round(number * multiplier);
}

function normalizeRenderedCreators(pageDiagnostics) {
  const creators = pageDiagnostics?.creators || [];
  const normalized = [];
  const seen = new Set();

  for (const creator of creators) {
    const username = creator.username || '';
    if (!username || seen.has(username)) continue;

    const lines = String(creator.text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const usernameIndex = lines.findIndex((line) => line === username);
    const localLines = usernameIndex >= 0 ? lines.slice(Math.max(0, usernameIndex - 2), usernameIndex + 8) : lines;
    const nickname = usernameIndex > 0 ? lines[usernameIndex - 1] : username;
    const followersIndex = localLines.findIndex((line) => /^Followers$/i.test(line));
    const likesIndex = localLines.findIndex((line) => /^Likes$/i.test(line));
    const followersText = followersIndex > 0 ? localLines[followersIndex - 1] : null;
    const likesText = likesIndex > 0 ? localLines[likesIndex - 1] : null;
    const beforeUsername = usernameIndex >= 0 ? lines.slice(Math.max(0, usernameIndex - 4), usernameIndex + 1) : [];
    const afterUsername = usernameIndex >= 0 ? lines.slice(usernameIndex, usernameIndex + 8) : [];

    seen.add(username);
    normalized.push({
      username,
      nickname,
      followersText,
      followers: parseTikTokCount(followersText),
      likesText,
      likes: parseTikTokCount(likesText),
      isLive: beforeUsername.includes('LIVE') || afterUsername.includes('LIVE'),
      profileUrl: creator.profileUrl || `https://www.tiktok.com/@${username}`,
      liveUrl: `https://www.tiktok.com/@${username}/live`,
      rawText: creator.text || ''
    });
  }

  return normalized;
}

function firstUrl(imageObject) {
  return imageObject?.url_list?.[0] || imageObject?.urls?.[0] || null;
}

function getSnapshotImage(room) {
  return firstUrl(room?.stream_snapshot) || null;
}

function looksLikeRoomObject(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value.id_str || value.id) &&
      value.title !== undefined &&
      value.user_count !== undefined &&
      value.owner &&
      typeof value.owner === 'object' &&
      (value.owner.display_id || value.owner.nickname)
  );
}

function normalizeRoom(room, sourcePath = '$') {
  const owner = room.owner || {};
  const username = owner.display_id || '';

  return {
    sourcePath,
    roomId: String(room.id_str || room.id || ''),
    title: room.title || '',
    viewers: Number(room.user_count || 0),
    totalUsers: Number(room.stats?.total_user || 0),
    likes: Number(room.like_count || 0),
    keyword: room.keyword || null,
    owner: {
      userId: String(owner.id_str || owner.id || room.owner_user_id || ''),
      username,
      nickname: owner.nickname || '',
      bio: owner.bio_description || '',
      followers: Number(owner.follow_info?.follower_count || 0),
      avatar: firstUrl(owner.avatar_medium) || firstUrl(owner.avatar_thumb) || firstUrl(room.cover),
      verified: Boolean(owner.authentication_info?.has_cert)
    },
    cover: firstUrl(room.cover),
    snapshot: getSnapshotImage(room),
    liveUrl: username ? `https://www.tiktok.com/@${username}/live` : null,
    battle: {
      hasLinkMic: Boolean(room.link_mic),
      hasBattleSettings: Boolean(room.link_mic?.battle_settings)
    },
    signals: {
      status: room.status,
      liveRoomMode: room.live_room_mode,
      startTime: room.start_time,
      hashtag: room.hashtag?.title || null
    }
  };
}

function collectRoomObjects(value, pathName = '$', rooms = []) {
  if (!value || typeof value !== 'object' || rooms.length >= 100) return rooms;

  if (looksLikeRoomObject(value)) {
    rooms.push(normalizeRoom(value, pathName));
    return rooms;
  }

  if (Array.isArray(value)) {
    value.slice(0, 200).forEach((item, index) => {
      collectRoomObjects(item, `${pathName}[${index}]`, rooms);
    });
    return rooms;
  }

  for (const [key, val] of Object.entries(value).slice(0, 150)) {
    collectRoomObjects(val, `${pathName}.${key}`, rooms);
  }

  return rooms;
}

function compactObject(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 2) return Array.isArray(value) ? `[array:${value.length}]` : '[object]';

  if (Array.isArray(value)) {
    return value.slice(0, 3).map((item) => compactObject(item, depth + 1));
  }

  const output = {};
  for (const [key, val] of Object.entries(value).slice(0, 25)) {
    output[key] = compactObject(val, depth + 1);
  }
  return output;
}

function collectRoomCandidates(value, pathName = '$', matches = []) {
  if (!value || typeof value !== 'object' || matches.length >= 25) return matches;

  if (Array.isArray(value)) {
    value.slice(0, 60).forEach((item, index) => collectRoomCandidates(item, `${pathName}[${index}]`, matches));
    return matches;
  }

  const jsonText = JSON.stringify(value).slice(0, 8000);
  const looksUseful =
    /id_str/.test(jsonText) &&
    /user_count/.test(jsonText) &&
    /owner/.test(jsonText) &&
    /(display_id|nickname)/.test(jsonText);

  if (looksUseful) {
    matches.push({
      path: pathName,
      signals: {
        hasIdStr: /id_str/.test(jsonText),
        hasTitle: /title/.test(jsonText),
        hasUserCount: /user_count/.test(jsonText),
        hasOwner: /owner/.test(jsonText),
        hasDisplayId: /display_id/.test(jsonText),
        hasBattleSettings: /battle_settings/.test(jsonText)
      },
      sample: compactObject(value)
    });
  }

  for (const [key, val] of Object.entries(value).slice(0, 80)) {
    collectRoomCandidates(val, `${pathName}.${key}`, matches);
  }

  return matches;
}

async function newTikTokPage(browser) {
  fs.mkdirSync('output', { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    userAgent: TIKTOK_USER_AGENT,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    ...(hasGuestState() ? { storageState: STORAGE_STATE_PATH } : {})
  });

  if (!hasGuestState()) {
    console.log('Creating TikTok guest session...');
    const warmup = await context.newPage();
    await warmup.goto('https://www.tiktok.com/', { waitUntil: 'networkidle', timeout: 60000 });
    await warmup.waitForTimeout(10000);
    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log('Saved TikTok guest session:', STORAGE_STATE_PATH);
    await warmup.close();
  }

  const page = await context.newPage();
  return { context, page };
}

async function closeLoginPopup(page) {
  await page.waitForTimeout(3000);

  try {
    await page.locator('[aria-label="Close"]').click({ timeout: 5000 });
    console.log('Closed TikTok login popup');
    return true;
  } catch {
    console.log('No login popup close button found');
    return false;
  }
}

async function forceLiveSearch(page, keyword) {
  await page.goto(liveSearchUrl(keyword), {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(3000);
  await closeLoginPopup(page);
  await page.waitForTimeout(8000);
  return true;
}

function extractTikTokPage() {
  const text = document.body?.innerText || '';
  const html = document.documentElement?.innerHTML || '';
  const links = Array.from(document.querySelectorAll('a'));
  const creatorsByUsername = new Map();

  for (const link of links) {
    const href = link.href || '';
    const match = href.match(/\/(@[^/?#]+)/);
    if (!match) continue;

    const username = match[1].replace('@', '').trim();
    if (!username) continue;

    const card = link.closest('div');
    const cardText = (card?.innerText || link.innerText || '').trim();

    if (!creatorsByUsername.has(username)) {
      creatorsByUsername.set(username, {
        username,
        profileUrl: href.split('?')[0],
        text: cardText.slice(0, 1200)
      });
    }
  }

  const images = Array.from(document.querySelectorAll('img'))
    .slice(0, 80)
    .map((img) => ({ alt: img.alt || '', src: img.currentSrc || img.src || '' }))
    .filter((img) => img.src);

  return {
    title: document.title,
    url: location.href,
    bodyTextLength: text.length,
    bodyTextSample: text.slice(0, 3000),
    htmlLength: html.length,
    anchorCount: document.querySelectorAll('a').length,
    creatorCount: creatorsByUsername.size,
    creators: Array.from(creatorsByUsername.values()).slice(0, 50),
    images,
    flags: {
      hasLoginText: /log in/i.test(text),
      hasSearchLoginText: /log in to search/i.test(text),
      hasLiveText: /live/i.test(text),
      hasCaptchaText: /captcha|verify|robot/i.test(text),
      hasRoomText: /room/i.test(html),
      hasUniqueIdText: /unique_id|uniqueId/i.test(html),
      hasItemListText: /item_list|itemList/i.test(html)
    }
  };
}

function analyzeJsonResponse(url, text) {
  let json = null;
  let keys = [];
  let hints = [];
  let roomCandidates = [];
  let rooms = [];

  try {
    json = JSON.parse(text);
    keys = Object.keys(json).slice(0, 30);
  } catch {}

  for (const word of ROOM_HINT_WORDS) {
    if (text.includes(word)) hints.push(word);
  }

  if (json) {
    rooms = collectRoomObjects(json).slice(0, 50);
    if (rooms.length || hints.length >= 4) {
      roomCandidates = collectRoomCandidates(json).slice(0, 8);
    }
  }

  return {
    url: url.split('?')[0],
    size: text.length,
    keys,
    hints,
    roomCount: rooms.length,
    rooms,
    candidateCount: roomCandidates.length,
    roomCandidates
  };
}

function mergeRooms(existingRooms, incomingRooms) {
  const seen = new Set(existingRooms.map((room) => room.roomId));

  for (const room of incomingRooms) {
    if (!room.roomId || seen.has(room.roomId)) continue;
    seen.add(room.roomId);
    existingRooms.push(room);
  }
}

function attachResponseCapture(page, discovered, rooms, counters) {
  page.on('response', async (response) => {
    try {
      counters.requestsSeen++;
      const url = response.url();
      const type = response.headers()['content-type'] || '';

      if (!type.includes('json')) return;
      counters.jsonResponses++;

      if (url.includes('monitor') || url.includes('log') || url.includes('analytics')) return;

      const text = await response.text();
      const analyzed = analyzeJsonResponse(url, text);

      if (analyzed.rooms.length) mergeRooms(rooms, analyzed.rooms);

      if (analyzed.roomCount || analyzed.candidateCount) {
        discovered.push(analyzed);
      }
    } catch {}
  });
}

export async function debugTikTokPage(keyword = 'battle') {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await newTikTokPage(browser);
  const url = liveSearchUrl(keyword);
  const responses = [];
  const requestFailures = [];
  const discovered = [];
  const rooms = [];
  const counters = { requestsSeen: 0, jsonResponses: 0 };

  attachResponseCapture(page, discovered, rooms, counters);

  page.on('response', async (response) => {
    const responseUrl = response.url();
    const contentType = response.headers()['content-type'] || '';

    if (responseUrl.includes('tiktok') || responseUrl.includes('tiktokw') || responseUrl.includes('tiktokv')) {
      responses.push({
        status: response.status(),
        url: responseUrl.split('?')[0],
        contentType: contentType.slice(0, 80)
      });
    }
  });

  page.on('requestfailed', (request) => {
    requestFailures.push({
      url: request.url().split('?')[0],
      failure: request.failure()?.errorText || 'unknown'
    });
  });

  let gotoError = null;
  let popupClosed = false;
  let liveTabClicked = false;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    popupClosed = await closeLoginPopup(page);
    liveTabClicked = await forceLiveSearch(page, keyword);
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(4000);
    await context.storageState({ path: STORAGE_STATE_PATH });
  } catch (error) {
    gotoError = String(error?.message || error);
  }

  const diagnostics = await page.evaluate(extractTikTokPage);
  const creators = normalizeRenderedCreators(diagnostics);
  const cookies = await context.cookies();
  const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
  await browser.close();

  return {
    checked_at: new Date().toISOString(),
    keyword,
    requestedUrl: url,
    gotoError,
    popupClosed,
    liveTabClicked,
    requestsSeen: counters.requestsSeen,
    jsonResponses: counters.jsonResponses,
    creatorCount: creators.length,
    creators,
    roomCount: rooms.length,
    rooms: rooms.slice(0, 100),
    discoveredCount: discovered.length,
    discovered: discovered.slice(0, 25),
    guestState: { path: STORAGE_STATE_PATH, exists: hasGuestState() },
    browser: {
      headless: true,
      userAgent: TIKTOK_USER_AGENT,
      locale: 'en-US',
      timezoneId: 'America/New_York'
    },
    cookies: {
      count: cookies.length,
      names: cookies.map((cookie) => cookie.name).slice(0, 30)
    },
    responses: responses.slice(0, 80),
    responseCount: responses.length,
    requestFailures: requestFailures.slice(0, 30),
    requestFailureCount: requestFailures.length,
    diagnostics,
    screenshotBase64: screenshot.toString('base64')
  };
}

async function extractSeedHeaders(request) {
  const rawHeaders = await request.headersArray();
  const headers = {};
  for (const { name, value } of rawHeaders) {
    if (!name.startsWith(':') && name.toLowerCase() !== 'content-length') {
      headers[name] = value;
    }
  }
  return headers;
}

// Capture a live-room API seed from the browser.
// Strategy A: generic /search page → expand LIVE nav section.
// Strategy B (fallback): /live discovery page.
// We accept any JSON response that contains actual room objects, not
// just the specific /api/search/live/ URL, because TikTok varies endpoint
// paths across sessions and regions.
async function captureApiSeed(keyword) {
  // Always start with a fresh guest session to avoid stale redirect state.
  if (hasGuestState()) {
    try { fs.unlinkSync(STORAGE_STATE_PATH); } catch {}
  }

  const browser = await chromium.launch({ headless: true });
  const { context, page } = await newTikTokPage(browser);

  let seed = null;

  page.on('response', async (response) => {
    if (seed) return;
    const url = response.url();
    // Skip non-API URLs and noise.
    if (!url.includes('/api/') && !url.includes('/webcast/')) return;
    if (/log|monitor|analytics|sentry|report/i.test(url)) return;

    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); } catch { return; }

      // Check the response contains real live-room objects.
      const rooms = collectRoomObjects(json);
      if (rooms.length === 0) return;

      const headers = await extractSeedHeaders(response.request());
      seed = { url: response.request().url(), headers };
      console.log('[seed] captured:', url.split('?')[0], '— rooms in response:', rooms.length);
    } catch {}
  });

  // ── Strategy A: generic search page ──────────────────────────────────
  const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await closeLoginPopup(page);
  await page.waitForTimeout(3000);
  console.log('[seed] landed on:', page.url());

  // Try to activate the LIVE section. TikTok renders it as a collapsible
  // nav wrapper (class DivLiveNavWrapper) whose inner div has aria-expanded.
  // Click the inner element, not the outer wrapper.
  const clickResult = await page.evaluate(() => {
    // 1. Click the aria-expanded child inside the live nav wrapper.
    const wrapper = document.querySelector('[class*="DivLiveNavWrapper"], [class*="LiveNavWrapper"]');
    if (wrapper) {
      const inner = wrapper.querySelector('[aria-expanded], a, button, [role="button"]');
      const target = inner || wrapper;
      target.click();
      return 'liveNavWrapper: ' + target.outerHTML.slice(0, 120);
    }
    // 2. Find any visible link whose href contains /search/live.
    for (const a of document.querySelectorAll('a')) {
      if (a.href?.includes('/search/live') && a.offsetParent !== null) {
        a.click();
        return 'href click: ' + a.outerHTML.slice(0, 120);
      }
    }
    // 3. Click the leaf element whose sole text is "LIVE".
    for (const el of document.querySelectorAll('*')) {
      if (el.childElementCount === 0 && el.textContent?.trim() === 'LIVE' && el.offsetParent !== null) {
        el.click();
        return 'text=LIVE: ' + el.outerHTML.slice(0, 120);
      }
    }
    return null;
  });
  console.log('[seed] click result:', clickResult || 'nothing clicked');
  await page.waitForTimeout(8000);

  // ── Strategy B: /live discovery page ─────────────────────────────────
  if (!seed) {
    console.log('[seed] no rooms yet — trying /live discovery page');
    try {
      await page.goto('https://www.tiktok.com/live', { waitUntil: 'domcontentloaded', timeout: 40000 });
      await closeLoginPopup(page);
      await page.waitForTimeout(10000);
    } catch (e) {
      console.log('[seed] /live navigation error:', e.message);
    }
  }

  // ── Strategy C: /search/live direct ──────────────────────────────────
  if (!seed) {
    console.log('[seed] still no rooms — trying /search/live direct');
    try {
      await page.goto(liveSearchUrl(keyword), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(8000);
    } catch (e) {
      console.log('[seed] /search/live error:', e.message);
    }
  }

  console.log('[seed] done. url:', page.url(), '| seed captured:', !!seed);

  await context.storageState({ path: STORAGE_STATE_PATH });
  const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
  await browser.close();

  return { seed, screenshotBase64: screenshot.toString('base64') };
}

// Build the URL for a paginated live-search request.
// We preserve all original query params (device_id, aid, verifyFp, etc.)
// and only swap the keyword and cursor.
function buildPageUrl(seedUrl, keyword, cursor) {
  const u = new URL(seedUrl);
  u.searchParams.set('keyword', keyword);
  u.searchParams.set('offset', String(cursor));
  // Some TikTok API versions use 'cursor' instead of 'offset'.
  if (u.searchParams.has('cursor')) u.searchParams.set('cursor', String(cursor));
  return u.toString();
}

// Parse rooms out of a TikTok live-search API response body.
// The response shape is typically:
//   { data: [ { lives: [ <room>, ... ] }, ... ], cursor: N, has_more: 0|1 }
// but we also fall back to the generic collectRoomObjects walker.
function extractRoomsFromApiBody(json) {
  const rooms = [];

  // Primary path: data[].lives[]
  if (Array.isArray(json?.data)) {
    for (const item of json.data) {
      if (Array.isArray(item?.lives)) {
        for (const live of item.lives) {
          if (looksLikeRoomObject(live)) rooms.push(normalizeRoom(live, '$.data[].lives[]'));
        }
      }
      // Some responses nest the room directly in data[].
      if (looksLikeRoomObject(item)) rooms.push(normalizeRoom(item, '$.data[]'));
    }
  }

  // Fallback: walk the whole tree.
  if (rooms.length === 0) collectRoomObjects(json, '$', rooms);

  return rooms;
}

async function paginateWithFetch(seed, keyword, timeLimitMs = 4 * 60 * 1000) {
  const allRooms = [];
  const seen = new Set();
  const startTime = Date.now();
  let cursor = 0;
  let page = 0;
  let hasMore = true;
  let consecutiveEmpty = 0;

  while (hasMore && Date.now() - startTime < timeLimitMs) {
    const url = buildPageUrl(seed.url, keyword, cursor);

    let json;
    try {
      const res = await fetch(url, {
        headers: seed.headers,
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) {
        console.log(`[paginate] HTTP ${res.status} on page ${page}, stopping`);
        break;
      }
      json = await res.json();
    } catch (err) {
      console.log(`[paginate] fetch error on page ${page}:`, err.message);
      break;
    }

    const rooms = extractRoomsFromApiBody(json);
    let added = 0;
    for (const room of rooms) {
      if (room.roomId && !seen.has(room.roomId)) {
        seen.add(room.roomId);
        allRooms.push(room);
        added++;
      }
    }

    console.log(`[paginate] page=${page} cursor=${cursor} rooms_this_page=${rooms.length} added=${added} total=${allRooms.length}`);

    // Advance cursor — TikTok returns the next cursor in the response.
    const nextCursor = json?.cursor ?? json?.next_cursor ?? null;
    hasMore = json?.has_more === 1 || json?.has_more === true;

    if (nextCursor !== null && nextCursor !== cursor) {
      cursor = nextCursor;
    } else {
      // No cursor advancement means we've reached the end.
      break;
    }

    if (rooms.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
    } else {
      consecutiveEmpty = 0;
    }

    page++;
    // Small delay to avoid hammering TikTok.
    await new Promise((r) => setTimeout(r, 300));
  }

  return allRooms;
}

export async function scrapeTikTokLive(keyword) {
  console.log(`[scrape] capturing API seed for keyword="${keyword}"`);
  const { seed, screenshotBase64 } = await captureApiSeed(keyword);

  if (!seed) {
    console.log('[scrape] no API seed captured — TikTok live search XHR was not observed');
    return {
      keyword,
      collected_at: new Date().toISOString(),
      error: 'No live-search API request was intercepted. TikTok may have blocked the session or the page did not reach the LIVE tab.',
      roomCount: 0,
      rooms: [],
      screenshotBase64
    };
  }

  console.log(`[scrape] seed captured, starting pagination`);
  const rooms = await paginateWithFetch(seed, keyword);

  return {
    keyword,
    collected_at: new Date().toISOString(),
    roomCount: rooms.length,
    rooms,
    screenshotBase64
  };
}

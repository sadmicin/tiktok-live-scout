import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const STORAGE_STATE_PATH = path.join(
  process.cwd(),
  'output',
  'tiktok-guest-state.json'
);

const TIKTOK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const LIVE_HINT_WORDS = [
  'user',
  'unique_id',
  'uniqueId',
  'nickname',
  'room',
  'room_id',
  'roomId',
  'live',
  'owner',
  'avatar',
  'viewer',
  'viewers',
  'follow',
  'item_list',
  'cursor'
];

function hasGuestState() {
  return fs.existsSync(STORAGE_STATE_PATH);
}

function safePreview(value) {
  try {
    return JSON.parse(JSON.stringify(value)).slice?.(0, 1) || value;
  } catch {
    return null;
  }
}

function compactObject(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 3) return Array.isArray(value) ? `[array:${value.length}]` : '[object]';

  if (Array.isArray(value)) {
    return value.slice(0, 3).map((item) => compactObject(item, depth + 1));
  }

  const output = {};
  for (const [key, val] of Object.entries(value).slice(0, 30)) {
    output[key] = compactObject(val, depth + 1);
  }
  return output;
}

function collectLiveCandidates(value, pathName = '$', matches = []) {
  if (!value || typeof value !== 'object' || matches.length >= 50) return matches;

  if (Array.isArray(value)) {
    value.slice(0, 60).forEach((item, index) => {
      collectLiveCandidates(item, `${pathName}[${index}]`, matches);
    });
    return matches;
  }

  const keys = Object.keys(value);
  const joinedKeys = keys.join(' ').toLowerCase();
  const jsonText = JSON.stringify(value).slice(0, 6000).toLowerCase();

  const looksUseful =
    /(unique_id|uniqueid|nickname|avatar|room_id|roomid|owner|viewer|live)/i.test(joinedKeys) ||
    /(unique_id|uniqueid|nickname|avatar|room_id|roomid|owner|viewer|live)/i.test(jsonText);

  if (looksUseful) {
    matches.push({
      path: pathName,
      signals: {
        hasUniqueId: /(unique_id|uniqueId)/.test(JSON.stringify(value).slice(0, 6000)),
        hasNickname: /nickname/.test(JSON.stringify(value).slice(0, 6000)),
        hasAvatar: /avatar/.test(JSON.stringify(value).slice(0, 6000)),
        hasRoom: /(room_id|roomId|room)/.test(JSON.stringify(value).slice(0, 6000)),
        hasViewer: /(viewer|viewers|user_count|audience)/i.test(JSON.stringify(value).slice(0, 6000)),
        hasLive: /live/i.test(JSON.stringify(value).slice(0, 6000))
      },
      sample: compactObject(value)
    });
  }

  for (const [key, val] of Object.entries(value).slice(0, 80)) {
    collectLiveCandidates(val, `${pathName}.${key}`, matches);
  }

  return matches;
}

async function newTikTokPage(browser) {
  fs.mkdirSync('output', { recursive: true });

  const context = await browser.newContext({
    viewport: {
      width: 1365,
      height: 900
    },
    userAgent: TIKTOK_USER_AGENT,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    ...(hasGuestState()
      ? {
          storageState: STORAGE_STATE_PATH
        }
      : {})
  });

  if (!hasGuestState()) {
    console.log('Creating TikTok guest session...');

    const warmup = await context.newPage();

    await warmup.goto('https://www.tiktok.com/', {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    await warmup.waitForTimeout(10000);

    await context.storageState({
      path: STORAGE_STATE_PATH
    });

    console.log('Saved TikTok guest session:', STORAGE_STATE_PATH);

    await warmup.close();
  }

  const page = await context.newPage();

  return {
    context,
    page
  };
}

async function closeLoginPopup(page) {
  await page.waitForTimeout(3000);

  try {
    await page.locator('[aria-label="Close"]').click({
      timeout: 5000
    });

    console.log('Closed TikTok login popup');
    return true;
  } catch {
    console.log('No login popup close button found');
    return false;
  }
}

async function forceLiveSearch(page, keyword) {
  await page.goto(`https://www.tiktok.com/search/live?q=${encodeURIComponent(keyword)}`, {
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
    if (!username || username === '') continue;

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
    .map((img) => ({
      alt: img.alt || '',
      src: img.currentSrc || img.src || ''
    }))
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
  let liveCandidates = [];

  try {
    json = JSON.parse(text);
    keys = Object.keys(json).slice(0, 30);
  } catch {}

  for (const word of LIVE_HINT_WORDS) {
    if (text.includes(word)) hints.push(word);
  }

  if (json && hints.length) {
    liveCandidates = collectLiveCandidates(json).slice(0, 12);
  }

  return {
    url: url.split('?')[0],
    size: text.length,
    keys,
    hints,
    candidateCount: liveCandidates.length,
    liveCandidates
  };
}

function attachResponseCapture(page, discovered, counters) {
  page.on('response', async (response) => {
    try {
      counters.requestsSeen++;

      const url = response.url();
      const type = response.headers()['content-type'] || '';

      if (!type.includes('json')) return;
      counters.jsonResponses++;

      if (
        url.includes('monitor') ||
        url.includes('log') ||
        url.includes('analytics')
      ) {
        return;
      }

      const text = await response.text();
      const analyzed = analyzeJsonResponse(url, text);

      if (analyzed.hints.length || analyzed.candidateCount) {
        discovered.push(analyzed);
      }
    } catch {}
  });
}

export async function debugTikTokPage(keyword = 'battle') {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await newTikTokPage(browser);

  const url = `https://www.tiktok.com/search/live?q=${encodeURIComponent(keyword)}`;
  const responses = [];
  const requestFailures = [];
  const discovered = [];
  const counters = { requestsSeen: 0, jsonResponses: 0 };

  attachResponseCapture(page, discovered, counters);

  page.on('response', async (response) => {
    const responseUrl = response.url();
    const contentType = response.headers()['content-type'] || '';

    if (
      responseUrl.includes('tiktok') ||
      responseUrl.includes('tiktokw') ||
      responseUrl.includes('tiktokv')
    ) {
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
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    popupClosed = await closeLoginPopup(page);
    liveTabClicked = await forceLiveSearch(page, keyword);

    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(4000);

    await context.storageState({
      path: STORAGE_STATE_PATH
    });
  } catch (error) {
    gotoError = String(error?.message || error);
  }

  const diagnostics = await page.evaluate(extractTikTokPage);

  const cookies = await context.cookies();
  const screenshot = await page.screenshot({
    fullPage: true,
    type: 'png'
  });

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
    discoveredCount: discovered.length,
    discovered: discovered.slice(0, 25),
    guestState: {
      path: STORAGE_STATE_PATH,
      exists: hasGuestState()
    },
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

export async function scrapeTikTokLive(keyword) {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await newTikTokPage(browser);

  const counters = { requestsSeen: 0, jsonResponses: 0 };
  const discovered = [];
  attachResponseCapture(page, discovered, counters);

  await page.goto(`https://www.tiktok.com/search/live?q=${encodeURIComponent(keyword)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  const popupClosed = await closeLoginPopup(page);
  const liveTabClicked = await forceLiveSearch(page, keyword);

  await page.mouse.wheel(0, 8000);
  await page.waitForTimeout(8000);

  await context.storageState({
    path: STORAGE_STATE_PATH
  });

  const pageDiagnostics = await page.evaluate(extractTikTokPage);
  const screenshot = await page.screenshot({
    fullPage: true,
    type: 'png'
  });

  await browser.close();

  return {
    keyword,
    collected_at: new Date().toISOString(),
    popupClosed,
    liveTabClicked,
    requestsSeen: counters.requestsSeen,
    jsonResponses: counters.jsonResponses,
    discoveredCount: discovered.length,
    discovered: discovered.slice(0, 25),
    pageDiagnostics,
    screenshotBase64: screenshot.toString('base64')
  };
}

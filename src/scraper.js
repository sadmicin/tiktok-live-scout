import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

function makeLogger() {
  const lines = [];
  const log = (...args) => {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(msg);
    lines.push(line);
  };
  return { log, lines };
}

const STORAGE_STATE_PATH = path.join(process.cwd(), 'output', 'tiktok-guest-state.json');

const TIKTOK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
  const multiplier = suffix === 'B' ? 1_000_000_000 : suffix === 'M' ? 1_000_000 : suffix === 'K' ? 1_000 : 1;
  return Math.round(number * multiplier);
}

async function launchBrowser() {
  return chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ]
  });
}

async function newTikTokContext(browser) {
  fs.mkdirSync('output', { recursive: true });

  const context = await browser.newContext({
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

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(window, 'chrome', { get: () => ({ runtime: {} }) });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
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

export async function scrapeTikTokLive(keyword) {
  const { log, lines: runLog } = makeLogger();
  log(`[scrape] start keyword="${keyword}"`);

  const browser = await launchBrowser();
  let screenshotBase64 = null;

  try {
    const context = await newTikTokContext(browser);

    // Warm up guest session if we don't have one
    if (!hasGuestState()) {
      log('[scrape] warming up guest session...');
      const warmup = await context.newPage();
      await warmup.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await warmup.waitForTimeout(5000);
      await context.storageState({ path: STORAGE_STATE_PATH });
      log('[scrape] guest session saved');
      await warmup.close();
    }

    const page = await context.newPage();
    const url = liveSearchUrl(keyword);
    log(`[scrape] navigating to ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissLoginPopup(page);

    // Wait for cards to appear
    log('[scrape] waiting for live cards to render...');
    try {
      await page.waitForSelector('a[href*="/live"]', { timeout: 15000 });
    } catch {
      log('[scrape] no live links appeared within 15s, proceeding anyway');
    }
    await page.waitForTimeout(2000);

    const rooms = await scrollAndCollect(page, log, 12);

    // Save updated guest state
    await context.storageState({ path: STORAGE_STATE_PATH });
    screenshotBase64 = (await page.screenshot({ fullPage: false, type: 'png' })).toString('base64');

    await browser.close();

    log(`[scrape] done. rooms=${rooms.length}`);
    return {
      keyword,
      collected_at: new Date().toISOString(),
      mode: 'dom-scroll',
      roomCount: rooms.length,
      rooms,
      runLog,
      screenshotBase64,
    };
  } catch (err) {
    log(`[scrape] fatal error: ${err.message}`);
    try { await browser.close(); } catch {}
    return {
      keyword,
      collected_at: new Date().toISOString(),
      mode: 'failed',
      error: err.message,
      roomCount: 0,
      rooms: [],
      runLog,
      screenshotBase64,
    };
  }
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

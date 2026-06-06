import { chromium } from 'playwright';

const TIKTOK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function newTikTokPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    userAgent: TIKTOK_USER_AGENT,
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });

  const page = await context.newPage();
  return { context, page };
}

export async function debugTikTokPage(keyword = 'battle') {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await newTikTokPage(browser);

  const url = `https://www.tiktok.com/search/live?q=${encodeURIComponent(keyword)}`;
  const responses = [];
  const requestFailures = [];

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

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await page.waitForTimeout(8000);
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(4000);
  } catch (error) {
    gotoError = String(error?.message || error);
  }

  const diagnostics = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const html = document.documentElement?.innerHTML || '';
    const links = Array.from(document.querySelectorAll('a')).slice(0, 50).map((a) => ({
      text: (a.innerText || '').slice(0, 120),
      href: a.href
    }));

    return {
      title: document.title,
      url: location.href,
      bodyTextLength: text.length,
      bodyTextSample: text.slice(0, 2500),
      htmlLength: html.length,
      anchorCount: document.querySelectorAll('a').length,
      links,
      flags: {
        hasLoginText: /log in/i.test(text),
        hasSearchLoginText: /log in to search/i.test(text),
        hasLiveText: /live/i.test(text),
        hasCaptchaText: /captcha|verify|robot/i.test(text),
        hasRoomText: /room/i.test(html),
        hasUniqueIdText: /unique_id|uniqueId/i.test(html)
      }
    };
  });

  const cookies = await context.cookies();
  const screenshot = await page.screenshot({ fullPage: true, type: 'png' });

  await browser.close();

  return {
    checked_at: new Date().toISOString(),
    keyword,
    requestedUrl: url,
    gotoError,
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
  const { page } = await newTikTokPage(browser);

  let requestsSeen = 0;
  let jsonResponses = 0;
  const discovered = [];

  page.on('response', async (response) => {
    try {
      requestsSeen++;

      const url = response.url();
      const type = response.headers()['content-type'] || '';

      if (!type.includes('json')) return;
      jsonResponses++;

      if (
        url.includes('monitor') ||
        url.includes('log') ||
        url.includes('analytics')
      ) return;

      const text = await response.text();

      let keys = [];
      let hints = [];

      try {
        const json = JSON.parse(text);
        keys = Object.keys(json).slice(0, 20);
      } catch {}

      for (const word of ['user','unique_id','nickname','room','live','owner','avatar','item_list','cursor']) {
        if (text.includes(word)) hints.push(word);
      }

      discovered.push({
        url: url.split('?')[0],
        size: text.length,
        keys,
        hints
      });

    } catch {}
  });

  await page.goto(`https://www.tiktok.com/search/live?q=${encodeURIComponent(keyword)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(5000);
  await page.mouse.wheel(0, 8000);
  await page.waitForTimeout(8000);

  const pageDiagnostics = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const anchors = Array.from(document.querySelectorAll('a')).slice(0, 80).map(a => ({
      text: (a.innerText || '').slice(0, 120),
      href: a.href
    }));

    return {
      title: document.title,
      url: location.href,
      bodyTextLength: text.length,
      bodyTextSample: text.slice(0, 3000),
      anchorCount: document.querySelectorAll('a').length,
      anchors
    };
  });

  await browser.close();

  return {
    keyword,
    collected_at: new Date().toISOString(),
    requestsSeen,
    jsonResponses,
    discoveredCount: discovered.length,
    discovered: discovered.slice(0, 40),
    pageDiagnostics
  };
}

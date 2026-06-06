import { chromium } from 'playwright';

export async function scrapeTikTokLive(keyword) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const captures = [];
  let requestsSeen = 0;
  let jsonResponses = 0;

  page.on('response', async (response) => {
    try {
      requestsSeen++;

      const url = response.url();
      const type = response.headers()['content-type'] || '';

      if (!type.includes('json')) return;

      jsonResponses++;

      const text = await response.text();

      if (
        url.toLowerCase().includes('live') ||
        text.includes('room') ||
        text.includes('LiveRoom') ||
        text.includes('user')
      ) {
        captures.push({
          url,
          size: text.length,
          sample: text.slice(0, 2000)
        });
      }
    } catch {}
  });

  const url = `https://www.tiktok.com/search/live?q=${encodeURIComponent(keyword)}`;

  await page.goto(url, {
    waitUntil: 'networkidle',
    timeout: 60000
  });

  await page.mouse.wheel(0, 5000);
  await page.waitForTimeout(5000);

  await browser.close();

  return {
    keyword,
    collected_at: new Date().toISOString(),
    requestsSeen,
    jsonResponses,
    capturesFound: captures.length,
    captures: captures.slice(0, 10)
  };
}

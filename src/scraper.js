import { chromium } from 'playwright';

export async function scrapeTikTokLive(keyword) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

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

      for (const word of ['user','unique_id','nickname','room','live','owner','avatar']) {
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
    waitUntil: 'networkidle',
    timeout: 60000
  });

  await page.mouse.wheel(0, 8000);
  await page.waitForTimeout(8000);

  await browser.close();

  return {
    keyword,
    collected_at: new Date().toISOString(),
    requestsSeen,
    jsonResponses,
    discoveredCount: discovered.length,
    discovered: discovered.slice(0, 40)
  };
}

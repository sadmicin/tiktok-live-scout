import { chromium } from 'playwright';

export async function scrapeTikTokLive(keyword) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1365, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

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

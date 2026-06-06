import { chromium } from 'playwright';

export async function scrapeTikTokLive(keyword) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const url = `https://www.tiktok.com/search/live?q=${encodeURIComponent(keyword)}`;

  await page.goto(url, {
    waitUntil: 'networkidle',
    timeout: 60000
  });

  await page.mouse.wheel(0, 3000);
  await page.waitForTimeout(3000);

  const data = await page.evaluate(() => {
    return window.__UNIVERSAL_DATA__ || null;
  });

  await browser.close();

  return {
    keyword,
    collected_at: new Date().toISOString(),
    raw_found: !!data,
    data
  };
}

import { chromium } from 'playwright';

function findCreators(obj, found = []) {
  if (!obj || typeof obj !== 'object') return found;

  if (obj.unique_id || obj.nickname || obj.room_id || obj.owner) {
    found.push({
      username: obj.unique_id || obj.owner?.display_id || null,
      nickname: obj.nickname || obj.owner?.nickname || null,
      room_id: obj.room_id || obj.id || null,
      followers: obj.follower_count || obj.owner?.follow_info?.follower_count || null,
      viewers: obj.user_count || obj.viewer_count || null
    });
  }

  for (const value of Object.values(obj)) {
    if (typeof value === 'object') findCreators(value, found);
  }

  return found;
}

export async function scrapeTikTokLive(keyword) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let requestsSeen = 0;
  let jsonResponses = 0;
  const endpoints = [];
  const creators = [];

  page.on('response', async (response) => {
    try {
      requestsSeen++;
      const url = response.url();
      const type = response.headers()['content-type'] || '';

      if (!type.includes('json')) return;
      jsonResponses++;

      if (
        url.includes('monitor_web') ||
        url.includes('starling') ||
        url.includes('abtest')
      ) return;

      const text = await response.text();

      if (
        url.includes('/api/search') ||
        url.includes('/webcast/') ||
        text.includes('unique_id') ||
        text.includes('nickname') ||
        text.includes('room_id')
      ) {
        endpoints.push({ url, size: text.length });

        try {
          const json = JSON.parse(text);
          creators.push(...findCreators(json));
        } catch {}
      }
    } catch {}
  });

  await page.goto(`https://www.tiktok.com/search/live?q=${encodeURIComponent(keyword)}`, {
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
    endpointsFound: endpoints.length,
    creatorsFound: creators.length,
    endpoints: endpoints.slice(0, 10),
    creators: creators.slice(0, 50)
  };
}

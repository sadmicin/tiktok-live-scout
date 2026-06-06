import fs from 'fs';
import { scrapeTikTokLive } from './scraper.js';
import { commitJsonToGitHub } from './githubLogger.js';

const keywords = ['push', 'battle', 'gaming'];

console.log('🚀 TikTok Live Scout starting');

let allResults = [];

for (const keyword of keywords) {
  console.log(`🔎 Starting keyword: ${keyword}`);

  const results = await scrapeTikTokLive(keyword);

  console.log(`✅ ${keyword}: collected`);

  allResults.push(results);
}

fs.mkdirSync('output', { recursive: true });
fs.writeFileSync(
  'output/latest.json',
  JSON.stringify(allResults, null, 2)
);

await commitJsonToGitHub(
  'logs/latest.json',
  {
    created_at: new Date().toISOString(),
    results: allResults
  },
  'Update latest scraper log'
);

console.log(`💾 Saved ${allResults.length} keyword results`);
console.log('DONE');

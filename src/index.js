import fs from 'fs';
import { scrapeTikTokLive } from './scraper.js';
import { commitJsonToGitHub } from './githubLogger.js';

const keywords = ['push', 'battle', 'gaming'];

const commitHash = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'unknown';

console.log('🚀 TikTok Live Scout starting');
console.log(`🔖 Commit: ${commitHash}`);

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
    commit: commitHash,
    results: allResults
  },
  'Update latest scraper log'
);

console.log(`💾 Saved ${allResults.length} keyword results`);
console.log('DONE');

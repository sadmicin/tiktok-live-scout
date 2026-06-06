import { scrapeTikTokLive } from './scraper.js';

const keywords = [
  'push',
  'battle',
  'gaming'
];

console.log('TikTok Live Scout starting...');

for (const keyword of keywords) {
  const results = await scrapeTikTokLive(keyword);
  console.log(keyword, results);
}

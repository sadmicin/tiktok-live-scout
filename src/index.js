import express from 'express';
import fs from 'fs';
import { scrapeTikTokLive, debugTikTokPage } from './scraper.js';
import { commitJsonToGitHub } from './githubLogger.js';

const keywords = ['battle'];
const commitHash = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'unknown';
const port = process.env.PORT || 3000;

let latestRun = null;
let latestDebug = null;
let isRunning = false;

async function runScrape() {
  if (isRunning) {
    console.log('⏭️ Scrape already running; skipping duplicate trigger');
    return latestRun;
  }

  isRunning = true;
  console.log('🚀 TikTok Live Scout starting');
  console.log(`🔖 Commit: ${commitHash}`);

  try {
    const allResults = [];

    for (const keyword of keywords) {
      console.log(`🔎 Starting keyword: ${keyword}`);
      const results = await scrapeTikTokLive(keyword);
      console.log(`✅ ${keyword}: collected`);
      allResults.push(results);
    }

    latestRun = {
      created_at: new Date().toISOString(),
      commit: commitHash,
      results: allResults
    };

    fs.mkdirSync('output', { recursive: true });
    fs.writeFileSync('output/latest.json', JSON.stringify(latestRun, null, 2));

    await commitJsonToGitHub('logs/latest.json', latestRun, 'Update latest scraper log');

    console.log(`💾 Saved ${allResults.length} keyword results`);
    console.log('DONE');
    return latestRun;
  } catch (error) {
    console.error('❌ Scrape failed:', error);
    latestRun = {
      created_at: new Date().toISOString(),
      commit: commitHash,
      error: String(error?.message || error)
    };
    return latestRun;
  } finally {
    isRunning = false;
  }
}

const app = express();

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    commit: commitHash,
    latestRunAt: latestRun?.created_at || null,
    isRunning
  });
});

app.get('/run', async (_req, res) => {
  const result = await runScrape();
  res.json(result);
});

app.get('/latest', (_req, res) => {
  res.json(latestRun || { status: 'no run yet', commit: commitHash });
});

app.get('/debug-page', async (_req, res) => {
  latestDebug = await debugTikTokPage('battle');
  const { screenshotBase64, ...json } = latestDebug;
  res.json(json);
});

app.get('/debug-screenshot', (_req, res) => {
  if (!latestDebug?.screenshotBase64) {
    return res.status(404).send('Run /debug-page first');
  }

  res.type('png').send(Buffer.from(latestDebug.screenshotBase64, 'base64'));
});

app.listen(port, () => {
  console.log(`🌐 Server listening on port ${port}`);
  runScrape();
});

import express from 'express';
import fs from 'fs';
import net from 'net';
import { scrapeTikTokLive, debugTikTokPage } from './scraper.js';
import { commitJsonToGitHub, commitImageToGitHub } from './githubLogger.js';

const keywords = ['Live'];
const commitHash = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'unknown';
const port = process.env.PORT || 3000;

let latestRun = null;
let latestDebug = null;
let isRunning = false;

function stamp() {
  return new Date().toISOString().replaceAll(':','-').replaceAll('.','-');
}

async function saveRunArtifacts(data, screenshotBase64) {
  const id = stamp();

  await commitJsonToGitHub('logs/latest.json', data, 'Update latest scraper JSON');
  await commitJsonToGitHub(`logs/runs/${id}/data.json`, data, 'Archive scraper JSON');

  if (screenshotBase64) {
    await commitImageToGitHub('logs/latest.png', screenshotBase64, 'Update latest scraper screenshot');
    await commitImageToGitHub(`logs/runs/${id}/screenshot.png`, screenshotBase64, 'Archive scraper screenshot');
  }
}

async function runScrape() {
  if (isRunning) return latestRun;

  isRunning = true;

  try {
    const allResults = [];
    let screenshotBase64 = null;

    for (const keyword of keywords) {
      const result = await scrapeTikTokLive(keyword);
      allResults.push(result);
      screenshotBase64 = result.screenshotBase64 || null;
    }

    latestRun = {
      created_at: new Date().toISOString(),
      commit: commitHash,
      results: allResults
    };

    fs.mkdirSync('output', { recursive: true });
    fs.writeFileSync('output/latest.json', JSON.stringify(latestRun, null, 2));

    await saveRunArtifacts(latestRun, screenshotBase64);

    return latestRun;
  } catch (error) {
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
  res.json({ status:'ok', commit:commitHash, latestRunAt: latestRun?.created_at || null, isRunning });
});

app.get('/run', async (_req, res) => res.json(await runScrape()));

app.get('/latest', (_req, res) => res.json(latestRun || {status:'no run yet'}));

app.get('/debug-page', async (_req, res) => {
  latestDebug = await debugTikTokPage('Live');

  await saveRunArtifacts(latestDebug, latestDebug.screenshotBase64);

  const { screenshotBase64, ...json } = latestDebug;
  res.json(json);
});

app.get('/debug-screenshot', (_req,res)=>{
  if (!latestDebug?.screenshotBase64) return res.status(404).send('Run debug first');
  res.type('png').send(Buffer.from(latestDebug.screenshotBase64,'base64'));
});

app.get('/proxy-test', (_req, res) => {
  const server = process.env.PROXY_SERVER || '';
  const [host, portStr] = server.split(':');
  const proxyPort = parseInt(portStr || '22225', 10);
  const username = process.env.PROXY_USERNAME || '';
  const password = process.env.PROXY_PASSWORD || '';
  const auth = Buffer.from(`${username}:${password}`).toString('base64');

  const result = { server, host, port: proxyPort, connectResponse: null, error: null };

  const socket = net.createConnection({ host, port: proxyPort }, () => {
    const req = [
      `CONNECT tiktok.com:443 HTTP/1.1`,
      `Host: tiktok.com:443`,
      `Proxy-Authorization: Basic ${auth}`,
      ``,
      ``
    ].join('\r\n');
    socket.write(req);
  });

  let data = '';
  socket.setTimeout(10000);
  socket.on('data', chunk => {
    data += chunk.toString();
    // First line of response is enough
    if (data.includes('\r\n')) {
      result.connectResponse = data.split('\r\n')[0];
      socket.destroy();
    }
  });
  socket.on('timeout', () => { result.error = 'timeout'; socket.destroy(); });
  socket.on('error', err => { result.error = err.message; });
  socket.on('close', () => res.json(result));
});

app.listen(port,()=>{
  console.log(`Server listening ${port}`);
  runScrape();
});

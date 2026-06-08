import express from 'express';
import fs from 'fs';
import net from 'net';
import { scrapeTikTokLive, debugTikTokPage } from './scraper.js';
import { commitJsonToGitHub, commitImageToGitHub } from './githubLogger.js';

const keywords = process.env.KEYWORDS
  ? process.env.KEYWORDS.split(',').map(k => k.trim()).filter(Boolean)
  : ['Live'];
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
  res.json({ status:'ok', commit:commitHash, latestRunAt: latestRun?.created_at || null, isRunning, keywords });
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

app.get('/report', (_req, res) => {
  if (!latestRun?.results?.[0]?.rooms?.length) {
    return res.status(404).send('No data yet — hit /run first');
  }
  const rooms = [...latestRun.results[0].rooms].sort((a, b) => b.viewers - a.viewers);
  const collected_at = latestRun.results[0].collected_at;

  const TIER_COLORS = { S: '#FFD700', A: '#C084FC', B: '#60A5FA', C: '#F97316', D: '#94A3B8' };
  function fmtNum(n) {
    if (!n) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }
  function engagement(r) {
    const total = r.totalViewers || 0;
    if (!total) return '0%';
    return (((r.comments || 0) + (r.shares || 0)) / total * 100).toFixed(1) + '%';
  }
  function engColor(r) {
    const total = r.totalViewers || 0;
    if (!total) return '#94a3b8';
    const e = ((r.comments || 0) + (r.shares || 0)) / total * 100;
    return e >= 5 ? '#4ade80' : e >= 2 ? '#facc15' : '#94a3b8';
  }

  const cards = rooms.map(r => {
    const battle = r.battle || {};
    const league = battle.league || '';
    const tierColor = TIER_COLORS[league[0]] || '#888';
    const score = battle.hostScore || battle.score;
    const leagueOverlay = league
      ? `<div class="league-overlay" style="border-color:${tierColor};color:${tierColor}">&#9876; ${league}${score ? ' &middot; ' + fmtNum(score) + ' pts' : ''}</div>`
      : '';
    const snap = r.streamSnapshotBase64 || '';
    const avatar = r.avatarBase64 || '';
    const initials = (r.nickname || r.username).slice(0, 2).toUpperCase();
    const avatarHtml = avatar
      ? `<img class="avatar-img" src="${avatar}" alt="">`
      : `<div class="avatar-circle">${initials}</div>`;
    const snapHtml = snap
      ? `<img class="snapshot" src="${snap}" alt="">`
      : `<div class="snapshot-placeholder"></div>`;
    const title = (r.title || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<div class="card">
      <div class="snapshot-wrap">${snapHtml}<div class="live-pill">&#9679; LIVE</div>${leagueOverlay}</div>
      <div class="card-body">
        <div class="card-top">${avatarHtml}<div class="creator-main">
          <a class="username" href="${r.liveUrl}" target="_blank">@${r.username}</a>
          <span class="nickname">${(r.nickname||'').replace(/</g,'&lt;')}</span>
        </div></div>
        <div class="stream-title">&ldquo;${title}&rdquo;</div>
        ${league ? `<div class="league-badge" style="border-color:${tierColor};color:${tierColor}">&#9876; League ${league}${score ? ' &middot; ' + fmtNum(score) + ' pts' : ''}</div>` : ''}
        <div class="stats-row">
          <div class="stat-box"><div class="stat-val">${fmtNum(r.viewers)}</div><div class="stat-lbl">Watching</div></div>
          <div class="stat-box"><div class="stat-val">${fmtNum(r.totalViewers)}</div><div class="stat-lbl">Total Views</div></div>
          <div class="stat-box"><div class="stat-val">${fmtNum(r.followers)}</div><div class="stat-lbl">Followers</div></div>
          <div class="stat-box"><div class="stat-val" style="color:${engColor(r)}">${engagement(r)}</div><div class="stat-lbl">Engagement</div></div>
        </div>
        <div class="bottom-row">
          <span class="comments-shares">&#128172; ${fmtNum(r.comments)} &nbsp; &#8618; ${fmtNum(r.shares)}</span>
          <a class="view-btn" href="${r.liveUrl}" target="_blank">Open Live &rarr;</a>
        </div>
      </div>
    </div>`;
  }).join('\n');

  const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TikTok LIVE Scout</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#08090a;color:#f0f0f0;padding:28px 20px}
header{max-width:1320px;margin:0 auto 32px;border-bottom:1px solid #1e1e1e;padding-bottom:20px}
.header-top{display:flex;align-items:center;gap:14px;margin-bottom:8px}
.logo{font-size:24px;font-weight:800;letter-spacing:-.5px}.logo em{color:#fe2c55;font-style:normal}
.badge{background:#fe2c55;color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;letter-spacing:.8px}
.meta{font-size:13px;color:#555}.meta strong{color:#888}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px;max-width:1320px;margin:0 auto}
.card{background:#111214;border:1px solid #1e2026;border-radius:14px;overflow:hidden;transition:border-color .15s,transform .15s}
.card:hover{border-color:#333;transform:translateY(-2px)}
.snapshot-wrap{position:relative;height:200px;background:#0c0d0f;overflow:hidden}
.snapshot{width:100%;height:100%;object-fit:cover;display:block}
.snapshot-placeholder{width:100%;height:100%;background:linear-gradient(135deg,#111 0%,#1a1a2e 100%)}
.snapshot-wrap::after{content:'';position:absolute;inset:0;background:linear-gradient(to bottom,transparent 40%,rgba(0,0,0,.75) 100%);pointer-events:none}
.live-pill{position:absolute;top:10px;left:10px;background:#fe2c55;color:#fff;font-size:11px;font-weight:700;padding:3px 9px;border-radius:5px;z-index:2}
.league-overlay{position:absolute;bottom:10px;left:10px;border:1px solid;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);border-radius:20px;padding:4px 10px;font-size:12px;font-weight:700;z-index:2}
.card-body{padding:14px 16px 16px}
.card-top{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.avatar-img{width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0}
.avatar-circle{width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#fe2c55,#25f4ee);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#fff;flex-shrink:0}
.creator-main{flex:1;min-width:0}
.username{font-size:14px;font-weight:700;color:#fff;text-decoration:none;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.username:hover{color:#fe2c55}
.nickname{font-size:12px;color:#666;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stream-title{font-size:13px;color:#888;font-style:italic;margin-bottom:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.league-badge{display:inline-flex;align-items:center;gap:6px;border:1px solid;border-radius:20px;padding:4px 12px;font-size:12px;font-weight:700;margin-bottom:12px}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}
.stat-box{background:#0c0d0f;border-radius:10px;padding:9px 4px;text-align:center;border:1px solid #1a1a1a}
.stat-val{font-size:15px;font-weight:800}.stat-lbl{font-size:10px;color:#555;margin-top:2px}
.bottom-row{display:flex;align-items:center;justify-content:space-between}
.comments-shares{font-size:12px;color:#555}
.view-btn{background:#fe2c55;color:#fff;text-decoration:none;padding:7px 14px;border-radius:8px;font-size:12px;font-weight:700}
.view-btn:hover{background:#d41f42}
</style></head><body>
<header>
  <div class="header-top"><div class="logo">TikTok <em>LIVE</em> Scout</div><span class="badge">LIVE</span></div>
  <div class="meta"><strong>${rooms.length} creators</strong> &nbsp;&middot;&nbsp; ${collected_at.replace('T',' ').split('.')[0]} UTC &nbsp;&middot;&nbsp; sorted by live viewers</div>
</header>
<div class="grid">${cards}</div>
</body></html>`;

  res.type('html').send(html);
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

# TikTok LIVE Scout — Roadmap

## In Progress / Next Up

### Image Storage via Cloudflare R2 ⚠️
- Image embedding is disabled (`GET_IMAGES=false`) until R2 is set up
- Code is in place in `src/scraper.js`, gated by `GET_IMAGES` env var
- Plan: upload snapshot + avatar to R2 per room, store permanent public URL instead of base64
- Overwrite by roomId each run so storage stays near zero, writes stay within free tier (~$2/month)
- Required env vars: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- Package needed: `@aws-sdk/client-s3` (R2 is S3-compatible)
- `/report` endpoint already handles both base64 and URL formats

### Pagination
- Currently returns ~25–30 creators per run (one page from `/api/search/live/full/`)
- Need to loop with `offset` param until results are exhausted or a max is hit
- Probably 100–200 creators per keyword is realistic before TikTok rate-limits

### Multi-keyword Support
- `keywords` array already exists in `index.js` but only has `['Live']`
- Add more keywords (e.g. `'battle'`, `'pk'`, category keywords) to surface different creator pools
- Deduplicate across keywords by username before storing

---

## Data & Storage

### Persistent Storage
- Right now data only lives in memory (lost on redeploy) and in GitHub log files
- Need a real database — lightweight options: SQLite via Railway volume, or Postgres (Railway has a native plugin)
- Schema: `creators`, `scrape_runs`, `scrape_appearances` (many-to-many)

### Change Tracking — League Over Time
- Once storage exists, track each creator's league rank per run
- Surface trends: "was C3 last week, now B1" = rising star worth recruiting
- Alert on rapid rank changes

---

## Recruit Intelligence

### Good / Bad Recruit Profile
- Define what "good" looks like: engagement rate thresholds, follower range, league tier, viewer consistency
- Define "bad": very low engagement despite high followers, declining league, erratic schedule
- Start with a simple rule-based score, then move to a learned model once enough labeled data exists

### League Rank Estimation (no battle required)
- League only appears when a creator is mid-battle — most runs show `battle: null`
- Train a simple model or rules using: followers, avg viewers, engagement rate, total views → predicted league tier
- Calibrate against creators where we *have* seen their actual league

---

## Recruit Funnel

### Creator Profiles
- Aggregate all appearances of a creator across runs into a single profile
- Store: first seen, last seen, avg viewers, peak viewers, league history, estimated tier

### Funnel Statuses
Statuses to track per recruit:
- `new` — first time seen, not yet reviewed
- `interested` — flagged by team for outreach
- `contacted` — outreach sent
- `in_talks` — responded, conversation active
- `joined` — signed to network
- `declined` — passed or ghosted
- `disqualified` — reviewed and ruled out

### Funnel UI
- Extend `/report` or add `/funnel` page
- Team can click a creator card and update their status
- Filter report by status (e.g. show only `new` + `interested`)
- Simple enough to be just a JSON file on disk initially, database later

---

## Nice to Have (Later)
- Scheduled auto-runs (cron) so data refreshes without manual `/run` calls
- Email/Slack digest when high-value new creators appear
- Creator deduplication across keyword searches
- Historical chart of a creator's viewer count over time

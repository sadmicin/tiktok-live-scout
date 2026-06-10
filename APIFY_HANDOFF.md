# Handoff: TikTok LIVE Scout → Apify Actor (TikTokLiveSearch)

This document hands off everything learned in the `tiktok-live-scout` (Railway) project
to a fresh start as an **Apify actor** in `sadmicin/TikTokLiveSearch`.

## Goal

Find TikTok LIVE creators by keyword search, matching the results of Apify's
`easyapi/tiktok-live-scraper` actor (benchmark: 85 rooms for "chill", 76 for
"vibes", 56 for "friends" in a single run; ~1000 rooms achievable across keywords).

Downstream (not built yet): persistent storage, recruit funnel, league change
tracking, multi-keyword scaling (~20 keywords).

## What to build

An Apify actor using the same stack easyapi uses:

- **`crawlee` + `PlaywrightCrawler`** with **headful Chromium** (Apify's base
  images handle Xvfb; use `apify/actor-node-playwright-chrome` Docker image)
- **`Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: 'US' })`**
  — residential proxy, sticky sessions handled by Crawlee's SessionPool
- **Input**: `{ "keywords": ["chill", "vibes", "friends"], "maxRooms": 100 }`
  via `Actor.getInput()` with an `input_schema.json`
- **Output**: `Dataset.pushData(room)` per room
- Deploy with `apify push` (CLI), or link the GitHub repo in Apify Console

## The core scraping recipe (proven by easyapi's run log)

1. Navigate to `https://www.tiktok.com/search/live?q=<keyword>`
2. Intercept responses to `/api/search/live/full/` — each returns ~12 raw room
   objects in `data[]` with `has_more` flag
3. Scroll the page (`page.mouse.wheel`) — each scroll fires another API page
4. Continue until `has_more=0` or no new rooms after ~3 scrolls
5. No TikTok auth/login needed **when the IP is trusted** (residential, warm)

## Hard-won lessons (do not relearn these)

### Rendering / environment
- **Headful Chromium is mandatory.** Headless or Firefox (Camoufox) gets a
  blank page (`bodyLen=0`) or the gated variant. easyapi runs headful under Xvfb.
- Pin Playwright version to exactly match the Docker base image's installed
  browser (we lost a day to `^1.52.0` resolving to 1.60.0 → missing `chromium-1223`).
  On Apify this is handled if you use their playwright-chrome base image and its
  matching `crawlee`/`playwright` versions.
- Spoof: `navigator.webdriver=undefined`, realistic UA (Chrome/124 Win64),
  `locale: en-US`, `timezoneId: America/New_York`, viewport 1920x1080,
  `--disable-blink-features=AutomationControlled`. Crawlee's fingerprint
  injection does most of this automatically — prefer it over manual spoofing.

### The login modal ("Log in to search for popular content")
- Appears on cold/low-trust IPs; on a good residential IP the grid renders
  with **no modal at all** (we observed this once with Apify proxy).
- **Pressing Escape or clicking Close bounces the SPA to `/search/user`** —
  the search silently turns into a Users search and `/api/search/live/full/`
  never fires. This was our #1 silent failure mode.
- DOM-removing the modal (`#loginContainer` etc. via `page.evaluate`) avoids
  the bounce but the underlying live search still doesn't populate — the page
  serves only `/api/search/user/preview/` requests. **If the modal shows up,
  the session/IP is already burned for live search. Retire the session and
  retry with a new proxy session instead of fighting the modal.** Crawlee's
  `session.retire()` + `maxErrorScore` is the right tool.

### Proxy & cost
- Residential proxy quality is the main determinant of whether the grid renders.
  Datacenter/cold rotating IPs (IPRoyal rotating) triggered the modal almost always.
- **Block images/media/fonts by `resourceType` only** to cut ~85% of proxy GB
  (16 of 18 MB in our test runs was TikTok CDN images).
  **Never block by hostname** — TikTok serves its JS bundles from the same
  `tiktokcdn` hosts; hostname blocking blanks the page entirely.
- Warm the session first: load `https://www.tiktok.com/` homepage, wait ~4s,
  confirm `ttwid` cookie exists, then go to the search URL.

### Fallback API (worked when scroll didn't): webcast hashtag endpoint
When scroll/intercept yields zero, `page.evaluate(fetch)` from the page context
(browser cookie jar included automatically) against:

```
https://webcast.tiktok.com/webcast/hashtag/anchor/?hashtag_name=<kw>&offset=<cursor>&count=30&type=0&aid=1988&device_platform=web_pc&app_name=tiktok_web&channel=tiktok_web&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=en-US&browser_platform=Win32&browser_name=Mozilla&region=US&tz_name=America/New_York
```

- Sign URL with `window.byted_acrawler.frontierSign(url)` if present
  (append `X-Bogus` / `_signature` params); unsigned often still works.
- Response: `data.anchor_list[]`, paginate via `data.cursor` + `data.has_more`.
- Room schema differs from web search: user under `room.user|anchor|owner`
  (`uniqueId`/`unique_id`/`display_id`), room info under `room.room_info`.
- This got us 53 rooms across 3 keywords when the scroll path got 0.
- Secondary fetch in the same style against `/api/search/live/full/` with full
  browser params + `msToken` cookie can add more. Paginate by server cursor,
  not `page*30`.

### Room object schema (web search API `/api/search/live/full/` items)
Each item in `data[]` → `item.live_info` (varies); we extracted:
`roomId, owner.uniqueId (username), owner.nickname, title, user_count (viewers),
stats.totalUser, owner follower count, avatarThumb, cover, liveUrl =
https://www.tiktok.com/@<username>/live`.
The easyapi dataset JSON (user has a copy) is the schema benchmark.

## Old repo reference

`sadmicin/tiktok-live-scout` — main branch has the full history. Key commits:
- `f2a105f` clean rebuild (scroll-only — this path never got rooms standalone)
- `ddff3b5` webcast hashtag API fallback (the version that actually got rooms)
- `50e5c72` final state: Apify proxy sticky sessions, DOM modal removal,
  resourceType media blocking, api-probe logging

## Suggested actor structure

```
.actor/actor.json          # actor config
.actor/input_schema.json   # keywords[], maxRooms, proxy override
Dockerfile                 # FROM apify/actor-node-playwright-chrome:20
package.json               # apify, crawlee, playwright (matching versions)
src/main.js                # Actor.main: PlaywrightCrawler, one request per keyword
src/scrape.js              # page handler: warm, navigate, intercept, scroll, webcast fallback
```

Key crawlee settings: `headless: false`, `useSessionPool: true`,
`persistCookiesPerSession: true`, `maxRequestRetries: 3`,
`preNavigationHooks` for the resourceType blocking,
retire session when login modal detected.

# invest-dashboard

[中文说明](README.zh-CN.md)

Personal watchlist page. Live quotes are colored by the valuation bands from my own research reports, so one glance says whether a name sits in its entry zone, fair range, or exit signal. Sister project: [etf-ai-analyst](https://github.com/yuuteng/etf-ai-analyst).

Live: https://invest-dashboard-snowy.vercel.app/

![Screenshot](docs/screenshot.jpg)

## What it shows

- Quotes from Boursorama (Paris names in real time), with Yahoo as fallback. A badge marks delayed or stale values.
- Each instrument is placed on its band: 🟢 below the entry price, 🔵 fair, 🟡 rich, 🔴 exit signal raised.
- Rows expand into a Boursorama-style chart (1D to 10Y) with a rolling MA200 on the longer windows.
- Per-name technicals: distance to the 52-week high, gap to MA200, RSI(14).
- Earnings date badge for stocks, turning yellow within two weeks and red once the date has passed.
- A holdings panel computes unrealised and daily P&L. Quantities and cost basis live only in the browser's localStorage and can be exported as JSON.

## How it works

| Path | Purpose |
|------|---------|
| `index.html` | The whole UI. Polls `/api/quotes` every 15 s and reads bands from `bands.json` |
| `bands.json` | The data: instruments, entry and exit thresholds, watch notes, report names, next earnings date |
| `api/quotes.js` | Vercel function. Scrapes Boursorama quote pages server-side, falls back to Yahoo, 15 s CDN cache |
| `api/history.js` | Price history for the charts (intraday and daily) |
| `api/indicators.js` | Daily indicators: 52-week high, MA200, RSI(14). One-hour CDN cache |
| `scripts/dev_server.js` | Local server that mimics the Vercel routes |

## Deploy

Import the repo in Vercel with framework set to Other. Every push to `main` redeploys.

## Updating bands

When a research report is refreshed, edit the matching entry in `bands.json` (`green`, `strong`, `yellow`, `axis`, `watch`, `report`, `earnings`), bump `updated`, commit and push. A `null` band shows the price without coloring.

## Running locally

```sh
node scripts/dev_server.js
```

Open http://localhost:8899/.

## Disclaimer

Research and education only, not investment advice. Quotes may be delayed. Bands reflect my personal research as of the noted date.

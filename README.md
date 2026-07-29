# invest-dashboard

Personal watchlist dashboard: live-ish quotes (Boursorama primary, Yahoo fallback) colored by valuation bands taken from my own research reports (sister project: [etf-ai-analyst](https://github.com/yuuteng/etf-ai-analyst)).

个人看盘页:行情来自 Boursorama(巴黎股实时,失败时 Yahoo 补位),价格自动落入研究报告给出的价位带并着色——🟢 偏低可入场 / 🔵 合理 / 🟡 偏高 / 🔴 信号离场。

## How it works

- `index.html` — static page, polls `/api/quotes` every 15s, reads bands from `bands.json`
- `api/quotes.js` — Vercel serverless function: scrapes Boursorama quote pages server-side (no CORS in browser), falls back to Yahoo v8 chart per symbol, 15s CDN cache
- `bands.json` — the "database": instruments + entry/exit thresholds + watch notes; updated whenever a research report is refreshed, `git push` = redeploy

## Deploy

Import this repo in Vercel (Framework: Other, zero config). Done.

## Disclaimer

Research/education only, not investment advice. Quotes may be delayed; bands reflect my personal research at the noted date.

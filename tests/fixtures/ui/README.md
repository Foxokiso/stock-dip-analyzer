# Browser regression fixtures

Recorded provider responses for `scripts/verify-ui.mjs` and `scripts/verify-alerts.mjs`. The scripts serve them through a stub of the desktop bridge (`window.dipAnalyzer.invoke`), each under the exact request the app makes for it; nothing here reaches a runtime view.

- `finviz-losers-r1-2026-10-31.html` is the live `https://finviz.com/screener/stocks?v=111&o=change&r=1`, the Overview's first page (200, no redirect), retrieved on 2026-10-31 at 08:05 UTC with the app's browser headers: the 20 biggest losers of the 2026-10-30 session, `#1 / 5620 Total`. It is trimmed to the result count line and the grid; scripts, styles, style attributes, logo images and icons were removed and the kept markup is unchanged. The app's parser reads the same 20 rows, row numbers and total from it as from the full page.
- `yahoo-chart-PTHS-1mo-2026-10-30.json` and `yahoo-chart-CETX-1mo-2026-10-30.json` are verbatim Yahoo v8 chart responses for two of those rows, recorded with curl at the app's URL (`range=1mo&interval=1d`) and headers on 2026-10-31 at 08:05 UTC. Both quotes are the 2026-10-30 close (`regularMarketTime` 20:00 UTC) and both closes sit at a one-month breakdown. `verify-alerts.mjs` sets the browser clock two minutes after that close, when the app judges the recorded quotes fresh, and six minutes after it, when it judges them stale.

The stock-page checks reuse `../yahoo-chart-AAPL-1mo-2026-10-30.json`, `../yahoo-chart-PLUG-1mo-2026-10-30.json` and `../finviz-quote-AAPL-2026-10-31.html`.

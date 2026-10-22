# Market data test fixtures

`futures-reference.json` is a recorded response from Finviz's public `api/futures_all?timeframe=i5` endpoint, retrieved on 2026-10-11 UTC (2026-10-10 New York). It contains 59 actual reference instruments; sparklines retain the final 60 source samples and sparse chart labels are omitted. It is a regression fixture, never a runtime market source or a current quote reference.

Browser checks deliberately stub desktop IPC with this recorded response to verify filtering, precision, source labeling, and cached failures. A separate live source probe verified the actual endpoint and schemas. Native tests also use controlled invalid and boundary inputs to reproduce failure cases.

`finviz-overview-grid-2026-10-17.html` and `finviz-overview-grid-2026-10-21.html` are the live `screener.ashx?v=111&o=change` ARIA grid, trimmed to the header row and two quote rows (scripts, styles and icons removed, markup otherwise untouched). The 10-21 capture is the one where header cells gained an `aria-label`, a short-label span and a sort indicator, and ticker cells gained `data-ticker`. `node scripts/verify-finviz-live.mjs` checks the live views against the parser whenever Finviz is suspected to have changed again.

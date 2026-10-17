# Futures and data integrity implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the owned tasks. The user authorizes completion; proceed without repeated permission requests.

**Goal:** Deliver a modern Finviz futures desk and trustworthy market views.

**Architecture:** Keep the existing React/Vite/Electron application and IPC. Isolate pure source parsing and validation from presentation; preserve existing navigation and technical scoring with honest data provenance.

**Tech stack:** React 19, Electron, Vite, native Node tests, linkedom for HTML parser regression tests.

**Spec:** ../specs/2026-10-10-futures-integrity.md

## Global constraints

- Real retrieved data only; no synthetic market values in runtime views.
- Finviz futures disclosure: conservative 20-minute source delay; source quote time unknown when absent.
- Financial numbers must be finite; absent data remains null. Preserve native futures units.
- Every request has a bounded timeout. Refresh races and unmounts cannot overwrite current data.
- No merge to master or publication. Deliver branch and draft PR.

## Review focus

- Unknown source timestamps must not be replaced with fetch time.
- Partial failures must not make prior quotes appear current.
- Previous daily bar depends on the quote session, especially weekends/market closures.
- Nested layout table cells must never be parsed as screener rows.
- Slow refresh and chart range changes must preserve consistent data/score attribution.

## Task 1: Stock analysis integrity (data_audit)

Own Dashboard.jsx, StockDetails.jsx, scoring.js, format.js, marketData.js, and their tests.

- [ ] Reproduce bad null/finite-value handling and session baseline selection with failing native tests.
- [ ] Implement `getYahooQuote(result, {fetchedAt})` and finite numeric helpers; share the interface with task 2.
- [ ] Remove runtime mocks, default scores, random alert text, and obsolete claims. Use Finviz as the primary screener through task 2's `parseFinvizScreener(html)`.
- [ ] Keep score period fixed at one month while chart display range changes; preserve source quote time and prevent stale async writes.
- [ ] Run owned tests and report integration limitations.

## Task 2: Context views and Finviz parsing (ui_audit)

Own MarketPulse.jsx, OilWatch.jsx, Discovery.jsx, ETFAwards.jsx, finviz.js and parser tests.

- [ ] Reproduce nested-row ticker corruption with a failing fixture-based test using linkedom.
- [ ] Implement `parseFinvizScreener(html)` returning actual v111 rows: symbol/name/sector/price/changePercentage/volume/marketCap plus source/fetchedAt metadata. Use exact direct-cell shape and validated financial values.
- [ ] Remove all mock values and headlines. Show source, delay/unknown delay, quote time, and retained stale data honestly.
- [ ] Fix overlap/unmount guards and TradingView script lifecycle; display ETF ranking criteria correctly.
- [ ] Run owned parser/data tests and report results.

## Task 3: Futures source integration (futures_research)

Own futures.js and futures.test.js.

- [ ] Add failing tests using actual Finviz API shape, page fallback, malformed input, bond decimal fractions, no IPC, and partial/cached failures.
- [ ] Export `FUTURES_GROUPS`, `FUTURES_TIMEFRAMES`, and `fetchFinvizFutures(ipcRenderer, {timeframe='i5', previous=null, now})`.
- [ ] Return snapshot status/quotes/fetchedAt/attemptedAt/quotedAt/delayMinutes/sourceUrl/error; each quote includes symbol/name/group/price/changePct/change/high/low/sparkline/status/sourceUrl, with unknown expiry and quote time null.
- [ ] Never synthesize charts. A failed row can retain prior values only as cached with its original retrieval time.
- [ ] Run all owned tests and a live endpoint check.

## Task 4: Futures desk and application shell (root)

Own App.jsx, index.css, App.css, Futures.jsx, main.cjs, LiveAlerts.jsx, package files, documentation, and verification scripts.

- [ ] Implement a modern responsive shell with active navigation, visible source/delay context, and Futures route.
- [ ] Consume task 3 snapshot in the futures desk; category/search filters, actual chart data, honest refresh/error states, no layout wipe on refresh.
- [ ] Bound IPC network requests and enable default accelerated rendering. Reduce global panel blur/animated row overhead; respect reduced motion.
- [ ] Fix alert audio lifecycle if investigation confirms leakage.
- [ ] Run native tests, lint, renderer build, browser smoke tests, and live-source probes. Review all tasks with a fresh agent, fix material findings, and deliver branch/draft PR.

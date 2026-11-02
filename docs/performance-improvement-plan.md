# Performance improvement report and agent methodology

This is a source-based opportunity review, not a benchmark report. The findings below are hypotheses to measure on low-budget and modern systems before expanding the work. No market-data fidelity, refresh, stale-data, or timestamp behavior should be traded for speed.

## Ten opportunities

Ranked by expected user benefit relative to implementation effort. Ratings are qualitative pending measurements; “high” is not a measured speedup.

| # | Opportunity | Evidence in this codebase | Expected impact / effort |
|---|---|---|---|
| 1 | Share identical in-flight Yahoo chart requests. | `src/utils/chartCache.js` previously cached completed responses only; concurrent misses could call the provider independently. Implemented here; completed-response TTL behavior remains unchanged. | Medium when calls overlap / Low |
| 2 | Aggregate Overview summary tiles in one pass. | `src/pages/Dashboard.jsx` traverses `stocks` separately for known changes, buy signals, low scores and scored rows, then scans it again for the deepest dip. | Low-to-medium on each scan update / Low |
| 3 | Reduce repeated Overview snapshot allocation during scan progress. | `scanScreener` in `src/state/scanStore.js` rebuilds `shown`, filters prior rows, counts retained rows, and creates a new published array on page and score flushes. | Medium for deep scans / Medium |
| 4 | Measure and reduce repeated full-list sorting during hydration. | `src/pages/Dashboard.jsx` filters and sorts all current scan rows whenever the `stocks` snapshot changes, although only up to 100 rows are rendered initially. | Medium for depth 250–500 / Medium |
| 5 | Publish Market Pulse quotes as each ticker finishes. | `src/components/MarketPulse.jsx` waits for every ticker in `Promise.all` before publishing any successful update; one slow quote delays the other fresh quotes. | Medium for perceived refresh latency / Low-to-medium |
| 6 | Benchmark Finviz parsing and avoid redundant per-row DOM queries where safe. | `src/utils/finviz.js` queries/sorts grid cells per row and binds fields while parsing each table. Preserve its schema-change checks and accessibility-grid support. | Medium on large/changed pages / Medium |
| 7 | Reduce Oil Watch state-update/render churn without delaying its first results. | `src/pages/OilWatch.jsx` receives bounded results through `mapPool` but calls `setBasket` once per settled symbol. | Low-to-medium on slower CPUs / Low-to-medium |
| 8 | Profile Stock Details chart transforms and keep expensive work memoized. | `src/pages/StockDetails.jsx` already memoizes closes, technical analysis, SMA series, plot data and axes; profile range changes and large chart responses before adding more caching. | Uncertain; measure first / Low |
| 9 | Profile sparkline generation on the Overview and Market Pulse. | `src/pages/Dashboard.jsx` and `src/components/MarketPulse.jsx` build SVG point strings from close arrays; repeated work may matter on constrained CPUs, but current series are bounded. | Low / Low-to-medium |
| 10 | Measure cache memory by bytes, not just entry count. | `src/utils/chartCache.js` bounds completed responses at 1,500 entries, but chart response sizes can differ substantially. Consider byte accounting only if heap traces show the cache is material. | Uncertain memory benefit / Medium |

## Recommended agent/model workflow

1. **Establish a baseline.** On each supported reference machine, capture cold launch to first usable desk, scan time to first row and first scored row, full-scan completion, refresh time, renderer main-thread long tasks, and peak renderer memory. Record OS, CPU, RAM, display scale, app build, scan depth, selected desk, and whether the run is cold or warm.
2. **Profile the actual bottleneck.** Use representative production builds and the same workload; use deterministic recorded fixtures only for repeatable correctness/performance comparisons. Keep live-provider latency separate from local CPU/render time. Do not infer app speed from a microbenchmark alone.
3. **Propose one small change at a time.** An agent must name the suspected hot path, explain why low-end systems benefit, list fidelity/UX invariants, estimate effort, and add a test that would fail without the change. Avoid speculative broad rewrites and changing request concurrency without measurements.
4. **Preserve data integrity.** Compare row identities, score values, quote and retrieval timestamps, source labels, stale/cached notices, unavailable states, and alert behavior before and after. Faster results must not be synthetic, less fresh, silently stale, rounded differently, or missing.
5. **Validate across tiers.** Repeat the workload on a low-budget reference system and a modern reference system. Report median and p95 timings plus request counts and memory; repeat enough times to distinguish noise. A suggested promotion gate is a repeatable improvement in the targeted metric with no meaningful regression elsewhere and exact correctness parity.
6. **Keep the change reviewable.** Run targeted tests during iteration, then `npm run verify`; use the native parity suites if a mirrored module changes. Include workload, before/after numbers, variance, and limitations in the PR. If evidence is inconclusive, keep the optimization behind a measured decision rather than claiming a win.

## Prioritization poll

Vote for the next investigation by checking one option in a PR comment. The current PR implements the first option's narrowly scoped request coalescing; this poll is for what to profile or improve next.

- [ ] Overview's repeated scans, snapshots and sorting
- [ ] Market Pulse first-quote latency when one ticker is slow
- [ ] Finviz parser CPU cost on full screener pages
- [ ] Oil Watch render churn while quotes arrive
- [ ] Measure low-budget hardware baselines before selecting another change

The last option is recommended if no representative low-budget baseline exists. Votes identify investigation priority, not permission to change freshness, fidelity, or data-integrity behavior.

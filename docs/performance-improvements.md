# Performance improvement report and agent methodology

## Summary

This is a code-based opportunity review, not a benchmark report. The repository
already has several important performance protections: shared bounded scan
request slots, concurrent page loading, progressive score hydration and
120 ms score batches, a 100-row initial Overview view, optional chart-response
TTL caching, hidden-window refresh pausing, and idle-time loading of the stock
page. Avoid duplicating or weakening those mechanisms.

The highest-impact, lowest-effort next step is in place: identical Yahoo chart
requests now share the same **in-flight** request. This reduces redundant
provider work and lets an Overview scan, Oil Watch, and Stock Details join an
already-running request for the same symbol/range/interval. It does not turn on
the optional persistent TTL, reuse a completed response when TTL is zero, or
change the source quote/retrieval timestamps. A failure is shared only by the
overlapping callers; a later call can retry normally.

The improvements below are qualitative hypotheses from code inspection. No
before/after latency or memory numbers are claimed. Measure each candidate
before widening its scope.

## Ten opportunities

| # | Improvement | Expected benefit | Effort | Evidence and constraints |
|---|---|---|---|---|
| 1 | **Coalesce identical in-flight Yahoo chart requests** — implemented in this PR. | Avoid duplicate network waits and provider requests across concurrent scans and desks. | Low | `src/utils/chartCache.js` is shared by `src/state/scanStore.js`, `src/pages/OilWatch.jsx`, and `src/pages/StockDetails.jsx`. Join only identical symbol/range/interval requests; keep sequential TTL-zero calls fresh. |
| 2 | Coalesce identical in-flight Finviz URL requests across overlapping scans/desks. | Avoid duplicate fetch and parse work when independent consumers ask for the same page at once. | Low–medium | Overview scopes can overlap at their first screener pages (`src/state/scanStore.js`); ETF rankings independently fetch three pages (`src/pages/ETFAwards.jsx`). Preserve each response's actual retrieval time and do not cache completed responses without an explicit freshness policy. |
| 3 | Reuse normalized Yahoo chart points/quote projections for one response on Stock Details. | Reduce repeat date conversion, sorting, and array allocation on the detail page. | Low–medium | The chart and technical effects can fetch the same one-month response and independently call `getYahooChartPoints` (`src/pages/StockDetails.jsx`, `src/utils/marketData.js`). Keep quote and retrieval metadata attached to the correct response. |
| 4 | Batch Oil Watch quote-state commits into short flush windows. | Reduce React reconciliation while preserving progressive row arrival. | Medium | `src/pages/OilWatch.jsx` calls `setBasket` as each item in a bounded pool settles. Compare a short, bounded batch with the current per-row updates; never wait for the full basket before showing results. |
| 5 | Derive Overview summary tiles in one pass over the stocks. | Remove repeated full-array filters/reductions for counts and the average. | Low | `src/pages/Dashboard.jsx` computes known changes, buy signals, low scores, scored count, and deepest dip separately. Keep every tile's null/unknown and strict-negative semantics identical. |
| 6 | Measure and tune Overview score publication cadence for large scans. | Balance time-to-first-useful-row against repeated rendering on slower CPUs. | Medium | The store publishes score batches on `FLUSH_MS` while the table filters/sorts in response to changed `stocks` (`src/state/scanStore.js`, `src/pages/Dashboard.jsx`). Test realistic 500-row scans; do not merely increase the delay to improve a single aggregate metric. |
| 7 | Bound the chart cache by approximate bytes as well as entry count. | Limit memory spikes when cached response sizes vary, especially on memory-constrained machines. | Medium | `src/utils/chartCache.js` caps entry count at 1,500, but response payloads are variable-sized. Preserve the existing user-selected TTL and make eviction cause a fresh request, never a partial or altered quote. |
| 8 | Profile and reduce repeated Dashboard filter/sort work during score updates. | Reduce main-thread work and improve input responsiveness while a large scan hydrates. | Medium–high | `displayStocks` is memoized, but its `stocks` dependency changes as score batches publish (`src/pages/Dashboard.jsx`, `src/state/scanStore.js`). First measure long tasks and sort cost; consider stable row identities or incremental indexing only if the profile warrants the added complexity. |
| 9 | Profile data-page renders and only virtualize lists that prove expensive. | Reduce DOM/layout work on slower systems if a view grows beyond its current small result set. | Medium | Discovery and ETF rankings currently cap results at 20 and 10 rows per category; the Overview initially renders 100 rows and reveals more on request. Do not add virtualization or remove visible data without evidence and keyboard/screen-reader parity. |
| 10 | Add a repeatable low-end performance smoke profile to the verification process. | Catch regressions and make future optimization choices comparable across agents. | Medium | `npm run verify` covers tests, lint, build and browser regressions, but no performance budgets are currently reported. Keep timings informational until stable baselines exist; never replace fidelity and correctness tests with speed-only checks. |

## Methodology for agents and models

Use this sequence for each proposed performance change:

1. **State a falsifiable hypothesis.** Name the user action, code path, target
   device constraint, expected bottleneck, and measurable outcome. Distinguish
   observed evidence from inference; do not label an unprofiled path “slow.”
2. **Capture a baseline before editing.** Record app build, OS, CPU/RAM class,
   display scale, power mode, settings, network conditions, and whether caches
   are cold or warm. On a constrained reference device, repeat each scenario at
   least five times and report median and p95, not only the best run. A
   2-core/4-GB reference profile is a useful proposed starting point when such a
   device is available, not a claim that it represents every budget computer.
3. **Measure user-facing and resource costs together.** For the same fixed
   action, capture time to first useful row, time to completion, click-to-route
   readiness, main-thread long tasks, peak memory, request count, and bytes.
   Keep cold-start, warm-cache, and refresh paths separate. Use the existing
   recorded fixtures only in tests; do not show fixture or synthetic quotes in
   the running app.
4. **Change one cause at a time.** Keep a before/after record and the smallest
   targeted regression test. Avoid speculative workers, broad memoization,
   larger concurrency, or new dependencies until a profile shows they address
   the measured bottleneck.
5. **Prove fidelity is unchanged.** For identical provider/fixture input,
   compare the complete meaningful output: symbol ordering where specified,
   numeric values, missing-value behavior, scores, quote times, retrieval
   times, errors, stale/cached notices, and accessibility behavior. Performance
   work must not discard rows, reduce chart/history fidelity, fabricate
   values, or relabel retrieval time as quote time.
6. **Set a review gate before implementation.** Keep the change only when it
   improves the stated user-facing metric or removes demonstrably redundant
   work, while all exact-output and regression checks pass. Report regressions
   and trade-offs, including a neutral result; do not hide them behind an
   average.
7. **Finish with repository checks.** Run the smallest targeted tests first,
   then `npm run verify` for a complete change. Describe the data, device, and
   limitations of any benchmark in the PR; do not generalize one machine's
   result to all low-cost hardware.

## Poll for the next debate

Vote in the PR discussion with **one number** and add the device or user-facing
symptom that should get priority. This lightweight reply poll is for choosing
the next experiment; it does not claim that a native GitHub poll has been
created.

1. Finviz in-flight request coalescing.
2. Low-end scan/render batching and concurrency measurements.
3. Reusing normalized chart data and other measured CPU work.
4. Memory-bounded chart caching.
5. First establish a shared low-end benchmark profile before another runtime
   change.

Discuss the trade-offs before choosing an implementation. The aim is faster
responses on modest hardware without reducing the app's data or analytical
fidelity.

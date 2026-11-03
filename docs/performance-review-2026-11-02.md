# Performance review — 2026-11-02

## Summary

The renderer already has useful performance safeguards: the Overview bounds initial table rendering to 100 rows, score hydration is streamed in batches, data requests are concurrency-limited, recurring work pauses when a window is hidden, and the stock page is split into an idle-warmed chunk. The main remaining risk on budget hardware is work repeated while an Overview scan progressively updates, followed by rendering all rows when someone explicitly selects **Show all**.

No representative low-end device trace was available for this review. The rankings below are evidence-based hypotheses, not claimed benchmark wins; run the measurement protocol before taking on larger changes. The first low-effort summary optimization has since landed on `master`; this pull request tackles the next low-effort opportunity with a regression test and preserves all displayed values.

The stock page loads its selected chart and fixed one-month technical history independently; at its default one-month range, both request the same Yahoo chart. Sharing only that in-flight read avoids duplicate provider work without changing completed-cache TTL behavior or sequential freshness. The implementation is isolated by invoke function so scan-scope priority and cancellation remain independent. Row virtualization has higher potential UI impact, but requires a larger accessibility-sensitive change and should follow a low-end-device trace.

## Ten opportunities, ranked

| Rank | Opportunity | Expected impact / effort | Evidence and fidelity guard |
|---|---|---|---|
| 1 | Virtualize the Overview after **Show all** (and consider a larger-than-100 cap) while preserving the full sorted result, keyboard navigation, expanded rows, and accessible row counts. | High / Medium–High | `src/pages/Dashboard.jsx:378-388, 577-581` initially renders 100 rows but lets the user render every match; each row includes multiple cells and an SVG sparkline. Measure scroll and interaction latency at 250 and 500 rows. Never drop records or change sort/filter results. |
| 2 | Keep Overview summary metrics to one traversal of the current stocks. | Low–Moderate / Low | `src/pages/Dashboard.jsx:394-405` used multiple `filter`, `reduce`, and intermediate-array passes; streamed scan publications can run this work repeatedly. Already implemented on `master` in `src/utils/dashboardStats.js`, with behavior tests. |
| 3 | Avoid rebuilding filtered and sorted dashboard results when a score update changes only a row outside the active view; consider incremental indexes only if profiling justifies their complexity. | Moderate / Medium–High | `src/pages/Dashboard.jsx:362-374` filters and sorts the full stock list whenever the scan publishes new stock state. Any incremental approach must exactly preserve null ordering, search, rating rules, and sort stability. |
| 4 | Coalesce concurrent Yahoo chart requests for identical symbol/range/interval keys within the same invoke context. | Low–Moderate / Low | `src/utils/chartCache.js:14` caches completed responses but does not track in-flight requests; `src/pages/StockDetails.jsx` loads the selected chart and technical series independently. Keep sequential requests fresh when cache TTL is zero, preserve provider errors, and do not merge distinct scan scopes. |
| 5 | Reduce repeated sort-key extraction/comparison work in the Overview. | Low / Low | `src/pages/Dashboard.jsx` sorts in `sortStocks` and comparator accessors repeatedly read nested values. A decorate-sort-undecorate variant is easy to compare at 100/500 rows, but should ship only if the trace shows sorting is material. |
| 6 | Profile and trim repeated DOM queries during multi-page Finviz parsing. | Moderate / Medium | `src/utils/finviz.js` repeatedly selects and filters rows/cells while parsing screener pages. Compare parser timings on the recorded 20-row and 250-row scans before restructuring; parser output must remain byte-for-byte equivalent on fixtures. |
| 7 | Combine related quote counts and summary aggregates into one pass on the Futures desk. | Low / Low | `src/pages/Futures.jsx:131-133` filters available quotes, then filters them again for advancing and declining counts. Verify unavailable and flat instruments retain their current treatment. |
| 8 | Measure cross-desk request contention and align live quote work with the shared request budget where appropriate. | Moderate / Medium | Overview has shared page/chart limiters (`src/state/scanStore.js`); Market Pulse sends one concurrent request per ticker (`src/components/MarketPulse.jsx:55`). Any shared limiter must not delay priority user-visible work or suppress its live refresh semantics. |
| 9 | Profile expensive page-derived chart series and keep derived calculations keyed to their source data. | Low–Moderate / Medium | `src/pages/StockDetails.jsx` already memoizes several chart calculations; verify whether any remaining series work repeats on unrelated renders before adding more memoization. Preserve every data point and chart domain. |
| 10 | Measure renderer startup and idle memory before changing chunk warm-up or page loading. | Potentially High / Medium | `src/App.jsx` ships most desks in the main bundle and warms the chart-heavy stock page during idle time. This is an intentional local-disk startup trade-off; compare first paint, route-ready time, and memory on a low-memory device before changing it. |

## Agent/model methodology

1. **Establish the baseline.** Record the app commit, machine/OS, CPU and memory class, display size, app build, and data scenario. Use recorded fixtures for deterministic runs; use live sources only for checks that require provider behavior.
2. **Measure budget hardware first.** On a low-end reference device (or a documented CPU-throttled profile), run cold start, Overview hydration at depths 100/250/500, filter/sort interaction, route changes, and **Show all**. Capture p50/p95 interaction-to-paint, longest main-thread task, total blocking time, heap after settling, request count, and first useful rows. Repeat at least five times and report the median plus spread.
3. **Locate the cause, not a proxy.** Capture Chromium/Electron Performance traces with React profiling where possible. Separate network wait, parsing, scoring, React render/commit, layout, and paint. Do not infer a UI improvement from fewer source lines or a faster isolated microbenchmark.
4. **Write a falsifiable hypothesis.** Name the interaction, code path, metric, expected direction, and a guardrail for data fidelity/accessibility. Rank impact from measured time saved on the low-end profile and effort from code/test surface, not intuition alone.
5. **Make one reversible change.** Keep quote source/timestamps, rows, ordering, scoring, alerts, and error states identical. Do not trade fidelity for placeholders, dropped rows, lower-resolution data, weaker refresh behavior, or unbounded concurrency.
6. **Prove equivalence and improvement.** Add a focused test that fails before the change, run the relevant unit/lint/build/browser checks, then repeat the exact baseline profile. Report before/after numbers and regressions on a modern machine too. If the measured gain is within noise, do not claim a win.
7. **Coordinate proposals.** Agents should report evidence, uncertainty, affected files, risk, and an isolated patch; avoid parallel edits to the same hot path. Keep competing proposals in the poll below, decide one experiment at a time, and record accepted/rejected decisions with their measurement.

## Debate poll

Choose the next primary experiment after this request-coalescing change; vote for one option before implementation:

- [ ] Overview row virtualization, with keyboard/expanded-row accessibility preserved.
- [ ] Cross-desk request scheduling and prioritization on slow connections.
- [ ] One-pass quote counts on the Futures desk, preserving unavailable/flat treatment.
- [ ] Profile-first only: collect low-end traces before making another optimization.

## Implementation already on master

`summarizeStocks` replaces repeated dashboard-summary traversals with a single pass. It preserves the previous finite-change average, score/zombie counts, deepest-losers selection, and empty-data behavior. The focused tests cover mixed valid/missing values and a scan with no losers.

## Implementation in this pull request

Concurrent requests for the same Yahoo chart now share the pending provider call, including when chart caching is disabled. A completed response is not reused by a later sequential call at zero TTL, and a failed request is removed so the next call can retry.

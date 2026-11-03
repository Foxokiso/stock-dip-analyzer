# Performance improvement report

## Summary

The app already applies several important performance measures: Overview rows are revealed in batches, scan requests have shared concurrency limits and are flushed to the UI every 120 ms, hidden-window refreshes are controlled, chart caching is optional, and the Stock page's charting code is preloaded during idle time. These existing protections should be preserved.

The selected quick win is to share identical Yahoo chart requests while they are in flight. On an initial Stock page visit with the default 1-month range, `StockDetails.jsx` independently requests the same symbol/range/interval for the price chart and technical score. `chartCache.js` previously reused only completed responses, so both calls could reach Yahoo at once, including when the completed-cache TTL is off. The Stock page now opts those two consumers into coalescing; independent scan requests retain their existing behavior. Each page consumer still receives the same provider response and original retrieval time; completed-response TTL behavior is unchanged.

The remaining opportunities below are hypotheses from source inspection, not measured speedup claims. Profile before choosing a larger follow-up.

## Ranked opportunities

| Rank | Opportunity | Evidence and possible benefit | Effort / impact | Guardrail |
|---|---|---|---|---|
| 1 | Coalesce in-flight identical Yahoo chart requests | The Stock page's chart and technical-analysis effects both request the default `1mo`/`1d` chart. A completed-cache TTL of zero does not prevent duplicate overlapping requests. Implemented in this PR. | Low / medium-high on first Stock page load | Keep TTL semantics, quote/retrieval timestamps, errors, and result data unchanged; test concurrent success and failure/retry. |
| 2 | Compute Overview summary tiles in one pass | `Dashboard.jsx` derives average change, buy count, low-score count, scored count, and deepest dip with multiple full-array traversals. Scan results are published on a 120 ms cadence, so the work repeats as rows arrive. | Low / medium on 250–500 row scans | Compare all summary values against existing behavior for null, zero, and unavailable values. |
| 3 | Limit scan-store notifications to affected scopes | `scanStore.js` calls every listener from `emit()` for any scope update. `useSyncExternalStore` prevents rendering when a watched snapshot is unchanged, but callbacks still fan out as concurrent scopes accumulate. | Low-medium / low-medium | Keep promoted-scope ordering and ensure listeners for the changed scope always update. |
| 4 | Virtualize the Overview's opt-in “Show all” rows | `Dashboard.jsx` normally renders up to 100 rows, but “Show all” can create up to 500 table rows with many cells and metadata nodes. Virtualization could reduce DOM/layout work on low-memory machines. | Medium / medium when showing all | Preserve sorting, focus movement, row expansion, keyboard access, and screen-reader table semantics; retain the current non-virtualized default unless measurements justify a change. |
| 5 | Bound chart-cache memory by bytes as well as entry count | `chartCache.js` retains up to 1,500 complete provider responses. Entry sizes can differ substantially, and TTL controls reuse rather than memory lifetime. | Medium / potentially high on long sessions | Measure representative heap size first; preserve requested TTL behavior and never evict a request in flight. |
| 6 | Cache the Futures number formatter | `Futures.jsx` constructs an `Intl.NumberFormat` each time `nativeNumber` formats a price, including repeated renders of the board and overview cards. A shared formatter avoids repeated setup. | Low / low-medium | Confirm exact locale and precision output is unchanged; measure because the board is small. |
| 7 | Avoid repeated queue-front shifts during large scans | `createQueue()` in `pool.js` removes items with `Array.shift()`, which moves remaining array entries. A head index or ring buffer makes dequeue constant-time. | Low / low | Benchmark at the supported maximum scan depth; do not complicate the small-queue implementation without a meaningful gain. |
| 8 | Reduce per-refresh Dashboard derivation during rapid filter/sort input | Search, filtering, and sorting are recomputed from the full scan result in `Dashboard.jsx`; rapid typing can request work on every keystroke. | Medium / low-medium | Keep the input immediate and the results understandable; do not add visible debounce delay unless interaction tests support it. |
| 9 | Profile the idle Stock-page preload on constrained hardware | `App.jsx` intentionally warms the chart-heavy Stock page after startup to make the first visit feel instant. On a constrained CPU or memory budget, that work may compete with startup and the initial scan. | Low-medium / uncertain | Keep first-visit latency and startup responsiveness as paired measurements; don't remove warming based on bundle size alone. |
| 10 | Audit the production renderer bundle before changing desk loading | `App.jsx` keeps most desks in the main bundle to avoid route-load fallback latency; only Stock Details is split. A bundle report could identify a safe split or dependency worth trimming. | Medium / uncertain | Treat disk startup, first navigation, memory, and fidelity as one outcome; avoid splitting solely to reduce the entry chunk. |

## Agent and model methodology

1. **Establish the baseline before editing.** Use a release renderer build and representative machines: a budget profile (2 CPU cores, 4 GB RAM) and a modest profile (4 cores, 8 GB RAM). Record OS, app/build version, power mode, display scale, cache settings, scan depth, and whether the run is cold or warm. If physical hardware is unavailable, state that limitation and use throttling only as a directional proxy.
2. **Measure user-visible work.** For three or more repeat runs, capture p50 and p95 for app-to-first-useful-paint, first Overview rows, 100- and 500-row scan completion, Stock-page first chart and score, and input response while searching/sorting. Also record renderer long tasks, peak renderer memory, request count, and bytes transferred. Separate provider/network time from parsing, scoring, rendering, and disk startup; keep quote time distinct from retrieval time.
3. **Change one bottleneck at a time.** Tie each proposal to a trace, profile, or reproducible count. State the expected win, the user-visible trade-off, implementation scope, and rollback condition before changing code. Do not reduce chart history, score fidelity, source freshness, scan coverage, or accessibility to improve a benchmark.
4. **Prove behavioral equivalence.** Add a focused regression test that fails before the change. Compare data values, ordering, timestamp provenance, errors, stale/cached labeling, and keyboard/focus behavior as applicable. Test slow and failed providers as well as the fast path.
5. **Protect the supported low-end experience.** Do not tune only on a modern developer workstation. Report results for the budget profile and verify that improvements do not worsen p95 input delay, startup, first useful paint, memory, or failure recovery.
6. **Keep performance fixtures in tests only.** Recorded or generated responses may drive isolated tests and benchmarks but must never appear as runtime market data. Preserve unavailable/failed states and all existing data-integrity rules.
7. **Run repository checks.** Use the focused unit test while iterating, then run `npm run verify` before opening or updating a PR. If a browser regression is needed, measure the same scenario in both the development renderer and production preview.
8. **Report evidence, not guesses.** In the PR include the before/after numbers, device profile, repetitions, trace or benchmark command, and any uncertainty. If a gain is within run-to-run noise, do not claim a win.

## Follow-up poll

Which follow-up should be profiled and planned next? Vote by commenting with the rank and the hardware or workflow that matters to you; explain any fidelity or accessibility concern.

- [ ] **2 —** Single-pass Overview summary calculation.
- [ ] **4 —** Virtualize the opt-in 500-row view.
- [ ] **5 —** Measure and cap chart-cache memory.
- [ ] **9 —** Check whether idle preloading competes with startup on budget hardware.

# Changelog

## 2.1.0 — Response (2026-10-21)

### Fixed
- Every Finviz screener desk (Overview, ETF rankings, Discovery) showed nothing: Finviz now appends a short label span and a sort indicator to header cells, so the header row was no longer recognised. The parser reads the full name from `aria-label` or the label span first (`src/utils/finviz.js`, fixture `tests/fixtures/finviz-overview-grid-2026-10-21.html`).
- Numeric parsing is normalised to 15 significant digits (33.24M no longer becomes 33240000.000000004).
- `master` had no CI: both workflows now also run on pushes to it.

### Changed
- Overview scan streams (`src/state/scanStore.js`): screener pages are fetched four at a time and published in page order as each one lands; Yahoo scoring starts on the first rows with eight requests in flight and is flushed to the table every 120 ms. Measured at depth 100: first row and first score 0.9 s after a reload, all names scored in 3.3 s (previously five names at a time, pages one at a time with a 300 ms pause).
- The scan lives outside React: leaving the Overview no longer cancels it, and returning adopts the run in flight or reuses a completed scan younger than Settings → Scanner → **Reuse a scan for** (default 90 s). Rows always keep their original retrieval time.
- Route switches no longer pay React 19's 300 ms Suspense fallback throttle: the desks are static imports and the stock page is a preloadable chunk warmed during idle time (`src/utils/preloadable.js`). Cold mount is now 0 ms on every route.
- ETF rankings fetch their three pages in parallel; Oil Watch hydrates through a pool of eight.
- Settings → Data → **Chart cache** is now honoured by Overview scoring, the stock page and Oil Watch (`src/utils/chartCache.js`; a reused quote keeps its original retrieval time; the Market Pulse strip always fetches live). Settings → Data → **Request timeout** is pushed to the main process through `configure-network`. Both are editable and the section has a reset.
- Placeholder rows while a scan is arriving are capped at eight.

### Added
- `npm run test:finviz` (`scripts/verify-finviz-live.mjs`): fetches every screener view the app uses plus the futures API and runs the shared parsers, so the next Finviz markup change is caught in seconds without launching Electron.
- `npm run test:live` now walks every route twice (cold, warm), times mount and first live value with an in-page observer, measures the return to the Overview, and records main-process fetch errors. `LIVE_SCAN_DEPTH` pins the depth; `ELECTRON_EXE` targets a packaged build.
- Tests for the pool, the chart cache, the scan store (streaming order, supersede, partial failure, unavailable symbols) and the configurable deadline — 112 in total.

## 2.0.0 — Pierce/27 (2026-10-17)

### Added
- Pierce/27 design system: 27° OKLCH hue grid with exact complements at k + 20, multiplication-derived tints/washes (×0.73 / ×0.46 / ×0.27), 27-based timing (270 ms / 540 ms / 2.7 s), silk surfaces — applied to every page with layouts unchanged (`src/styles/tokens.css`, `src/styles/pages/*`, `src/styles/components.css`).
- Settings desk with a versioned settings document (`dipAnalyzerSettingsV2`), one-time migration from the legacy keys, per-section reset, export/import, and sections for Appearance, Scanner, Futures, Alerts, Data & sources, Backup and About (`src/state/*`, `src/pages/Settings.jsx`, 15 tests).
- Dashboard, Futures desk and Live Alerts read their defaults (scan depth, sort, rating filter, market group, timeframe, delay notice, sound, volume, alert types, minimum score, history limit) from settings.
- Native C++ modules with cross-language parity suites: `format`, `jsonlite`, `futures`, `marketdata`, `oilnews`, `palette` (generated header + drift check); modular `native/CMakeLists.txt` that auto-discovers `native/modules/*`.
- `scripts/screenshot-routes.mjs` for route-by-route visual review.
- Design contract: `docs/design/pierce27-brief.md`.

### Changed
- Electron window opens on the ink background (no white flash); page title is "Dip Analyzer PRO".
- Native CI workflow triggers on `v2/**` and on every parity verifier and reference module.
- `settings.data.requestTimeoutSeconds` reports the real 12 s used by `main.cjs`.

### Fixed
- Native parity verifier failed on Windows (`'null\r' !== 'null'`): rows are split on `/\r?\n/`.
- Saved Finviz screener page moved to `tests/fixtures/finviz-overview-2026.html`; committed build/lint logs removed; `artifacts/` ignored by git and ESLint.
- Generated palette header pinned to LF via `.gitattributes` so the byte-for-byte check passes on Windows checkouts.

### Not in this release
- A native (Qt) GUI, native networking or an installer for the C++ core. The shipping application remains Electron + React with the C++ core verified underneath.

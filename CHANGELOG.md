# Changelog

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

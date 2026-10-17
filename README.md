# Stock Dip Analyzer Pro

A desktop market research workspace built with React, Vite, and Electron. Finviz is the primary stock screener and futures reference; Yahoo Finance supplies historical technical analysis and market context. Google News RSS supplies the Oil Watch headlines.

## Release Notes v2.0.0 — Pierce/27

The layout is the same; the style is new, every setting is deliberate, and the C++ core now covers far more than scoring.

* **Pierce/27 design system** (`src/styles/tokens.css`, contract in `docs/design/pierce27-brief.md`):
  * Every hue sits on a 27° grid in OKLCH — H(k) = 27·k mod 360. Because 27·20 ≡ 180, the complement of grid hue k is grid hue k + 20, so each colour pair is two multiples of 27 placed exactly opposite: magenta ↔ green (primary), cyan ↔ red (secondary), violet ↔ yellow, amber ↔ blue. Up/down, selected/unselected and action/context are drawn with these complements rather than with shades of one colour.
  * Tints, shades and washes are not hand-picked: lightness, chroma and alpha are multiplied by 0.73, 0.46 and 0.27. Durations follow the same scale (270 ms, 540 ms, a 2.7 s pulse on live indicators). Radii are 9 / 6 / 13 px.
  * Black-ink ground, hairline borders, a 2 % sheen on every panel, soft 27 px glows scaled by a user-set intensity, and one long ease-out curve. No new web fonts; the app renders identically offline.
  * The previous themes (Modern, Alien Fractal, Seizure Mode) remain selectable; all pages consume role tokens only.
* **Settings desk** (`/settings`): one versioned document (`dipAnalyzerSettingsV2`, migrated once from the old keys) with a sticky section index and per-section reset — Appearance (theme cards with live complement swatches, density, motion, glow), Scanner (excluded sectors, refresh interval, scan depth, default rating filter, default sort), Futures (default market group, default timeframe, delay notice), Alerts (sound, volume, which alert types fire, minimum score, history limit), Data & sources (read-only facts: 45 s chart cache, 12 s request timeout, Finviz 1 min / 20 min delays, Yahoo delay as reported), Backup (export / import / reset) and About. Every control is keyboard-reachable with a visible focus ring; the Dashboard, Futures desk and alert system read their defaults from it.
* **Futures desk** ships in this version with the data-integrity rules of v1.3 unchanged: no simulated quotes, no invented headlines, retrieval time and source quote time always shown separately, unavailable shown as unavailable.
* **Native C++ core** (`native/`, C++20, MSVC `/W4 /WX` and GCC `-Wall -Wextra -Werror -pedantic`), each module checked against the JavaScript reference by a deterministic parity suite run under CTest on Windows and Linux:
  * `dip_analysis` — recovery score, EMA/RSI, factors, verdicts, trend flags (528 cases)
  * `dip_format` — compact/percent/price formatting incl. en-US `toLocaleString` semantics (3 192 cases)
  * `dip_jsonlite` + `dip_futures` — strict RFC 8259 JSON parser and the Finviz futures payload validation, grouping and snapshot rules (577 cases)
  * `dip_marketdata` — Yahoo chart points, previous-close selection across exchange days via `std::chrono` time zones, day change, alert eligibility (13 481 cases)
  * `dip_oilnews` — headline/source split and high-impact classification with de-escalation suppression (3 853 cases)
  * `dip_palette` — the Pierce/27 palette as a generated `constexpr` header (`scripts/gen-native-palette.mjs`), with a byte-for-byte drift check (1 008 cases)
  * Still JavaScript by design: DOM/RSS parsing, networking, the Electron shell and the React UI. A native (Qt) window is **not** part of this release.
* **Fixed:** the native parity verifier failed on Windows because the driver's text-mode stdout ends lines with CRLF; the saved Finviz screener page is now a fixture under `tests/fixtures/`; committed build and lint logs were removed.

Verification: `npm test` 67/67, `npx eslint .` clean, `vite build`, `ctest` 6/6 parity suites, `scripts/verify-ui.mjs` and `scripts/verify-alerts.mjs` pass; `scripts/screenshot-routes.mjs` captures every route.

## Futures desk and modern workspace

The Futures tab groups Finviz reference instruments across indices, rates, energy, metals, grains, softs, and currencies. It includes search, overview cards, actual source sparklines, and an instrument detail panel. The default theme uses slate surfaces, mint accents, readable tabular numbers, and active navigation. Large route components load on demand; refreshes preserve the interface, and reduced motion is respected.

## Data integrity

- Runtime views never substitute synthetic prices, scores, or news. A browser preview without Electron's source connection shows unavailable data.
- Retrieval time and source quote time are different fields. Unknown quote timestamps remain unknown; retrieving a response does not establish quote freshness.
- Finviz's [FAQ](https://finviz.com/help/faq) specifies a **20-minute futures delay**, while its [current futures page](https://finviz.com/futures) says **15 minutes**. The app conservatively displays 20 minutes. This is delayed reference data, not a real-time exchange feed or a freshness guarantee.
- The Finviz futures feed does not supply a confirmed delivery contract or source quote timestamp. Native price units and Treasury decimal fractions are preserved; a universal dollar sign is not applied.
- Finviz US equity quotes are delayed one minute under its documented regular service. Yahoo delay metadata is shown when supplied; otherwise the delay is unknown. Displayed quote times include their timezone.
- Failed refreshes retain previous retrieved values only with stale/cached notices. Unknown and invalid values remain unavailable rather than becoming zero or a Hold rating.
- Recovery scores are rule-based technical scores from a fixed one-month Yahoo history and its current source quote. They are not calibrated recovery probabilities or guarantees. Changing the detail chart range does not change the scoring period.
- Technical alerts require sufficient history, an explicitly zero-delay source, and a recent source quote timestamp. Messages describe observed technical conditions, not unmeasured trading flows.
- Stock screening honors sector exclusions. ETF rankings show the return period or dividend yield corresponding to their ranking criteria.

## Run locally

Requires Node.js 22.12 or later (supported by this Vite version).

```bash
npm ci
npm start
```

`npm start` launches Vite and Electron together. `npm run dev` provides a browser layout preview; market data requires Electron. Existing refresh settings and alternate themes are retained.

## Verify and build

```bash
npm test
npm run lint
npm run build:renderer
```

The native test suite covers financial parsing, current Finviz table schemas, daily session comparisons, missing data, futures fractions, source provenance, cached failures, and RSS integrity.

For browser regressions, run `npm run dev` in one terminal, then:

```bash
npx playwright install --with-deps chromium
npm run test:ui
```

These checks exercise unavailable states across seven routes, futures filtering and decimal precision, retained cached quotes, narrow-screen layout, and alert audio cleanup. They use recorded test fixtures rather than a live feed. Screenshots are written to the ignored `artifacts/` directory.

`npm run build` also invokes electron-builder to create a platform installer. Native packaging requires the target platform's build dependencies; the renderer build alone does not verify an installer.

## Source limits

Public providers can be unavailable, delayed, rate limited, or change their response schemas. Network requests have bounded timeouts, and those failures are exposed in the interface. Live prices with exchange entitlements require an authorized feed or broker connection; Finviz's built-in futures delay cannot be removed by faster polling.

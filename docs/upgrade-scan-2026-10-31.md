# Upgrade scan — 2026-10-31

This report records a 13-area, independently verified scan of stock-dip-analyzer at commit 022402f (v2.1.0 "Response" plus security hardening #10). It was written before the fixes and explains what was found, how it was verified, which fixes change documented behaviour, and what stays a proposal. It now also records the outcome: the issue table's Status column and the section "Implementation in this pull request" describe the pull request that carries this report.

## Summary

The app's foundations are sound. The security design holds where it was meant to: one allowlisted bridge function behind sandboxing, context isolation and deny-all permissions, no XSS path, and zero CSP violations on any route. The core market arithmetic matches Yahoo's own figures, the native core is clean under sanitizers and differential fuzzing, and the unit suite is deterministic. The defects sit at the edges: assumptions about provider responses that do not hold, a 2.1.0 change that was carried only halfway through, a third-party script running with the app's privileges, and code that `npm test` does not check (28 of 36 realistic mutants survive `npm test`, 11 of them caught only by the C++ parity suites, and every `.jsx` file is at 0% coverage).

The most important problems:

- **Technical alerts can never fire (U30).** The alert gate requires a quote with an explicitly zero delay, but Yahoo's v8 chart endpoint never sends `exchangeDataDelayedBy`. A verifier found the field missing even from an archived 2024 capture, so the gate has likely never passed since commit e0d3e7a (2026-10-10). Toasts, sounds, history and every Settings → Alerts control do nothing, and no test notices: no automated check runs the alert path on a real Yahoo payload (the unit fixtures add the field by hand, scanStore's dispatch returns early under Node, and the alert regression script dispatches its own event).
- **Data settings reset on every launch (U17).** Chart cache and Request timeout, editable since 2.1.0, are replaced with their defaults on every load, import and replace. Seven of the 13 finders reported this independently, and one unit test (tests/settings.test.js:228-242) asserts the reset.
- **Outdated Electron and electron-builder (U01, U02).** The installer ships Electron 45.0.0, while 45.2.1 carries the Node 24.22.1 security release and Chromium backports. The electron-builder 26.8.1 pin keeps 7 high build-chain advisories, including an AppImage `LD_LIBRARY_PATH` flaw in a script that runs on users' machines, and the Windows rename failure it works around was fixed in 26.15.4.
- **Stock-page chart axis (U44).** The price axis is padded by a flat $5, so sub-$5 names, 16 of the 20 rows on the live losers page that feeds the Overview, get negative price ticks and a nearly flat line (SNDL's price used 4 px of a 282 px plot).
- **TradingView script in the privileged document (U06).** tv.js, which TradingView redeploys and subresource integrity cannot pin, runs in the document that holds the desktop bridge. A simulated compromised copy reached the bridge and rewrote the displayed quote with zero CSP violations, while a sandboxed iframe renders the same chart.
- **Drifted quote-page parser (U45).** Finviz no longer publishes a '52W Range' label, so the stock page's 52-week strip never renders, and all 10 headlines on a live page were credited to the hosting domain instead of the publisher. The parser had no fixture, test or live probe.
- **Also high or widely reported.** The Overview "Sell" chip is unreadable at about 1.2:1 contrast (U35). Because preloadable caches a failed chunk import, one failed warm-up load leaves stock links dead with the renderer at 100% CPU, and with no error boundary a single render error blanks the window (U58). Building a new `Intl.DateTimeFormat` for every price bar costs about 3.4 s of main-thread time per depth-500 scan (U39).

After de-duplication there are 86 issues: 5 high, 34 medium, 35 low and 12 endorsed features. The pull request that carries this report fixes 67 of them and partly fixes 3 more, including two endorsed features that harden existing behaviour: binding the Finviz grid by its stable column ids (U27) and Dependabot (U79). Each partial fix leaves a follow-up: a separate release build/publish job with provenance attestation (U10), passing the quote's own session to the breakout rule (U41), and a `build_exe.bat` that does not run the toolchain as Administrator (U77). A final review of the whole change then found 27 problems in the fixes themselves. All 27 were confirmed, and all but one are fixed in this pull request (see "Implementation in this pull request"). The other 16 issues stay proposals: ten endorsed feature proposals and six confirmed findings whose fixes are left for separate work (an app:// protocol, Electron fuses, embeddable native CMake, replacing recharts, an accessibility gate, and the Vite 8 and ESLint 10 majors). Seven decisions in the fix work change documented or user-visible behaviour and need the owner's review; they are set out below.

## How the scan worked

The scan split the repository into 13 areas and gave each to one deep finder agent. The areas ran as 5 parallel workflow slices; in total 88 agents used about 19.9 million subagent tokens. Finders worked on scratch copies and left the repository untouched. They used live provider data sparingly (Finviz screener, quote and futures pages, Yahoo's v8 chart endpoint, Google News RSS), recorded fixtures, Playwright Chromium against dev servers and production builds with a stubbed desktop bridge, Node vm harnesses around main.cjs, ASan/UBSan and clang-tidy on the native core, mutation testing, c8 coverage, and differential fuzzing of the native core against the JS references.

| Area | Scope | Findings | Confirmed | Features endorsed | Rejected |
|---|---|---|---|---|---|
| A1 | Electron shell, IPC and network layer | 13 | 12 | 1 | 0 |
| A2 | Renderer security and third-party content | 8 | 7 | 0 | 1 |
| A3 | CI/CD, build, release and dependencies | 12 | 9 | 2 | 1 |
| A4 | Native C++ core | 9 | 8 | 0 | 1 |
| B1 | Provider parsing (Finviz, futures, RSS, formatting) | 11 | 9 | 1 | 1 |
| B2 | Market math and data integrity | 11 | 10 | 0 | 1 |
| B3 | State, concurrency and settings | 12 | 10 | 0 | 2 |
| B4 | Test suite and verification tooling | 12 | 11 | 1 | 0 |
| C1 | React app shell, Dashboard and shared components | 11 | 11 | 0 | 0 |
| C2 | React pages | 12 | 9 | 2 | 1 |
| C3 | CSS, accessibility and UX | 12 | 12 | 0 | 0 |
| C4 | Performance, bundle and dead code | 9 | 8 | 0 | 1 |
| C5 | Product upgrade opportunities | 12 | 5 | 5 | 2 |
| **Total** | | **144** | **121** | **12** | **11** |

Every finding was then checked by verifiers independent of its finder:

- Findings reported as high or critical went to two verifiers, one trying to prove the finding and one trying to refute it as a devil's advocate. A finding was confirmed only when both agreed.
- Medium and low findings went to skeptic verifiers in batches of up to five, who defaulted to "not real" when uncertain.
- Feature proposals went to a product reviewer, who checked whether the proposal is grounded in the code, feasible, and free of conflicts with the README's data-integrity and security rules or provider terms, and scored value (1–5) and effort. A proposal was endorsed only when grounded, feasible, conflict-free and of value 3 or more.
- A finding's final severity is the lowest severity any confirming verifier assigned.

Of 144 raw findings, 121 were confirmed (9 high, 59 medium, 53 low), 12 feature proposals were endorsed, and 11 findings were rejected, 2 of them feature proposals. All 21 non-feature findings reported as high were confirmed by both verifiers, but 12 of them were lowered to medium (three feature proposals that the C5 finder also rated high, C5-2 to C5-4, went to the product reviewer instead). Of the 109 non-feature findings reported as medium or low, 24 were lowered from medium to low and 9 were rejected. De-duplication across areas merged the surviving findings into 86 distinct issues, U01–U86, including the features; 28 issues were reported by more than one finding.

Three environment limits shaped the method. The Electron binary could not be installed, because GitHub release downloads are blocked in the sandbox, so main-process behaviour was checked against the Electron 45 sources and typings and with vm harnesses, not by launching the app. Windows packaging is validated only by the repository's windows-installer CI workflow. Everything ran on Linux.

## Baseline

At HEAD 022402f, before any change:

- `npm test`: 116/116 pass.
- `npx eslint .`: clean.
- `vite build`: OK; index chunk 354.33 kB, StockDetails chunk 375.06 kB.
- Native: `cmake` + `ctest` 6/6 parity suites pass (scoring 528 cases, format, futures 577, marketdata 13,481, oilnews, palette).
- Live Finviz smoke test (`NODE_USE_ENV_PROXY=1 npm run test:finviz`): 8/8 views pass. Node's fetch needs `NODE_USE_ENV_PROXY=1` to use the sandbox proxy.
- Browser regressions on Linux: `scripts/verify-ui.mjs` passes every check except line 90 ("page overflows narrow viewport"), a font-dependent overflow from the header theme select (U62, U69); `scripts/verify-alerts.mjs` passes.
- `npm audit`: 26 advisories (10 high, 16 moderate), all in dev/build tooling; `npm audit --omit=dev` reports 0. Seven of the highs are in the electron-builder 26.8.1 chain, including GHSA-7g7r-gx96-252g (AppImage `LD_LIBRARY_PATH`). zod, follow-redirects and joi are fixable in range.
- `npm outdated`: in range are electron 45.2.1, react/react-dom 19.3.1, recharts 3.10.1, react-router-dom 7.18.5, playwright 1.64.1 and others; majors are available for vite 8, @vitejs/plugin-react 6, eslint 10, lucide-react 1.x, globals 17, concurrently 10 and eslint-plugin-react-refresh 0.5.

## Health by area

**A1 Electron shell, IPC and network layer.** The IPC surface is tight: one bridge function, sandboxing, context isolation, a host allowlist and deny-all permissions. The weak points are around it: Electron 45.0.0 in the lockfile (U01); a `fetch-url` that followed a 302 from an allowlisted host to `http://localhost` and returned the LAN body, with a cookie jar that misattributes, drops and fails to delete cookies (U05); webview guests on the persistent default session that can reach `shell.openExternal` (U03, U04); and raw "Error invoking remote method" strings shown to users (U14). Legacy Finviz URLs add 1–2 redirect hops: 560 and 249 ms, against 150 and 151 ms for the same 279,177-byte page at the canonical URL (U29).

**A2 Renderer security and third-party content.** There is no XSS path: provider text renders as React text nodes, provider links are filtered to http(s), DOMParser documents are inert, and hostile import JSON cannot pollute prototypes. The shipped CSP produced zero violations on all seven routes. The gaps: tv.js runs in the document that holds the bridge (U06); the CSP is broader than needed, since a strict variant also gave zero violations (U07); embedded sites' popups reach `shell.openExternal` without a user gesture (U03); and imports accept values that flood providers (`refreshMinutes` 0.0001 produced 159 futures API calls in 5 s, U19). The inline-handler stripping regex took 2,820 ms on a 40,000-character whitespace run, against 0.6 ms for a lookbehind variant (U50).

**A3 CI/CD, build, release and dependencies.** The pipeline works and is mostly well pinned; all 549 lockfile packages come from registry.npmjs.org with integrity hashes. The main problems are Electron 45.0.0 (U01), the outdated electron-builder pin (U02), and zero ESLint rules for main.cjs, preload.cjs and scripts/*.mjs, about 2,500 lines, so an `isHtps` typo in main.cjs passes lint (U74). Smaller gaps: release.yml exposes signing secrets and a write token to the whole toolchain and splices `ref_name` into PowerShell (U10), the pinned actions are v4 releases built for the Node 20 runtime GitHub removed on 2026-09-23 (U75), and there is no Dependabot or CodeQL (U79). Vite 8 cut build times from 9.85 s and 6.44 s to 1.84 s and 1.68 s (U78).

**A4 Native C++ core.** The core (7 libraries, 3,061 lines of C++) is well built: all 6 suites pass under ASan and UBSan, also on fuzzed and hostile inputs; it raises only benign warnings under aggressive clang 18 and GCC 13 warning sets (6 intentional -Wfloat-equal and 2 -Wuseless-cast nits); and differential fuzzing against the JS references found no mismatch in 35,988 format cases or for exchangeDay across all 418 IANA zones. The defects sit at boundaries the parity harness cannot see: locale-dependent number parsing (every JSON number is truncated under de_DE, U51), host time-zone handling (the marketdata suite fails at case 13420 with TZ=America/New_York, U54), O(n²) parsing of wide objects (7,584 ms for 64k keys, 112 ms with a hash index, U52) and byte-level UTF-8 (U53). Five of ten hand-made mutants survive the parity suites (U55), and the CMake project cannot be embedded (U56).

**B1 Provider parsing.** Grid parsing of today's Finviz markup is correct and identical in linkedom and Chromium (20 of 20 rows on two live pages, 18 ms per 278 KB page). The defects sit around the parsers: in TradingView, BRK-B charts a TSX instrument at 2.15 instead of Berkshire at 542.49 (U46); TIO's "intraday" futures sparkline ends at 211.8 against a quote of 90.71 (U47); Oil Watch's 15 headlines included only 5 of the 15 newest (U48); and the quote-page parsing has drifted (U45). Markup drift fails silently: with a U+2212 minus sign in every change cell, a scan made 50 page requests, kept 0 rows and reported no error (U21). The finder's claim about the futures "Previous close" was rejected (B1-3).

**B2 Market math and data integrity.** The core arithmetic holds up: previous-close selection matched Yahoo's own `regularMarketChangePercent` on every live symbol, including futures; the live price is counted exactly once; EMA seeding changed no trend flag in 393 symbol-days; and the chart cache stays bounded. The defects sit where the code's assumptions fail, some about the providers and some in the app's own logic: alerts cannot fire (U30); `isBreakout` flagged none of 14 real new one-month closing highs (U41); the app's RSI falls in a different zone from Wilder's RSI(14) on 13.2% of days (U40); the 52-week strip vanished after a Finviz label change (U45); and the price axis goes negative for sub-$5 names, 16 of 20 rows on the live losers page (U44).

**B3 State, concurrency and settings.** Superseded runs never publish, flush timers are cleared, settings merging resists `__proto__`, `constructor` and `prototype` keys, and telemetry.js sends nothing about the user. The defects: the Data settings reset (U17); number fields commit on every keystroke, so clearing History limit cut stored history from 30 entries to 1 (U18); a stored `refreshMinutes` of 0.01 produced 68 Finviz and 119 Yahoo requests in 10 s (U19); with page 0 slow, a 20-row scan fetched 50 pages, and a failure on an unneeded page marked a complete scan as failed (U20); a scan whose Yahoo requests all failed was reused as complete (U22); and six scope changes in 1.2 s put up to 48 Yahoo requests in flight against a documented 8 (U23). An unguarded localStorage access blanks the app, and a failed chunk load is never retried (U58).

**B4 Test suite and verification tooling.** The unit suite is deterministic: its 116 tests pass in every time zone and locale tried, never touch the network, show no flakiness and run in about 2 s. It is thin where risk is highest: 28 of 36 realistic mutants survive `npm test`; scoring, format and market-data mutants are caught only by the C++ parity suite; and every main.cjs security mutant and a broken shipped-bridge mutant pass every automated check (U11, U12). All `.jsx` files are at 0% coverage, and main.cjs is missing from coverage reports. A unit test locks in the Data-settings reset (U17), and the browser regressions run only on Windows; on Linux and on the production bundle they fail because of the scripts and fonts, not the app (U69).

**C1 React app shell, Dashboard and shared components.** Effects clean up, StrictMode causes no double scans, list keys are stable, memoised rows keep render cost low, and no route produced page errors with realistic data. The problems are in scan lifecycle and alerting: 1.29 s after a refresh at depth 500, the table dropped from 500 scored rows to 160 unscored ones while the notice said the scan was retained (U24); picking five sectors 300 ms apart sent 148 Finviz and 2,968 Yahoo requests, up to 39 in flight (U23); alerts never fire (U30); a failed stock-page chunk, which preloadable caches and rethrows, kept the main thread busy (5.1 s of task time per 5 s), and with no error boundary one malformed alert-history entry blanked the window (U58).

**C2 React pages.** Race handling is sound: the newest request wins on every page, and rapid switches leave exactly one TradingView iframe. The defects are in what the pages show and how Settings edits values: editing Request timeout to 30 produced "130" and pushed timeouts of 1, 13 and 130 s (U18); SNDL's price line filled 4 px of a 282 px plot (U44); the 52-week bar never shows (U45); Finviz data that arrived at 101 ms waited for Yahoo until 5.6 s (U67); ETF rankings, Discovery and Oil Watch have no refresh control (U38); and one failed warm-up load breaks every stock link until a reload (U58). The claim that the stock page's Refresh is served from the cache was rejected as documented behaviour (C2-5).

**C3 CSS, accessibility and UX.** axe-core ran on 7 routes at two widths in three themes (42 runs), backed by a gradient-aware contrast audit, keyboard tab-throughs and a flash measurement. In the default theme, focus rings, landmarks, lang, icon-button names and reduced-motion coverage are good, there are no keyboard traps, and Seizure Mode stays below the WCAG flash threshold. The serious problems: the Overview table is mouse-only (U33); the Overview "Sell" chip measures 1.14–1.26:1 (U35); Alien Fractal pushes toasts and the history drawer off-screen (U59); and `--text-faint` captions, which carry the provenance and delay notes, reach only 3.0–3.7:1 (U60). The 112 KB of CSS gzips to 17.8 KB but carries about 7 KB of dead rules and overrides that never apply (U66).

**C4 Performance, bundle and dead code.** Bundle composition is reasonable (lucide-react is tree-shaken to 10 KB and the index chunk parses off-thread in 18 ms), concurrent duplicate Yahoo requests are merged in main.cjs, and per-scope heap growth (~0.7 MB) and the chart cache are not a concern. The Overview at depth 250–500 renders every row in an auto-layout table and builds a new `Intl.DateTimeFormat` per timestamp: a depth-500 scan took 25.7–39.9 s to score every row against a network-bound floor of 13.5 s, and 14.5–19.8 s with cached formatters and at most 100 rendered rows (U32, U39). Five of the six desks keep polling while minimised; the Overview made 1,130 requests in 10 hidden minutes (U37). recharts with its dependencies is about 95% of the 375 KB StockDetails chunk (U68). Timings are ranges from a loaded, shared VM.

**C5 Product upgrade opportunities.** The data-integrity and security rules hold up well, but two features do not work: technical alerts, which have been unable to fire since the zero-delay gate arrived in e0d3e7a because Yahoo's v8 chart response has never carried a delay field (U30), and the stock page's 52-week panel, because Finviz dropped the '52W Range' label (U45). The largest product gaps are that no arbitrary ticker can be opened (U81) and that there is no watchlist (U82), earnings context (U83) or export (U85). A score backtest and keeping the last scan between launches were proposed and rejected in product review (C5-8, C5-11), and the finder recommends against a WASM core.

## Issues

Each row below is one canonical issue, ranked by severity and then by number of reports: Severity is the verified severity after de-duplication (the highest that verification confirmed among the merged findings; endorsed features show the product reviewer's value score instead), Area is the finding category, Reports counts the verified findings merged into the issue and lists their ids (each from a separate finder, except that B3 contributed two each to U20 and U58), and Status gives the issue's state in this pull request.

| # | Severity | Area | Issue | Reports (finding ids) | Status |
|---|---|---|---|---|---|
| U17 | high | bug | Chart cache and Request timeout settings are reset to defaults on every launch, import and replace | 7 (A2-2, B3-1, B4-1, C1-8, C2-1, C4-4, C5-5) | Fixed |
| U30 | high | bug | Technical alerts can never fire: the gate requires delayMinutes === 0 but Yahoo's v8 chart meta never carries exchangeDataDelayedBy | 3 (B2-1, C1-3, C5-1) | Fixed |
| U01 | high | dependency | Installer ships Electron 45.0.0; 45.2.1 carries the Node 24.22.1 security release and Chromium backports | 2 (A1-1, A3-1) | Fixed |
| U35 | high | bug | Rating colours: the Overview "Sell" chip is unreadable (1.2:1), Strong Sell is grey on the stock page, and the same verdict is coloured differently across pages | 2 (C3-2, B2-11) | Fixed |
| U44 | high | bug | The stock-page price axis is padded by a flat $5: sub-$5 names (most Overview losers) show negative ticks and a flat line | 2 (B2-2, C2-2) | Fixed |
| U58 | medium | bug | No error boundary; preloadable caches a failed chunk import forever (stock links dead, renderer at 100% CPU); unguarded localStorage blanks the app | 6 (A2-6, B3-8, B3-9, B4-10, C1-4, C2-8) | Fixed |
| U39 | medium | performance | A new Intl.DateTimeFormat is built for every price bar and quote-time label (~3.4 s of main-thread time per depth-500 scan) | 5 (A4-2, B2-7, C1-5, C4-2, C5-7) | Fixed |
| U45 | medium | bug | The stock page's 52-week strip never renders and news publishers are misattributed: the untested inline Finviz quote-page parser has drifted | 5 (B1-4, B2-4, B4-9, C2-3, C5-6) | Fixed |
| U13 | medium | bug | Settings → Backup → Copy cannot work in the desktop app: the deny-all permission handlers refuse clipboard-sanitized-write | 3 (A1-8, C2-9, C5-12) | Fixed |
| U20 | medium | bug | Screener paging: end of results inferred from accepted rows, unbounded look-ahead while a page is slow, and failures on unneeded pages mark complete scans failed | 3 (B1-5, B3-2, B3-5) | Fixed |
| U02 | medium | dependency | electron-builder 26.8.1 pin is outdated: the EPERM rename it avoids was fixed in 26.15.4, and the pin keeps 7 high build advisories incl. the AppImage LD_LIBRARY_PATH flaw | 2 (A1-10, A3-2) | Fixed |
| U03 | medium | security | Research webviews can open any URL in the system browser without a click; any HTTPS host can be attached as a webview | 2 (A1-3, A2-4) | Fixed |
| U06 | medium | security | TradingView's mutable tv.js runs in the document that holds the desktop bridge (a sandboxed iframe renders the same chart); the stock-page chart also ignores the app theme | 2 (A2-1, C2-10) | Fixed |
| U18 | medium | bug | Settings number fields commit and clamp on every keystroke (45 becomes 145; a 1 s timeout and a truncated alert history apply mid-edit) | 2 (B3-4, C2-4) | Fixed |
| U19 | medium | bug | Import and stored-document validation accept values the UI never offers (fractional refresh intervals poll continuously; unbounded sector lists) | 2 (A2-5, B3-7) | Fixed |
| U23 | medium | performance | Changing sector or depth starts concurrent full scans with separate pools (up to 48 Yahoo requests in flight) | 2 (B3-6, C1-2) | Fixed |
| U29 | medium | performance | Every Finviz HTML request goes through 1–2 redirect hops (+100–410 ms per page; Discovery loses a filter in the redirect) | 2 (A1-9, C4-5) | Fixed |
| U33 | medium | accessibility | Overview rows are mouse-only: no keyboard or screen-reader path to a stock page | 2 (C1-6, C3-1) | Fixed |
| U42 | medium | test-gap | npm test pins no scoring, formatting or market-data rule; the Yahoo fixtures carry a field the provider never sends | 2 (B2-8, B4-7) | Fixed |
| U74 | medium | ci-build | ESLint applies zero rules to main.cjs, preload.cjs and scripts/*.mjs | 2 (A3-4, B4-4) | Fixed |
| U08 | medium | security | App served from file:// with the file-protocol extra-privileges fuse on | 1 (A1-5) | Proposal |
| U10 | medium | security | release.yml gives signing secrets and a write token to the whole toolchain, splices ref_name into PowerShell, and publishes without provenance | 1 (A3-3) | Partly fixed: secrets reach only the installer step and releases wait for CI; build and publish still share one job, without provenance attestation |
| U11 | medium | security | main.cjs window/navigation/webview/permission policies and the preload allowlist have no tests | 1 (B4-3) | Fixed |
| U12 | medium | test-gap | The shipped bridge path (window.dipAnalyzer.invoke) is never exercised by any automated check | 1 (B4-2) | Fixed |
| U22 | medium | bug | Yahoo scoring failures are silent: a scan whose chart requests all failed is marked complete and reused | 1 (B3-3) | Fixed |
| U24 | medium | bug | Refresh wipes the retained, scored Overview table within ~1 s while the notice says it is retained | 1 (C1-1) | Fixed |
| U28 | medium | test-gap | Scan-store alert generation and the Photonics basket are untested; a weak assertion hides doubled Yahoo traffic | 1 (B4-8) | Fixed |
| U32 | medium | performance | The Overview renders every scan row in an auto-layout table; at depth 250–500 the main thread saturates | 1 (C4-1) | Fixed |
| U34 | medium | bug | The Overview hard-clips the timezone off every row's retrieval time | 1 (C3-5) | Fixed |
| U40 | medium | data-integrity | The app's simple 23-bar RSI is labelled 'RSI (14)' beside Finviz's Wilder RSI (14) and lands in a different zone on 13% of days | 1 (B2-3) | Fixed |
| U46 | medium | bug | Class-share tickers (BRK-B, BF-B) chart a different security in TradingView | 1 (B1-1) | Fixed |
| U47 | medium | data-integrity | Futures charts are not checked against the quote (TIO's '5-minute intraday' series is months old) | 1 (B1-2) | Fixed |
| U48 | medium | bug | Oil Watch shows Google's first 15 relevance-ranked headlines, not the newest | 1 (B1-7) | Fixed |
| U51 | medium | data-integrity | jsonlite parses numbers with locale-dependent strtod (prices truncated under a comma-decimal locale) | 1 (A4-1) | Fixed |
| U59 | medium | bug | Alien Fractal animates filter on <body>, pushing alert toasts and the history drawer off-screen | 1 (C3-3) | Fixed |
| U60 | medium | accessibility | --text-faint fails WCAG 1.4.3 contrast in every theme and carries the provenance and delay disclosures | 1 (C3-4) | Fixed |
| U61 | medium | accessibility | The floating 'Alert history' button can completely hide a focused control (WCAG 2.4.11) | 1 (C3-7) | Fixed |
| U62 | medium | accessibility | Header controls cannot wrap: the theme select is clipped at narrow or zoomed widths (and the narrow-viewport regression fails on Linux) | 1 (C3-9) | Fixed |
| U69 | medium | ci-build | Browser regressions run only on Windows against the dev server; they fail on Linux and on the production bundle | 1 (B4-6) | Fixed |
| U66 | low | maintainability | Dead code, CSS, assets and dependencies (stale second Finviz parser, StockCard, unreachable theme rules, cheerio, @types/*, cross-env) | 3 (B1-11, C3-10, C4-8) | Fixed |
| U25 | low | bug | Picking a sector that Settings excludes gives a silent empty table after paging through every loser | 2 (B3-12, C1-10) | Fixed |
| U31 | low | bug | Alert rules: minimum score drops every warning, unchanged conditions re-alert on every refresh, and bursts create one toast, sound and AudioContext per alert | 2 (B2-6, C1-7) | Fixed |
| U37 | low | performance | Auto-refresh keeps polling providers while the window is hidden or minimised (every desk except Futures) | 2 (C1-9, C4-3) | Fixed |
| U43 | low | bug | Display formatting: '1000.0K'/'1000.00M' rollover, negative zero, and a 0.00% change drawn as a rise | 2 (B1-10, C2-11) | Fixed |
| U57 | low | ci-build | CI gaps: no Linux JS job, parity path filter misses its fixture, stale branch triggers, no sanitizer/clang/locale/TZ native coverage | 2 (A3-8, A4-6) | Fixed |
| U64 | low | accessibility | Route changes are silent: static title, no h1 on most desks, focus left behind, unknown routes render an empty desk | 2 (C1-11, C3-8) | Fixed |
| U77 | low | ci-build | build_exe.bat reports the wrong output folder and runs npm as Administrator; npm run dev lacks --strictPort | 2 (A1-13, A3-10) | Partly fixed: output folder and build steps fixed; the script still self-elevates, so the toolchain runs as Administrator |
| U04 | low | security | Webview guests share the persistent default session; the HTTPS lock misses server redirects; deprecated will-navigate argument | 1 (A1-4) | Fixed |
| U05 | low | security | fetch-url follows redirects without re-checking the allowlist; the per-host cookie jar misattributes, drops and fails to delete cookies | 1 (A1-2) | Fixed |
| U07 | low | security | Production CSP is broader than the renderer needs | 1 (A2-3) | Fixed |
| U09 | low | security | Installer keeps Electron's default fuses (RunAsNode, NODE_OPTIONS, --inspect; no asar integrity) | 1 (A1-6) | Proposal |
| U14 | low | bug | Provider failures reach users as raw 'Error invoking remote method' strings; Yahoo's error text is lost; fetch-yahoo-chart inputs are unvalidated and never retried | 1 (A1-7) | Fixed |
| U15 | low | bug | The Request timeout setting is ignored by the first provider requests after launch | 1 (A1-12) | Fixed |
| U21 | low | bug | Finviz numeric/column drift silently becomes "unavailable"; an all-null required column yields an empty "complete" scan | 1 (B1-6) | Fixed |
| U26 | low | bug | The Overview's RelVol column is always '-' (avgVolume hard-coded to null) | 1 (B2-10) | Fixed |
| U36 | low | performance | The 353 KB alert WAV is read in full at every startup | 1 (C4-6) | Fixed |
| U41 | low | bug | isBreakout can never be true on an actual breakout | 1 (B2-5) | Partly fixed: the current session is still the last bar, which is wrong when Yahoo's series lacks the quote's own bar |
| U49 | low | bug | RSS publisher split ignores the <source> element; item fields are selected namespace-blind | 1 (B1-9) | Fixed |
| U50 | low | performance | stripInlineHandlers regex is quadratic on long whitespace runs (UI thread, every Finviz page) | 1 (A2-7) | Fixed |
| U52 | low | performance | jsonlite parses objects in O(n²) | 1 (A4-5) | Fixed |
| U53 | low | bug | jsonlite UTF-8 handling diverges from the shipped JS path in both directions | 1 (A4-9) | Fixed |
| U54 | low | bug | marketdata host time-zone handling: parseDate ignores TZ on libstdc++; DST-gap rule untested | 1 (A4-3) | Fixed |
| U55 | low | test-gap | Parity suites leave meaningful mutants alive; the analysis driver aborts on valid JS numbers | 1 (A4-4) | Fixed |
| U56 | low | maintainability | Native CMake cannot be embedded by another project | 1 (A4-7) | Proposal |
| U63 | low | accessibility | Seizure Mode starts from arrow-key browsing with no warning, plays an unmutable drone and hides the focus ring | 1 (C3-6) | Fixed |
| U65 | low | accessibility | Small semantic gaps: brand link name, empty header cell, unlabelled filter group, colour-only 52-week bar | 1 (C3-11) | Fixed |
| U67 | low | performance | The stock page hides Finviz stats, headlines and research viewers behind a spinner until the Yahoo chart arrives | 1 (C2-6) | Fixed |
| U68 | low | performance | recharts is 95% of the StockDetails chunk for one price/SMA chart | 1 (C4-7) | Proposal |
| U70 | low | test-gap | npm run test:live cannot fail on what it measures | 1 (B4-5) | Fixed |
| U71 | low | test-gap | Several regression checks cannot fail (tautological route loop, unrelated pollution probe, count-free fixture tests) | 1 (B4-11) | Fixed |
| U72 | low | test-gap | No automated accessibility gate | 1 (C3-12) | Proposal |
| U75 | low | ci-build | Pinned actions are the last v4 releases, built for the Node 20 runtime GitHub removed | 1 (A3-5) | Fixed |
| U76 | low | dependency | A routine in-range lockfile refresh pulls eslint-plugin-react-hooks 7.1.1 and breaks lint | 1 (A3-6) | Fixed |
| U78 | low | dependency | Major upgrades measured low-risk: Vite 8 (4–5x faster builds), ESLint 10 | 1 (A3-11) | Proposal |
| U16 | feature (value 3/5) | feature | Move provider requests to Chromium's network stack on an in-memory session | 1 (A1-11) | Proposal |
| U27 | feature (value 4/5) | feature | Bind the Finviz grid by its stable data-column-id/data-ticker attributes instead of label text and an exact column count | 1 (B1-8) | Fixed |
| U38 | feature (value 4/5) | feature | ETF rankings, Discovery and Oil Watch have no refresh or retry control | 1 (C2-7) | Proposal |
| U73 | feature (value 3/5) | feature | Logic/component tests for the untested desks and a coverage gate that counts what ships | 1 (B4-12) | Proposal |
| U79 | feature (value 4/5) | feature | No Dependabot (or other automated dependency/advisory updates) | 1 (A3-7) | Fixed |
| U80 | feature (value 3/5) | feature | Run the live Finviz smoke test on a schedule | 1 (A3-12) | Proposal |
| U81 | feature (value 5/5) | feature | 'Go to symbol' box / Ctrl+K to open any ticker | 1 (C5-2) | Proposal |
| U82 | feature (value 4/5) | feature | User watchlist as a saved scan scope (generalising the Photonics basket) | 1 (C5-3) | Proposal |
| U83 | feature (value 4/5) | feature | Earnings context on the stock page and a "reported in the last 5 sessions" scope | 1 (C5-4) | Proposal |
| U84 | feature (value 3/5) | feature | Configurable RSI: offer Wilder's RSI(14) with native parity | 1 (C5-9) | Proposal |
| U85 | feature (value 3/5) | feature | Export the scan as CSV/JSON with provenance columns | 1 (C5-10) | Proposal |
| U86 | feature (value 3/5) | feature | Loading, error and retry state for the embedded research tabs | 1 (C2-12) | Proposal |

## Decisions that change documented behaviour

Seven decisions in the fix work change documented or user-visible behaviour. Four of them (1, 3, 4 and 7) change what the README, the Settings text or a documented pin says. Decision 2 changes only on-screen labels, bringing them in line with the "simple trailing RSI(14)" that the native README already describes; decision 5 makes the scan follow the existing Settings text (README:55's general wording needs aligning); and decision 6 removes a visible column that no document describes. Each follows from a verified finding that showed the behaviour to be unreachable, misleading or unsafe. They describe the intended behaviour of the change; the issue table's Status column gives each issue's state in this pull request.

### 1. Technical alerts: a freshness rule replaces the zero-delay rule (U30, U31)

README:54 lets technical alerts use only quotes from "an explicitly zero-delay source", and `canRaiseTechnicalAlert` requires `delayMinutes === 0`. Yahoo's v8 chart endpoint never sends `exchangeDataDelayedBy`. It was missing from every live response the finders and verifiers fetched (US stocks and an ETF, futures, indices, a London listing, BTC-USD while it traded) and from an archived 2024 capture; the field belongs to Yahoo's v7 quote API, which answers 401 without a crumb (B2-1, C1-3, C5-1). Under the documented rule, no alert can ever fire.

The new rule makes a quote eligible when its price is positive, at least 15 daily closes exist, and the quote's own timestamp is between −60 s and +5 min old. A source that reports a delay above zero is still refused, and an unreported delay stays `null` rather than becoming 0. A delayed feed cannot produce a quote time younger than its delay, so the 5-minute age check already rejects 10–30 minute feeds (C5-1). Mapping exchanges to Yahoo's published delay table was considered and not chosen: the table lists only Nasdaq as real-time, so NYSE names such as JPM would still never alert (B2-1).

Once alerts can fire, three alert rules matter, and they change too (B2-6, C1-7):

- Alerts are rising-edge: raised when a condition appears, silent while it persists, and re-armed when it clears or a new exchange day starts. The old key `${symbol}-${type}-${quotedAt}` changes with every trade, so one unchanged condition raised 5 alerts over 5 one-minute refreshes.
- The minimum score gates only Bullish alerts. The score measures buy-side strength: at the default of 60 a gate on every type passed 0 of 8 amber breakdowns, 27 of 67 breakdowns and 9 of 34 bearish warnings. *Corrected during implementation:* the plan also gated Breakout. That figure was measured under the old breakout rule. Under the corrected rule (U41) a fresh one-month closing high has no dip or bounce to score, so a breakout scores about 40-50 in practice. A default gate of 60 would therefore have dropped every breakout, which the final review found. The Minimum score now gates Bullish alerts only.
- Bursts collapse to at most 3 toasts plus one "+N more" toast, with at most one sound per 2 s and one reused AudioContext. A depth-100 burst produced 100 toasts in a 7,548 px stack, 100 sound restarts and, for amber alerts, up to 63 AudioContexts alive at once.

The Settings text for alerts and for Yahoo's delay is reworded to match.

### 2. RSI: same calculation, labelled "Simple RSI" (U40)

The score's RSI is Cutler's simple RSI over the last 14 changes of the documented one-month window (23 daily bars). It was labelled 'RSI (14)' in the factor list and 'RSI' in the stock-page pill and the Overview column, next to Finviz's 'RSI (14)', which is Wilder's. Over 393 symbol-days the two differed by 6.5 points on average (maximum 29.2), fell in different oversold/neutral/overbought zones on 13.2% of days, and changed the verdict on 4.6% (B2-3). Switching to Wilder is not a label fix: on the 23-bar window it still disagrees on 8.4% of days, and agreement needs a 3-month history, which changes README:53's fixed one-month window and the meaning of the score. The change therefore keeps the maths, labels every app-computed value "Simple RSI", keeps Finviz's figure attributed to Finviz, and leaves a Wilder option to proposal U84 (C5-9).

### 3. electron-builder: the exact pin moves from 26.8.1 to 26.18.1 (U02)

The project documents its exact electron-builder pin at 26.8.1 as a workaround for a newer build that failed with EPERM while renaming `win-unpacked.tmp`, and README:65 says the remaining advisories are moderate and never run on a user's machine. The lockfile history shows the failing build used 26.15.3, which renamed the extracted directory exactly once. 26.15.4 (2026-06-16) added `moveDirAtomic`, which tries the rename up to five times (four retries) on ENOENT, EPERM, EBUSY and EXDEV and then falls back to copy and delete, and 26.18.1 still has it (A3-2). The pin, meanwhile, keeps all 7 high advisories in the builder chain. One of them, GHSA-7g7r-gx96-252g (CVE-2026-54672, CVSS 7.8), is in the AppImage launcher that the configured Linux target generates: its `LD_LIBRARY_PATH` puts the launch directory on the library search path, and that script does run on users' machines (A1-10). On a scratch lockfile, 26.18.1 cleared all 7. Windows packaging cannot run in the sandbox, so the windows-installer workflow validates it on the PR. A verifier notes that the copy-and-delete fallback does not retry the delete, so a file held open by antivirus could still fail a local build; the machine that originally hit EPERM is the decisive test.

### 4. TradingView: a sandboxed iframe instead of tv.js in the app document (U06, U07)

The README's Security section accepts "a TradingView widget script in the page". That script, `s3.tradingview.com/tv.js`, is appended to the document where the preload exposes `window.dipAnalyzer`. TradingView redeploys it (cached for 300 s, last modified the day before the scan), so subresource integrity cannot pin it. With a payload appended to the real tv.js under the shipped CSP, the finder reached the bridge (a `fetch-url` call returned 303,241 bytes from Finviz), rewrote the displayed quote to $1.00, created a `<webview>` and opened a window, all with zero CSP violations (A2-1). TradingView's own `widgetembed` iframe, whose URL a verifier rebuilt byte for byte from tv.js, renders the same chart under `script-src 'self'` with zero violations and removes all TradingView code from the document that holds the bridge. The iframe is sandboxed without `allow-popups`, so links inside the chart do nothing. The CSP drops TradingView from `script-src` and `connect-src`; a stricter policy measured zero violations on all seven routes (A2-3). Both verifiers rated it medium rather than high; the refute verifier pointed out that the README accepts this risk and keeps the bridge small.

### 5. Sector exclusions apply only to broad scans (U25)

Settings says excluded sectors are "left out of broad 'any sector' scans", but the scan also applied them when the user picked an excluded sector on the Overview. Picking Energy while Energy was excluded paged through every Energy loser (13 screener requests in one harness, 24 in another), kept 0 rows, showed "No stocks found matching your criteria." with no explanation, and stored the empty result as a complete, reusable scan (B3-12, C1-10). Exclusions now apply only to "any sector" scans and are left out of the scope key when a sector is picked, so picking a sector scans it. Making exclusions absolute and refusing the pick with a notice was the alternative; a verifier rejected it because it contradicts the Settings text (C1-10).

### 6. The RelVol column is removed (U26)

Both scan paths set `avgVolume` to `null`, so the Overview's RelVol column showed '-' on every row and sorting by it did nothing; commit e0d3e7a removed the path that used to fill it (B2-10). A correct value would need its own design: an unadjusted intraday ratio reads low all session, while Finviz's own RelVol is intraday-adjusted. The verifier called removing the column and its sort key the safe minimal fix.

### 7. Research webviews: private session, gesture-gated popups, five hosts (U03, U04)

README:63 says http(s) links open in the system browser, and main.cjs applied that to every webContents, including the five research webviews (Finviz, Chartmill, StockCharts, Fidelity, Yahoo), which carry ads and are created with `allowpopups`. Electron 45's `CanCreateWindow` never reads the user-gesture flag and the window-open handler's details carry none, so a scripted `window.open` from a guest page or one of its ad frames would reach `shell.openExternal` without a click (traced through the Electron 45 source, not executed); `will-attach-webview` also accepted any HTTPS host (A1-3, A2-4). The guests shared the persistent default session, whose cookies are stored in plain text while the cookie-encryption fuse is off, and their HTTPS-only lock ran only on `will-navigate`, which Electron does not emit for server redirects (A1-4).

Guests now run in an in-memory 'research' partition with deny-all permissions. A guest popup opens the system browser only right after a real click or keypress in that guest, so ordinary links in the research tabs keep working. Only the five research hosts can be attached. Downloads still go through Electron's save dialog, because blocking them would also block legitimate PDF and CSV downloads from Fidelity and StockCharts (A1-4 verifier). Loading popup targets inside the guest instead was rejected, because it would let ad frames navigate the research view without a gesture (A1-3 verifier). These findings rest on the Electron 45 sources and typings; the app could not be launched in the sandbox.

## Implementation in this pull request

The fixes were built in three waves by 14 groups, followed by a final review and four more groups. Each group owned a separate set of files, so no two groups ever edited the same file:

- **Wave 1, ten groups:**
  - dependencies and CI;
  - the Electron main process;
  - settings;
  - market maths and native;
  - futures, news and the native JSON parser;
  - the scan engine;
  - the Overview and alerts;
  - TradingView and the CSP;
  - the stock page;
  - the app shell and accessibility.
- **Wave 2, three groups:**
  - follow-ups in the state, engine, native and main-process code;
  - the browser regression scripts;
  - consistency across the pages.
- **Wave 3, one group:** lint coverage, eslint-plugin-react-hooks 7.1.1, and CI.
- **Final, four groups:**
  - code follow-ups found by the documentation fact-checks;
  - alerts and the Overview;
  - the app shell, accessibility and styles;
  - the main process, native and tooling.
  The last three fixed the final review's findings.

Each group worked in its own git worktree from the integration branch. It added tests that fail without its fix, and ran the unit, lint, build, native and browser checks.

An independent reviewer, who had not written the code, then read the group's whole diff. The reviewer:

- reproduced the original failure scenarios against the new code where that was cheap;
- re-ran every check;
- tried mutants against the new tests.

Fifteen of the 18 reviews requested changes, with 31 must-fix findings in all. Each group fixed them in a further round before its work was squash-merged as one commit. The documentation was rewritten in three passes. Each pass was checked by independent fact-checkers for accuracy, staleness and honesty.

**Verification at the head of this pull request**

- **Unit tests.** `npm test`: 319 tests pass, against 116 at the base. They also pass under `TZ=America/New_York` with `LANG=de_DE.UTF-8`, which CI now repeats.
- **Lint.** ESLint now applies its recommended rules to main.cjs, preload.cjs, the scripts and the tests as well as the renderer. It is clean with `--max-warnings 0`.
- **Native.** 7 CTest suites pass, against 6 at the base; the new one is a locale regression. The marketdata parity suite runs 15,296 cases plus its time-zone re-runs. Where a Turkish locale is available, it also runs 1,749 zone-name cases under it.
- **Browser regressions.** `npm run test:ui` passes against the dev server and against `vite preview` of the production build, with no CSP violations. CI runs it on Linux against both, and on Windows.
- **CI.** All five checks pass on the pull request:
  - Linux tests, lint, build and browser regressions;
  - Windows tests and NSIS packaging;
  - native parity on Ubuntu, on Windows and under ASan/UBSan.
- **The real app.** `npm run test:live` passes against the real Electron 45.2.1 app, in dev mode on Linux under a virtual display, with live provider data:
  - every desk loads its data;
  - the TradingView chart completes its handshake inside its sandboxed frame;
  - the Finviz research viewer runs without Node, in the in-memory research session;
  - Copy reaches the clipboard;
  - there are no page errors and no warnings.
  The packaged build was not run (dev mode carries no CSP).
- **`npm audit`.** 0 high advisories, against 10 at the base. There are 20 moderate advisories, all from one minimatch advisory in eslint and electron-builder, and 0 in production dependencies.

**Final review**

After the three waves, five independent reviewers read the whole diff from 022402f, each through one lens:

- security;
- data integrity;
- UI and accessibility;
- tests and CI;
- integration across groups.

For each lens, an adversarial verifier then tried to refute every finding by reproducing it.

- **All 27 findings were confirmed.** Four were rated major, covering three problems:
  - breakout alerts could never pass the default Minimum score (see decision 1);
  - the alert type chosen for a symbol could hide a condition the user had enabled;
  - a desk opened from a scrolled page opened part-way down, with its focused heading off-screen.
- **26 are fixed in this pull request.** Five were already fixed when the review reported, by the code follow-ups from the documentation fact-checks and by the second documentation pass. The others were fixed by the last three groups, each with its own adversarial review, and by the final documentation pass.
- **One is not.** Code running in the app window can steer an attached research viewer through the `<webview>` API to a non-HTTPS page and read it back. The proposed main-process guard would crash Chromium, so the README states the limit and the fix stays a proposal (see the near-term table).
- **Four rejected findings were re-checked.** The scan had rejected them on premises this branch changed. Three still hold: A2-8, B3-11 and C2-5. C4-9 no longer applies, because alerts are now keyed by symbol and type.

**Found during implementation**

- **Chromium versions differ on failed chunk imports.** CI's Chromium 156, which is also the Chromium in Electron 45, fetches a module again after a failed import. The sandbox's Chromium 153 keeps the failure.
  - In the shipped app, the first visit after a failed idle warm-up can therefore still load the stock page's chunk. A visit that starts while the failed warm-up is still settling shares its failure, as CI's dev-server run once showed.
  - When the chunk cannot be loaded, the desk's error panel offers Reload.
  - The browser check now accepts either behaviour and reports which one it saw.
- **The hidden-window pause would have silenced alerts.** As first planned, U37 meant a minimised window would never raise the alerts that U30 makes possible.
  - The Overview scan therefore keeps running while the window is hidden whenever an alert type is enabled.
  - Every other desk, and the Overview's Market Pulse strip, pauses.
- **Legacy scan depths.** Validating the scan depth against the presets (U19) would have turned the v1 default depth of 20, and other legacy depths, into 100 on upgrade. That is five times the requests. Whole depths from 1 to 500 are now kept.
- **Black-holed scoring.** When every Yahoo request hung, a depth-500 scan ran for about 12.5 minutes of timeouts with Refresh disabled. A scan now stops requesting charts after 16 failures in a row: 23 requests instead of 500.
- **Windows clipboard.** Text copied on Windows comes back with CRLF line breaks. The browser check folds them to LF before comparing.
- **The first real Electron run** found two bugs in `test:live` itself, not in the app. Its in-page probe never saw the TradingView frame being revealed, because the reveal is an attribute change. Its research-viewer probe also called `getURL()` from a timer that fired after the run had left the page. Both are fixed.

**Other behaviour changes**

- **Hidden window.** Desks pause auto-refresh while the window is hidden and skip the refreshes that fall due. They run one catch-up refresh when the window is shown again (U37, with the Overview exception above). The Futures desk keeps its own visible-only timer and has no catch-up.
- **Seizure Mode** is no longer in the header theme list (U63).
  - It starts from Settings → Appearance after a photosensitivity warning.
  - Its drone follows the alert sound and volume settings and can be muted.
  - It ends after 20 seconds, or earlier with End now.
- **Research webviews** need a click or key press before media plays with sound.

## Proposals and roadmap

Sixteen issues are proposals: this change does not implement them. For the ten feature proposals, value (1–5) and effort (S, M, L) come from the product reviewer. The other six are confirmed findings whose fixes are left for separate work; they had no product review, so Value shows "—" and Effort is the finder's estimate. The near-term table also lists the follow-ups that the three partial fixes leave. The split into near-term and medium-term is a suggested order, based on value, effort and the dependencies the reviewers and verifiers named.

### Near-term

| Issue | Proposal | Value | Effort | Reviewer notes |
|---|---|---|---|---|
| U81 | "Go to symbol" box and Ctrl+K to open any ticker | 5 | S | The stock page is reachable only from a symbol already listed somewhere, and the Overview search only filters scanned rows. Needs no new channel or host; validate the typed symbol with a shared pattern and encode it (C5-2). |
| U83 | Earnings context on the stock page and a "reported in the last 5 days" Overview scope | 4 | M | The quote page the stock page already downloads carries the earnings date, and Finviz's earnings-date filter works with the existing screener parser. Finviz gives no year, so show its string as-is and compute a day offset only within ±60 days (C5-4). |
| U38 | Refresh and retry controls for ETF rankings, Discovery and Oil Watch | 4 | M | Settings promises "Off means manual refresh only", yet the ETF desk has no buttons and a failed panel did not retry in 10 minutes. Disable the control while loading, as the Overview and Futures desks do (C2-7). |
| U85 | Export the scan as CSV/JSON with provenance columns | 3 | S | A Blob download worked in Chromium under the app's CSP with zero violations; Electron's save dialog was not exercised. No IPC, channel or host (C5-10). |
| U86 | Loading, error and retry state for the embedded research tabs | 3 | S | The five tabs render a bare `<webview>` with no listeners. Retries must stay user-initiated (C2-12). |
| U80 | Run the live Finviz smoke test on a schedule | 3 | S | Finviz broke the parser twice in four days (fixes on 10-17 and 10-21). Provider terms need a decision: screener.ashx redirects to a path Finviz's robots.txt disallows for generic agents, although 8 requests a day is fewer than one app scan, and a public repository's logs would republish one symbol and price per view (A3-12). |
| U78 | Vite 8 and ESLint 10 | — | M | Vite 8 builds 4–5x faster with slightly smaller chunks and passed a 7-route production smoke test. ESLint 10 needs eslint-plugin-react-hooks 7.1.1, which this pull request adopts (A3-11). |
| U10 follow-up | release.yml build/publish split and provenance attestation | — | — | Needs new third-party actions whose pinned SHAs could not be verified from the sandbox. Releases already wait for the CI and native suites, and signing secrets reach only the installer step. |
| U41 follow-up | Pass the quote's own session to the breakout rule | — | S | `analyzeStock` receives only closes and a price, so it takes the last bar as the current session. When a provider series lacks the quote's own bar, yesterday's close is left out of the prior high. Fixing it means passing session information from `getYahooQuote` through the scan store, the stock page and Oil Watch. |
| Final review (security-2) | Research viewers that code in the app window cannot steer | — | M | The HTTPS lock covers navigations a viewer's own page starts and server redirects, not loads started through the `<webview>` API. A guard on 'did-start-navigation' that stops the load would crash Chromium. The options are main-process-owned viewers (WebContentsView, so `webviewTag` can be turned off) or refusing file: and http: loads on the research session. Neither could be tested without an Electron binary when this was reviewed. |
| Small follow-ups | The alert drawer covers its own toggle and toasts; a focused toast that expires drops focus to the page; unit tests for the error boundary's new reset contract | — | S | Found in the last reviews, all minor; the first two predate this change. |
| U77 follow-up | Run `build_exe.bat` without elevation | — | S | In electron-builder 26.18.1 an unsigned NSIS build should no longer need the winCodeSign archive, but no standard-user Windows build has confirmed it yet. |

### Medium-term

| Issue | Proposal | Value | Effort | Reviewer notes |
|---|---|---|---|---|
| U82 | User watchlist as a saved scan scope, generalising the Photonics basket | 4 | M | Finviz's ticker-list screener parsed 6 of 6 rows live, with market cap, volume and sector, at one allowlisted request per 20 names. "Reset all" and settings import would silently empty a watchlist stored in settings; those paths need handling (C5-3). |
| U84 | Configurable RSI with Wilder's RSI(14) and native parity | 3 | M | Changes the meaning of the score and README:53. Keep "simple" as the default and dip, bounce and EMA on the last month, and add the RSI method to the scan key. Wilder over 126 bars matched the full-history value within 0.01 (C5-9). |
| U73 | Logic and component tests for the untested desks, plus a coverage gate that counts what ships | 3 | M | All 3,265 lines of `.jsx` are at 0%. Once main.cjs is visible to coverage, a 90% gate fails at 87.54%, so the threshold needs calibrating (B4-12). |
| U72 | Automated accessibility gate | — | M | "Zero serious violations" alone would miss contrast on gradient backgrounds (axe reports the 1.2:1 Sell chip as incomplete), and today's violations must be fixed or allow-listed first or the gate starts red (C3-12). |
| U16 | Provider requests on Chromium's network stack, on an in-memory session | 3 | M | Node's fetch ignores system and PAC proxies and the OS trust store. In the sandbox the real handler failed after 2.1 s and worked only with `NODE_USE_ENV_PROXY` set, and packaged Electron ignores almost all NODE_OPTIONS, so users cannot work around a system or PAC proxy themselves. The session must stay in-memory and keep `cache: 'no-store'` (A1-11). |
| U09 | Electron fuses: RunAsNode, NODE_OPTIONS and --inspect off; asar integrity and cookie encryption on | — | S | Turning NODE_OPTIONS off also ignores `NODE_EXTRA_CA_CERTS`, which users behind TLS-inspecting proxies may rely on until U16 lands; cookie encryption is one-way (A1-6). |
| U08 | Serve the app from an app:// protocol instead of file:// | — | M | Allows the file-protocol privileges fuse to be turned off afterwards. The origin change orphans localStorage (settings, alert history, sector) unless it is migrated, and origin checks must compare protocol and host, because Node's URL reports the origin of app://bundle as 'null' (A1-5). |
| U68 | Replace recharts with a small SVG chart | — | M | recharts and its dependencies are about 358 of the 375 KB StockDetails chunk. recharts 3 provides keyboard navigation of the chart that a pointer-only replacement would lose, and the live-Electron check waits on `.recharts-surface` (C4-7). |
| U56 | Embeddable native CMake | — | M | Matters only once a native host consumes the core; none exists yet (A4-7). |

Taken together, the review and verifier notes suggest an order for the Electron hardening items: U16 first, so that users behind TLS-inspecting proxies no longer depend on `NODE_EXTRA_CA_CERTS`; then the fuses in U09; then U08, after which the file-protocol privileges fuse can be turned off as well.

### Not recommended

| Idea | Source | Reason |
|---|---|---|
| A WebAssembly build of the native core | A4 and C5 finders | Scoring is not a bottleneck: `analyzeStock` takes 2.7 µs per call in JS, 1.33 ms for 500 symbols. WebAssembly fails to compile under the app's CSP unless `'wasm-unsafe-eval'` is added. |
| An N-API addon for the native core | A4 finder | It would move untrusted-payload parsing from the sandboxed renderer into the privileged main process for no measurable CPU gain; the one measured CPU hotspot (U39) is a three-line JS fix. A verifier added that no tracked document proposes N-API or WASM, and that an addon could run in an Electron utility process instead. |
| Score backtest: an on-demand 5-year replay of each verdict's hit rate (C5-8) | Product review, value 2 | The per-verdict hit rates are noise: the reviewer's replay of AAPL, NKE and PFE gave Strong Buy 54.2% against a 49.8% base, the finder's six symbols gave 49.9% against 51.1%, and per-symbol 95% intervals are about ±14–22 points. A hit-rate table over overlapping windows would also present the score as a calibrated probability, which README:53 says it is not. |
| Keep the last scan across restarts as a stale snapshot (C5-11) | Product review, value 2 | On a normal start the snapshot would be visible only until the first page of the new scan lands (about 0.9 s per the README), and a partial failure would lose it. It survives only when the session's first scan fails outright, and then it shows yesterday's losers. |

The C5 finder folded OS notifications into its alerts finding (C5-1), since they make sense only once alerts can fire, and set aside two ideas without proposing them: signed auto-update, which should wait because releases are unsigned, electron-updater would ship inside the app and an update check would contact a new host; and Linux/macOS packaging in CI, which is low priority while the project builds and tests only on Windows.

## Rejected findings

| Finding | Claim | Why the verifiers rejected it |
|---|---|---|
| A2-8 | The stock page puts the route symbol into the Finviz URL unencoded and never checks which ticker the page returned. | Nothing in the app can produce such a symbol: every stock link uses a parser-validated or hard-coded ticker. The proposed ticker check would hide statistics and news whenever Finviz changes its header markup. |
| A3-9 | The Node version policy is undeclared and untested. | No harm shown: the README states the 22.12 floor, dependencies already warn below it, and ESLint 10, `npm test` and the build all passed on Node 22.12.0. |
| A4-8 | Strategy: keep the native core as a frozen reference, because N-API and WASM are not justified and its CI gate taxes JS-only changes. | A strategy opinion, not a defect, with a false cost premise: the native check is not a required status check, its last 15 runs passed in about 90 s, and none of the six reference files has changed since the port. Narrowing its triggers would let the verified specification drift, and the N-API/WASM advice answers no actual proposal. |
| B1-3 | The Futures desk's "Previous close" contradicts the displayed change for 49 of 60 instruments. | The change percentage is measured from that previous close in 60 of 60 live records; previous close plus change is the settlement price, and the captures were taken after Friday's close. |
| B2-9 | Daily bars sharing a date are not collapsed, so a duplicate in-session Yahoo row would be scored twice. | The trigger is unproven: no fetched response had two bars on one date, and a legacy yfinance workaround does not show that the endpoint the app uses is affected today. |
| B3-10 | A settings document from a newer schema version is discarded and overwritten. | Every released build writes version 2 under a storage key that names the version, so a future schema would use a new key; the scenario needs a hypothetical v3 on the old key plus an unsupported downgrade. |
| B3-11 | The scan store and the alert de-duplication set grow without bound. | The alert set is never created with live Yahoo data, because alerts cannot fire; the scan map grows per distinct scope, not over time, and keeping old scopes is deliberate. |
| C2-5 | The stock page's Refresh and auto-refresh are answered from the chart cache. | Documented behaviour: the README and the Settings hint say the chart cache applies to the stock page, the cache is off by default, and the page shows the original retrieval time. |
| C4-9 | The alert de-duplication key includes the quote time, so every refresh re-alerts. | Unreachable today, because alerts cannot fire. The verifier endorsed per-symbol de-duplication for when they can, which is the rising-edge rule U31 adopts. |
| C5-8 | Feature: an on-demand 5-year replay showing how each verdict has performed. | Value 2: the hit rates are noise and would present the score as calibrated, against README:53 (see Not recommended). |
| C5-11 | Feature: keep the last completed scan across restarts as a stale snapshot. | Value 2: on a normal start it would show for about 0.9 s, and it survives only when the first scan fails outright (see Not recommended). |

## Limitations

- **No running Electron app during the scan.** The scan established main-process behaviour (window-open handling, webview attachment, permissions, redirects) from the Electron 45 sources and typings, and exercised it through vm harnesses around main.cjs. At the end of this pull request the real app was run (see Implementation). The webview popup finding (A2-4) was verified from source but not executed. The clipboard failure behind U13 could not be reproduced in headless Chromium, which allowed the write; it rests on the Electron 45 typings and reports from other Electron projects. Cross-window behaviour and the save dialog that a CSV export would open (U85) were not tested.
- **Windows packaging.** Everything ran on Linux. Windows packaging, including whether electron-builder 26.18.1 avoids the original EPERM failure, is validated only by the windows-installer CI workflow.
- **Browser and fonts.** Playwright 1.64 expects Chromium build 1248; the sandbox had build 1243 (Chrome for Testing 153), which the agents launched explicitly. The two differ in one behaviour that matters here: 153 keeps a failed module import failed, while 156 (Playwright's build, and the Chromium in Electron 45) fetches it again. The narrow-viewport check in verify-ui depends on installed fonts: Inter, Liberation Sans and DejaVu Sans overflow at 390 px, Carlito does not.
- **Shared machine.** Timings come from a shared 4-CPU VM under load from other agents (load averages from 3.5 to about 11), so absolute timings are indicative only: C4 gives ranges over several runs and C2 claims only relative ordering, while single figures elsewhere come from one or a few runs.
- **Market hours.** Live captures were taken after Friday's close (2026-10-30) and on Saturday 2026-10-31. In-session behaviour was exercised with BTC-USD, which trades around the clock, and with recorded or synthetic fresh quotes; a real in-session duplicate daily bar (B2-9) was never observed.
- **Provider snapshot.** Findings about Finviz, Yahoo and Google News (for example U29, U30, U45, U47 and U48) describe their responses on the scan date, and Finviz broke the parser twice in four days earlier in October. Live requests were kept few. Finviz answered some with a Cloudflare 403; Electron's GitHub PR pages returned 403 through the proxy, so CVEs could not be mapped to individual Electron releases; and Finviz's response to an `r=` offset past the end of the results was not verified.
- **Seen but not reported.** The A1 finder judged four items too low in value to report: there is no single-instance lock, the default menu still offers DevTools in production, IPC handlers do not check the sender, and the allowlist ignores the port. cppcheck was not available for the native core.

### Coverage gaps

A completeness review of the scan named the gaps below. Leads are unverified and are not among the 86 issues.

**Not exercised**

- **Electron.** During the scan the app never ran in Electron, yet most planned security fixes (gesture-gated guest popups, the 'research' partition, the redirect lock, the clipboard exception, the TradingView iframe handshake) change Electron-only behaviour. *Partly exercised since:* `npm run test:live` passes against the real Electron 45.2.1 app in dev mode on Linux. That covers the research partition, the guest without Node, the clipboard exception and the TradingView handshake. Still unexercised: the gesture-gated popups, autoplay, the packaged build and its CSP. Before release, run the PR's installer through a short manual checklist, and run `npm run test:live` against the packaged build (`ELECTRON_EXE`).
- **Windows.** No install, upgrade over a 2.1.0 profile, uninstall or standard-user `build_exe.bat` run, so U17 and U19 first meet real profiles on upgrade, and decision 3 rests on reading electron-builder's source. The configured AppImage and mac targets are never built.
- **Market hours.** No equity or futures data was captured during a US session, so decision 1's quote-age window (also sensitive to PC clock skew), U41's breakout rule, U47's tolerance and U31's re-arm were designed on closed-market data.
- **Provider volume.** Every scale test used stubbed providers, so nothing measured how Finviz, Yahoo or Google respond from one IP at the rates the settings allow (about 25 Finviz pages and 500 Yahoo charts a minute at depth 500 with a 1-minute refresh). U20's new stop rule also relies on Finviz behaviour past the last result that was never observed.
- **Other.** No screen-reader pass and no multi-hour soak test. Four tracked files were neither read nor cited: docs/crypto_micro_scalp_strategy.md, docs/superpowers/plans/2026-10-10-futures-integrity.md and the two docs/screenshots PNGs.

**Unverified claims and premises**

- U13, U03, U04 and U08 rest on Electron or Chromium source, typings or other projects' reports, and their fixes add untested assumptions ('input-event' on guest webContents, a partition forced in `will-attach-webview`, the 'clipboard-sanitized-write' permission name). *Since observed in the real app:* the forced partition (U04) and the clipboard exception (U13). The 'input-event' popup gate (U03) and U08 remain unexercised. U01's verifiers disagree on its brotli rationale, so its severity rests on the Chromium backports.
- C4-9, B3-11, C2-5 and A2-8 were rejected on premises that U30, U17 and U81 remove, and U37's planned pause while hidden would silence the newly working alerts whenever the window is minimised. Re-check these on the integrated branch. *Re-checked by the final review:* A2-8, B3-11 and C2-5 still hold, and C4-9 no longer applies. The Overview keeps scanning while hidden whenever an alert type is enabled, and a browser regression guards it.

**Leads (unverified)**

- **Forced colors.** Under Windows High Contrast every keyboard focus ring may vanish, because all focus styles are `outline: none` plus a box-shadow and no rule targets forced colors. This was seen only in Chromium's forced-colors emulation, and the U33, U61 and U63 fixes reuse the same ring. *Addressed in this pull request:* focus shows as a system Highlight outline under forced colors, checked in the same emulation.
- **U58 recovery.** The plan lets the next render retry a failed chunk import, but four verifiers found that Chromium caches the failure. Stock links may stay dead unless the error boundary's Reload reloads the window, through `location.reload()` or Vite's `vite:preloadError`. *Resolved:* the error panel's Reload reloads the window. The verifiers' Chromium 153 does keep the failure, but Chromium 156, which Electron 45 ships and CI uses, fetches the chunk again, so the first visit after a failed warm-up can still load it (see Implementation).
- **Electron defaults.** Research webviews may autoplay media without a click, and nothing handles `render-process-gone`. *Partly addressed:* research webviews now need a click or key press before media plays with sound; `render-process-gone` is still unhandled.

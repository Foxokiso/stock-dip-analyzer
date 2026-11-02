---
name: fix-finviz-parsing
description: Repair the Finviz screener, quote-page or futures parsing when a desk shows no rows or missing columns, the app reports a Finviz layout change, or npm run test:finviz fails. Use when Finviz has changed its markup, URLs or API.
---

# Repair Finviz parsing

Finviz changes its pages from time to time (it last changed the screener grid on 2026-10-21). The parsers bind to stable attributes, and recorded fixtures pin each layout they have handled.

1. **See what broke.** The live check fetches every view the desks request and runs the app's parsers on them:

```bash
npm run test:finviz
```

Each line names a view (`overview losers p1`, `overview losers p2`, `overview sector`, `etf 1-month`, `etf dividend`, `etf 1-year`, `discovery`, `quote page`, `futures api`). A view that fails returned no rows, started at the wrong row, ignored its filter or signal, lost a statistic or was redirected.

2. **Find the code.**

| What broke | Parser | URLs built in |
|---|---|---|
| Screener grids (Overview, Discovery, ETF rankings) | `parseFinvizScreenerPage` in `src/utils/finviz.js` | `src/state/scanStore.js`, `src/pages/Discovery.jsx`, `src/pages/ETFAwards.jsx` |
| Stock page statistics, 52-week range, headlines | `parseFinvizQuotePage` in `src/utils/finvizQuote.js` | `finvizQuoteUrl` in the same file |
| Futures desk | `src/services/futures.js` | the same file |

3. **Record the new layout as a fixture.** Save the live page, trim it the way `tests/fixtures/README.md` describes (keep the result-count line, the header row and two or three rows; remove scripts, styles and icons; leave the remaining markup untouched) and save it as `tests/fixtures/finviz-<view>-<YYYY-MM-DD>.html`. Add a paragraph to `tests/fixtures/README.md` with its URL, retrieval time and what was trimmed.

4. **Write the failing test first** in `tests/finviz.test.js`, `tests/finvizQuote.test.js` or `tests/futures.test.js`, against the new fixture. Keep the tests on older fixtures passing unless Finviz no longer serves that layout; if so, say so in the fixture README.

5. **Fix the parser.** Bind by stable attributes (`data-column-id`, `data-ticker`, accessible names), never by column position. Do not fill a value that is now missing with a default: it stays unavailable.

6. **Check it.** A change to `src/services/futures.js` also needs the native parity suites (`.agents/rules/native-parity.md`).

```bash
npm run test:finviz
npm run verify
```

7. **Record it** in `CHANGELOG.md` under `## Unreleased`: what Finviz changed, on which date, and what the parser now reads.

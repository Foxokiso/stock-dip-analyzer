# Stock Dip Analyzer Pro

A desktop market research workspace built with React, Vite, and Electron. Finviz is the primary stock screener and futures reference; Yahoo Finance supplies historical technical analysis and market context. Google News RSS supplies the Oil Watch headlines.

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

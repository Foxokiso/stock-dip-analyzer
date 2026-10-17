# C++ native reengineering: baseline and design

## Requested result

Replace Electron and move application control and responsiveness-critical work
into C++, preserve all current features, choose an appropriate graphical frontend,
and review/test the replacement. The current reference is PR #6 at
`fa2fe86d1561959a7088a036554c20ff118a6ba7`. This work has its own
`feat/cpp-native-reengineering` branch; do not merge or publish either branch.

## Chosen direction

C++20 domain/services, Qt 6 networking and models, Qt Quick/QML presentation,
and Qt WebEngine only for embedded research content that requires a browser.
QML owns layout, visual states and presentation animations. C++ owns market
models, parsing, scoring, scheduling, cancellation, source provenance, settings,
alerts and audio lifecycle. Business rules must not be duplicated in QML.

Qt Quick's scene graph can render on a separate thread; this does not guarantee
better latency. Measure input latency, frame times, CPU, resident memory and scan
duration on the same machine and fixtures before claiming a performance gain.
No renderer may perform blocking network calls or bulk parsing/scoring.

The initial deliverable is a portable scoring core with fixture parity checks.
It is not a functioning native replacement. Qt is absent from this Linux
workspace, so the Qt frontend, network adapters and Windows native deployment
cannot be presented as compiled or exercised here.

## Feature parity inventory

| Current feature | Reference | Native responsibility |
| --- | --- | --- |
| Overview, screening, sectors, combined Sell filter | Dashboard.jsx, finviz.js | C++ scanner, parser, filter model; QML table |
| Shared score and factor breakdown | scoring.js, StockCard.jsx | One C++ analysis engine used by every view |
| 59 futures instruments, seven groups, search, units/fractions, source sparklines | Futures.jsx, futures.js | C++ futures model/parser; QML list and chart |
| Delayed/cached/unavailable states, retrieval/source timestamps, unknown expiry | futures.js, marketData.js | Explicit C++ snapshot/quote value types |
| Stock detail chart ranges and fixed one-month scoring | StockDetails.jsx | Separate chart and analysis requests/models |
| TradingView chart loading/retry/cleanup | tradingView.js | Restricted WebEngine view; preserve lifecycle semantics |
| Finviz, Chartmill, StockCharts, Fidelity, Yahoo embedded research | StockDetails.jsx | Isolated WebEngine profile without privileged bridge |
| ETF rankings and published criteria | ETFAwards.jsx | C++ ranking/filter model; QML view |
| Oil Watch baskets, tanker/refiner scores, RSS conflict tags | OilWatch.jsx, oilNews.js | C++ baskets/RSS parser; QML panels |
| Unusual-volume/volatility discovery | Discovery.jsx | C++ screener request/model |
| Market pulse and history sparklines | MarketPulse.jsx | C++ quote aggregation; QML visualizations |
| Alert eligibility, persistent history, siren/audio cleanup | LiveAlerts.jsx, marketData.js | C++ policy/storage/audio service |
| Themes, sector exclusion, chart count, refresh interval | App.jsx, Dashboard.jsx | C++ settings migration; QML preferences |
| Optional visual/audio mode and real local-news display | App.jsx, telemetry.js | C++ lifecycle/news provider; QML effects |
| Window lifecycle and external HTTP(S) links | main.cjs | Native Qt window and validated system-browser launch |
| Per-host cookies, retries, timeouts and Yahoo requests | main.cjs | C++ asynchronous Qt Network service |
| Windows install/upgrade/uninstall | Electron Builder + NSIS | Native deployment with Qt dependencies; separate validation |

## Structural contracts

- A bounded request queue owns scan concurrency; cancellation and generation IDs
  prevent superseded requests from updating models. Auto-refresh must not restart
  an active scan continuously.
- Network operations are asynchronous; expensive parse/analysis runs in a bounded
  worker pool. UI model publication happens only on the GUI thread, in batches.
- Preserve previous actual data on refresh failure with its original successful
  retrieval time and an explicit cached status. Never create substitute prices,
  fabricated history, default ratings or invented headlines.
- Keep missing values distinct from zero. Preserve Treasury fractional precision.
  Treat source quote time and retrieval time separately.
- Use the existing fixed one-month scoring period, factor thresholds and simple
  trailing RSI rather than silently changing strategy semantics during the port.
- Market providers remain delayed/unreliable. Native code cannot remove source
  delays or establish real-time entitlements.
- Remote research pages receive no native privileged objects. The application
  interface uses typed commands rather than arbitrary JavaScript/native access.
- Migrate saved settings and alert history with versioned schemas and backups.
  Preserve a fallback to the existing application until migration parity passes.

## Validation and review

Port the seven existing regression suites into native equivalents and compare
native output against recorded fixtures and current JavaScript behavior. Retain
the original 52 tests as reference checks. Add concurrency/cancellation, timeout,
partial-failure, shutdown and missing-data tests. Use deterministic source fixtures
for UI parity; live-provider checks remain separate.

The repository contains no historical trade simulator, fill/slippage model,
transaction-cost configuration, or backtest reports. Regression parity is not
evidence of profitable trading. Whether a historical strategy backtest is an
additional deliverable remains to be clarified before designing that subsystem.

Review boundaries include numerical parity, all routes, embedded-site isolation,
state migration, threaded model updates, audio teardown, Windows packaging and
measured responsiveness. Do not declare the rewrite complete until those checks
have passed; do not invent a backtest outcome or a speedup.

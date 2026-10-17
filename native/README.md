# Native reengineering — initial core

This is an initial C++20 numerical scoring library, not a native application.
The Electron/React application remains the feature reference. It is not connected
to this library. No Qt frontend, native networking, installer, or trading backtest
exists in this directory yet.

The core preserves the reference score, verdict, EMA5/EMA10, simple trailing
RSI(14), post-peak structure, factor labels/points, trend flags and sparkline.
This numerical API accepts doubles and an optional live quote. The remaining
renderer logic is ported module by module under `native/modules/<name>/`, each
with its own README, header under `include/dip/` and parity driver: `format`
(display strings), `jsonlite` + `futures` (strict JSON and Finviz futures
parsing), `marketdata` (Yahoo quote validation and session/timezone handling),
`oilnews` (headline source split and impact flags) and `palette` (the Pierce/27
token table, regenerated from `src/styles/tokens.css`). Factor explanation
strings stay presentation work in the renderer.

## Build and compare

The verifiers use Node.js and the locked development dependencies (including
`linkedom` for the oil-news reference). From the repository root:

```bash
npm ci --include=dev --ignore-scripts --no-audit --no-fund
cmake -S native -B artifacts/native-build
cmake --build artifacts/native-build --config Release
ctest --test-dir artifacts/native-build -C Release --output-on-failure
```

Or with GCC where CMake is unavailable:

```bash
mkdir -p artifacts/native
g++ -std=c++20 -Wall -Wextra -Werror -pedantic -I native/include \
  native/src/analysis.cpp native/tests/analysis_driver.cpp \
  -o artifacts/native/analysis-driver
node scripts/verify-native-analysis.mjs ./artifacts/native/analysis-driver
```

The deterministic parity suite compares against `src/utils/scoring.js`. Its
528 cases cover missing/invalid bars and quotes, insufficient data, repeated/new
peaks, dip thresholds, trend/RSI/factor decisions and seeded price series. Numerical
comparison uses relative tolerance `1e-12`. This verifies preservation of existing
behavior, not strategy profitability, robustness on every possible numeric input,
UI responsiveness or Windows runtime behavior. The test driver is not a shipped
API and is excluded when configuring `BUILD_TESTING=OFF`.

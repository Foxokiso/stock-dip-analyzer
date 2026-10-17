# Native reengineering — initial core

This is an initial C++20 numerical scoring library, not a native application.
The Electron/React application remains the feature reference. It is not connected
to this library. No Qt frontend, native networking, installer, or trading backtest
exists in this directory yet.

The core preserves the reference score, verdict, EMA5/EMA10, simple trailing
RSI(14), post-peak structure, factor labels/points, trend flags and sparkline.
Factor explanation strings and theme colors remain presentation work. Provider
JSON validation, session/timezone handling and futures parsing are separate ports
still required; this numerical API accepts doubles and an optional live quote.

## Build and compare

```bash
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

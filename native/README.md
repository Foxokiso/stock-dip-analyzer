# Native reengineering — initial core

This is an initial C++20 numerical scoring library, not a native application.
The Electron/React application remains the feature reference. It is not connected
to this library. No Qt frontend, native networking, installer, or trading backtest
exists in this directory yet.

The core preserves the reference score, verdict, EMA5/EMA10, simple trailing
RSI(14) (Cutler's, which the app labels "Simple RSI"; not Wilder's), post-peak
structure, factor labels/points, trend flags, breakout and breakdown flags and
sparkline. This numerical API accepts doubles and an optional live quote. The remaining
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
cmake -S native -B artifacts/native-build -DCMAKE_BUILD_TYPE=Release
cmake --build artifacts/native-build --config Release
ctest --test-dir artifacts/native-build -C Release --output-on-failure
```

Single-configuration generators (Makefiles, Ninja) take the build type from
`-DCMAKE_BUILD_TYPE`; Visual Studio ignores it and builds the `--config` given.
CI (`.github/workflows/native-core.yml`) runs these steps on Ubuntu and Windows,
and again on Ubuntu as a Debug build with
`-fsanitize=address,undefined -fno-sanitize-recover=undefined`, where a sanitizer
report fails the parity test it occurs in.

Toolchain: `dip::jsonlite` (and with it `dip::futures`) and the scoring, format and
marketdata drivers read numbers with floating-point `std::from_chars`, and
`dip::format` writes them with floating-point `std::to_chars`, so the standard
library must provide both: libstdc++ 11+ (GCC 11+), MSVC 2019 16.4+ or libc++ 20+.
libc++ 14 to 19 have `std::to_chars` for `double` but not `std::from_chars`.

Or with GCC where CMake is unavailable:

```bash
mkdir -p artifacts/native
g++ -std=c++20 -Wall -Wextra -Werror -pedantic -I native/include \
  native/src/analysis.cpp native/tests/analysis_driver.cpp \
  -o artifacts/native/analysis-driver
node scripts/verify-native-analysis.mjs ./artifacts/native/analysis-driver
```

The deterministic parity suite compares against `src/utils/scoring.js`. Its
659 cases cover missing/invalid bars and quotes, insufficient data, repeated/new
peaks, dip thresholds, trend/RSI/factor decisions, the breakout and breakdown
boundaries (the length of the base before a breakout, a second top at the high,
the 0.5 % and 5 % breakdown edges), subnormal and near-overflow closes, and seeded
price series. Numerical comparison uses relative tolerance `1e-12`; `NaN` and
`±Infinity` must match exactly. This verifies preservation of existing
behavior, not strategy profitability, robustness on every possible numeric input,
UI responsiveness or Windows runtime behavior. The test driver is not a shipped
API and is excluded when configuring `BUILD_TESTING=OFF`.

## What CTest runs

Each parity script (`scripts/verify-native-*.mjs`) prints how many cases it compared. At the time of writing:

| CTest name | Reference | Cases |
| --- | --- | --- |
| `scoring_reference_parity` | `src/utils/scoring.js` | 659 |
| `format_reference_parity` | `src/utils/format.js` | 3,321 |
| `futures_reference_parity` | `src/services/futures.js` | 634 (560 snapshots, 73 rejections, 1 documented divergence), plus a 150,000-member object parsed in linear time |
| `marketdata_reference_parity` | `src/utils/marketData.js` | 15,296; then 272 local-time cases re-run under four `TZ` zones and 1,749 zone-name cases re-run under a Turkish `LC_CTYPE` |
| `oilnews_reference_parity` | `src/utils/oilNews.js` | 3,917 |
| `palette_reference_parity` | `src/styles/tokens.css` | 1,008 |
| `locale_regression` | — | JSON numbers and the recorded futures fixture under a comma-decimal C locale |

The module READMEs describe what each suite covers.

## Locales and time zones

A host program may set the C locale from the environment (`setlocale(LC_ALL, "")`),
so the library does not depend on it. `dip::jsonlite` reads numbers with
`std::from_chars` and `dip::format` writes digits with `std::to_chars` and its own
rounding, so a comma-decimal locale such as `de_DE.UTF-8` cannot change a parsed
or printed value; the scoring, format, marketdata and oil-news drivers read their
input with `std::from_chars` too. `locale_regression` checks the JSON side under
a comma-decimal locale, and exits with CTest's skip status only when none is
available. Time-zone names are matched by folding ASCII letters only:
`std::tolower` would leave `I` unfolded under a Turkish `LC_CTYPE` and send
`europe/istanbul` to the UTC fallback. The marketdata parity script repeats those
lookups under a Turkish `LC_CTYPE` (`tr_TR.UTF-8` on Linux), and skips that run
with a warning where no Turkish locale exists. On Linux the configure step compiles `de_DE.UTF-8` and
`tr_TR.UTF-8` into `<build>/locales` with `localedef` when glibc's locale sources
are installed, so both checks also run on CI images that ship no such locale. The
host time zone for local-time `Date.parse` forms is taken from `TZ` the way V8
takes it; see [`modules/marketdata/README.md`](modules/marketdata/README.md).

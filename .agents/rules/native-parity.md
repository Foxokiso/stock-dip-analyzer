---
trigger: glob
globs: "native/**, src/utils/scoring.js, src/utils/format.js, src/utils/marketData.js, src/utils/oilNews.js, src/services/futures.js, src/styles/tokens.css, scripts/verify-native-*.mjs, scripts/gen-native-palette.mjs"
description: "Keep the C++ core in native/ in step with the JavaScript modules it mirrors, and run its parity suites."
---

# Native parity

The C++20 core in `native/` mirrors these renderer modules, and a parity script compares the two on thousands of deterministic cases:

| JavaScript reference | C++ | Parity script |
|---|---|---|
| `src/utils/scoring.js` | `native/src/analysis.cpp`, `native/include/dip/analysis.hpp` | `scripts/verify-native-analysis.mjs` |
| `src/utils/format.js` | `native/modules/format/` | `scripts/verify-native-format.mjs` |
| `src/services/futures.js` | `native/modules/futures/` with `native/modules/jsonlite/` | `scripts/verify-native-futures.mjs` |
| `src/utils/marketData.js` | `native/modules/marketdata/` | `scripts/verify-native-marketdata.mjs` |
| `src/utils/oilNews.js` | `native/modules/oilnews/` | `scripts/verify-native-oilnews.mjs` |
| `src/styles/tokens.css` | `native/modules/palette/` (generated header) | `scripts/verify-native-palette.mjs` |

When you change the behaviour of a reference module:

1. Make the same change in the C++ module, or record a deliberate divergence in that module's README the way the existing ones are recorded.
2. After editing `src/styles/tokens.css`, regenerate the palette header with `node scripts/gen-native-palette.mjs`; `node scripts/gen-native-palette.mjs --check` exits 1 when the committed header has drifted.
3. Build and run the parity suites from the repository root (CMake 3.20 or later and a C++20 compiler):

```bash
cmake -S native -B artifacts/native-build -DCMAKE_BUILD_TYPE=Release
cmake --build artifacts/native-build --config Release
ctest --test-dir artifacts/native-build -C Release --output-on-failure
```

4. If a parity script now reports a different number of cases, update the counts in the table in `native/README.md`.

A refactor with no behaviour change still needs the suites to pass. CI runs them (`.github/workflows/native-core.yml`, on Ubuntu, Windows and an ASan + UBSan build) for every pull request that touches these files.

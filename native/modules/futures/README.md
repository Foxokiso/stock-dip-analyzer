# dip::futures (and dip::jsonlite)

A C++20 port of the pure parts of `src/services/futures.js`, built on `dip::jsonlite`, a
strict RFC 8259 reader with JavaScript's object semantics (insertion order, duplicate keys
replaced in place, `__proto__` an ordinary key, enumeration order of array-index keys).
Both preserve the existing behavior of the reference application for regression parity;
neither is a trading backtest, and neither performs network access or reads a clock.

Ported: `FUTURES_GROUPS` / group lookup, bond symbols and units, the symbol-key filter, the
`readPayload` rule (raw JSON, or only the Finviz page's `<script id="futures-init-data"
type="application/json">` body, never anything executable), `sourceQuote` validation and
`parseFinvizFutures` including its three rejection cases. `fetchedAt` is a caller-supplied
normalized ISO-8601 string.

Not ported: `fetchFinvizFutures`, `mergePrevious`, `failedSnapshot` (they need IPC, a clock
or previous state).

## Build and compare

```bash
cmake -S native -B artifacts/native-futures -G "Visual Studio 18 2026" -A x64
cmake --build artifacts/native-futures --config Release
ctest --test-dir artifacts/native-futures -C Release -R futures_reference_parity --output-on-failure
```

`scripts/verify-native-futures.mjs` feeds the recorded 59-instrument fixture
(`tests/fixtures/futures-reference.json`), its HTML-wrapped variants, every malformed,
executable and empty case from `tests/futures.test.js`, explicit record mutations and 300
seeded mutations through `futures_driver` and compares every snapshot and quote field with
`parseFinvizFutures` (relative tolerance 1e-12 for doubles, exact for strings; rejections
must match rejections).

## Known divergences

* `dip::jsonlite` refuses nesting deeper than `kMaxDepth` (512); `JSON.parse` only fails
  much deeper, on stack exhaustion. Finviz payloads nest three levels.
* A JavaScript `NaN` cannot be written in JSON text, so the NaN branch of the reference's
  unit test (an object input) is covered here only through non-finite literals such as
  `1e999`, which both sides treat as "not numeric".

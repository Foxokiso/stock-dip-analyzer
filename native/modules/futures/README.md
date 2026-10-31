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

Input is the provider's bytes. The renderer only ever parses text that `Response.text()`
decoded, so `readPayload` first applies the same WHATWG UTF-8 decode
(`jsonlite::decodeUtf8Lossy`: leading BOM dropped, each ill-formed sequence one U+FFFD). A
mis-encoded byte inside a label therefore keeps the payload (the label shows U+FFFD), and a
stray byte outside a string, such as 0xA0 or an overlong space, is a JSON error rather than
whitespace. Numbers are read with `std::from_chars`, so the host's C locale cannot change them.

`sourceQuote` keeps a sparkline only when its last sample agrees with the quote:
`|last sample - last| <= max(0.5 % of |last|, high - low)`, where a missing high or low counts
as no range. Finviz's 5-minute series for a thin market can be a months-old history that ends
far from the quote (TIO's ended at 211.8 against 90.71); such a row keeps its quote, drops its
samples and chart labels, and carries `chartNote` (`kChartMismatchNote`) so the desk can say
why it draws no chart.

Not ported: `fetchFinvizFutures`, `mergePrevious`, `failedSnapshot` (they need IPC, a clock
or previous state) and `changeDirection` (presentation).

## Build and compare

```bash
cmake -S native -B artifacts/native-futures -G "Visual Studio 18 2026" -A x64
cmake --build artifacts/native-futures --config Release
ctest --test-dir artifacts/native-futures -C Release -R futures_reference_parity --output-on-failure
```

`scripts/verify-native-futures.mjs` feeds the recorded 59-instrument fixture
(`tests/fixtures/futures-reference.json`), its HTML-wrapped variants, every malformed,
executable and empty case from `tests/futures.test.js`, explicit record mutations, the
chart-agreement edges and the real stale series in `tests/fixtures/futures-i5-2026-10-31.json`,
ill-formed UTF-8 bytes (compared with `parseFinvizFutures(new TextDecoder().decode(bytes))`)
and 300 seeded mutations through `futures_driver` and compares every snapshot and quote field with
`parseFinvizFutures` (relative tolerance 1e-12 for doubles, exact for strings; rejections
must match rejections). A separate run checks that a 150,000-member object parses in linear
time. `locale_regression` (native/tests) repeats key fixture values under a comma-decimal C
locale. On Linux the configure step compiles `de_DE.UTF-8` into the build tree with `localedef`
when glibc's locale sources are installed, so the test runs on CI images without that locale;
it is reported as skipped only when no comma-decimal locale is available.

## Known divergences

* `dip::jsonlite` refuses nesting deeper than `kMaxDepth` (512 levels, the outermost
  included), which bounds its recursion on hostile input. `JSON.parse` has no depth limit
  at all (V8's parser is iterative; Node 22 parses 10,000,000 levels). Finviz payloads nest
  three levels. The verifier checks both sides: 512 levels parse like the reference, and
  513 must be rejected natively while the reference accepts them.
* Rejections: the three Finviz messages must match the reference exactly; JSON syntax
  errors only need to be JSON syntax errors on both sides, because V8 and `dip::jsonlite`
  word them differently.
* A JavaScript `NaN` cannot be written in JSON text, so the NaN branch of the reference's
  unit test (an object input) is covered here only through non-finite literals such as
  `1e999`, which both sides treat as "not numeric".

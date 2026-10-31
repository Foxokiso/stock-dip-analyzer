# dip::format — display formatters shared with the renderer

Preserves `formatCompact`, `formatPct(value, digits = 2)` and `formatPrice` from
`src/utils/format.js` with byte-identical output for the en-US locale, so a future
native UI prints exactly the strings the Electron renderer shows. This is
preservation of existing presentation behavior; it is not a trading backtest.
`formatQuoteTime` (Date and time-zone dependent) is not ported.

Unavailable input — JavaScript `null`/`undefined`/empty string (`std::nullopt`
here), `NaN` and `±Infinity` — renders as `—` (U+2014) from every formatter.
No placeholder number is ever produced.

Two display rules sit on top of the engine's rounding:

- `formatCompact` picks its unit **after** rounding: a value whose rounded mantissa
  reaches 1000 moves up a unit, so `999950` prints `1.00M` and `999995000` prints
  `1.00B`, never `1000.0K` or `1000.00M` (`T` is the last unit).
- A value that rounds to zero prints **unsigned** in every formatter:
  `formatPct(-0.004) == "0.00%"` (and `formatPct(0.004) == "0.00%"`: the `+` follows
  the rounded value), `formatPrice(-0.004) == "$0.00"`, `formatCompact(-0) == "0"`.
  The `toFixed` / `toLocaleString` building blocks keep the engine's signs.

## Locale assumption

`formatCompact`'s sub-1000 branch formats with the host's default locale through
`Intl.NumberFormat(undefined, { signDisplay: 'negative' })`: the
`toLocaleString()` text, except that a value that rounds to zero has no sign in
any locale (Swedish and Finnish write the minus as U+2212 and Arabic adds a
letter mark, so stripping a leading `-` is not enough). The port reproduces the
**en-US** result (ICU `decimal` style): `,` grouping, `.` decimal point, 0..3
fraction digits with trailing zeros trimmed, half-expand rounding. Its
`toLocaleString` building block keeps the sign for negative values including
`-0`, as `toLocaleString()` does, and `formatCompact` prints a zero result as
`0`. Hosts whose default Intl locale formats numbers differently are outside
the contract; the verifier probes the running Node's default locale against
`en-US` and fails early with an explanation if they differ.

## Rounding: where C++ would differ and how it is handled

| JavaScript | C library | Port |
| --- | --- | --- |
| `toFixed` rounds the **exact binary** value and resolves exact ties toward the larger magnitude: `(1.25).toFixed(1) == "1.3"`, `(12.125).toFixed(2) == "12.13"`, `(2.5).toFixed(0) == "3"` | `printf`/`std::to_chars` resolve the same ties half-to-even (`"1.2"`, `"12.12"`, `"2"`) | exact integer arithmetic on the mantissa (`floor(x·10^d + ½)` in a small big-integer), never the C library |
| `toLocaleString` rounds the **shortest round-trip decimal** (what `String(x)` prints): `(1.0005).toLocaleString() == "1.001"` although `(1.0005).toFixed(3) == "1.000"` | any exact-value rounding gives `"1"`/`"1.000"` | `std::to_chars` shortest form, then decimal half-away-from-zero to 3 places |
| `(-0).toFixed(2) == "0.00"` (sign test is `x < 0`), `(-0.001).toFixed(2) == "-0.00"`, `(-0).toLocaleString() == "-0"` | — | reproduced per building block; the formatters then print a zero result unsigned |
| `toFixed` falls back to `Number::toString` at magnitudes of `1e21` and above, so `formatCompact(1e33) == "1e+21T"` | — | `numberToString` implements the ECMAScript `Number::toString` layout rules |

## Driver protocol

`tests/format_driver.cpp` reads one case per line, `<fn> <value> [digits]`, and
prints the formatted string:

- `fn`: `formatCompact` | `formatPct` | `formatPrice` | `toFixed` | `toLocaleString` | `toString`
- `value`: the literal `String(x)` prints (parsed with `std::from_chars`, which
  round-trips it exactly whatever the C locale), or `null` | `nan` | `Infinity` | `-Infinity`
- `digits`: integer 0..100 (formatPct default 2, toFixed default 0)

## Build and compare

Toolchain: C++20 and a standard library with floating-point `std::to_chars`
(MSVC 2019 16.4+, libstdc++ 11+ / GCC 11+, libc++ 14+). Verified warning-free with
MSVC `/W4 /WX` and GCC 13 `-Wall -Wextra -Werror -pedantic`; no third-party code.

```bash
cmake -S native -B artifacts/native-format -G "Visual Studio 18 2026" -A x64
cmake --build artifacts/native-format --config Release
ctest --test-dir artifacts/native-format -C Release -R format_reference_parity --output-on-failure
# or directly:
node scripts/verify-native-format.mjs artifacts/native-format/modules/format/Release/format_driver.exe
```

`scripts/verify-native-format.mjs` imports the real `src/utils/format.js` and
compares every output string exactly (display strings have no numeric tolerance).
Its 3321 cases cover `null`/`NaN`/`±Infinity`, `0` and `-0`, negatives, `999.999`
and the `1e3..1e15` boundaries one ulp either side plus the K/M/B/T hand-offs and
roll-overs after rounding (`999950`, `999995000`), values that round to a signed zero,
exact binary `.5` ties and decimal literals that only look like ties
(`1.005`, `2.675`, `8.325`), the `toLocaleString` carry into a new integer digit
(`999.9995` → `1,000`), precisions 0..100, the `>= 1e21` fallback, subnormals,
`Number.MAX_VALUE`, and 500 seeded random magnitudes from `1e-4` to `1e16`.

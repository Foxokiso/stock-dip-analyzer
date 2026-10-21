# dip::format — display formatters shared with the renderer

Preserves `formatCompact`, `formatPct(value, digits = 2)` and `formatPrice` from
`src/utils/format.js` with byte-identical output for the en-US locale, so a future
native UI prints exactly the strings the Electron renderer shows. This is
preservation of existing presentation behavior; it is not a trading backtest.
`formatQuoteTime` (Date and time-zone dependent) is not ported.

Unavailable input — JavaScript `null`/`undefined`/empty string (`std::nullopt`
here), `NaN` and `±Infinity` — renders as `—` (U+2014) from every formatter.
No placeholder number is ever produced.

## Locale assumption

`formatCompact`'s sub-1000 branch calls `Number.prototype.toLocaleString()` with
the host's default locale. The port reproduces the **en-US** result (ICU
`decimal` style): `,` grouping, `.` decimal point, 0..3 fraction digits with
trailing zeros trimmed, half-expand rounding, and the sign kept for negative
values including `-0`. Hosts whose default Intl locale formats numbers
differently are outside the contract; the verifier probes the running Node's
default locale against `en-US` and fails early with an explanation if they differ.

## Rounding: where C++ would differ and how it is handled

| JavaScript | C library | Port |
| --- | --- | --- |
| `toFixed` rounds the **exact binary** value and resolves exact ties toward the larger magnitude: `(1.25).toFixed(1) == "1.3"`, `(12.125).toFixed(2) == "12.13"`, `(2.5).toFixed(0) == "3"` | `printf`/`std::to_chars` resolve the same ties half-to-even (`"1.2"`, `"12.12"`, `"2"`) | exact integer arithmetic on the mantissa (`floor(x·10^d + ½)` in a small big-integer), never the C library |
| `toLocaleString` rounds the **shortest round-trip decimal** (what `String(x)` prints): `(1.0005).toLocaleString() == "1.001"` although `(1.0005).toFixed(3) == "1.000"` | any exact-value rounding gives `"1"`/`"1.000"` | `std::to_chars` shortest form, then decimal half-away-from-zero to 3 places |
| `(-0).toFixed(2) == "0.00"` (sign test is `x < 0`), `(-0.001).toFixed(2) == "-0.00"`, `(-0).toLocaleString() == "-0"` | — | reproduced per function |
| `toFixed` falls back to `Number::toString` at magnitudes of `1e21` and above, so `formatCompact(1e33) == "1e+21T"` | — | `numberToString` implements the ECMAScript `Number::toString` layout rules |

## Driver protocol

`tests/format_driver.cpp` reads one case per line, `<fn> <value> [digits]`, and
prints the formatted string:

- `fn`: `formatCompact` | `formatPct` | `formatPrice` | `toFixed` | `toLocaleString` | `toString`
- `value`: the literal `String(x)` prints (parsed with `strtod`, which round-trips it
  exactly), or `null` | `nan` | `Infinity` | `-Infinity`
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
Its 3192 cases cover `null`/`NaN`/`±Infinity`, `0` and `-0`, negatives, `999.999`
and the `1e3..1e15` boundaries one ulp either side plus the K/M/B/T hand-offs,
exact binary `.5` ties and decimal literals that only look like ties
(`1.005`, `2.675`, `8.325`), the `toLocaleString` carry into a new integer digit
(`999.9995` → `1,000`), precisions 0..100, the `>= 1e21` fallback, subnormals,
`Number.MAX_VALUE`, and 500 seeded random magnitudes from `1e-4` to `1e16`.

#pragma once
// dip::format — C++20 port of the shared display formatters in src/utils/format.js
// (formatCompact, formatPct, formatPrice). This preserves the existing presentation
// behavior of the reference application byte-for-byte; it is not a trading backtest
// and performs no provider IO.
//
// Locale assumption: the JavaScript reference calls Number.prototype.toLocaleString()
// with the host's default locale. This port reproduces the en-US result (ICU "decimal"
// style: "," grouping, "." decimal point, 0..3 fraction digits with trailing zeros
// trimmed, half-expand rounding of the shortest round-trip decimal, "-" shown for
// negative values including -0). Hosts whose default Intl locale formats numbers
// differently are outside the contract.
//
// Rounding notes (verified empirically against V8/ICU, see scripts/verify-native-format.mjs):
//  * Number.prototype.toFixed rounds the EXACT binary value and resolves exact ties toward
//    the larger n (half-up on the magnitude): (1.25).toFixed(1) == "1.3",
//    (12.125).toFixed(2) == "12.13", (2.5).toFixed(0) == "3". C's printf / std::to_chars
//    resolve the same ties half-to-even ("1.2", "12.12", "2"), so toFixed is evaluated
//    with exact integer arithmetic instead of the C library.
//  * (-0).toFixed(2) == "0.00" (the sign test is x < 0) while (-0.001).toFixed(2) == "-0.00".
//  * toLocaleString rounds the SHORTEST round-trip decimal (as String(x) prints it), not
//    the exact binary value: (1.0005).toLocaleString() == "1.001" although
//    (1.0005).toFixed(3) == "1.000". The port therefore derives digits with
//    std::to_chars (shortest) before rounding half away from zero.
//  * For |x| >= 1e21 toFixed falls back to Number.prototype.toString ("1e+21").
#include <optional>
#include <string>

namespace dip::format {
// A missing value (JavaScript null/undefined/empty string) is std::nullopt; NaN and
// ±Infinity are likewise "unavailable". All of them render as "—" (U+2014), never a number.
std::string formatCompact(std::optional<double> value);
std::string formatPct(std::optional<double> value, int digits = 2);
std::string formatPrice(std::optional<double> value);

// Building blocks, exposed so the parity driver can check them directly.
// `digits` must be within 0..100 (JavaScript throws a RangeError otherwise; this throws
// std::out_of_range).
std::string toFixed(double value, int digits);
// Number.prototype.toString() (radix 10), e.g. 1e21 -> "1e+21", 1e-7 -> "1e-7".
std::string numberToString(double value);
// Number.prototype.toLocaleString() for the en-US locale, e.g. 1234.5678 -> "1,234.568".
std::string toLocaleStringEnUS(double value);
}

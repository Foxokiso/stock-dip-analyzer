#pragma once
// dip::marketdata — C++20 port of src/utils/marketData.js: getYahooChartPoints,
// getYahooQuote and canRaiseTechnicalAlert, plus the private helpers they rely on
// (positive/finite validation, Date#toISOString, the exchange-day lookup and Date.parse).
//
// This module preserves the existing behavior of the reference application; it is
// not a trading backtest, performs no network or provider IO, and never invents a
// quote, close, change or timestamp. Everything the JavaScript reports as null
// (missing, non-numeric, non-finite, non-positive) is std::nullopt here, and the
// retrieval time (fetchedAt) stays separate from the source quote time (quotedAt).
//
// Preserved rules (see the reference for the comments that motivate them):
//  * A chart point needs a positive finite timestamp that is a valid Date (|ms| <= 8.64e15)
//    and a positive finite close; points are stable-sorted by timestamp.
//  * previousClose comes from meta.previousClose; chartPreviousClose is only yesterday
//    on a one-day request (range === '1d'); otherwise the prior session is the LAST bar
//    that is older than the quote AND falls on an earlier exchange day. A null close on
//    that bar yields null (a missing session must not turn into a multi-session change).
//  * quotedAt is Date#toISOString of regularMarketTime: millisecond precision, the
//    time value truncated toward zero, years beyond 9999 written as +YYYYYY.
//  * delayMinutes keeps a finite value >= 0 (including -0); currency and the exchange
//    zone are passed through only when they are strings.
//  * canRaiseTechnicalAlert: positive price, at least 15 bars, delayMinutes === 0, and a
//    parseable quotedAt no older than five minutes (and not in the future).
//
// Time zones: the exchange day is computed with std::chrono (time_zone::get_info /
// zoned_time semantics) from the IANA zone name Yahoo reports. Zone data therefore
// comes from the OS ICU (icu.dll) on Windows/MSVC and from the system tzdata
// (/usr/share/zoneinfo) on Linux/libstdc++, while the JavaScript reference uses Node's
// bundled ICU; parity holds as long as both carry the same rules for the zone and era
// in question. Like Intl.DateTimeFormat, the lookup ignores case and accepts link
// (alias) names. If the zone cannot be located — unknown name, or no zone database at
// all — the day falls back to the UTC date exactly like the JavaScript catch path
// (Date#toISOString().slice(0, 10)). Instants past year 9999 are folded back by whole
// 400-year Gregorian cycles before asking the zone, so libraries whose chrono::year is
// 16-bit still apply the zone's perpetual rule correctly.
//
// Date.parse: only the ECMAScript date-time string format as V8 accepts it is ported
// (YYYY[-MM[-DD]][(T|t| )HH:mm[:ss[.s+]]][Z|z|±HH:mm|±HHmm], expanded ±YYYYYY years,
// 24:00 end-of-day, day-of-month overflow such as Feb 30). Date-only forms are UTC;
// date-time forms without an offset are local time, using the offset in force before a
// transition inside a DST gap or overlap, as ECMAScript requires. V8's lenient legacy
// fallback formats ("Oct 9 2026", "2026-1-9", ...) are not ported and parse as NaN.
#include <optional>
#include <string>
#include <vector>

namespace dip::marketdata {

// The slice of a Yahoo chart "result" the reference reads. Numbers that JavaScript would
// see as null/undefined/non-number are std::nullopt; NaN and ±Infinity are kept as such
// because the validation helpers reject them the same way.
struct ChartMeta {
    std::optional<double> regularMarketPrice;
    std::optional<double> regularMarketTime;        // seconds since the epoch
    std::optional<std::string> exchangeTimezoneName; // IANA name, e.g. "America/New_York"
    std::optional<std::string> range;               // e.g. "1d", "1mo"
    std::optional<double> chartPreviousClose;
    std::optional<double> previousClose;
    std::optional<double> exchangeDataDelayedBy;    // minutes
    std::optional<std::string> currency;
};

struct ChartResult {
    ChartMeta meta;
    std::vector<std::optional<double>> timestamp;   // result.timestamp (null bars preserved)
    std::vector<std::optional<double>> close;       // result.indicators.quote[0].close
};

struct ChartPoint {
    double timestamp = 0;   // seconds, as received
    std::string date;       // exchange day "YYYY-MM-DD"
    double price = 0;
};

struct Quote {
    std::optional<double> price;
    std::optional<double> previousClose;
    std::optional<double> changePct;
    std::vector<double> closes;
    std::optional<std::string> quotedAt;    // ISO-8601 with milliseconds, UTC ("Z")
    std::string fetchedAt;                  // retrieval time, never derived from the quote
    std::string source = "Yahoo Finance";
    std::optional<double> delayMinutes;
    std::optional<std::string> currency;
    std::optional<std::string> exchangeTimezone;
};

struct QuoteOptions {
    std::optional<std::string> fetchedAt;   // default: the current time as ISO-8601
    std::optional<std::string> range;       // overrides meta.range when non-empty
};

std::vector<ChartPoint> getYahooChartPoints(const ChartResult& result);
Quote getYahooQuote(const ChartResult& result, const QuoteOptions& options = {});
// `historyLength` and `nowMillis` are doubles because the reference compares JavaScript
// numbers (NaN never qualifies). The two-argument overload uses the system clock.
bool canRaiseTechnicalAlert(const Quote& quote, double historyLength, double nowMillis);
bool canRaiseTechnicalAlert(const Quote& quote, double historyLength);

// Building blocks, exposed so the parity driver can check them directly.
std::optional<double> positive(std::optional<double> value);   // finite and > 0
std::optional<double> finite(std::optional<double> value);
// Date#toISOString for `seconds * 1000`; nullopt when the reference yields null.
std::optional<std::string> isoTime(std::optional<double> seconds);
// Date#toISOString of a time value in milliseconds (TimeClip applied: nullopt when |ms| > 8.64e15).
std::optional<std::string> toISOString(double millis);
// Intl.DateTimeFormat('en-CA', {timeZone}).format(new Date(seconds * 1000)) → "YYYY-MM-DD".
// An empty or missing zone means UTC; an unknown zone falls back to the UTC date.
// Throws std::invalid_argument for an invalid time value (JavaScript throws a RangeError).
std::string exchangeDay(double seconds, const std::optional<std::string>& timezone);
// Date.parse: milliseconds since the epoch, or NaN when the string is not accepted.
double parseDate(const std::optional<std::string>& text);
// Date.now() as a double (milliseconds).
double nowMillis();

}  // namespace dip::marketdata

// dip::marketdata — see include/dip/marketdata.hpp. Preservation of existing behavior;
// not a trading backtest. Zone data comes from the OS ICU on Windows and tzdata on Linux.
#include "dip/marketdata.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string_view>

namespace dip::marketdata {
namespace {

constexpr double kMaxTimeValue = 8.64e15;         // ECMAScript TimeClip bound (ms)
constexpr std::int64_t kMsPerDay = 86'400'000;
constexpr std::int64_t kDaysPer400Years = 146'097; // one Gregorian cycle: same leap pattern and weekdays
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

std::int64_t floorDiv(std::int64_t value, std::int64_t divisor) {
    std::int64_t quotient = value / divisor;
    const std::int64_t remainder = value % divisor;
    if (remainder != 0 && ((remainder < 0) != (divisor < 0))) --quotient;
    return quotient;
}

struct Civil {
    std::int64_t year;
    unsigned month;   // 1..12
    unsigned day;     // 1..31
};

// Proleptic Gregorian calendar in 64-bit arithmetic (Howard Hinnant's algorithms), so the
// full ECMAScript time range (years -271821..275760) is handled without std::chrono::year.
Civil civilFromDays(std::int64_t days) {
    days += 719468;
    const std::int64_t era = (days >= 0 ? days : days - 146096) / kDaysPer400Years;
    const auto dayOfEra = static_cast<unsigned>(days - era * kDaysPer400Years);                    // [0, 146096]
    const unsigned yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146096) / 365;  // [0, 399]
    const unsigned dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100);   // [0, 365]
    const unsigned shiftedMonth = (5 * dayOfYear + 2) / 153;                                     // [0, 11]
    const unsigned day = dayOfYear - (153 * shiftedMonth + 2) / 5 + 1;                           // [1, 31]
    const unsigned month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;              // [1, 12]
    const std::int64_t year = static_cast<std::int64_t>(yearOfEra) + era * 400 + (month <= 2 ? 1 : 0);
    return {year, month, day};
}

std::int64_t daysFromCivil(std::int64_t year, unsigned month, unsigned day) {
    year -= month <= 2 ? 1 : 0;
    const std::int64_t era = (year >= 0 ? year : year - 399) / 400;
    const auto yearOfEra = static_cast<unsigned>(year - era * 400);                               // [0, 399]
    const unsigned dayOfYear = (153 * (month > 2 ? month - 3 : month + 9) + 2) / 5 + day - 1;     // [0, 365]
    const unsigned dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear;      // [0, 146096]
    return era * kDaysPer400Years + static_cast<std::int64_t>(dayOfEra) - 719468;
}

std::string zeroPadded(std::int64_t value, std::size_t width) {
    std::string digits = std::to_string(value);
    if (digits.size() < width) digits.insert(0, width - digits.size(), '0');
    return digits;
}

// Date.prototype.toISOString for an already clipped (integral) time value.
std::string isoFromTimeValue(std::int64_t millis) {
    const std::int64_t days = floorDiv(millis, kMsPerDay);
    const std::int64_t ofDay = millis - days * kMsPerDay;   // [0, 86399999]
    const Civil civil = civilFromDays(days);
    std::string out;
    if (civil.year >= 0 && civil.year <= 9999) {
        out += zeroPadded(civil.year, 4);
    } else {
        out += civil.year < 0 ? '-' : '+';
        out += zeroPadded(civil.year < 0 ? -civil.year : civil.year, 6);
    }
    out += '-';
    out += zeroPadded(civil.month, 2);
    out += '-';
    out += zeroPadded(civil.day, 2);
    out += 'T';
    out += zeroPadded(ofDay / 3'600'000, 2);
    out += ':';
    out += zeroPadded((ofDay / 60'000) % 60, 2);
    out += ':';
    out += zeroPadded((ofDay / 1'000) % 60, 2);
    out += '.';
    out += zeroPadded(ofDay % 1'000, 3);
    out += 'Z';
    return out;
}

// TimeClip: NaN (nullopt) outside ±8.64e15, otherwise truncation toward zero.
std::optional<std::int64_t> clipTimeValue(double millis) {
    if (!(std::fabs(millis) <= kMaxTimeValue)) return std::nullopt;   // also rejects NaN
    return static_cast<std::int64_t>(std::trunc(millis));
}

bool equalsIgnoreCase(std::string_view left, std::string_view right) {
    if (left.size() != right.size()) return false;
    for (std::size_t i = 0; i < left.size(); ++i) {
        const auto a = static_cast<unsigned char>(left[i]);
        const auto b = static_cast<unsigned char>(right[i]);
        if (std::tolower(a) != std::tolower(b)) return false;
    }
    return true;
}

// Intl.DateTimeFormat resolves zone names case-insensitively and accepts link names;
// std::chrono::tzdb::locate_zone is exact, so fall back to a scan of zones and links.
// nullptr means the zone cannot be located (or no zone database is available).
const std::chrono::time_zone* resolveZone(std::string_view name) {
    try {
        const auto& db = std::chrono::get_tzdb();
        try {
            return db.locate_zone(name);
        } catch (const std::runtime_error&) {
            // fall through to the case-insensitive scan
        }
        for (const auto& zone : db.zones) {
            if (equalsIgnoreCase(zone.name(), name)) return &zone;
        }
        for (const auto& link : db.links) {
            if (equalsIgnoreCase(link.name(), name)) return db.locate_zone(link.target());
        }
    } catch (...) {
        // No usable zone database: treated like an unknown zone.
    }
    return nullptr;
}

// Every IANA zone is governed by a perpetual rule well before year 9600 and by a fixed
// LMT offset before year -9600, so shifting an instant into [-9999, 9999] by whole
// 400-year cycles keeps the zone's answer while staying inside std::chrono::year.
std::int64_t foldIntoChronoRange(std::int64_t millis) {
    constexpr std::int64_t cycleMs = kDaysPer400Years * kMsPerDay;
    const std::int64_t year = civilFromDays(floorDiv(millis, kMsPerDay)).year;
    if (year > 9999) return millis - ((year - 9600) / 400) * cycleMs;
    if (year < -9600) return millis + ((-9600 - year + 399) / 400) * cycleMs;
    return millis;
}

// UTC offset (seconds) in force at a UTC instant, taken from the zoned_time conversion
// (local wall clock minus UTC), or nullopt if the zone cannot answer.
std::optional<std::int64_t> offsetAtSys(const std::chrono::time_zone& zone, std::int64_t millis) {
    try {
        const std::chrono::sys_time<std::chrono::milliseconds> instant{std::chrono::milliseconds{foldIntoChronoRange(millis)}};
        const std::chrono::zoned_time<std::chrono::milliseconds> zoned{&zone, instant};
        const auto offset = zoned.get_local_time().time_since_epoch() - instant.time_since_epoch();
        return static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::seconds>(offset).count());
    } catch (...) {
        return std::nullopt;
    }
}

// UTC offset (seconds) for a local wall-clock time. In a DST gap or overlap ECMAScript
// (LocalTZA with isUTC = false) uses the offset before the transition, which is exactly
// local_info::first in both the nonexistent and the ambiguous case.
std::optional<std::int64_t> offsetAtLocal(const std::chrono::time_zone& zone, std::int64_t localMillis) {
    try {
        const std::chrono::local_time<std::chrono::milliseconds> wall{std::chrono::milliseconds{foldIntoChronoRange(localMillis)}};
        return static_cast<std::int64_t>(zone.get_info(wall).first.offset.count());
    } catch (...) {
        return std::nullopt;
    }
}

// The host zone, as Date.parse would use for local-time forms. Without one, UTC.
std::int64_t localToUtc(std::int64_t localMillis) {
    try {
        const auto* zone = std::chrono::current_zone();
        if (zone == nullptr) return localMillis;
        const auto offset = offsetAtLocal(*zone, localMillis);
        return offset ? localMillis - *offset * 1000 : localMillis;
    } catch (...) {
        return localMillis;
    }
}

struct Scanner {
    std::string_view text;
    std::size_t pos = 0;

    bool done() const { return pos >= text.size(); }
    bool peek(char expected) const { return !done() && text[pos] == expected; }
    bool take(char expected) {
        if (!peek(expected)) return false;
        ++pos;
        return true;
    }
    bool digits(std::size_t count, std::int64_t& value) {
        if (text.size() - pos < count) return false;
        value = 0;
        for (std::size_t k = 0; k < count; ++k) {
            const char c = text[pos + k];
            if (c < '0' || c > '9') return false;
            value = value * 10 + (c - '0');
        }
        pos += count;
        return true;
    }
};

}  // namespace

std::optional<double> positive(std::optional<double> value) {
    return value && std::isfinite(*value) && *value > 0 ? value : std::nullopt;
}

std::optional<double> finite(std::optional<double> value) {
    return value && std::isfinite(*value) ? value : std::nullopt;
}

std::optional<std::string> toISOString(double millis) {
    const auto clipped = clipTimeValue(millis);
    if (!clipped) return std::nullopt;
    return isoFromTimeValue(*clipped);
}

std::optional<std::string> isoTime(std::optional<double> seconds) {
    const auto valid = positive(seconds);
    if (!valid) return std::nullopt;
    return toISOString(*valid * 1000.0);
}

std::string exchangeDay(double seconds, const std::optional<std::string>& timezone) {
    const auto millis = clipTimeValue(seconds * 1000.0);
    if (!millis) throw std::invalid_argument("dip::marketdata::exchangeDay: invalid time value");
    const std::string_view name = timezone && !timezone->empty() ? std::string_view(*timezone) : std::string_view("UTC");
    if (const auto* zone = resolveZone(name)) {
        if (const auto offset = offsetAtSys(*zone, *millis)) {
            const Civil civil = civilFromDays(floorDiv(*millis + *offset * 1000, kMsPerDay));
            // ICU's en-CA "y-MM-dd": the year is written with however many digits it needs.
            return std::to_string(civil.year) + '-' + zeroPadded(civil.month, 2) + '-' + zeroPadded(civil.day, 2);
        }
    }
    return isoFromTimeValue(*millis).substr(0, 10);
}

double parseDate(const std::optional<std::string>& text) {
    if (!text) return kNaN;
    Scanner in{*text, 0};
    std::int64_t year = 0;
    if (in.peek('+') || in.peek('-')) {
        const bool negative = in.take('-');
        if (!negative) in.take('+');
        if (!in.digits(6, year)) return kNaN;
        if (negative && year == 0) return kNaN;   // "-000000" is explicitly invalid
        if (negative) year = -year;
    } else if (!in.digits(4, year)) {
        return kNaN;
    }
    std::int64_t month = 1, day = 1;
    if (in.take('-')) {
        if (!in.digits(2, month) || month < 1 || month > 12) return kNaN;
        if (in.take('-')) {
            if (!in.digits(2, day) || day < 1 || day > 31) return kNaN;   // overflow is applied by MakeDay
        }
    }
    bool hasTime = false;
    std::int64_t hour = 0, minute = 0, second = 0, millis = 0;
    std::optional<std::int64_t> offsetMinutes;
    if (in.take('T') || in.take('t') || in.take(' ')) {
        hasTime = true;
        if (!in.digits(2, hour) || !in.take(':') || !in.digits(2, minute)) return kNaN;
        if (in.take(':')) {
            if (!in.digits(2, second)) return kNaN;
            if (in.take('.')) {
                std::size_t count = 0;
                while (!in.done() && in.text[in.pos] >= '0' && in.text[in.pos] <= '9') {
                    if (count < 3) millis = millis * 10 + (in.text[in.pos] - '0');
                    ++count;
                    ++in.pos;
                }
                if (count == 0) return kNaN;
                for (; count < 3; ++count) millis *= 10;
            }
        }
        if (hour == 24) {
            if (minute != 0 || second != 0 || millis != 0) return kNaN;
        } else if (hour > 23) {
            return kNaN;
        }
        if (minute > 59 || second > 59) return kNaN;
        if (in.take('Z') || in.take('z')) {
            offsetMinutes = 0;
        } else if (in.peek('+') || in.peek('-')) {
            const bool negative = in.take('-');
            if (!negative) in.take('+');
            std::int64_t offsetHours = 0, offsetMins = 0;
            if (!in.digits(2, offsetHours)) return kNaN;
            in.take(':');
            if (!in.digits(2, offsetMins) || offsetHours > 23 || offsetMins > 59) return kNaN;
            offsetMinutes = (negative ? -1 : 1) * (offsetHours * 60 + offsetMins);
        }
    }
    if (!in.done()) return kNaN;

    const std::int64_t days = daysFromCivil(year, static_cast<unsigned>(month), 1) + (day - 1);
    std::int64_t value = days * kMsPerDay + hour * 3'600'000 + minute * 60'000 + second * 1'000 + millis;
    // Anything more than a day outside the representable range is NaN whatever the offset.
    if (std::fabs(static_cast<double>(value)) > kMaxTimeValue + static_cast<double>(kMsPerDay)) return kNaN;
    if (offsetMinutes) value -= *offsetMinutes * 60'000;
    else if (hasTime) value = localToUtc(value);
    const auto clipped = clipTimeValue(static_cast<double>(value));
    return clipped ? static_cast<double>(*clipped) : kNaN;
}

double nowMillis() {
    const auto sinceEpoch = std::chrono::system_clock::now().time_since_epoch();
    return static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(sinceEpoch).count());
}

std::vector<ChartPoint> getYahooChartPoints(const ChartResult& result) {
    std::vector<ChartPoint> points;
    for (std::size_t index = 0; index < result.timestamp.size(); ++index) {
        const auto price = positive(index < result.close.size() ? result.close[index] : std::nullopt);
        const auto timestamp = positive(result.timestamp[index]);
        if (!timestamp || !isoTime(timestamp) || !price) continue;
        points.push_back({*timestamp, exchangeDay(*timestamp, result.meta.exchangeTimezoneName), *price});
    }
    // Array.prototype.sort is stable; equal timestamps keep their input order.
    std::stable_sort(points.begin(), points.end(),
                     [](const ChartPoint& a, const ChartPoint& b) { return a.timestamp < b.timestamp; });
    return points;
}

Quote getYahooQuote(const ChartResult& result, const QuoteOptions& options) {
    const ChartMeta& meta = result.meta;
    const auto points = getYahooChartPoints(result);
    Quote quote;
    quote.price = positive(meta.regularMarketPrice);
    quote.quotedAt = isoTime(meta.regularMarketTime);
    quote.previousClose = positive(meta.previousClose);
    // chartPreviousClose is a range-start reference: it is yesterday only on a one-day request.
    const std::optional<std::string>& range = options.range && !options.range->empty() ? options.range : meta.range;
    if (!quote.previousClose && range && *range == "1d") quote.previousClose = positive(meta.chartPreviousClose);
    if (!quote.previousClose && quote.quotedAt) {
        const double quoteTime = *meta.regularMarketTime;   // valid: quotedAt exists
        const std::string quoteDay = exchangeDay(quoteTime, meta.exchangeTimezoneName);
        // Preserve null bars when locating the prior session: skipping a missing
        // session would turn a multi-session return into a misleading day change.
        std::optional<std::size_t> previousIndex;
        for (std::size_t index = result.timestamp.size(); index-- > 0;) {
            const auto timestamp = positive(result.timestamp[index]);
            if (timestamp && isoTime(timestamp) && *timestamp < quoteTime
                && exchangeDay(*timestamp, meta.exchangeTimezoneName) < quoteDay) {
                previousIndex = index;
                break;
            }
        }
        quote.previousClose = previousIndex && *previousIndex < result.close.size()
            ? positive(result.close[*previousIndex]) : std::nullopt;
    }
    const auto delay = finite(meta.exchangeDataDelayedBy);
    quote.changePct = quote.price && quote.previousClose
        ? std::optional<double>(((*quote.price - *quote.previousClose) / *quote.previousClose) * 100) : std::nullopt;
    quote.closes.reserve(points.size());
    for (const auto& point : points) quote.closes.push_back(point.price);
    quote.fetchedAt = options.fetchedAt ? *options.fetchedAt : toISOString(nowMillis()).value_or(std::string());
    quote.source = "Yahoo Finance";
    quote.delayMinutes = delay && *delay >= 0 ? delay : std::nullopt;
    quote.currency = meta.currency;
    quote.exchangeTimezone = meta.exchangeTimezoneName;
    return quote;
}

bool canRaiseTechnicalAlert(const Quote& quote, double historyLength, double nowMs) {
    const double quoteTime = parseDate(quote.quotedAt);
    const double age = nowMs - quoteTime;
    return positive(quote.price).has_value() && historyLength >= 15
        && quote.delayMinutes.has_value() && *quote.delayMinutes == 0
        && std::isfinite(quoteTime) && age >= 0 && age <= 5 * 60 * 1000;
}

bool canRaiseTechnicalAlert(const Quote& quote, double historyLength) {
    return canRaiseTechnicalAlert(quote, historyLength, nowMillis());
}

}  // namespace dip::marketdata

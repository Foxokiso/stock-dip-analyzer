// Test-only line protocol for cross-language market-data parity checks (not a shipped API).
// One case per input line, one tab-separated result line per case:
//
//   <quote line>  a flat token list shaped like a Yahoo chart result:
//     regularMarketPrice regularMarketTime exchangeTimezoneName range chartPreviousClose
//     previousClose exchangeDataDelayedBy currency | timestamps... | closes...
//     → price previousClose changePct quotedAt delayMinutes currency exchangeTimezone source
//       closes(comma-terminated) points(each "timestamp,date,price;")
//   alert <price> <quotedAt> <delayMinutes> <historyLength> <nowMillis>   → 1 | 0
//   iso <seconds>                                                         → quotedAt string | null
//   day <seconds> <zone>                                                  → "YYYY-MM-DD" | throws
//   parse <text>                                                          → milliseconds | nan
//
// Number tokens: null | nan | Infinity | -Infinity | a decimal literal as String(x) prints it
// (parsed with strtod, which round-trips it exactly). String tokens: null, or "s:" followed by
// the percent-encoded (encodeURIComponent) UTF-8 text, so "s:" alone is the empty string.
// Output numbers use 17 significant digits with the same null/nan/Infinity spellings, and
// output strings use the same "s:" encoding.
#include "dip/marketdata.hpp"

#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <limits>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using dip::marketdata::ChartResult;
using dip::marketdata::Quote;

std::optional<double> parseNumber(const std::string& token, bool& ok) {
    if (token == "null") return std::nullopt;
    if (token == "nan" || token == "NaN") return std::numeric_limits<double>::quiet_NaN();
    if (token == "Infinity" || token == "+Infinity" || token == "inf") return std::numeric_limits<double>::infinity();
    if (token == "-Infinity" || token == "-inf") return -std::numeric_limits<double>::infinity();
    char* end = nullptr;
    const double parsed = std::strtod(token.c_str(), &end);
    if (end == token.c_str() || *end != '\0') ok = false;
    return parsed;
}

int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

std::optional<std::string> parseString(const std::string& token, bool& ok) {
    if (token == "null") return std::nullopt;
    if (token.size() < 2 || token[0] != 's' || token[1] != ':') {
        ok = false;
        return std::nullopt;
    }
    std::string out;
    for (std::size_t i = 2; i < token.size(); ++i) {
        if (token[i] == '%' && i + 2 < token.size() && hexValue(token[i + 1]) >= 0 && hexValue(token[i + 2]) >= 0) {
            out += static_cast<char>(hexValue(token[i + 1]) * 16 + hexValue(token[i + 2]));
            i += 2;
        } else {
            out += token[i];
        }
    }
    return out;
}

std::string encodeString(const std::optional<std::string>& value) {
    if (!value) return "null";
    static const char* const hex = "0123456789ABCDEF";
    std::string out = "s:";
    for (const char c : *value) {
        const auto byte = static_cast<unsigned char>(c);
        const bool unreserved = (byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z')
            || (byte >= '0' && byte <= '9') || byte == '-' || byte == '_' || byte == '.' || byte == '~';
        if (unreserved) {
            out += c;
        } else {
            out += '%';
            out += hex[byte >> 4];
            out += hex[byte & 15];
        }
    }
    return out;
}

std::string encodeNumber(std::optional<double> value) {
    if (!value) return "null";
    if (std::isnan(*value)) return "nan";
    if (std::isinf(*value)) return *value > 0 ? "Infinity" : "-Infinity";
    std::ostringstream out;
    out << std::setprecision(17) << *value;
    return out.str();
}

// Reads the flat quote line; `ok` is cleared on any malformed token.
ChartResult parseQuoteLine(std::istringstream& input, const std::string& firstToken, bool& ok) {
    ChartResult result;
    std::string token;
    result.meta.regularMarketPrice = parseNumber(firstToken, ok);
    if (!(input >> token)) ok = false;
    result.meta.regularMarketTime = parseNumber(token, ok);
    if (!(input >> token)) ok = false;
    result.meta.exchangeTimezoneName = parseString(token, ok);
    if (!(input >> token)) ok = false;
    result.meta.range = parseString(token, ok);
    if (!(input >> token)) ok = false;
    result.meta.chartPreviousClose = parseNumber(token, ok);
    if (!(input >> token)) ok = false;
    result.meta.previousClose = parseNumber(token, ok);
    if (!(input >> token)) ok = false;
    result.meta.exchangeDataDelayedBy = parseNumber(token, ok);
    if (!(input >> token)) ok = false;
    result.meta.currency = parseString(token, ok);
    if (!(input >> token) || token != "|") ok = false;
    bool closes = false;
    while (ok && input >> token) {
        if (token == "|") {
            if (closes) ok = false;
            closes = true;
            continue;
        }
        (closes ? result.close : result.timestamp).push_back(parseNumber(token, ok));
    }
    if (!closes) ok = false;
    return result;
}

std::string formatQuote(const Quote& quote, const std::vector<dip::marketdata::ChartPoint>& points) {
    std::string out;
    out += encodeNumber(quote.price) + '\t';
    out += encodeNumber(quote.previousClose) + '\t';
    out += encodeNumber(quote.changePct) + '\t';
    out += encodeString(quote.quotedAt) + '\t';
    out += encodeNumber(quote.delayMinutes) + '\t';
    out += encodeString(quote.currency) + '\t';
    out += encodeString(quote.exchangeTimezone) + '\t';
    out += encodeString(quote.source) + '\t';
    for (const double close : quote.closes) out += encodeNumber(close) + ',';
    out += '\t';
    for (const auto& point : points) {
        out += encodeNumber(point.timestamp) + ',' + encodeString(point.date) + ',' + encodeNumber(point.price) + ';';
    }
    return out;
}

}  // namespace

int main() {
    bool allOk = true;
    std::string line;
    while (std::getline(std::cin, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        std::istringstream input(line);
        std::string first;
        bool ok = static_cast<bool>(input >> first);
        std::string out;
        if (!ok) {
            // empty line
        } else if (first == "alert") {
            std::string priceToken, quotedAtToken, delayToken, historyToken, nowToken, extra;
            if (!(input >> priceToken >> quotedAtToken >> delayToken >> historyToken >> nowToken) || (input >> extra)) ok = false;
            Quote quote;
            if (ok) {
                quote.price = parseNumber(priceToken, ok);
                quote.quotedAt = parseString(quotedAtToken, ok);
                quote.delayMinutes = parseNumber(delayToken, ok);
            }
            const auto history = ok ? parseNumber(historyToken, ok) : std::nullopt;
            const auto now = ok ? parseNumber(nowToken, ok) : std::nullopt;
            if (ok && history && now) out = dip::marketdata::canRaiseTechnicalAlert(quote, *history, *now) ? "1" : "0";
            else ok = false;
        } else if (first == "iso") {
            std::string secondsToken, extra;
            if (!(input >> secondsToken) || (input >> extra)) ok = false;
            const auto seconds = ok ? parseNumber(secondsToken, ok) : std::nullopt;
            if (ok) out = encodeString(dip::marketdata::isoTime(seconds));
        } else if (first == "day") {
            std::string secondsToken, zoneToken, extra;
            if (!(input >> secondsToken >> zoneToken) || (input >> extra)) ok = false;
            const auto seconds = ok ? parseNumber(secondsToken, ok) : std::nullopt;
            const auto zone = ok ? parseString(zoneToken, ok) : std::nullopt;
            if (ok && seconds) {
                try {
                    out = encodeString(dip::marketdata::exchangeDay(*seconds, zone));
                } catch (const std::invalid_argument&) {
                    out = "throws";
                }
            } else {
                ok = false;
            }
        } else if (first == "parse") {
            std::string textToken, extra;
            if (!(input >> textToken) || (input >> extra)) ok = false;
            const auto text = ok ? parseString(textToken, ok) : std::nullopt;
            if (ok) out = encodeNumber(dip::marketdata::parseDate(text));
        } else {
            const ChartResult result = parseQuoteLine(input, first, ok);
            if (ok) {
                dip::marketdata::QuoteOptions options;
                options.fetchedAt = "1970-01-01T00:00:00.000Z";   // fixed: retrieval time is not under test
                out = formatQuote(dip::marketdata::getYahooQuote(result, options), dip::marketdata::getYahooChartPoints(result));
            }
        }
        if (!ok) {
            allOk = false;
            out = "error:malformed-line";
            std::cerr << "marketdata_driver: cannot handle line: " << line << '\n';
        }
        std::cout << out << '\n';
    }
    return allOk ? 0 : 1;
}

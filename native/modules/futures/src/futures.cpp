// dip::futures — port of the pure parts of src/services/futures.js. Preservation of the
// reference application's parsing and validation behavior; not a trading backtest.
#include "dip/futures.hpp"

#include <cmath>
#include <cstdint>

namespace dip::futures {

const std::vector<Timeframe>& timeframes() {
    static const std::vector<Timeframe> list = {
        {"i5", "5 minute"}, {"h", "Hourly"}, {"d", "Daily"},
        {"w", "Weekly"}, {"m", "Monthly"}, {"NO", "Quotes only"},
    };
    return list;
}

bool isSupportedTimeframe(std::string_view id) {
    for (const auto& item : timeframes()) {
        if (item.id == id) return true;
    }
    return false;
}

const std::vector<Group>& groups() {
    static const std::vector<Group> list = {
        {"indices", "Indices", {"ES", "NQ", "YM", "ER2", "NKD", "EX", "DY", "VX"}},
        {"rates", "Rates", {"ZQ", "SR3", "ZT", "ZF", "ZN", "TN", "ZB", "UB"}},
        {"energy", "Energy", {"CL", "QA", "NG", "RB", "G", "HO", "NCF", "UX", "ZK"}},
        {"metals", "Metals", {"GC", "SI", "PL", "PA", "HG", "ALI", "TIO", "HRC"}},
        {"grains", "Grains", {"ZS", "ZM", "ZL", "ZC", "ZW", "ZR", "RS", "ZO"}},
        {"softs", "Softs & Meats", {"KC", "CC", "SB", "CT", "LB", "LC", "FC", "LH", "JO"}},
        {"currencies", "Currencies", {"DX", "6E", "6J", "6B", "6C", "6S", "6A", "BTC", "6N"}},
    };
    return list;
}

std::string_view groupOf(std::string_view symbol) {
    for (const auto& group : groups()) {
        for (const auto& item : group.symbols) {
            if (item == symbol) return group.id;
        }
    }
    return "other";
}

bool isBondSymbol(std::string_view symbol) noexcept {
    return symbol == "ZT" || symbol == "ZF" || symbol == "ZN"
        || symbol == "TN" || symbol == "ZB" || symbol == "UB";
}

std::string_view unitOf(std::string_view symbol) noexcept {
    return isBondSymbol(symbol) ? "points" : "native quote";
}

bool isSymbolKey(std::string_view key) noexcept {
    if (key.empty() || key.size() > 8) return false;
    for (const char c : key) {
        if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) return false;
    }
    return true;
}

namespace {

// ---------------------------------------------------------------------------------------
// JavaScript string semantics on UTF-8 / WTF-8 text.

// The WhiteSpace + LineTerminator set that String.prototype.trim strips and that the
// regular-expression class \s matches.
bool isJsWhitespace(char32_t codePoint) noexcept {
    switch (codePoint) {
        case 0x09u: case 0x0Au: case 0x0Bu: case 0x0Cu: case 0x0Du: case 0x20u:
        case 0xA0u: case 0x1680u: case 0x2028u: case 0x2029u: case 0x202Fu:
        case 0x205Fu: case 0x3000u: case 0xFEFFu:
            return true;
        default:
            return codePoint >= 0x2000u && codePoint <= 0x200Au;
    }
}

// Byte length of the JavaScript whitespace code point starting at `position`, else 0.
std::size_t whitespaceAt(std::string_view text, std::size_t position) noexcept {
    if (position >= text.size()) return 0;
    char32_t codePoint = 0;
    const std::size_t length = jsonlite::decodeUtf8(text, position, codePoint);
    return isJsWhitespace(codePoint) ? length : 0;
}

// Byte length of the JavaScript whitespace code point ending exactly at `end`, else 0.
std::size_t whitespaceBefore(std::string_view text, std::size_t end) noexcept {
    for (std::size_t length = 1; length <= 4 && length <= end; ++length) {
        const std::size_t start = end - length;
        if ((static_cast<unsigned char>(text[start]) & 0xC0u) == 0x80u) continue;  // continuation byte
        char32_t codePoint = 0;
        if (jsonlite::decodeUtf8(text, start, codePoint) != length) return 0;
        return isJsWhitespace(codePoint) ? length : 0;
    }
    return 0;
}

// Position after the \s* run starting at `position`.
std::size_t skipWhitespace(std::string_view text, std::size_t position) noexcept {
    for (;;) {
        const std::size_t length = whitespaceAt(text, position);
        if (length == 0) return position;
        position += length;
    }
}

// String.prototype.trim.
std::string_view jsTrim(std::string_view text) noexcept {
    const std::size_t begin = skipWhitespace(text, 0);
    std::size_t end = text.size();
    while (end > begin) {
        const std::size_t length = whitespaceBefore(text, end);
        if (length == 0) break;
        end -= length;
    }
    return text.substr(begin, end - begin);
}

// String.prototype.slice(0, count) measured in UTF-16 code units. A cut through a
// supplementary character keeps its high surrogate, as JavaScript does.
std::string sliceUtf16(std::string_view text, std::size_t count) {
    std::string out;
    std::size_t units = 0;
    std::size_t position = 0;
    while (position < text.size() && units < count) {
        char32_t codePoint = 0;
        const std::size_t length = jsonlite::decodeUtf8(text, position, codePoint);
        if (codePoint >= 0x10000u) {
            if (units + 2 > count) {
                jsonlite::appendUtf8(out, 0xD800u + ((codePoint - 0x10000u) >> 10));
                break;
            }
            units += 2;
        } else {
            units += 1;
        }
        out.append(text.substr(position, length));
        position += length;
    }
    return out;
}

// Case folding of a regular expression without the u flag: ASCII letters only.
char lowerAscii(char c) noexcept {
    return (c >= 'A' && c <= 'Z') ? static_cast<char>(c + ('a' - 'A')) : c;
}

bool matchesIgnoreCase(std::string_view text, std::size_t position, std::string_view lowerLiteral) noexcept {
    if (position > text.size() || lowerLiteral.size() > text.size() - position) return false;
    for (std::size_t index = 0; index < lowerLiteral.size(); ++index) {
        if (lowerAscii(text[position + index]) != lowerLiteral[index]) return false;
    }
    return true;
}

std::size_t findIgnoreCase(std::string_view text, std::string_view lowerLiteral, std::size_t from) noexcept {
    for (std::size_t position = from; position + lowerLiteral.size() <= text.size(); ++position) {
        if (matchesIgnoreCase(text, position, lowerLiteral)) return position;
    }
    return std::string_view::npos;
}

// \w of a regular expression without the u flag.
bool isWordChar(char c) noexcept {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
}

// /(?:^|\s)name\s*=\s*(["'])value\1/i evaluated on a script tag's attribute text.
bool hasAttribute(std::string_view attributes, std::string_view name, std::string_view value) noexcept {
    for (std::size_t position = 0; position + name.size() <= attributes.size(); ++position) {
        if (!matchesIgnoreCase(attributes, position, name)) continue;
        if (position != 0 && whitespaceBefore(attributes, position) == 0) continue;
        std::size_t cursor = skipWhitespace(attributes, position + name.size());
        if (cursor >= attributes.size() || attributes[cursor] != '=') continue;
        cursor = skipWhitespace(attributes, cursor + 1);
        if (cursor >= attributes.size() || (attributes[cursor] != '"' && attributes[cursor] != '\'')) continue;
        const char quote = attributes[cursor];
        ++cursor;
        if (!matchesIgnoreCase(attributes, cursor, value)) continue;
        cursor += value.size();
        if (cursor < attributes.size() && attributes[cursor] == quote) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------------------
// Record validation.

// numeric(value): a finite JavaScript number, else null.
std::optional<double> numeric(const jsonlite::Value* value) noexcept {
    if (value == nullptr) return std::nullopt;
    const double* number = value->ifNumber();
    if (number == nullptr || !std::isfinite(*number)) return std::nullopt;
    return *number;
}

// /^\d+$/.test(key) && Number(key) < length
bool isIndexBelow(std::string_view key, std::size_t length) noexcept {
    if (key.empty()) return false;
    for (const char c : key) {
        if (c < '0' || c > '9') return false;
    }
    std::size_t first = 0;
    while (first + 1 < key.size() && key[first] == '0') ++first;
    const std::string_view digits = key.substr(first);
    // 16 or more significant digits is at least 1e15, beyond any sparkline length, so
    // Number()'s rounding of such strings cannot change the comparison.
    if (digits.size() > 15) return false;
    std::uint64_t value = 0;
    for (const char c : digits) value = value * 10u + static_cast<std::uint64_t>(c - '0');
    return value < static_cast<std::uint64_t>(length);
}

}  // namespace

Payload readPayload(std::string_view input) {
    const std::string_view text = jsTrim(input);
    if (text.empty() || text[0] != '<') return Payload{jsonlite::parse(text), false};

    // Never evaluate page JavaScript. This walks the matches of
    // /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi in order and parses the body of the
    // first one whose attributes carry the typed JSON id and type.
    constexpr std::string_view openTag = "<script";
    constexpr std::string_view closeTag = "</script";
    std::size_t position = 0;
    for (;;) {
        const std::size_t open = findIgnoreCase(text, openTag, position);
        if (open == std::string_view::npos) break;
        const std::size_t afterName = open + openTag.size();
        if (afterName < text.size() && isWordChar(text[afterName])) {  // \b fails ("<scripts")
            position = open + 1;
            continue;
        }
        const std::size_t endOfTag = text.find('>', afterName);
        if (endOfTag == std::string_view::npos) break;  // no later <script can close either
        const std::string_view attributes = text.substr(afterName, endOfTag - afterName);
        const std::size_t bodyStart = endOfTag + 1;
        std::size_t bodyEnd = std::string_view::npos;
        std::size_t resume = std::string_view::npos;
        for (std::size_t close = findIgnoreCase(text, closeTag, bodyStart);
             close != std::string_view::npos;
             close = findIgnoreCase(text, closeTag, close + 1)) {
            const std::size_t bracket = skipWhitespace(text, close + closeTag.size());
            if (bracket < text.size() && text[bracket] == '>') {
                bodyEnd = close;
                resume = bracket + 1;
                break;
            }
        }
        if (bodyEnd == std::string_view::npos) break;  // nothing after here closes a script
        if (hasAttribute(attributes, "id", "futures-init-data")
            && hasAttribute(attributes, "type", "application/json")) {
            return Payload{jsonlite::parse(text.substr(bodyStart, bodyEnd - bodyStart)), true};
        }
        position = resume;
    }
    throw FuturesError("Finviz response does not contain futures quote JSON.");
}

Quote sourceQuote(std::string_view symbol, const jsonlite::Value& data,
                  std::string_view fetchedAt, std::string_view sourceUrl) {
    static const jsonlite::Object empty;
    const jsonlite::Object& record = data.ifObject() != nullptr ? *data.ifObject() : empty;

    const jsonlite::Value* ticker = record.find("ticker");
    const bool identityMatches = ticker != nullptr && ticker->ifString() != nullptr
        && *ticker->ifString() == symbol;
    const std::optional<double> last = numeric(record.find("last"));
    const std::optional<double> changePct = numeric(record.find("change"));
    const bool available = identityMatches && last.has_value() && changePct.has_value();

    Quote quote;
    quote.symbol = std::string(symbol);
    quote.name = std::string(symbol);
    if (const jsonlite::Value* label = record.find("label"); label != nullptr && label->ifString() != nullptr) {
        const std::string_view trimmed = jsTrim(*label->ifString());
        if (!trimmed.empty()) quote.name = sliceUtf16(trimmed, 100);
    }
    quote.group = std::string(groupOf(symbol));
    quote.status = available ? "delayed" : "unavailable";
    if (available) {
        quote.price = last;
        quote.changePct = changePct;
        quote.change = numeric(record.find("changeUsd"));
        quote.prevClose = numeric(record.find("prevClose"));
        quote.high = numeric(record.find("high"));
        quote.low = numeric(record.find("low"));
        if (const jsonlite::Value* sparkline = record.find("sparkline"); sparkline != nullptr && sparkline->ifArray() != nullptr) {
            const jsonlite::Array& points = *sparkline->ifArray();
            bool everyNumeric = true;
            for (const jsonlite::Value& point : points) {
                if (!numeric(&point).has_value()) { everyNumeric = false; break; }
            }
            if (everyNumeric) {
                quote.sparkline.reserve(points.size());
                for (const jsonlite::Value& point : points) quote.sparkline.push_back(point.asNumber());
            }
        }
    }
    if (!quote.sparkline.empty()) {
        if (const jsonlite::Value* changes = record.find("sparklineDateChanges"); changes != nullptr && changes->ifObject() != nullptr) {
            const jsonlite::Object& labels = *changes->ifObject();
            for (const std::size_t index : jsonlite::enumerationOrder(labels)) {
                const std::string& key = labels.keys[index];
                const std::string* label = labels.values[index].ifString();
                if (label != nullptr && isIndexBelow(key, quote.sparkline.size())) {
                    quote.chartLabels.emplace_back(key, sliceUtf16(*label, 40));
                }
            }
        }
    }
    quote.unit = std::string(unitOf(symbol));
    if (available) quote.fetchedAt = std::string(fetchedAt);
    quote.sourceUrl = std::string(sourceUrl);
    return quote;
}

Snapshot parseFinvizFutures(std::string_view input, const ParseOptions& options) {
    const Payload payload = readPayload(input);
    const jsonlite::Object* data = payload.data.ifObject();
    if (data == nullptr) throw FuturesError("Finviz futures quote payload must be a record.");

    Snapshot snapshot;
    snapshot.source = "Finviz";
    snapshot.timeframe = options.timeframe.has_value() ? *options.timeframe : std::string(kDefaultTimeframe);
    if (options.sourceUrl.has_value()) {
        snapshot.sourceUrl = *options.sourceUrl;
    } else if (payload.fromPage) {
        snapshot.sourceUrl = std::string(kSourceUrl);
    } else {
        snapshot.sourceUrl = std::string(kApiUrl) + "?timeframe=" + snapshot.timeframe;
    }
    snapshot.status = "delayed";
    snapshot.cached = false;
    bool usable = false;
    for (const std::size_t index : jsonlite::enumerationOrder(*data)) {
        const std::string& symbol = data->keys[index];
        if (!isSymbolKey(symbol)) continue;
        snapshot.quotes.push_back(sourceQuote(symbol, data->values[index], options.fetchedAt, snapshot.sourceUrl));
        if (snapshot.quotes.back().status == "delayed") usable = true;
        else snapshot.partial = true;
    }
    if (!usable) throw FuturesError("Finviz response contains no usable futures quotes.");
    snapshot.fetchedAt = options.fetchedAt;
    snapshot.attemptedAt = options.fetchedAt;
    snapshot.quotedAt = std::nullopt;
    snapshot.delayMinutes = kDelayMinutes;
    if (snapshot.partial) snapshot.error = "Some Finviz quotes are unavailable.";
    return snapshot;
}

}  // namespace dip::futures

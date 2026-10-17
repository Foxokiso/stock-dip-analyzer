// Test-only line protocol for cross-language parity checks of dip::futures.
//
// Input, one case per line:
//   <base64 payload> TAB <timeframe> TAB <fetchedAt> [TAB <sourceUrl>]
//   payload    the exact bytes handed to parseFinvizFutures (raw JSON or an HTML page),
//              base64 encoded (RFC 4648 alphabet, '=' padding) so a case stays on one line
//   timeframe  the literal option, or the token `null` for "not given" (JavaScript
//   sourceUrl  undefined, so the reference's defaults apply); an empty field is ""
//   fetchedAt  an already normalized ISO-8601 timestamp (the library reads no clock)
//
// Output, one line per case:
//   ERROR TAB <message>
//   OK TAB source TAB sourceUrl TAB timeframe TAB status TAB cached TAB partial TAB fetchedAt
//      TAB attemptedAt TAB quotedAt TAB delayMinutes TAB error TAB quoteCount {TAB quote}
//   quote       = symbol|name|group|status|price|changePct|change|prevClose|high|low|unit
//                 |quotedAt|contract|fetchedAt|sourceUrl|sparkline|chartLabels
//   sparkline   = doubles joined by ','          (empty when there are no points)
//   chartLabels = {key=label;}                   (both strings, in enumeration order)
//
// Scalars: strings are double-quoted; every UTF-16 code unit of the string outside
// printable ASCII, or among  " \ | ; = , TAB , is written as \uXXXX (surrogates included),
// so a field never contains a separator and JSON.parse recovers the exact JavaScript
// string. null is the bare token `null`, booleans are 0/1, doubles use setprecision(17).
#include "dip/futures.hpp"

#include <exception>
#include <iomanip>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace {

bool decodeBase64(std::string_view text, std::string& out) {
    out.clear();
    unsigned int buffer = 0;
    int bits = 0;
    for (const char c : text) {
        if (c == '=') break;
        int value = -1;
        if (c >= 'A' && c <= 'Z') value = c - 'A';
        else if (c >= 'a' && c <= 'z') value = c - 'a' + 26;
        else if (c >= '0' && c <= '9') value = c - '0' + 52;
        else if (c == '+') value = 62;
        else if (c == '/') value = 63;
        if (value < 0) return false;
        buffer = (buffer << 6) | static_cast<unsigned int>(value);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<char>((buffer >> bits) & 0xFFu));
            buffer &= (1u << bits) - 1u;
        }
    }
    return bits < 6;
}

void writeUnit(std::ostream& out, char32_t unit) {
    const bool plain = unit >= 0x20u && unit < 0x7Fu && unit != U'"' && unit != U'\\'
        && unit != U'|' && unit != U';' && unit != U'=' && unit != U',';
    if (plain) {
        out << static_cast<char>(unit);
        return;
    }
    static constexpr char hex[] = "0123456789abcdef";
    out << "\\u" << hex[(unit >> 12) & 0xFu] << hex[(unit >> 8) & 0xFu]
        << hex[(unit >> 4) & 0xFu] << hex[unit & 0xFu];
}

void writeString(std::ostream& out, std::string_view text) {
    out << '"';
    std::size_t position = 0;
    while (position < text.size()) {
        char32_t codePoint = 0;
        position += dip::jsonlite::decodeUtf8(text, position, codePoint);
        if (codePoint >= 0x10000u) {
            writeUnit(out, 0xD800u + ((codePoint - 0x10000u) >> 10));
            writeUnit(out, 0xDC00u + ((codePoint - 0x10000u) & 0x3FFu));
        } else {
            writeUnit(out, codePoint);
        }
    }
    out << '"';
}

void writeOptional(std::ostream& out, const std::optional<double>& value) {
    if (value) out << *value;
    else out << "null";
}

void writeOptional(std::ostream& out, const std::optional<std::string>& value) {
    if (value) writeString(out, *value);
    else out << "null";
}

void writeQuote(std::ostream& out, const dip::futures::Quote& quote) {
    writeString(out, quote.symbol); out << '|';
    writeString(out, quote.name); out << '|';
    writeString(out, quote.group); out << '|';
    writeString(out, quote.status); out << '|';
    writeOptional(out, quote.price); out << '|';
    writeOptional(out, quote.changePct); out << '|';
    writeOptional(out, quote.change); out << '|';
    writeOptional(out, quote.prevClose); out << '|';
    writeOptional(out, quote.high); out << '|';
    writeOptional(out, quote.low); out << '|';
    writeString(out, quote.unit); out << '|';
    writeOptional(out, quote.quotedAt); out << '|';
    writeOptional(out, quote.contract); out << '|';
    writeOptional(out, quote.fetchedAt); out << '|';
    writeString(out, quote.sourceUrl); out << '|';
    const char* separator = "";
    for (const double point : quote.sparkline) {
        out << separator << point;
        separator = ",";
    }
    out << '|';
    for (const auto& [key, label] : quote.chartLabels) {
        writeString(out, key);
        out << '=';
        writeString(out, label);
        out << ';';
    }
}

void writeSnapshot(std::ostream& out, const dip::futures::Snapshot& snapshot) {
    out << "OK\t";
    writeString(out, snapshot.source); out << '\t';
    writeString(out, snapshot.sourceUrl); out << '\t';
    writeString(out, snapshot.timeframe); out << '\t';
    writeString(out, snapshot.status); out << '\t';
    out << (snapshot.cached ? 1 : 0) << '\t' << (snapshot.partial ? 1 : 0) << '\t';
    writeOptional(out, snapshot.fetchedAt); out << '\t';
    writeString(out, snapshot.attemptedAt); out << '\t';
    writeOptional(out, snapshot.quotedAt); out << '\t';
    out << snapshot.delayMinutes << '\t';
    writeOptional(out, snapshot.error); out << '\t';
    out << snapshot.quotes.size();
    for (const auto& quote : snapshot.quotes) {
        out << '\t';
        writeQuote(out, quote);
    }
    out << '\n';
}

std::vector<std::string> splitTabs(const std::string& line) {
    std::vector<std::string> fields;
    std::size_t start = 0;
    for (;;) {
        const std::size_t tab = line.find('\t', start);
        if (tab == std::string::npos) {
            fields.push_back(line.substr(start));
            return fields;
        }
        fields.push_back(line.substr(start, tab - start));
        start = tab + 1;
    }
}

}  // namespace

int main() {
    std::cout << std::setprecision(17);
    bool allOk = true;
    std::string line;
    while (std::getline(std::cin, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        const std::vector<std::string> fields = splitTabs(line);
        std::string payload;
        if (fields.size() < 3 || fields.size() > 4 || !decodeBase64(fields[0], payload)) {
            allOk = false;
            std::cerr << "futures_driver: cannot handle line: " << line.substr(0, 80) << '\n';
            std::cout << "ERROR\tdriver: malformed line\n";
            continue;
        }
        dip::futures::ParseOptions options;
        options.fetchedAt = fields[2];
        if (fields[1] != "null") options.timeframe = fields[1];
        if (fields.size() == 4 && fields[3] != "null") options.sourceUrl = fields[3];
        try {
            writeSnapshot(std::cout, dip::futures::parseFinvizFutures(payload, options));
        } catch (const std::exception& error) {
            std::cout << "ERROR\t" << error.what() << '\n';
        }
    }
    return allOk ? 0 : 1;
}

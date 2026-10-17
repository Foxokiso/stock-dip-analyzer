// Test-only line protocol for cross-language display-format parity checks.
// Each input line is "<fn> <value> [digits]"; each output line is the formatted string.
//   fn     formatCompact | formatPct | formatPrice | toFixed | toLocaleString | toString
//   value  decimal literal as String(x) prints it, or null | nan | Infinity | -Infinity
//   digits integer, used by formatPct (default 2) and toFixed (default 0)
#include "dip/format.hpp"
#include <cstdlib>
#include <iostream>
#include <limits>
#include <optional>
#include <sstream>
#include <string>

namespace {
// std::nullopt for "null"; NaN/±Infinity otherwise parsed explicitly because strtod's
// spelling of them varies between C libraries. Numbers go through strtod, whose
// correctly rounded conversion matches the JavaScript parser for String(x) output.
std::optional<double> parseValue(const std::string& token, bool& ok) {
    if (token == "null") return std::nullopt;
    if (token == "nan" || token == "NaN") return std::numeric_limits<double>::quiet_NaN();
    if (token == "inf" || token == "Infinity" || token == "+Infinity") return std::numeric_limits<double>::infinity();
    if (token == "-inf" || token == "-Infinity") return -std::numeric_limits<double>::infinity();
    char* end = nullptr;
    const double parsed = std::strtod(token.c_str(), &end);
    if (end == token.c_str() || *end != '\0') ok = false;
    return parsed;
}
}  // namespace

int main() {
    bool allOk = true;
    std::string line;
    while (std::getline(std::cin, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        std::istringstream input(line);
        std::string fn, valueToken, digitsToken;
        input >> fn >> valueToken >> digitsToken;
        bool ok = !fn.empty() && !valueToken.empty();
        const std::optional<double> value = ok ? parseValue(valueToken, ok) : std::nullopt;
        std::optional<int> digits;
        if (!digitsToken.empty()) {
            char* end = nullptr;
            const long parsed = std::strtol(digitsToken.c_str(), &end, 10);
            if (end == digitsToken.c_str() || *end != '\0' || parsed < 0 || parsed > 100) ok = false;
            else digits = static_cast<int>(parsed);
        }
        std::string out;
        if (!ok) {
            out = "error:malformed-line";
        } else if (fn == "formatCompact") {
            out = dip::format::formatCompact(value);
        } else if (fn == "formatPct") {
            out = dip::format::formatPct(value, digits.value_or(2));
        } else if (fn == "formatPrice") {
            out = dip::format::formatPrice(value);
        } else if (fn == "toFixed" && value) {
            out = dip::format::toFixed(*value, digits.value_or(0));
        } else if (fn == "toLocaleString" && value) {
            out = dip::format::toLocaleStringEnUS(*value);
        } else if (fn == "toString" && value) {
            out = dip::format::numberToString(*value);
        } else {
            out = "error:unknown-function";
            ok = false;
        }
        if (!ok) {
            allOk = false;
            std::cerr << "format_driver: cannot handle line: " << line << '\n';
        }
        std::cout << out << '\n';
    }
    return allOk ? 0 : 1;
}

// Test-only line protocol for cross-language numerical parity checks.
// Each input line is "<quote> <closes...>" with numbers as String(x) prints them, or null | nan;
// each output line is the analysis (tab-separated), null, or error:malformed-line.
#include "dip/analysis.hpp"
#include <charconv>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <limits>
#include <optional>
#include <sstream>
#include <string>
#include <system_error>
#include <vector>

namespace {
// std::from_chars is locale-independent and takes every literal String(x) prints, including
// subnormals such as 5e-324 that std::stod rejects as out of range. nullopt: not a number.
std::optional<double> number(const std::string& token) {
    if (token == "null" || token == "nan") return std::numeric_limits<double>::quiet_NaN();
    double value = 0;
    const auto [end, error] = std::from_chars(token.data(), token.data() + token.size(), value);
    if (error != std::errc{} || end != token.data() + token.size()) return std::nullopt;
    return value;
}

// Non-finite values use JavaScript's spelling, so Number() reads them back on every platform.
std::string text(double value) {
    if (std::isnan(value)) return "NaN";
    if (std::isinf(value)) return value > 0 ? "Infinity" : "-Infinity";
    std::ostringstream out;
    out << std::setprecision(17) << value;
    return out.str();
}
}  // namespace

int main() {
    bool allOk = true;
    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream input(line);
        std::string token;
        bool ok = static_cast<bool>(input >> token);
        std::optional<double> quote;
        if (ok && token != "null") {
            quote = number(token);
            ok = quote.has_value();
        }
        std::vector<double> prices;
        while (ok && input >> token) {
            const auto price = number(token);
            if (price) prices.push_back(*price);
            else ok = false;
        }
        if (!ok) {
            allOk = false;
            std::cerr << "analysis_driver: cannot handle line: " << line << '\n';
            std::cout << "error:malformed-line\n";
            continue;
        }
        const auto result = dip::analyzeStock(prices, quote);
        if (!result) { std::cout << "null\n"; continue; }
        const auto& a = *result;
        std::cout << a.score << '\t' << a.verdict << '\t' << a.isZombie
                  << '\t' << text(a.currentPrice) << '\t' << text(a.peakPrice)
                  << '\t' << a.peakIndex << '\t' << text(a.dipPercentage)
                  << '\t' << text(a.recentLow) << '\t' << text(a.recentHigh)
                  << '\t' << text(a.rsi) << '\t' << text(a.ema5) << '\t' << text(a.ema10)
                  << '\t' << a.trend << '\t' << a.trendAlertEligible
                  << '\t' << a.isBreakout << '\t' << a.isBreakdown << '\t';
        for (const auto& factor : a.factors) std::cout << factor.label << ':' << factor.points << '|';
        std::cout << '\t';
        for (const auto price : a.sparkline) std::cout << text(price) << ',';
        std::cout << '\n';
    }
    return allOk ? 0 : 1;
}

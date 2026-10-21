// Test-only line protocol for cross-language numerical parity checks.
#include "dip/analysis.hpp"
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>

static double number(const std::string& token) {
    if (token == "null" || token == "nan") return std::numeric_limits<double>::quiet_NaN();
    return std::stod(token);
}

int main() {
    std::cout << std::setprecision(17);
    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream input(line);
        std::string token;
        input >> token;
        const auto quote = token == "null" ? std::nullopt : std::optional<double>(number(token));
        std::vector<double> prices;
        while (input >> token) prices.push_back(number(token));
        const auto result = dip::analyzeStock(prices, quote);
        if (!result) { std::cout << "null\n"; continue; }
        const auto& a = *result;
        std::cout << a.score << '\t' << a.verdict << '\t' << a.isZombie
                  << '\t' << a.currentPrice << '\t' << a.peakPrice
                  << '\t' << a.peakIndex << '\t' << a.dipPercentage
                  << '\t' << a.recentLow << '\t' << a.recentHigh
                  << '\t' << a.rsi << '\t' << a.ema5 << '\t' << a.ema10
                  << '\t' << a.trend << '\t' << a.trendAlertEligible
                  << '\t' << a.isBreakout << '\t' << a.isBreakdown << '\t';
        for (const auto& factor : a.factors) std::cout << factor.label << ':' << factor.points << '|';
        std::cout << '\t';
        for (const auto price : a.sparkline) std::cout << price << ',';
        std::cout << '\n';
    }
}

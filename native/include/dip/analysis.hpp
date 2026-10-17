#pragma once

#include <optional>
#include <string>
#include <vector>

namespace dip {
struct Factor {
    std::string label;
    int points;
};

struct Analysis {
    int score{};
    std::string verdict;
    bool isZombie{};
    double currentPrice{}, peakPrice{}, dipPercentage{}, recentLow{}, recentHigh{};
    std::size_t peakIndex{};
    double rsi{}, ema5{}, ema10{};
    std::string trend;
    bool trendAlertEligible{}, isBreakout{}, isBreakdown{};
    std::vector<Factor> factors;
    std::vector<double> sparkline;
};

// No provider IO or UI work. Invalid/non-positive closes are excluded as in
// the current reference; absent or invalid live quotes use the latest close.
std::optional<Analysis> analyzeStock(const std::vector<double>& closes,
                                   std::optional<double> livePrice = std::nullopt);
}

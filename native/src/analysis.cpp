#include "dip/analysis.hpp"
#include <algorithm>
#include <cmath>

namespace dip {
namespace {
double ema(const std::vector<double>& prices, int period) {
    const double weight = 2.0 / (period + 1);
    double result = prices.front();
    for (std::size_t i = 1; i < prices.size(); ++i) {
        result = (prices[i] - result) * weight + result;
    }
    return result;
}

double rsi14(const std::vector<double>& prices) {
    double gains = 0, losses = 0;
    for (std::size_t i = prices.size() - 14; i < prices.size(); ++i) {
        const double difference = prices[i] - prices[i - 1];
        if (difference >= 0) gains += difference;
        else losses -= difference;
    }
    if (gains == 0 && losses == 0) return 50;
    if (losses == 0) return 100;
    return 100 - 100 / (1 + gains / losses);
}

std::string verdict(int score) {
    if (score >= 80) return "Strong Buy";
    if (score >= 60) return "Buy";
    if (score >= 40) return "Hold";
    if (score >= 20) return "Sell";
    return "Strong Sell";
}
}

std::optional<Analysis> analyzeStock(const std::vector<double>& closes,
                                   std::optional<double> livePrice) {
    std::vector<double> prices;
    prices.reserve(closes.size());
    for (const double price : closes) {
        if (std::isfinite(price) && price > 0) prices.push_back(price);
    }
    if (prices.size() < 15) return std::nullopt;

    Analysis a;
    a.score = 50;
    a.currentPrice = livePrice && std::isfinite(*livePrice) && *livePrice > 0
        ? *livePrice : prices.back();
    const double historicalPeak = *std::max_element(prices.begin(), prices.end());
    a.peakPrice = std::max(a.currentPrice, historicalPeak);
    a.peakIndex = prices.size() - 1;
    if (a.currentPrice <= historicalPeak) {
        for (std::size_t i = 0; i < prices.size(); ++i) {
            if (prices[i] == historicalPeak) a.peakIndex = i;
        }
    }
    a.dipPercentage = ((a.peakPrice - a.currentPrice) / a.peakPrice) * 100;
    const auto apply = [&](const std::string& label, int points) {
        a.factors.push_back({label, points});
        a.score += points;
    };
    if (a.dipPercentage > 25) apply("Dip depth", -20);
    else if (a.dipPercentage > 15) apply("Dip depth", 15);
    else if (a.dipPercentage > 5) apply("Dip depth", 25);
    else apply("Dip depth", -10);

    const auto begin = prices.begin() + static_cast<std::ptrdiff_t>(a.peakIndex);
    const auto [low, high] = std::minmax_element(begin, prices.end());
    a.recentLow = *low;
    a.recentHigh = *high;
    const auto postPeakCount = prices.size() - a.peakIndex;
    if (postPeakCount > 5) {
        apply("Recovery bounce", a.currentPrice > a.recentLow * 1.02 ? 20 : -15);
        if (postPeakCount >= 10) {
            if (a.currentPrice <= a.recentLow * 1.005 && a.dipPercentage > 5) {
                a.isBreakdown = true;
            } else if (a.currentPrice >= a.recentHigh * 0.995 && a.currentPrice > prices.front()) {
                a.isBreakout = true;
            }
        }
    }

    a.ema5 = ema(prices, 5);
    a.ema10 = ema(prices, 10);
    a.trend = "neutral";
    if (a.ema5 > a.ema10 && a.currentPrice > a.ema5 * 1.01) {
        a.trend = "bullish";
        apply("Short-term trend", 10);
    } else if (a.ema5 < a.ema10 && a.currentPrice < a.ema5 * 0.99) {
        a.trend = "bearish";
        apply("Short-term trend", -10);
    } else {
        apply("Short-term trend", 0);
    }
    a.rsi = rsi14(prices);
    apply("RSI (14)", a.rsi <= 30 ? 10 : a.rsi >= 70 ? -10 : 0);
    a.score = std::clamp(a.score, 0, 100);
    a.verdict = verdict(a.score);
    a.isZombie = a.score < 20;
    a.trendAlertEligible = postPeakCount > 5 && postPeakCount >= 10;
    a.sparkline.assign(prices.end() - 15, prices.end());
    return a;
}
}

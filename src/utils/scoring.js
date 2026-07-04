// Shared technical-analysis + recovery-scoring engine.
// Used by Dashboard.jsx and StockDetails.jsx so both surfaces show the exact
// same score AND the per-factor breakdown explaining it.

export function computeEMA(values, period) {
    if (!values || values.length === 0) return null;
    const k = 2 / (period + 1);
    return values.reduce((ema, v, i) => (i === 0 ? v : (v - ema) * k + ema), values[0]);
}

// Simple (Wilder-less) RSI over the trailing `period` bars.
export function computeRSI(values, period = 14) {
    if (!values || values.length < period + 1) return null;
    const slice = values.slice(-(period + 1));
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < slice.length; i++) {
        const diff = slice[i] - slice[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    // Flat window (no gains AND no losses) is neutral, not "all gains".
    if (gains === 0 && losses === 0) return 50;
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
}

// SMA series aligned with the input (null until enough bars accumulate).
export function computeSMASeries(values, period) {
    if (!values) return [];
    let windowSum = 0;
    return values.map((v, i) => {
        windowSum += v;
        if (i >= period) windowSum -= values[i - period];
        return i >= period - 1 ? windowSum / period : null;
    });
}

export function getVerdict(score, isZombie = score < 20) {
    if (isZombie) return { label: 'Zombie', color: '#9ca3af' };
    if (score >= 80) return { label: 'Strong Buy', color: 'var(--success)' };
    if (score >= 60) return { label: 'Buy', color: '#22c55e' };
    if (score >= 40) return { label: 'Hold', color: 'var(--warning)' };
    if (score >= 20) return { label: 'Sell', color: '#f97316' };
    return { label: 'Strong Sell', color: 'var(--danger)' };
}

/**
 * Analyze a chronological series of closing prices.
 *
 * @param {number[]} closes   Chronological closing prices (nulls tolerated).
 * @param {number}   livePrice Optional real-time price overriding the last close.
 * @returns {object|null} {
 *   score, verdict: {label, color}, isZombie,
 *   factors: [{ label, points, detail }],
 *   currentPrice, peakPrice, peakIndex, dipPercentage,
 *   recentLow, recentHigh, rsi, ema5, ema10,
 *   trend: 'bullish'|'bearish'|'neutral',
 *   trendAlertEligible,        // peak old enough that trend alerts may fire
 *   isBreakout, isBreakdown,
 *   sparkline: number[]        // trailing closes for mini-charts
 * } or null when there is no usable data.
 */
export function analyzeStock(closes, livePrice = null) {
    const prices = (closes || []).filter(p => typeof p === 'number' && !Number.isNaN(p));
    if (prices.length === 0) return null;

    const currentPrice = livePrice || prices[prices.length - 1];
    const historicalPeak = Math.max(...prices);
    const peakPrice = Math.max(livePrice || 0, historicalPeak);
    const peakIndex = prices.indexOf(historicalPeak);
    const dipPercentage = peakPrice > 0 ? ((peakPrice - currentPrice) / peakPrice) * 100 : 0;

    const factors = [];
    let score = 50;
    const apply = (label, points, detail) => {
        factors.push({ label, points, detail });
        score += points;
    };

    // Factor 1: dip depth — the 5-25% zone is the attractive buy window.
    if (dipPercentage > 25) {
        apply('Dip depth', -20, `${dipPercentage.toFixed(1)}% below peak — falling-knife territory`);
    } else if (dipPercentage > 15) {
        apply('Dip depth', 15, `${dipPercentage.toFixed(1)}% below peak — deep correction zone`);
    } else if (dipPercentage > 5) {
        apply('Dip depth', 25, `${dipPercentage.toFixed(1)}% below peak — attractive dip zone`);
    } else {
        apply('Dip depth', -10, `Only ${dipPercentage.toFixed(1)}% below peak — no meaningful dip yet`);
    }

    // Post-peak structure: bounce detection plus support/resistance breaks.
    const postPeak = prices.slice(peakIndex);
    const recentLow = postPeak.length ? Math.min(...postPeak) : null;
    const recentHigh = postPeak.length ? Math.max(...postPeak) : null;
    let isBreakout = false;
    let isBreakdown = false;

    if (prices.length - peakIndex > 5) {
        if (currentPrice > recentLow * 1.02) {
            const abovePct = ((currentPrice / recentLow - 1) * 100).toFixed(1);
            apply('Recovery bounce', 20, `Trading ${abovePct}% above the post-peak low of $${recentLow.toFixed(2)}`);
        } else {
            apply('Recovery bounce', -15, `Still pinned to the post-peak low of $${recentLow.toFixed(2)} — no bounce yet`);
        }

        if (postPeak.length >= 10) {
            if (currentPrice <= recentLow * 1.005 && dipPercentage > 5) {
                isBreakdown = true;
            } else if (currentPrice >= recentHigh * 0.995 && currentPrice > prices[0]) {
                isBreakout = true;
            }
        }
    }

    // Factor 3: short-term momentum via EMA5 vs EMA10 with price confirmation.
    const ema5 = computeEMA(prices.slice(-5), 5);
    const ema10 = computeEMA(prices.slice(-10), 10);
    let trend = 'neutral';
    if (prices.length >= 10 && ema5 !== null && ema10 !== null) {
        if (ema5 > ema10 && currentPrice > ema5 * 1.01) {
            trend = 'bullish';
            apply('Short-term trend', 10, 'EMA5 above EMA10 with price confirming — momentum turning up');
        } else if (ema5 < ema10 && currentPrice < ema5 * 0.99) {
            trend = 'bearish';
            apply('Short-term trend', -10, 'EMA5 below EMA10 with price confirming — momentum still pointing down');
        } else {
            apply('Short-term trend', 0, 'No decisive short-term momentum signal');
        }
    }

    // Factor 4: RSI extremes.
    const rsi = computeRSI(prices, 14);
    if (rsi !== null) {
        if (rsi <= 30) apply('RSI (14)', 10, `RSI ${rsi.toFixed(0)} — oversold, mean-reversion setups favored`);
        else if (rsi >= 70) apply('RSI (14)', -10, `RSI ${rsi.toFixed(0)} — overbought, poor dip-entry timing`);
        else apply('RSI (14)', 0, `RSI ${rsi.toFixed(0)} — neutral zone`);
    }

    score = Math.max(0, Math.min(100, score));
    const isZombie = score < 20;

    return {
        score,
        verdict: getVerdict(score, isZombie),
        isZombie,
        factors,
        currentPrice,
        peakPrice,
        peakIndex,
        dipPercentage,
        recentLow,
        recentHigh,
        rsi,
        ema5,
        ema10,
        trend,
        // Trend ALERTS historically only fired once the peak was >5 bars old with
        // >=10 post-peak bars; the trend itself stays informative regardless.
        trendAlertEligible: prices.length - peakIndex > 5 && postPeak.length >= 10,
        isBreakout,
        isBreakdown,
        sparkline: prices.slice(-15),
    };
}

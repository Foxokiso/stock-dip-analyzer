import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStock, getVerdict, computeEMA, computeRSI, computeSMASeries } from '../src/utils/scoring.js';
import { formatPrice, formatPct, formatCompact } from '../src/utils/format.js';

const factor = (analysis, label) => analysis.factors.find(f => f.label === label);
const fromChanges = (changes) => changes.reduce((closes, change) => [...closes, closes.at(-1) + change], [100]);

test('insufficient history never produces a trade rating', () => {
    assert.equal(analyzeStock([100, 90], 92), null);
    assert.equal(getVerdict(null), null);
});

test('low technical scores never claim an asset is dead or delisted', () => {
    assert.equal(getVerdict(15, true).label, 'Strong Sell');
});

test('verdict bands are 80/60/40/20 and carry labels only, never colours', () => {
    const bands = [[100, 'Strong Buy'], [80, 'Strong Buy'], [79.99, 'Buy'], [60, 'Buy'], [59.99, 'Hold'], [40, 'Hold'],
        [39.99, 'Sell'], [20, 'Sell'], [19.99, 'Strong Sell'], [0, 'Strong Sell']];
    for (const [score, label] of bands) assert.deepEqual(getVerdict(score), { label }, `score ${score}`);
    assert.deepEqual(getVerdict(45, true), { label: 'Strong Sell' });
    for (const score of [NaN, Infinity, '50', undefined]) assert.equal(getVerdict(score), null);
});

test('invalid bars and quotes cannot enter a technical score', () => {
    assert.equal(analyzeStock(Array(20).fill(Infinity), 90), null);
    const closes = Array(20).fill(100);
    const a = analyzeStock(closes, Infinity);
    assert.equal(a.currentPrice, 100);
    assert.equal(a.score, 40);
});

test('dip depth: over 25% is a falling knife, over 15% a deep correction, over 5% an attractive dip', () => {
    // Flat closes at 100: trend and RSI are neutral, so only the dip moves the score.
    for (const [live, points] of [[97, -10], [95, -10], [94.99, 25], [90, 25], [85, 25], [84.99, 15], [80, 15], [75, 15], [74.99, -20], [70, -20]]) {
        const a = analyzeStock(Array(20).fill(100), live);
        assert.deepEqual(a.factors.map(f => f.label), ['Dip depth', 'Short-term trend', 'Simple RSI (14)']);
        assert.equal(a.factors[0].points, points, `live ${live}`);
        assert.equal(a.score, 50 + points);
    }
    assert.equal(factor(analyzeStock(Array(20).fill(100), 90), 'Dip depth').detail, '10.0% below peak — attractive dip zone');
});

test('a recovery bounce needs more than 2% above the post-peak low and a peak over 5 bars old', () => {
    const base = [100, 95, 90, 85, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80];
    assert.deepEqual(factor(analyzeStock(base, 81.7), 'Recovery bounce'), { label: 'Recovery bounce', points: 20, detail: 'Trading 2.1% above the post-peak low of $80.00' });
    assert.deepEqual(factor(analyzeStock(base, 81.5), 'Recovery bounce'), { label: 'Recovery bounce', points: -15, detail: 'Still pinned to the post-peak low of $80.00 — no bounce yet' });
    assert.equal(factor(analyzeStock([...Array(10).fill(90), 100, 95, 90, 85, 84]), 'Recovery bounce'), undefined);
    assert.equal(factor(analyzeStock([...Array(9).fill(90), 100, 95, 90, 85, 84, 83]), 'Recovery bounce').points, -15);
});

test('the short-term trend needs EMA5 across EMA10 and the price 1% beyond EMA5', () => {
    assert.equal(computeEMA([1, 2, 3], 2), 23 / 9);
    assert.equal(computeEMA([7], 5), 7);
    assert.equal(computeEMA([], 5), null);
    const rising = Array.from({ length: 15 }, (_, i) => 100 + i);
    const trendOf = (closes, live) => {
        const a = analyzeStock(closes, live);
        return [a.trend, factor(a, 'Short-term trend').points];
    };
    assert.deepEqual(trendOf(rising), ['bullish', 10]);
    assert.deepEqual(trendOf([...rising].reverse()), ['bearish', -10]);
    assert.deepEqual(trendOf(Array(20).fill(100)), ['neutral', 0]);
    // EMA5 (about 112.01 rising, 101.99 falling) is beyond EMA10, but the price is within 1% of it.
    assert.deepEqual(trendOf(rising, 112.5), ['neutral', 0]);
    assert.deepEqual(trendOf([...rising].reverse(), 101.5), ['neutral', 0]);
});

test('the simple RSI sums the last 14 changes; 30 or less adds 10 and 70 or more subtracts 10', () => {
    const thirty = fromChanges([-1, -1, -1, -1, -1, -1, -1, 1, 1, 1, 0, 0, 0, 0]);
    const seventy = fromChanges([1, 1, 1, 1, 1, 1, 1, -1, -1, -1, 0, 0, 0, 0]);
    assert.equal(computeRSI(thirty), 30);
    assert.equal(computeRSI(seventy), 70);
    assert.equal(computeRSI([500, ...thirty]), 30, 'only the last 14 changes count');
    assert.equal(computeRSI(Array(15).fill(100)), 50);
    assert.equal(computeRSI(fromChanges(Array(14).fill(1))), 100);
    assert.equal(computeRSI(fromChanges(Array(14).fill(-1))), 0);
    assert.equal(computeRSI(Array(14).fill(100)), null);
    assert.deepEqual(factor(analyzeStock(thirty), 'Simple RSI (14)'), { label: 'Simple RSI (14)', points: 10, detail: 'Simple RSI 30 — oversold, mean-reversion setups favored' });
    assert.deepEqual(factor(analyzeStock(seventy), 'Simple RSI (14)'), { label: 'Simple RSI (14)', points: -10, detail: 'Simple RSI 70 — overbought, poor dip-entry timing' });
});

test('scores are clamped to 0..100', () => {
    // Every factor at its best: 50 + 25 + 20 + 10 + 10 = 115.
    const top = analyzeStock([120, 90, 90.95, 91.9, 92.85, 93.8, 94.75, 95.7, 96.65, 97.6, 98.55, 99.5, 100.45, 101.4, 102.35]);
    assert.deepEqual(top.factors.map(f => f.points), [25, 20, 10, 10]);
    assert.equal(top.score, 100);
    assert.deepEqual(top.verdict, { label: 'Strong Buy' });
    // Every factor at its worst: 50 - 20 - 15 - 10 - 10 = -5.
    const bottom = analyzeStock([20, 100, 97.4, 94.8, 92.2, 89.6, 87, 84.4, 81.8, 79.2, 76.6, 74, 71.4, 68.8, 66.2]);
    assert.deepEqual(bottom.factors.map(f => f.points), [-20, -15, -10, -10]);
    assert.equal(bottom.score, 0);
    assert.equal(bottom.isZombie, true);
    assert.deepEqual(bottom.verdict, { label: 'Strong Sell' });
});

test('trend alerts are eligible once the peak is at least 9 sessions back', () => {
    const peakBack = (sessions) => [...Array(20 - sessions).fill(90), 100, ...Array(sessions).fill(95)];
    assert.equal(analyzeStock(peakBack(9)).trendAlertEligible, true);
    assert.equal(analyzeStock(peakBack(8)).trendAlertEligible, false);
    assert.equal(analyzeStock(peakBack(3)).trendAlertEligible, false);
});

test('the SMA series slides its window and stays aligned with the closes', () => {
    assert.deepEqual(computeSMASeries([1, 2, 3, 4, 5, 10], 3), [null, null, 2, 3, 4, 19 / 3]);
    assert.deepEqual(computeSMASeries([], 20), []);
    assert.deepEqual(computeSMASeries(null, 20), []);
});

test('the scoring RSI is labelled as a simple RSI, not as the Wilder RSI (14) Finviz shows', () => {
    // 14 changes: four falls of 5.5 and ten rises of 1, so 100 * 10 / (10 + 22) = 31.25.
    const a = analyzeStock([100, 94.5, 89, 83.5, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88]);
    assert.ok(Math.abs(a.rsi - 31.25) < 1e-9);
    assert.deepEqual(a.factors.at(-1), { label: 'Simple RSI (14)', points: 0, detail: 'Simple RSI 31 — neutral zone' });
    assert.ok(a.factors.every(f => !/^RSI/.test(f.label) && !/^RSI/.test(f.detail)));
});

// 21 daily closes: 100s, a 110 closing high `sessionsSinceHigh` sessions before the current
// session, a 105 base, and the current session's bar last, as Yahoo's daily series ends.
const breakoutCloses = (sessionsSinceHigh, sessionClose) => {
    const high = 20 - sessionsSinceHigh;
    return Array.from({ length: 21 }, (_, i) => (i === 20 ? sessionClose : i === high ? 110 : i < high ? 100 : 105));
};

test('a breakout is a price above the earlier sessions\' closing high after a base of 9+ sessions', () => {
    // With and without a live quote (during trading the session's bar is at the live price).
    for (const quoted of [false, true]) {
        const breakout = (sessionsSinceHigh, price) => analyzeStock(breakoutCloses(sessionsSinceHigh, price), quoted ? price : undefined).isBreakout;
        assert.equal(breakout(12, 112), true, 'break above');
        assert.equal(breakout(12, 110), false, 'touch');
        assert.equal(breakout(12, 109.6), false, 'retest from below');
        assert.equal(breakout(8, 112), false, '8-session base');
        assert.equal(breakout(9, 112), true, '9-session base');
    }
    // A live price that differs slightly from the session bar is compared, not the bar.
    assert.equal(analyzeStock(breakoutCloses(12, 110.2), 109.9).isBreakout, false);
    assert.equal(analyzeStock(breakoutCloses(12, 109.9), 110.2).isBreakout, true);
    // The base runs from the latest close at the high: a second top 4 sessions ago resets it.
    const doubleTop = breakoutCloses(12, 112);
    doubleTop[16] = 110;
    assert.equal(analyzeStock(doubleTop).isBreakout, false);
});

test('a breakdown is a close at most 0.5% above the post-peak low, more than 5% under the peak', () => {
    // 15 closes falling from a 100 peak; the last close (the current session) is `low`.
    const fallTo = (low) => [...Array.from({ length: 14 }, (_, i) => 100 - (100 - low) * i / 14), low];
    assert.equal(analyzeStock(fallTo(95.5)).isBreakdown, false, '4.5% dip');
    assert.equal(analyzeStock(fallTo(95)).isBreakdown, false, '5% dip');
    assert.equal(analyzeStock(fallTo(94.9999)).isBreakdown, true, '5.0001% dip');
    assert.equal(analyzeStock(fallTo(80)).isBreakdown, true, 'at the low');
    // Below an earlier low, within 0.5% above it, and clear of it.
    const bounced = [...fallTo(80).slice(0, -1), 80, 84, 83];
    assert.equal(analyzeStock([...bounced, 79]).isBreakdown, true, 'new low');
    assert.equal(analyzeStock([...bounced, 80.3]).isBreakdown, true, 'retest of the low');
    assert.equal(analyzeStock([...bounced, 80.39]).isBreakdown, true, 'within 0.5% of the low');
    assert.equal(analyzeStock([...bounced, 80 * 1.005]).isBreakdown, true, 'exactly 0.5% above the low');
    assert.equal(analyzeStock([...bounced, 80.41]).isBreakdown, false, 'just over 0.5%');
    assert.equal(analyzeStock([...bounced, 80.5]).isBreakdown, false, 'bounce');
    // The peak needs at least 9 sessions after it.
    assert.equal(analyzeStock([90, 90, 90, 90, 90, 90, 100, 98, 96, 94, 92, 90, 88, 86, 85]).isBreakdown, false);
    assert.equal(analyzeStock([90, 90, 90, 90, 90, 100, 98, 96, 94, 92, 90, 88, 86, 85, 84]).isBreakdown, true);
});

test('breakout and breakdown never coincide', () => {
    for (const closes of [breakoutCloses(12, 112), breakoutCloses(12, 109.6), [100, ...Array(18).fill(90), 80]]) {
        for (const live of [undefined, 70, 95, 100, 120]) {
            const a = analyzeStock(closes, live);
            assert.ok(!(a.isBreakout && a.isBreakdown));
        }
    }
});

test('a quote setting a new high is assigned to the latest observation', () => {
    const a = analyzeStock([100, 98, 97, 99, 96, 95, 94, 96, 92, 93, 94, 95, 96, 97, 98], 105);
    assert.equal(a.peakPrice, 105);
    assert.equal(a.peakIndex, 14);
});

test('missing and nonfinite display values remain unavailable', () => {
    for (const value of ['', ' ', Infinity, -Infinity, NaN, null, undefined]) {
        assert.equal(formatPrice(value), '—');
        assert.equal(formatPct(value), '—');
        assert.equal(formatCompact(value), '—');
    }
    assert.equal(formatPct(0), '0.00%');
    assert.equal(formatPrice(12.3), '$12.30');
});

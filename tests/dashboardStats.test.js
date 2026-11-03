import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStocks } from '../src/utils/dashboardStats.js';

test('summarizeStocks preserves dashboard summary behavior in one pass', () => {
    const stocks = [
        { symbol: 'AAA', changePercentage: -8, recoveryProbability: 75, isZombie: false, analysis: {} },
        { symbol: 'BBB', changePercentage: -3, recoveryProbability: 59, isZombie: true, analysis: null },
        { symbol: 'CCC', changePercentage: 4, recoveryProbability: null, isZombie: false, analysis: {} },
        { symbol: 'DDD', changePercentage: null, recoveryProbability: 90, isZombie: true, analysis: {} },
        { symbol: 'EEE', changePercentage: NaN, recoveryProbability: undefined, isZombie: false, analysis: null },
    ];

    assert.deepEqual(summarizeStocks(stocks), {
        scanned: 5,
        avgDayChange: -7 / 3,
        buySignals: 2,
        lowScoreCount: 2,
        scoredCount: 3,
        deepestDip: stocks[0],
    });
});

test('summarizeStocks handles empty and non-losing scans', () => {
    assert.deepEqual(summarizeStocks([]), {
        scanned: 0,
        avgDayChange: null,
        buySignals: 0,
        lowScoreCount: 0,
        scoredCount: 0,
        deepestDip: null,
    });
    assert.equal(summarizeStocks([
        { symbol: 'AAA', changePercentage: 0 },
        { symbol: 'BBB', changePercentage: 2 },
    ]).deepestDip, null);
});

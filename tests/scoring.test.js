import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStock, getVerdict } from '../src/utils/scoring.js';
import { formatPrice, formatPct, formatCompact } from '../src/utils/format.js';

test('insufficient history never produces a trade rating', () => {
    assert.equal(analyzeStock([100, 90], 92), null);
    assert.equal(getVerdict(null), null);
});

test('low technical scores never claim an asset is dead or delisted', () => {
    assert.equal(getVerdict(15, true).label, 'Strong Sell');
});

test('invalid bars and quotes cannot enter a technical score', () => {
    assert.equal(analyzeStock(Array(20).fill(Infinity), 90), null);
    const closes = Array(20).fill(100);
    const a = analyzeStock(closes, Infinity);
    assert.equal(a.currentPrice, 100);
    assert.equal(a.score, 40);
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

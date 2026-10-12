import test from 'node:test';
import assert from 'node:assert/strict';
import { getYahooQuote, getYahooChartPoints, canRaiseTechnicalAlert } from '../src/utils/marketData.js';

const ts = (value) => Date.parse(value) / 1000;
const result = (quoteTime, timestamps, close, extra = {}) => ({
    meta: { regularMarketPrice: 105, regularMarketTime: ts(quoteTime), exchangeTimezoneName: 'America/New_York', range: '1mo', dataGranularity: '1d', exchangeDataDelayedBy: 15, currency: 'USD', ...extra },
    timestamp: timestamps.map(ts), indicators: { quote: [{ close }] },
});

test('daily change uses the preceding session when the current daily bar exists', () => {
    const q = getYahooQuote(result('2026-10-09T18:00:00Z', ['2026-10-08T13:30:00Z', '2026-10-09T13:30:00Z'], [100, 104]));
    assert.equal(q.previousClose, 100);
    assert.equal(q.changePct, 5);
    assert.equal(q.quotedAt, '2026-10-09T18:00:00.000Z');
    assert.equal(q.delayMinutes, 15);
});

test('a new session quote uses the last daily bar when its own bar is absent', () => {
    const q = getYahooQuote(result('2026-10-09T18:00:00Z', ['2026-10-07T13:30:00Z', '2026-10-08T13:30:00Z'], [90, 100]));
    assert.equal(q.previousClose, 100);
    assert.equal(q.changePct, 5);
});

test('a missing prior session close cannot become a multi-session day change', () => {
    const q = getYahooQuote(result('2026-10-09T18:00:00Z', ['2026-10-07T13:30:00Z', '2026-10-08T13:30:00Z', '2026-10-09T13:30:00Z'], [90, null, 104]));
    assert.equal(q.previousClose, null);
    assert.equal(q.changePct, null);
});

test('multi-day chartPreviousClose cannot become yesterday close', () => {
    const q = getYahooQuote(result('2026-10-09T18:00:00Z', ['2026-10-09T13:30:00Z'], [104], { chartPreviousClose: 80 }));
    assert.equal(q.previousClose, null);
    assert.equal(q.changePct, null);
});

test('one-day intraday charts may use their previous session reference', () => {
    const q = getYahooQuote(result('2026-10-09T18:00:00Z', ['2026-10-09T13:30:00Z', '2026-10-09T13:35:00Z'], [104, 105], { range: '1d', dataGranularity: '5m', chartPreviousClose: 100 }));
    assert.equal(q.changePct, 5);
});

test('invalid quote metadata remains unavailable without substituting an old close', () => {
    const q = getYahooQuote(result('2026-10-09T18:00:00Z', ['2026-10-08T13:30:00Z'], [100], { regularMarketPrice: null, regularMarketTime: null, exchangeDataDelayedBy: null }));
    assert.equal(q.price, null);
    assert.equal(q.quotedAt, null);
    assert.equal(q.delayMinutes, null);
    assert.equal(q.changePct, null);
});

test('chart points retain the exchange date and timestamp while dropping invalid bars', () => {
    const points = getYahooChartPoints(result('2026-10-09T18:00:00Z', ['2026-10-08T00:30:00Z', '2026-10-09T13:30:00Z'], [100, Infinity]));
    assert.deepEqual(points, [{ timestamp: ts('2026-10-08T00:30:00Z'), date: '2026-10-07', price: 100 }]);
});

test('delayed, stale, and untimed quotes cannot create live technical alerts', () => {
    const now = Date.parse('2026-10-09T18:00:00Z');
    const quote = { quotedAt: '2026-10-09T17:59:00Z', delayMinutes: 0, price: 100 };
    assert.equal(canRaiseTechnicalAlert(quote, 20, now), true);
    assert.equal(canRaiseTechnicalAlert({ ...quote, delayMinutes: 1 }, 20, now), false);
    assert.equal(canRaiseTechnicalAlert({ ...quote, quotedAt: null }, 20, now), false);
    assert.equal(canRaiseTechnicalAlert({ ...quote, quotedAt: '2026-10-09T17:30:00Z' }, 20, now), false);
    assert.equal(canRaiseTechnicalAlert(quote, 2, now), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchYahooChart, clearChartCache, chartCacheSize } from '../src/utils/chartCache.js';

const bridge = () => {
    const calls = [];
    return { calls, invoke: async (channel, symbol, range, interval) => { calls.push([channel, symbol, range, interval]); return { symbol, n: calls.length }; } };
};

test.beforeEach(() => clearChartCache());

test('a zero TTL always goes to the provider', async () => {
    const { invoke, calls } = bridge();
    const first = await fetchYahooChart(invoke, 'AAPL', { ttlSeconds: 0 });
    const second = await fetchYahooChart(invoke, 'AAPL', { ttlSeconds: 0 });
    assert.equal(calls.length, 2);
    assert.equal(first.cached, false);
    assert.equal(second.cached, false);
    assert.deepEqual(calls[0], ['fetch-yahoo-chart', 'AAPL', '1mo', '1d']);
});

test('within the TTL the response and its original retrieval time are reused', async () => {
    const { invoke, calls } = bridge();
    let clock = Date.parse('2026-10-21T09:00:00.000Z');
    const now = () => clock;
    const first = await fetchYahooChart(invoke, 'AAPL', { ttlSeconds: 60, now });
    clock += 30_000;
    const hit = await fetchYahooChart(invoke, 'AAPL', { ttlSeconds: 60, now });
    assert.equal(calls.length, 1);
    assert.equal(hit.cached, true);
    assert.equal(hit.fetchedAt, first.fetchedAt, 'the retrieval time is the original one, not the read time');
    assert.equal(hit.fetchedAt, '2026-10-21T09:00:00.000Z');
    clock += 31_000;
    const miss = await fetchYahooChart(invoke, 'AAPL', { ttlSeconds: 60, now });
    assert.equal(calls.length, 2);
    assert.equal(miss.cached, false);
    assert.equal(miss.fetchedAt, '2026-10-21T09:01:01.000Z');
});

test('symbol, range and interval are distinct keys and a later TTL can reuse an earlier fetch', async () => {
    const { invoke, calls } = bridge();
    await fetchYahooChart(invoke, 'AAPL', { range: '1d', interval: '5m' });
    await fetchYahooChart(invoke, 'AAPL', { range: '1mo', interval: '1d' });
    await fetchYahooChart(invoke, 'MSFT', { range: '1mo', interval: '1d' });
    assert.equal(calls.length, 3);
    assert.equal(chartCacheSize(), 3);
    const reused = await fetchYahooChart(invoke, 'MSFT', { range: '1mo', interval: '1d', ttlSeconds: 3600 });
    assert.equal(reused.cached, true);
    assert.equal(calls.length, 3);
});

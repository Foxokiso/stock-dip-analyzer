import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFinvizFutures, parseFinvizFutures } from '../src/services/futures.js';

// Small excerpts of the real public Finviz response retrieved 2026-10-11.
// Sparkline samples are the final six source points, never generated prices.
const actual = {
    ES: {
        label: 'S&P 500', ticker: 'ES', last: 7866, change: 0.56,
        changeUsd: 43.5, prevClose: 7816.25, high: 7870.5, low: 7817,
        sparkline: [7862.25, 7862.5, 7863.25, 7865.5, 7865, 7866],
        sparklineDateChanges: {},
    },
    ZB: {
        label: '30 Year Bond', ticker: 'ZB', last: 103.1875, change: 0.06,
        changeUsd: 0.0625, prevClose: 103.0625, high: 103.25, low: 102.5625,
        sparkline: [103.125, 103.125, 103.1875, 103.1875, 103.1875, 103.1875],
        sparklineDateChanges: {},
    },
    ZF: {
        label: '5 Year Note', ticker: 'ZF', last: 103.6015625, change: -0.13,
        changeUsd: -0.1328, prevClose: 103.7265625, high: 103.796875, low: 103.4765625,
        sparkline: [], sparklineDateChanges: {},
    },
    ZT: {
        label: '2 Year Note', ticker: 'ZT', last: 101.83984375, change: -0.06,
        changeUsd: -0.0625, prevClose: 101.8984375, high: 101.921875, low: 101.78515625,
        sparkline: [], sparklineDateChanges: {},
    },
};
const fetchedAt = '2026-10-11T01:51:13.000Z';
const refreshedAt = '2026-10-11T01:56:13.000Z';
const row = (snapshot, symbol) => snapshot.quotes.find(quote => quote.symbol === symbol);
const html = (data) => `<html><script type="application/json" id="futures-init-data">${JSON.stringify(data)}</script></html>`;

test('normalizes source quotes without replacing source percent changes with derived values', () => {
    const snapshot = parseFinvizFutures(JSON.stringify(actual), { fetchedAt, timeframe: 'i5' });
    assert.equal(row(snapshot, 'ES').price, 7866);
    assert.equal(row(snapshot, 'ES').changePct, 0.56);
    assert.equal(row(snapshot, 'ES').change, 43.5);
    assert.equal(row(snapshot, 'ES').name, 'S&P 500');
    assert.equal(row(snapshot, 'ES').group, 'indices');
    assert.deepEqual(row(snapshot, 'ES').sparkline, actual.ES.sparkline);
    assert.deepEqual(row(snapshot, 'ES').chartLabels, {});
    assert.equal(snapshot.status, 'delayed');
    assert.equal(snapshot.fetchedAt, fetchedAt);
    assert.equal(snapshot.quotedAt, null);
    assert.equal(row(snapshot, 'ES').contract, null);
    assert.equal(row(snapshot, 'ES').quotedAt, null);
    assert.equal(snapshot.delayMinutes, 20);
});

test('retains decimal bond points down to eighths of one thirty-second', () => {
    const snapshot = parseFinvizFutures(actual, { fetchedAt });
    assert.equal(row(snapshot, 'ZB').price, 103.1875);
    assert.equal(row(snapshot, 'ZF').price, 103.6015625);
    assert.equal(row(snapshot, 'ZT').price, 101.83984375);
    assert.equal(row(snapshot, 'ZB').unit, 'points');
    assert.equal(row(snapshot, 'ZB').change, 0.0625);
});

test('reads only the non-executable init JSON script from the live page layout', () => {
    const snapshot = parseFinvizFutures(html(actual), { fetchedAt });
    assert.equal(row(snapshot, 'ES').price, 7866);
    assert.equal(snapshot.sourceUrl, 'https://finviz.com/futures.ashx');
});

test('rejects malformed or executable data without evaluating JavaScript', () => {
    for (const value of [
        '{invalid JSON}',
        '<script id="futures-init-data">window.futures = {}</script>',
        '<script id="futures-init-data" type="text/javascript">({ES:{last:10}})</script>',
        '<html><h1>Just a moment...</h1></html>',
        '{"__proto__":{"ticker":"__proto__","label":"Injected","last":12,"change":0}}',
    ]) assert.throws(() => parseFinvizFutures(value), /Finviz|JSON|quote/i);
    assert.equal({}.polluted, undefined);
});

test('does not mistake data attributes on unrelated or executable scripts for init JSON', () => {
    for (const value of [
        `<script data-id="futures-init-data" type="application/json">${JSON.stringify(actual)}</script>`,
        `<script id="futures-init-data" type="text/javascript" data-type="application/json">${JSON.stringify(actual)}</script>`,
    ]) assert.throws(() => parseFinvizFutures(value), /Finviz|JSON|quote/i);
});

test('rejects empty arrays, missing payloads and records with no usable quotes', () => {
    for (const value of [null, undefined, [], {}, '[]', '{}', { success: true }]) {
        assert.throws(() => parseFinvizFutures(value), /Finviz|quote/i);
    }
});

test('marks missing, non-numeric and non-finite required values unavailable instead of zero', () => {
    for (const value of [null, undefined, NaN, Infinity, -Infinity, '', '7866', false]) {
        const snapshot = parseFinvizFutures({ ...actual, ES: { ...actual.ES, last: value } }, { fetchedAt });
        assert.equal(row(snapshot, 'ES').status, 'unavailable');
        assert.equal(row(snapshot, 'ES').price, null);
    }
    const snapshot = parseFinvizFutures({ ...actual, ES: { ...actual.ES, change: null } }, { fetchedAt });
    assert.equal(row(snapshot, 'ES').status, 'unavailable');
    assert.equal(row(snapshot, 'ES').changePct, null);
});

test('allows actual zero and negative quotes while retaining null optional fields', () => {
    const snapshot = parseFinvizFutures({
        ES: { ...actual.ES, last: 0, change: 0, changeUsd: null, prevClose: null, high: Infinity, low: NaN },
        CL: { ...actual.ES, ticker: 'CL', label: 'Crude Oil WTI', last: -1, change: -101 },
    }, { fetchedAt });
    assert.equal(row(snapshot, 'ES').status, 'delayed');
    assert.equal(row(snapshot, 'ES').price, 0);
    assert.equal(row(snapshot, 'ES').changePct, 0);
    assert.equal(row(snapshot, 'ES').change, null);
    assert.equal(row(snapshot, 'ES').prevClose, null);
    assert.equal(row(snapshot, 'ES').high, null);
    assert.equal(row(snapshot, 'ES').low, null);
    assert.equal(row(snapshot, 'CL').price, -1);
});

test('rejects a mismatched contract identity instead of attributing another quote to the row', () => {
    const snapshot = parseFinvizFutures({ ...actual, ES: { ...actual.ES, ticker: 'NQ' } }, { fetchedAt });
    assert.equal(row(snapshot, 'ES').status, 'unavailable');
    assert.equal(row(snapshot, 'ES').price, null);
});

test('does not invent a history or timestamps for absent or incomplete source points', () => {
    const snapshot = parseFinvizFutures({
        ...actual,
        ES: { ...actual.ES, sparkline: [7800, null, 7866] },
    }, { fetchedAt });
    assert.deepEqual(row(snapshot, 'ES').sparkline, []);
    assert.deepEqual(row(snapshot, 'ZF').sparkline, []);
    assert.equal(row(snapshot, 'ES').quotedAt, null);
});

test('returns unavailable data in browser mode with no simulated prices', async () => {
    const snapshot = await fetchFinvizFutures(null, { now: fetchedAt });
    assert.equal(snapshot.status, 'unavailable');
    assert.deepEqual(snapshot.quotes, []);
    assert.equal(snapshot.fetchedAt, null);
    assert.equal(snapshot.attemptedAt, fetchedAt);
    assert.match(snapshot.error, /desktop|Electron/i);
});

test('fetches actual five-minute chart data through the Electron network boundary', async () => {
    const ipcRenderer = {
        async invoke(channel, url) {
            if (channel !== 'fetch-url' || url !== 'https://finviz.com/api/futures_all?timeframe=i5') {
                throw new Error('Unexpected data request');
            }
            return JSON.stringify(actual);
        },
    };
    const snapshot = await fetchFinvizFutures(ipcRenderer, { now: fetchedAt });
    assert.equal(row(snapshot, 'ES').price, 7866);
    assert.deepEqual(row(snapshot, 'ES').sparkline, actual.ES.sparkline);
    assert.equal(snapshot.cached, false);
    assert.equal(snapshot.sourceUrl, 'https://finviz.com/api/futures_all?timeframe=i5');
});

test('falls back to real init quotes when the data endpoint is unavailable', async () => {
    const ipcRenderer = {
        async invoke(channel, url) {
            if (channel !== 'fetch-url') throw new Error('Unexpected channel');
            if (url.startsWith('https://finviz.com/api/')) throw new Error('HTTP 403');
            if (url !== 'https://finviz.com/futures.ashx') throw new Error('Unexpected URL');
            return html({ ES: { ...actual.ES, sparkline: [], sparklineDateChanges: {} } });
        },
    };
    const snapshot = await fetchFinvizFutures(ipcRenderer, { now: fetchedAt });
    assert.equal(snapshot.status, 'delayed');
    assert.equal(snapshot.sourceUrl, 'https://finviz.com/futures.ashx');
    assert.equal(row(snapshot, 'ES').price, 7866);
    assert.deepEqual(row(snapshot, 'ES').sparkline, []);
    assert.match(snapshot.error, /chart|endpoint/i);
});

test('keeps last successful data explicitly cached after both network requests fail', async () => {
    const previous = parseFinvizFutures(actual, { fetchedAt, timeframe: 'i5' });
    const ipcRenderer = { async invoke() { throw new Error('HTTP 403'); } };
    const snapshot = await fetchFinvizFutures(ipcRenderer, { previous, now: refreshedAt });
    assert.equal(snapshot.status, 'cached');
    assert.equal(snapshot.cached, true);
    assert.equal(snapshot.fetchedAt, fetchedAt);
    assert.equal(snapshot.attemptedAt, refreshedAt);
    assert.equal(row(snapshot, 'ES').status, 'cached');
    assert.equal(row(snapshot, 'ES').fetchedAt, fetchedAt);
    assert.equal(row(snapshot, 'ES').price, 7866);
    assert.match(snapshot.error, /403/);
});

test('preserves old data as cached when individual rows fail validation or disappear', async () => {
    const previous = parseFinvizFutures(actual, { fetchedAt, timeframe: 'i5' });
    const partial = { ES: { ...actual.ES, last: null }, ZB: actual.ZB };
    const ipcRenderer = { async invoke() { return JSON.stringify(partial); } };
    const snapshot = await fetchFinvizFutures(ipcRenderer, { previous, now: refreshedAt });
    assert.equal(snapshot.status, 'delayed');
    assert.equal(row(snapshot, 'ES').status, 'cached');
    assert.equal(row(snapshot, 'ES').price, 7866);
    assert.equal(row(snapshot, 'ES').fetchedAt, fetchedAt);
    assert.equal(row(snapshot, 'ZF').status, 'cached');
    assert.equal(row(snapshot, 'ZT').status, 'cached');
    assert.equal(row(snapshot, 'ZB').status, 'delayed');
    assert.equal(row(snapshot, 'ZB').fetchedAt, refreshedAt);
    assert.equal(snapshot.partial, true);
});

test('does not show a prior chart as a different requested timeframe after failure', async () => {
    const previous = parseFinvizFutures(actual, { fetchedAt, timeframe: 'd' });
    const ipcRenderer = { async invoke() { throw new Error('Offline'); } };
    const snapshot = await fetchFinvizFutures(ipcRenderer, { previous, timeframe: 'i5', now: refreshedAt });
    assert.equal(snapshot.status, 'unavailable');
    assert.deepEqual(snapshot.quotes, []);
});

test('rejects unsupported timeframes without making an external request', async () => {
    const ipcRenderer = { async invoke() { assert.fail('Unsupported timeframe sent to source'); } };
    const snapshot = await fetchFinvizFutures(ipcRenderer, { timeframe: 'untrusted', now: fetchedAt });
    assert.equal(snapshot.status, 'unavailable');
    assert.match(snapshot.error, /timeframe/i);
});

for (const timeframe of ['i5', 'w']) {
    test(`page fallback discards unverified chart samples for ${timeframe} while preserving quotes`, async () => {
        const calls = [];
        const pageQuote = { ...actual.ES, sparklineDateChanges: { 0: 'Oct-16', 5: 'Oct-17' } };
        const ipcRenderer = { async invoke(channel, url) {
            assert.equal(channel, 'fetch-url');
            calls.push(url);
            if (url === `https://finviz.com/api/futures_all?timeframe=${timeframe}`) throw new Error('HTTP 403');
            assert.equal(url, 'https://finviz.com/futures.ashx');
            return html({ ES: pageQuote });
        } };
        const snapshot = await fetchFinvizFutures(ipcRenderer, { now: fetchedAt, timeframe });
        const quote = row(snapshot, 'ES');
        assert.deepEqual(calls, [`https://finviz.com/api/futures_all?timeframe=${timeframe}`, 'https://finviz.com/futures.ashx']);
        assert.equal(snapshot.timeframe, timeframe);
        assert.equal(quote.status, 'delayed');
        assert.equal(quote.fetchedAt, fetchedAt);
        for (const [field, source] of Object.entries({ price: 'last', changePct: 'change', change: 'changeUsd', prevClose: 'prevClose', high: 'high', low: 'low' })) {
            assert.equal(quote[field], pageQuote[source]);
        }
        assert.deepEqual(quote.sparkline, []);
        assert.deepEqual(quote.chartLabels, {});
        assert.match(snapshot.error, /without unverified chart samples/i);
    });
}

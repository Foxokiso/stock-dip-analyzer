import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHART_MISMATCH_NOTE, changeDirection, fetchFinvizFutures, parseFinvizFutures } from '../src/services/futures.js';

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
    assert.equal(row(snapshot, 'ES').chartNote, null);
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
    assert.equal(snapshot.sourceUrl, 'https://finviz.com/futures');
});

test('rejects malformed or executable data without evaluating JavaScript', () => {
    for (const value of [
        '{invalid JSON}',
        '<script id="futures-init-data">window.futures = {}</script>',
        '<script id="futures-init-data" type="text/javascript">({ES:{last:10}})</script>',
        '<html><h1>Just a moment...</h1></html>',
        '{"__proto__":{"ticker":"__proto__","label":"Injected","last":12,"change":0}}',
    ]) assert.throws(() => parseFinvizFutures(value), /Finviz|JSON|quote/i);
});

test('__proto__ and constructor keys stay inert source data', () => {
    const injected = { polluted: true, ticker: 'ES', label: 'Injected', last: 12, change: 0, high: 99 };
    const payloads = [
        `{"__proto__":${JSON.stringify(injected)}}`,
        `{"__proto__":${JSON.stringify(injected)},"ES":${JSON.stringify(actual.ES)}}`,
        `{"constructor":{"prototype":${JSON.stringify(injected)}},"ES":${JSON.stringify(actual.ES)}}`,
        // A record's own "__proto__" member must not supply fields the record lacks.
        `{"ES":{"ticker":"ES","last":7866,"change":0.56,"__proto__":${JSON.stringify(injected)}}}`,
    ];
    // JSON.parse keeps "__proto__" as an own key, so html() re-serializes it unchanged.
    for (const payload of [...payloads, ...payloads.map(text => html(JSON.parse(text)))]) {
        let snapshot = null;
        try {
            snapshot = parseFinvizFutures(payload, { fetchedAt });
        } catch (error) {
            assert.match(error.message, /no usable futures quotes/);
        }
        for (const key of Object.keys(injected)) {
            assert.equal(Object.hasOwn(Object.prototype, key), false, `${key} reached Object.prototype`);
        }
        // Every payload with a real "ES" member still yields its quote; the others have none.
        assert.equal(snapshot !== null, payload.includes('"ES":'), payload);
        if (snapshot) {
            assert.deepEqual(snapshot.quotes.map(quote => quote.symbol), ['ES']);
            assert.notEqual(row(snapshot, 'ES').name, 'Injected');
            assert.notEqual(row(snapshot, 'ES').high, 99);
        }
    }
});

test('does not mistake data attributes on unrelated or executable scripts for init JSON', () => {
    for (const value of [
        `<script data-id="futures-init-data" type="application/json">${JSON.stringify(actual)}</script>`,
        `<script id="futures-init-data" type="text/javascript" data-type="application/json">${JSON.stringify(actual)}</script>`,
    ]) assert.throws(() => parseFinvizFutures(value), /Finviz|JSON|quote/i);
});

// The page's script elements were once matched by one expression; a single pass over the
// text replaced it and must pick the same payload, or refuse the same pages.
test('the page walk picks the payload the script expression it replaced picked', () => {
    const typed = (data, { open = '<script type="application/json" id="futures-init-data">', close = '</script>' } = {}) => `${open}${JSON.stringify(data)}${close}`;
    const other = { ...actual, ES: { ...actual.ES, last: 1 } };
    const pages = [
        `<html><script>var a = 1;</script><script src="x.js"></script>${typed(actual)}</html>`,
        `<html>${typed(actual, { open: '<SCRIPT ID=\'futures-init-data\' TYPE="application/json">', close: '</SCRIPT >' })}</html>`,
        `<html>${typed(actual, { close: '</script\n\t>' })}${typed(other)}</html>`,
        `<html>${typed(actual, { close: '</script >' })}</html>`,
        `<html>${typed(actual)}${typed(other)}</html>`,
        // Not script elements: the word goes on.
        `<html><scripts id="futures-init-data" type="application/json">{}</scripts>${typed(actual)}</html>`,
        `<html><script_ id="futures-init-data" type="application/json">{}</script_>${typed(actual)}</html>`,
        // An opening tag written inside another script's text belongs to that script.
        `<html><script>var s = "<script id='futures-init-data' type='application/json'>";</script>${typed(actual)}</html>`,
        `<html><script>var s = "${typed(other).replaceAll('"', "'")}";${typed(actual)}</html>`,
        // The first complete closing tag ends the body, whatever came before it.
        `<html>${typed(actual, { close: '</script x></script>' })}</html>`,
        `<html>${typed(actual, { close: '</script </script>' })}</html>`,
        `<html><script data-x="a>b" id="futures-init-data" type="application/json">${JSON.stringify(actual)}</script></html>`,
        // Nothing completes these.
        `<html>${typed(actual, { close: '' })}</html>`,
        `<html>${typed(actual, { close: '</script' })}</html>`,
        '<html><script id="futures-init-data" type="application/json"',
        `<html><script>${typed(actual, { close: '' })}</html>`,
        // A complete payload ahead of a script nothing closes is still read.
        `<html>${typed(actual)}<script>unclosed</html>`,
        `<html>${typed(actual)}<script unterminated</html>`,
        '<html><script></script></html>',
        '<html></html>',
    ];
    const options = { fetchedAt, timeframe: 'i5', sourceUrl: 'https://finviz.com/futures' };
    const outcome = (read) => {
        try { return { quotes: read().quotes }; } catch (error) { return { error: error.constructor.name, json: /JSON/.test(error.message) }; }
    };
    const expression = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    const reference = (page) => {
        for (const [, attributes, body] of page.matchAll(expression)) {
            if (/(?:^|\s)id\s*=\s*(["'])futures-init-data\1/i.test(attributes)
                && /(?:^|\s)type\s*=\s*(["'])application\/json\1/i.test(attributes)) return parseFinvizFutures(JSON.parse(body), options);
        }
        throw new Error('Finviz response does not contain futures quote JSON.');
    };
    let read = 0;
    for (const page of pages) {
        const expected = outcome(() => reference(page));
        assert.deepEqual(outcome(() => parseFinvizFutures(page, options)), expected, page.slice(0, 120));
        if (expected.quotes) read++;
    }
    assert.equal(read, 11, 'the pages above cover both outcomes');
});

// Each opening tag that nothing closes used to be scanned to the end of the page: 80,000
// of them (0.6 MB) held the interface thread for 11 s, and fetch-url hands over up to 15 MB.
// The expression would need about 17 s for the first page here; the walk takes milliseconds.
test('a page of script tags that nothing closes is refused in time linear in its length', () => {
    for (const tag of ['<script>', '<script x', '<script></script', '</script ']) {
        const page = `<html>${tag.repeat(100_000)}`;
        const started = performance.now();
        assert.throws(() => parseFinvizFutures(page), /does not contain futures quote JSON/);
        const elapsed = performance.now() - started;
        assert.ok(elapsed < 2000, `${JSON.stringify(tag)} × 100,000 took ${Math.round(elapsed)} ms`);
    }
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

test('an unchanged quote is flat, neither advancing nor declining', () => {
    // The recorded 2026-10-11 response quotes CC, SR3 and ZQ at a 0.00% change.
    const snapshot = parseFinvizFutures({ ...actual, ES: { ...actual.ES, change: 0 }, ZB: { ...actual.ZB, change: -0 } }, { fetchedAt });
    assert.equal(changeDirection(row(snapshot, 'ES').changePct), 'flat');
    assert.equal(changeDirection(row(snapshot, 'ZB').changePct), 'flat');
    assert.equal(changeDirection(row(snapshot, 'ZF').changePct), 'down');
    assert.equal(changeDirection(0.01), 'up');
    assert.equal(changeDirection(null), 'flat');
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
    // Incomplete points are absent data, not a disagreement with the quote.
    assert.equal(row(snapshot, 'ES').chartNote, null);
});

test('withholds a 5-minute series that ends away from its quote, with the reason', () => {
    // Real records from one live i5 response: TIO's series ended at 211.8 against a 90.71 quote.
    const { records } = JSON.parse(readFileSync(new URL('./fixtures/futures-i5-2026-10-31.json', import.meta.url), 'utf8'));
    const snapshot = parseFinvizFutures(JSON.stringify(records), { fetchedAt, timeframe: 'i5' });
    for (const symbol of ['TIO', 'UX', 'ZK']) {
        const quote = row(snapshot, symbol);
        assert.equal(quote.status, 'delayed');
        assert.equal(quote.price, records[symbol].last);
        assert.deepEqual(quote.sparkline, []);
        assert.deepEqual(quote.chartLabels, {});
        assert.equal(quote.chartNote, CHART_MISMATCH_NOTE);
    }
    // NCF's series reaches back months but ends at its quote: it stays, with Finviz's labels.
    for (const symbol of ['ES', 'NCF']) {
        const quote = row(snapshot, symbol);
        assert.deepEqual(quote.sparkline, records[symbol].sparkline);
        assert.deepEqual(quote.chartLabels, records[symbol].sparklineDateChanges);
        assert.equal(quote.chartNote, null);
    }
});

test('a series agrees with its quote within the session range, or 0.5 % when that is narrower', () => {
    const quoteWith = (fields) => row(parseFinvizFutures({ ...actual, ES: { ...actual.ES, ...fields } }, { fetchedAt }), 'ES');
    const kept = (fields) => quoteWith(fields).sparkline.length > 0;
    // ES: last 7866, session range 7817-7870.5 (53.5 points, wider than 0.5 % = 39.33).
    assert.equal(kept({ sparkline: [7800, 7812.5] }), true);
    assert.equal(kept({ sparkline: [7800, 7812.25] }), false);
    // 0.5 % of 200 is 1; a missing high or low, or a high below the low, adds no range.
    assert.equal(kept({ last: 200, high: null, low: 150, sparkline: [190, 201] }), true);
    assert.equal(kept({ last: 200, high: null, low: 150, sparkline: [190, 201.5] }), false);
    assert.equal(kept({ last: 200, low: null, sparkline: [190, 198.5] }), false);
    assert.equal(kept({ last: 200, high: 190, low: 210, sparkline: [190, 198.5] }), false);
    assert.equal(kept({ last: -1, high: null, low: null, sparkline: [-1.002] }), true);
    assert.equal(kept({ last: 0, change: 0, high: null, low: null, sparkline: [0, 0] }), true);
    assert.equal(kept({ last: 0, change: 0, high: null, low: null, sparkline: [0, 1e-9] }), false);
    // Only the last sample is compared, and a withheld series takes its labels with it.
    assert.equal(kept({ sparkline: [100, 7866] }), true);
    const withheld = quoteWith({ sparkline: [7866, 100], sparklineDateChanges: { 0: 'Oct 10' } });
    assert.deepEqual(withheld.chartLabels, {});
    assert.equal(withheld.chartNote, CHART_MISMATCH_NOTE);
    assert.equal(quoteWith({ last: null, sparkline: [100] }).chartNote, null);
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
            // The canonical page: futures.ashx only answers with a 301 to it.
            if (url !== 'https://finviz.com/futures') throw new Error('Unexpected URL');
            return html({ ES: { ...actual.ES, sparkline: [], sparklineDateChanges: {} } });
        },
    };
    const snapshot = await fetchFinvizFutures(ipcRenderer, { now: fetchedAt });
    assert.equal(snapshot.status, 'delayed');
    assert.equal(snapshot.sourceUrl, 'https://finviz.com/futures');
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
            assert.equal(url, 'https://finviz.com/futures');
            return html({ ES: pageQuote });
        } };
        const snapshot = await fetchFinvizFutures(ipcRenderer, { now: fetchedAt, timeframe });
        const quote = row(snapshot, 'ES');
        assert.deepEqual(calls, [`https://finviz.com/api/futures_all?timeframe=${timeframe}`, 'https://finviz.com/futures']);
        assert.equal(snapshot.timeframe, timeframe);
        assert.equal(quote.status, 'delayed');
        assert.equal(quote.fetchedAt, fetchedAt);
        for (const [field, source] of Object.entries({ price: 'last', changePct: 'change', change: 'changeUsd', prevClose: 'prevClose', high: 'high', low: 'low' })) {
            assert.equal(quote[field], pageQuote[source]);
        }
        assert.deepEqual(quote.sparkline, []);
        assert.deepEqual(quote.chartLabels, {});
        // The page did send samples, so the desk must not claim Finviz has none.
        assert.match(quote.chartNote, /does not say which interval/);
        assert.match(snapshot.error, /without unverified chart samples/i);
    });
}

test('page fallback keeps the reason a series ending away from its quote was withheld', async () => {
    const ipcRenderer = { async invoke(channel, url) {
        if (url.startsWith('https://finviz.com/api/')) throw new Error('HTTP 403');
        return html({ ES: { ...actual.ES, sparkline: [7866, 100] }, ZF: actual.ZF });
    } };
    const snapshot = await fetchFinvizFutures(ipcRenderer, { now: fetchedAt });
    assert.equal(row(snapshot, 'ES').chartNote, CHART_MISMATCH_NOTE);
    assert.equal(row(snapshot, 'ZF').chartNote, null);
});

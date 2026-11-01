import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getYahooQuote, getYahooChartPoints, canRaiseTechnicalAlert } from '../src/utils/marketData.js';

const ts = (value) => Date.parse(value) / 1000;
// Like Yahoo's chart meta, the synthetic meta states no exchangeDataDelayedBy unless a test adds it.
const result = (quoteTime, timestamps, close, extra = {}) => ({
    meta: { regularMarketPrice: 105, regularMarketTime: ts(quoteTime), exchangeTimezoneName: 'America/New_York', range: '1mo', dataGranularity: '1d', currency: 'USD', ...extra },
    timestamp: timestamps.map(ts), indicators: { quote: [{ close }] },
});
// Yahoo v8 chart responses recorded with curl (the app's URL, range=1mo&interval=1d) on 2026-10-31
// 05:32 UTC, after the 2026-10-30 session: AAPL (Nasdaq GS) and PLUG, a sub-$5 Nasdaq CM listing.
const recorded = (symbol) => JSON.parse(readFileSync(new URL(`./fixtures/yahoo-chart-${symbol}-1mo-2026-10-30.json`, import.meta.url), 'utf8')).chart.result[0];

test('daily change uses the preceding session when the current daily bar exists', () => {
    const q = getYahooQuote(result('2026-10-09T18:00:00Z', ['2026-10-08T13:30:00Z', '2026-10-09T13:30:00Z'], [100, 104], { exchangeDataDelayedBy: 15 }));
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

test('an unstated delay leaves alert eligibility to the quote age, with a minute of clock skew', () => {
    const now = Date.parse('2026-10-09T18:00:00Z');
    const at = (ageSeconds) => new Date(now - ageSeconds * 1000).toISOString();
    for (const delayMinutes of [null, undefined, 0]) {
        const quote = { quotedAt: at(60), delayMinutes, price: 100 };
        assert.equal(canRaiseTechnicalAlert(quote, 15, now), true);
        assert.equal(canRaiseTechnicalAlert(quote, 14, now), false);
        for (const [age, eligible] of [[-61, false], [-60, true], [0, true], [300, true], [301, false]]) {
            assert.equal(canRaiseTechnicalAlert({ ...quote, quotedAt: at(age) }, 15, now), eligible, `delay ${delayMinutes}, age ${age} s`);
        }
        assert.equal(canRaiseTechnicalAlert({ ...quote, quotedAt: 'garbage' }, 15, now), false);
    }
    // A delay the source does state still has to be zero.
    for (const delayMinutes of [15, 1, -1, NaN, Infinity]) {
        assert.equal(canRaiseTechnicalAlert({ quotedAt: at(60), delayMinutes, price: 100 }, 15, now), false, `delay ${delayMinutes}`);
    }
});

test('recorded Yahoo charts state no delay and normalize to the real session values', () => {
    const aapl = getYahooQuote(recorded('AAPL'), { fetchedAt: '2026-10-31T05:32:10.000Z' });
    assert.equal('exchangeDataDelayedBy' in recorded('AAPL').meta, false);
    assert.equal(aapl.delayMinutes, null);
    assert.equal(aapl.price, 344.63);
    assert.equal(aapl.quotedAt, '2026-10-30T20:00:01.000Z');
    assert.equal(aapl.fetchedAt, '2026-10-31T05:32:10.000Z');
    assert.equal(aapl.previousClose, 348.9100036621094);
    assert.ok(Math.abs(aapl.changePct - recorded('AAPL').meta.regularMarketChangePercent) < 0.0005);
    assert.equal(aapl.closes.length, 23);
    assert.equal(aapl.currency, 'USD');
    assert.equal(aapl.exchangeTimezone, 'America/New_York');

    // Sub-$5: Yahoo's last daily close (1.37) differs from the regular-market price (1.365).
    const plug = getYahooQuote(recorded('PLUG'));
    assert.equal(plug.delayMinutes, null);
    assert.equal(plug.price, 1.365);
    assert.equal(plug.closes.at(-1), 1.3700000047683716);
    assert.equal(plug.previousClose, 1.4199999570846558);
    assert.ok(Math.abs(plug.changePct - recorded('PLUG').meta.regularMarketChangePercent) < 0.0005);

    // The last daily bar is the quote's own exchange-day session (scoring relies on it).
    for (const symbol of ['AAPL', 'PLUG']) {
        const points = getYahooChartPoints(recorded(symbol));
        assert.equal(points.at(-1).date, '2026-10-30');
        assert.equal(points.at(-2).date, '2026-10-29');
    }
});

test('cached exchange-day formatters give the days a fresh formatter per bar gave', () => {
    // The previous implementation, which built an Intl.DateTimeFormat for every call.
    const freshDay = (seconds, timezone) => {
        try {
            return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(seconds * 1000));
        } catch {
            return new Date(seconds * 1000).toISOString().slice(0, 10);
        }
    };
    const recordedStamps = ['AAPL', 'PLUG'].flatMap(symbol => recorded(symbol).timestamp);
    // Hourly instants around the 2026 DST changes in New York, London and Sydney.
    const transitions = ['2026-03-08', '2026-03-29', '2026-04-05', '2026-10-04', '2026-10-25', '2026-11-01']
        .flatMap(day => Array.from({ length: 48 }, (_, hour) => ts(`${day}T00:00:00Z`) + (hour - 12) * 3600));
    const zones = ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata', 'Asia/Tokyo', 'US/Eastern',
        'america/new_york', 'Mars/Olympus_Mons', '', null, undefined, 'America/New_York'];
    for (const zone of zones) {
        const points = getYahooChartPoints({ meta: { exchangeTimezoneName: zone }, timestamp: [...recordedStamps, ...transitions],
            indicators: { quote: [{ close: Array(recordedStamps.length + transitions.length).fill(1) }] } });
        for (const point of points) assert.equal(point.date, freshDay(point.timestamp, zone), `${zone} ${point.timestamp}`);
    }
    // An unknown zone keeps the UTC-date fallback on repeated calls, and other zones still apply.
    const dayIn = (zone, time) => getYahooChartPoints(result(time, [time], [1], { exchangeTimezoneName: zone }))[0].date;
    assert.equal(dayIn('Mars/Olympus_Mons', '2026-10-10T03:30:00Z'), '2026-10-10');
    assert.equal(dayIn('Mars/Olympus_Mons', '2026-10-10T03:30:00Z'), '2026-10-10');
    assert.equal(dayIn('America/New_York', '2026-10-10T03:30:00Z'), '2026-10-09');
});

test('a zone Intl rejects is tried once, not once (and one exception) per bar', (t) => {
    const zone = 'Mars/Valles_Marineris'; // used by no other test, so not cached yet
    const OriginalFormat = Intl.DateTimeFormat;
    let attempts = 0;
    t.mock.method(Intl, 'DateTimeFormat', function DateTimeFormat(locale, options) {
        if (options?.timeZone === zone) attempts++;
        return new OriginalFormat(locale, options);
    });
    const stamps = Array.from({ length: 40 }, (_, i) => ts('2026-09-01T03:30:00Z') + i * 86400);
    const quote = getYahooQuote(result('2026-10-10T03:30:00Z', stamps.map(seconds => new Date(seconds * 1000).toISOString()), Array(40).fill(100), { exchangeTimezoneName: zone }));
    assert.equal(quote.closes.length, 40);
    assert.equal(quote.previousClose, 100, 'the prior session is found by UTC day');
    const points = getYahooChartPoints({ meta: { exchangeTimezoneName: zone }, timestamp: stamps, indicators: { quote: [{ close: Array(40).fill(1) }] } });
    assert.deepEqual(points.map(point => point.date), stamps.map(seconds => new Date(seconds * 1000).toISOString().slice(0, 10)), 'UTC dates');
    assert.equal(attempts, 1);
});

test('a recorded Yahoo quote can raise technical alerts only while fresh', () => {
    const quote = getYahooQuote(recorded('AAPL'));
    const quoteTime = Date.parse(quote.quotedAt);
    assert.equal(canRaiseTechnicalAlert(quote, quote.closes.length, quoteTime + 40 * 1000), true);
    assert.equal(canRaiseTechnicalAlert(quote, quote.closes.length, quoteTime + 5 * 60 * 1000), true);
    assert.equal(canRaiseTechnicalAlert(quote, quote.closes.length, quoteTime + 5 * 60 * 1000 + 1), false);
    assert.equal(canRaiseTechnicalAlert(quote, quote.closes.length, Date.parse('2026-10-31T05:32:10Z')), false);
});

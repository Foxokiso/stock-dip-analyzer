// Market-data parity between native/modules/marketdata and src/utils/marketData.js.
// Preservation of existing behavior only; this is not a trading backtest. Every number here is
// a synthetic probe of the normalization rules: no quote, close or timestamp is presented as real.
//
// The JavaScript reference is the real getYahooQuote / getYahooChartPoints / canRaiseTechnicalAlert
// fed Yahoo-shaped objects. The only engine-level reference is Date.parse for the parser building
// block the alert rule depends on (the format verifier does the same for toFixed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { getYahooQuote, getYahooChartPoints, canRaiseTechnicalAlert } from '../src/utils/marketData.js';

const executable = process.argv[2];
assert.ok(executable, 'Pass the compiled native marketdata test driver');

const ts = value => Date.parse(value) / 1000;
const cases = [];

// ---------------------------------------------------------------------------------------------
// Quote cases: { kind: 'quote', meta, timestamps, closes, omitNulls?, raw? }. `raw` replaces the
// object handed to the JavaScript reference (shape probes); the driver always receives the tokens.
const quote = (label, meta, timestamps, closes, extra = {}) => cases.push({ kind: 'quote', label, meta, timestamps, closes, ...extra });
const metaOf = (quoteTime, extra = {}) => ({
  regularMarketPrice: 105, regularMarketTime: typeof quoteTime === 'string' ? ts(quoteTime) : quoteTime,
  exchangeTimezoneName: 'America/New_York', range: '1mo', exchangeDataDelayedBy: 15, currency: 'USD',
  chartPreviousClose: null, previousClose: null, ...extra,
});
const stamps = list => list.map(value => typeof value === 'string' ? ts(value) : value);

// Every case in tests/marketData.test.js.
quote('unit: preceding session', metaOf('2026-10-09T18:00:00Z'), stamps(['2026-10-08T13:30:00Z', '2026-10-09T13:30:00Z']), [100, 104]);
quote('unit: own bar absent', metaOf('2026-10-09T18:00:00Z'), stamps(['2026-10-07T13:30:00Z', '2026-10-08T13:30:00Z']), [90, 100]);
quote('unit: null prior session', metaOf('2026-10-09T18:00:00Z'), stamps(['2026-10-07T13:30:00Z', '2026-10-08T13:30:00Z', '2026-10-09T13:30:00Z']), [90, null, 104]);
quote('unit: multi-day chartPreviousClose', metaOf('2026-10-09T18:00:00Z', { chartPreviousClose: 80 }), stamps(['2026-10-09T13:30:00Z']), [104]);
quote('unit: 1d chartPreviousClose', metaOf('2026-10-09T18:00:00Z', { range: '1d', chartPreviousClose: 100 }), stamps(['2026-10-09T13:30:00Z', '2026-10-09T13:35:00Z']), [104, 105]);
quote('unit: invalid metadata', metaOf('2026-10-09T18:00:00Z', { regularMarketPrice: null, regularMarketTime: null, exchangeDataDelayedBy: null }), stamps(['2026-10-08T13:30:00Z']), [100]);
quote('unit: chart points drop Infinity', metaOf('2026-10-09T18:00:00Z'), stamps(['2026-10-08T00:30:00Z', '2026-10-09T13:30:00Z']), [100, Infinity]);
quote('unit: explicit previousClose', metaOf('2026-10-09T18:00:00Z', { previousClose: 102 }), stamps(['2026-10-08T13:30:00Z', '2026-10-09T13:30:00Z']), [100, 104]);

// Object-shape probes: the reference tolerates a missing result, meta or indicators.
const empty = { regularMarketPrice: null, regularMarketTime: null, exchangeTimezoneName: null, range: null, chartPreviousClose: null, previousClose: null, exchangeDataDelayedBy: null, currency: null };
for (const raw of [null, undefined, {}, { meta: null }, { meta: {}, timestamp: null }, { meta: {}, indicators: {} }, { meta: {}, indicators: { quote: [] } }, { meta: {}, indicators: { quote: [{}] } }]) {
  quote('shape probe', empty, [], [], { raw });
}
quote('shape probe: undefined meta fields', empty, [1760000000, 1760086400], [10, 11], { omitNulls: true });
quote('shape probe: closes shorter than timestamps', metaOf('2026-10-09T18:00:00Z'), stamps(['2026-10-07T13:30:00Z', '2026-10-08T13:30:00Z', '2026-10-09T13:30:00Z']), [90, 100]);
quote('shape probe: closes longer than timestamps', metaOf('2026-10-09T18:00:00Z'), stamps(['2026-10-08T13:30:00Z']), [100, 104, 108]);
quote('shape probe: unsorted and duplicate timestamps', metaOf('2026-10-09T18:00:00Z'), stamps(['2026-10-09T13:30:00Z', '2026-10-07T13:30:00Z', '2026-10-08T13:30:00Z', '2026-10-07T13:30:00Z']), [104, 90, 100, 91]);

// Exchange-day rules around DST transitions and local midnights.
const dst = (label, zone, quoteTime, bars, closes, extra = {}) => quote(label, metaOf(quoteTime, { exchangeTimezoneName: zone, ...extra }), stamps(bars), closes);
dst('NY spring-forward: bar just before local midnight (EST)', 'America/New_York', '2026-03-08T12:00:00Z', ['2026-03-08T04:59:59Z', '2026-03-08T05:00:00Z'], [100, 104]);
dst('NY spring-forward: only same-day bars', 'America/New_York', '2026-03-08T12:00:00Z', ['2026-03-08T05:00:00Z', '2026-03-08T07:00:00Z'], [100, 104]);
dst('NY fall-back: EDT midnight is 04:00Z', 'America/New_York', '2026-11-01T15:00:00Z', ['2026-11-01T03:59:59Z', '2026-11-01T04:00:00Z'], [100, 104]);
dst('NY after fall-back: EST midnight is 05:00Z', 'America/New_York', '2026-11-02T15:00:00Z', ['2026-11-02T04:59:59.999Z', '2026-11-02T05:00:00Z'], [100, 104]);
dst('London spring-forward', 'Europe/London', '2026-03-29T12:00:00Z', ['2026-03-28T23:59:59Z', '2026-03-29T00:30:00Z', '2026-03-29T01:00:00Z'], [100, 102, 104]);
dst('London fall-back: BST midnight is 23:00Z', 'Europe/London', '2026-10-25T12:00:00Z', ['2026-10-24T22:59:59Z', '2026-10-24T23:00:00Z'], [100, 104]);
dst('Tokyo: midnight is 15:00Z', 'Asia/Tokyo', '2026-10-09T01:00:00Z', ['2026-10-08T14:59:59Z', '2026-10-08T15:00:00Z'], [100, 104]);
dst('Tokyo: quote before its own bar', 'Asia/Tokyo', '2026-10-09T01:00:00Z', ['2026-10-08T14:59:59Z', '2026-10-09T02:00:00Z'], [100, 104]);
dst('Sydney: southern-hemisphere DST end', 'Australia/Sydney', '2026-04-05T20:00:00Z', ['2026-04-04T12:59:59Z', '2026-04-04T13:00:00Z'], [100, 104]);
dst('unknown zone falls back to the UTC day', 'Mars/Olympus_Mons', '2026-10-09T00:30:00Z', ['2026-10-08T23:30:00Z', '2026-10-09T00:10:00Z'], [100, 104]);
dst('same bars in New York are one session', 'America/New_York', '2026-10-09T00:30:00Z', ['2026-10-08T23:30:00Z', '2026-10-09T00:10:00Z'], [100, 104]);
dst('lower-case zone name', 'america/new_york', '2026-10-09T00:30:00Z', ['2026-10-08T23:30:00Z', '2026-10-09T00:10:00Z'], [100, 104]);
dst('link name', 'US/Eastern', '2026-10-09T00:30:00Z', ['2026-10-08T23:30:00Z', '2026-10-09T00:10:00Z'], [100, 104]);
dst('Etc/GMT+5 (fixed -5)', 'Etc/GMT+5', '2026-10-09T04:30:00Z', ['2026-10-09T04:59:59Z', '2026-10-09T05:00:00Z', '2026-10-09T03:00:00Z'], [100, 104, 99]);
dst('empty zone means UTC', '', '2026-10-09T00:30:00Z', ['2026-10-08T23:30:00Z', '2026-10-09T00:10:00Z'], [100, 104]);
dst('null zone means UTC', null, '2026-10-09T00:30:00Z', ['2026-10-08T23:30:00Z', '2026-10-09T00:10:00Z'], [100, 104]);
dst('quote older than every bar', 'America/New_York', '2026-10-01T18:00:00Z', ['2026-10-08T13:30:00Z', '2026-10-09T13:30:00Z'], [100, 104]);
dst('invalid timestamps are skipped, null bars kept', 'America/New_York', '2026-10-09T18:00:00Z', ['2026-10-07T13:30:00Z', null, NaN, 0, -1, Infinity, 8.64e12 + 1, '2026-10-09T13:30:00Z'], [90, 95, 96, 97, 98, 99, 100, 104]);
dst('fractional-second timestamps', 'America/New_York', 1760000000.999, [1759913600.0004, 1759913600.9995, 1760000000.5], [90, 91, 104]);
dst('far-future quote time (year 275760)', 'America/New_York', 8.64e12, ['2026-10-08T13:30:00Z'], [100]);
dst('far-future quote time, unknown zone', 'Mars/Olympus_Mons', 8.64e12, ['2026-10-08T13:30:00Z'], [100]);
dst('quote time past the Date range', 'America/New_York', 8.64e12 + 1, ['2026-10-08T13:30:00Z'], [100]);
dst('year-10000 bars', 'America/New_York', 253402300800 + 86400, [253402300799, 253402300800], [100, 104]);
for (const delay of [0, -0, 15, -1, 0.5, NaN, Infinity, -Infinity, null]) dst(`delay ${delay}`, 'America/New_York', '2026-10-09T18:00:00Z', ['2026-10-08T13:30:00Z'], [100], { exchangeDataDelayedBy: delay });
for (const currency of ['USD', '', null, 'GBp', '日本円', 'a b']) dst(`currency ${JSON.stringify(currency)}`, 'America/New_York', '2026-10-09T18:00:00Z', ['2026-10-08T13:30:00Z'], [100], { currency });
for (const price of [0, -5, NaN, Infinity, 1e-300, 1e300]) dst(`price ${price}`, 'America/New_York', '2026-10-09T18:00:00Z', ['2026-10-08T13:30:00Z'], [100], { regularMarketPrice: price });
for (const previousClose of [0, -5, NaN, Infinity, 1e-300]) dst(`previousClose ${previousClose}`, 'America/New_York', '2026-10-09T18:00:00Z', ['2026-10-08T13:30:00Z'], [100], { previousClose });
for (const range of ['1d', '5d', '', null, '1D']) dst(`range ${JSON.stringify(range)} with chartPreviousClose`, 'America/New_York', '2026-10-09T18:00:00Z', ['2026-10-09T13:30:00Z'], [104], { range, chartPreviousClose: 100 });
dst('1d with invalid chartPreviousClose falls through to the bars', 'America/New_York', '2026-10-09T18:00:00Z', ['2026-10-08T13:30:00Z', '2026-10-09T13:30:00Z'], [100, 104], { range: '1d', chartPreviousClose: -1 });
dst('changePct overflow is a number', 'America/New_York', '2026-10-09T18:00:00Z', ['2026-10-08T13:30:00Z'], [1e-300], { regularMarketPrice: 1e300 });

// 300 seeded cases: random zones (known, aliased, unknown), spacing, invalid bars and metadata.
let seed = 0x27c0ffee;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = list => list[Math.floor(random() * list.length)];
const seedZones = ['America/New_York', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'UTC', 'Australia/Sydney', 'Asia/Kolkata', 'US/Eastern', 'america/new_york', 'Mars/Olympus_Mons', '', null, 'Pacific/Chatham', 'America/St_Johns'];
for (let i = 0; i < 300; i++) {
  const zone = pick(seedZones);
  const base = ts('2020-01-01T00:00:00Z') + Math.floor(random() * 7 * 365 * 86400);
  const step = random() < 0.4 ? pick([60, 300, 900, 3600]) : 86400;
  const count = 1 + Math.floor(random() * 40);
  const timestamps = [];
  const closes = [];
  let price = 5 + random() * 500;
  for (let j = 0; j < count; j++) {
    let stamp = base + j * step + (random() < 0.2 ? Math.floor(random() * step) : 0);
    if (random() < 0.3) stamp += random() * 0.999;
    const r = random();
    if (r < 0.03) stamp = null; else if (r < 0.05) stamp = NaN; else if (r < 0.06) stamp = 0;
    else if (r < 0.07) stamp = -stamp; else if (r < 0.08) stamp = 8.64e12 + 1; else if (r < 0.085) stamp = Infinity;
    timestamps.push(stamp);
    price *= 0.95 + random() * 0.1;
    const c = random();
    closes.push(c < 0.05 ? null : c < 0.07 ? NaN : c < 0.09 ? Infinity : c < 0.1 ? -Infinity : c < 0.11 ? 0 : c < 0.12 ? -price : price);
  }
  if (random() < 0.15) {
    for (let j = timestamps.length - 1; j > 0; j--) {
      const k = Math.floor(random() * (j + 1));
      [timestamps[j], timestamps[k]] = [timestamps[k], timestamps[j]];
      [closes[j], closes[k]] = [closes[k], closes[j]];
    }
  }
  if (random() < 0.1 && timestamps.length > 1) timestamps[timestamps.length - 1] = timestamps[0];
  if (random() < 0.1) closes.pop(); else if (random() < 0.1) closes.push(price);
  const valid = timestamps.filter(value => Number.isFinite(value) && value > 0 && value < 8.64e12);
  const lastValid = valid.length ? Math.max(...valid) : base;
  const qr = random();
  const regularMarketTime = qr < 0.1 ? null : qr < 0.15 ? NaN : qr < 0.2 ? 0 : qr < 0.3 ? base - 86400 * random() * 3 : lastValid + random() * 86400 * 1.5;
  const pr = random();
  const regularMarketPrice = pr < 0.1 ? null : pr < 0.13 ? NaN : pr < 0.16 ? 0 : pr < 0.19 ? -1 : pr < 0.2 ? Infinity : price * (0.9 + random() * 0.2);
  const meta = {
    regularMarketPrice, regularMarketTime, exchangeTimezoneName: zone,
    range: pick(['1d', '5d', '1mo', null, '']),
    chartPreviousClose: random() < 0.5 ? price * 0.98 : random() < 0.2 ? -1 : null,
    previousClose: random() < 0.25 ? price * 0.99 : random() < 0.1 ? 0 : null,
    exchangeDataDelayedBy: pick([0, 15, 20, -1, -0, 0.5, NaN, Infinity, null]),
    currency: pick(['USD', 'EUR', '', null, 'GBp']),
  };
  quote(`seeded ${i}`, meta, timestamps, closes, { omitNulls: i % 7 === 0 });
}

// ---------------------------------------------------------------------------------------------
// Exchange-day building block, checked through getYahooChartPoints (the exported path): every
// zone × instants on each hour boundary (±1 ms) of dates around DST changes and the far future.
const dayZones = ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'UTC', 'Etc/UTC', 'GMT', 'utc', 'america/new_york', 'US/Eastern', 'Etc/GMT+5', 'Australia/Sydney', 'Asia/Kolkata', 'Asia/Kathmandu', 'Pacific/Chatham', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/St_Johns', 'Mars/Olympus_Mons', 'Etc/Unknown', 'not a zone', '', null];
const dayDates = ['2026-03-08', '2026-11-01', '2026-03-29', '2026-10-25', '2026-04-05', '2026-10-04', '2007-03-11', '2040-03-11', '1970-01-01', '2000-02-29', '9999-12-31', '2026-10-09'];
// Only positive instants reach exchangeDay through the exported path (non-positive bars are dropped).
const day = (seconds, zone) => { if (seconds > 0) cases.push({ kind: 'day', seconds, zone }); };
for (const zone of dayZones) {
  for (const date of dayDates) {
    const midnight = ts(`${date}T00:00:00Z`);
    for (let hour = 0; hour < 24; hour++) {
      day(midnight + hour * 3600, zone);
      day(midnight + hour * 3600 - 0.001, zone);
    }
  }
  for (const seconds of [1, 0.001, 1760000000.999, 253402300799.999, 253402300800, 8.64e12, 8.64e12 - 0.001, 1e12, 1e11]) day(seconds, zone);
}
// An invalid time value makes Intl and toISOString throw; the native port throws too.
cases.push({ kind: 'day-throws', seconds: 8.64e12 + 1, zone: 'America/New_York' });
cases.push({ kind: 'day-throws', seconds: 1e300, zone: 'Mars/Olympus_Mons' });

// ---------------------------------------------------------------------------------------------
// quotedAt / isoTime building block, checked through getYahooQuote(...).quotedAt.
const iso = seconds => cases.push({ kind: 'iso', seconds });
for (const seconds of [null, NaN, Infinity, -Infinity, 0, -0, -1, 1, 0.5, 0.001, 0.0004, 0.0009999, 1e-9, 5e-324, 1760000000, 1760000000.123, 1760000000.9999, 1760000000.9995, 1760000000.0005,
  86399.9999, 86400, 951782400, 4107542399, 253402300799, 253402300799.999, 253402300800, 1e13, 2e12, 8.64e12, 8.64e12 - 0.001, 8.64e12 + 0.001, 8.64e12 + 1, 1e300, 1.7976931348623157e308]) iso(seconds);
for (let i = 0; i < 100; i++) iso(Math.floor(random() * 4e9) + (i % 3 === 0 ? random() : 0));

// ---------------------------------------------------------------------------------------------
// Date.parse building block (engine reference): the ECMAScript format as V8 accepts it, strings
// both sides reject, and local-time forms away from any transition (both sides use the host zone).
const parse = text => cases.push({ kind: 'parse', text });
for (const text of ['2026-10-09T17:59:00Z', '2026-10-09T17:59:00.000Z', '2026-10-09T17:59Z', '2026-10-09T17:59:00.1Z', '2026-10-09T17:59:00.12Z', '2026-10-09T17:59:00.1234Z', '2026-10-09T17:59:00.12345Z',
  '2026-10-09T17:59:00.123456789Z', '2026-10-09T17:59:00.9999Z', '2026-10-09T17:59:00.0000000000000000000000001Z', '2026-10-09T17:59:00.00000000000000000000Z', '2026-10-09T24:00:00Z', '2026-10-09T24:00Z',
  '2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-10-09', '2026-10', '2026', '2026T17:59Z', '2026-10T17:59Z', '+275760-09-13T00:00:00.000Z', '+275760-09-13', '+010000-01-01T00:00:00Z',
  '+000000-01-01T00:00:00Z', '-000001-01-01T00:00:00Z', '-271821-04-20T00:00:00Z', '0000-01-01T00:00:00Z', '1970-01-01T00:00:00Z', '2026-10-09t17:59:00z', '2026-10-09T17:59:00.000z', '2026-10-09 17:59:00Z',
  '2026-10-09T17:59:00+05:00', '2026-10-09T17:59:00-05:00', '2026-10-09T17:59:00-0500', '2026-10-09T17:59:00+0500', '2026-10-09T17:59:00+0530', '2026-10-09T17:59:00.000+0530', '2026-10-09T17:59:00.000+00:00',
  '2026-10-09T17:59:00-00:00', '2026-10-09T17:59:00+23:59', '2026-10-09T00:00:00+14:00', '2026-10-09T00:00:00-12:00',
  // rejected by both
  '2026-10-09T17:59:00.Z', '2026-10-09T23:60:00Z', '2026-10-09T23:59:60Z', '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z', '2026-10-00T00:00:00Z', '2026-10-32T00:00:00Z', '+275760-09-13T00:00:00.001Z',
  '-271821-04-19T23:59:59.999Z', '-000000-01-01T00:00:00Z', '2026-10-09T17:59:00+05', '2026-10-09T17:59:00+05:3', '2026-10-09T17:59:00+5:30', '2026-10-09T17:59:00+05:60', '2026-10-09T17:59:00+24:00',
  '2026-10-09T17:59:00+05:00:00', '2026-10-09T17:59:00+05:00Z', '2026-10-9T17:59:00Z', '2026-10-09T7:59:00Z', '2026-10-09T1759Z', '', 'null', 'garbage', '2026-10-09T17:59:00ZZ', '2026-10-09T17:59:00Z ',
  ' 2026-10-09T17:59:00Z', '2026-10-09T17:59:00 Z', '2026-10-09T17:59:00+05:00 ', '2026-10-09T', '2026-10-09T17', '99999-01-01T00:00:00Z', '2026-10-09T17:59:00,123Z', '20261009T175900Z', '2026-10-09T17:59:00GMT',
  '2026-10-09T24:30:00Z', '2026-10-09T24:00:00.001Z', '2026-10-09T17:59:00.000Z0', '0000-00-00', '1e3',
  // local-time forms
  '2026-10-09T12:00:00', '2026-10-09T12:00', '2026-10-09T12:00:00.5', '2026-10-09 17:59', '2026-07-04T00:00:00', '2026-01-15T23:59:59.999', '+010000-06-15T12:00:00', '2026-03-08T02:30:00', '2026-11-01T01:30:00']) parse(text);
cases.push({ kind: 'parse', text: null });

// ---------------------------------------------------------------------------------------------
// Technical-alert gate.
const alert = (label, quoteFields, historyLength, now) => cases.push({ kind: 'alert', label, quote: quoteFields, historyLength, now });
const now = Date.parse('2026-10-09T18:00:00Z');
const live = { quotedAt: '2026-10-09T17:59:00Z', delayMinutes: 0, price: 100 };
alert('unit: live', live, 20, now);
alert('unit: delayed', { ...live, delayMinutes: 1 }, 20, now);
alert('unit: untimed', { ...live, quotedAt: null }, 20, now);
alert('unit: stale', { ...live, quotedAt: '2026-10-09T17:30:00Z' }, 20, now);
alert('unit: short history', live, 2, now);
for (const age of [0, 1, 299999, 300000, 300001, -1, -1000, 86400000]) alert(`age ${age}`, { ...live, quotedAt: new Date(now - age).toISOString() }, 15, now);
for (const historyLength of [14, 15, 16, 14.999, 15.5, NaN, Infinity, -Infinity, 0]) alert(`history ${historyLength}`, live, historyLength, now);
for (const delayMinutes of [0, -0, 0.0, 1, -1, NaN, Infinity, null, 15]) alert(`delay ${delayMinutes}`, { ...live, delayMinutes }, 20, now);
for (const price of [100, 0, -1, NaN, Infinity, null, 1e-300]) alert(`price ${price}`, { ...live, price }, 20, now);
for (const quotedAt of ['2026-10-09T17:59:00Z', '2026-10-09T17:59:00.000Z', '2026-10-09T17:59:00+00:00', '2026-10-09T22:59:00+05:00', '2026-10-09T12:59:00-05:00', '2026-10-09', '2026-10-09T17:59', 'garbage', '', null, '2026-10-09 17:59:00Z']) {
  alert(`quotedAt ${JSON.stringify(quotedAt)}`, { ...live, quotedAt }, 20, now);
}
alert('now NaN', live, 20, NaN);
alert('now earlier than quote', live, 20, now - 120000);

// ---------------------------------------------------------------------------------------------
// Encoding (see native/modules/marketdata/tests/marketdata_driver.cpp).
const encNum = value => value === null || value === undefined ? 'null' : Number.isNaN(value) ? 'nan'
  : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : Object.is(value, -0) ? '-0' : String(value);
const encStr = value => value === null || value === undefined ? 'null' : `s:${encodeURIComponent(value)}`;
const decNum = token => token === 'null' ? null : token === 'nan' ? NaN : token === 'Infinity' ? Infinity : token === '-Infinity' ? -Infinity : Number(token);
const decStr = token => {
  if (token === 'null') return null;
  assert.ok(token.startsWith('s:'), `string token expected, got ${JSON.stringify(token)}`);
  return decodeURIComponent(token.slice(2));
};
const encodeCase = entry => {
  switch (entry.kind) {
    case 'quote': {
      const m = entry.meta;
      return [encNum(m.regularMarketPrice), encNum(m.regularMarketTime), encStr(m.exchangeTimezoneName), encStr(m.range), encNum(m.chartPreviousClose), encNum(m.previousClose),
        encNum(m.exchangeDataDelayedBy), encStr(m.currency), '|', ...entry.timestamps.map(encNum), '|', ...entry.closes.map(encNum)].join(' ');
    }
    case 'alert': return ['alert', encNum(entry.quote.price), encStr(entry.quote.quotedAt), encNum(entry.quote.delayMinutes), encNum(entry.historyLength), encNum(entry.now)].join(' ');
    case 'iso': return `iso ${encNum(entry.seconds)}`;
    case 'day': case 'day-throws': return `day ${encNum(entry.seconds)} ${encStr(entry.zone)}`;
    case 'parse': return `parse ${encStr(entry.text)}`;
    default: throw new Error(`unknown case kind ${entry.kind}`);
  }
};
const input = cases.map(encodeCase).join('\n') + '\n';
const run = spawnSync(executable, [], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
assert.equal(run.status, 0, run.error?.message || run.stderr);
// Windows text-mode stdout ends lines with CRLF; compare line content, not line endings.
const rows = run.stdout.replace(/\r?\n$/, '').split(/\r?\n/);
assert.equal(rows.length, cases.length, 'one output line per case');
assert.ok(!run.stdout.includes('Zombie Corp') && !run.stdout.includes('Mock News'));

// ---------------------------------------------------------------------------------------------
// Comparison: relative tolerance 1e-12 for doubles, exact equality for strings and booleans.
const near = (actual, expected, label) => {
  if (expected === null || expected === undefined) return assert.equal(actual, null, `${label}: expected null, got ${actual}`);
  assert.notEqual(actual, null, `${label}: expected ${expected}, got null`);
  if (Number.isNaN(expected)) return assert.ok(Number.isNaN(actual), `${label}: expected NaN, got ${actual}`);
  if (!Number.isFinite(expected)) return assert.equal(actual, expected, label);
  assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12, `${label}: ${actual} != ${expected}`);
};
const toResult = entry => {
  if ('raw' in entry) return entry.raw;
  const meta = {};
  for (const [key, value] of Object.entries(entry.meta)) if (!(entry.omitNulls && value === null)) meta[key] = value;
  return { meta, timestamp: entry.timestamps, indicators: { quote: [{ close: entry.closes }] } };
};
const pointsOf = (seconds, zone) => getYahooChartPoints({ meta: { exchangeTimezoneName: zone }, timestamp: [seconds], indicators: { quote: [{ close: [1] }] } });

for (let i = 0; i < cases.length; i++) {
  const entry = cases[i];
  const row = rows[i];
  const label = `case ${i} (${entry.kind}${entry.label ? `: ${entry.label}` : ''})`;
  assert.notEqual(row, 'error:malformed-line', `${label}: driver rejected the line`);
  switch (entry.kind) {
    case 'quote': {
      const result = toResult(entry);
      const expected = getYahooQuote(result, { fetchedAt: 'fixed' });
      const expectedPoints = getYahooChartPoints(result);
      const fields = row.split('\t');
      assert.equal(fields.length, 10, `${label}: field count`);
      near(decNum(fields[0]), expected.price, `${label}: price`);
      near(decNum(fields[1]), expected.previousClose, `${label}: previousClose`);
      near(decNum(fields[2]), expected.changePct, `${label}: changePct`);
      assert.equal(decStr(fields[3]), expected.quotedAt, `${label}: quotedAt`);
      near(decNum(fields[4]), expected.delayMinutes, `${label}: delayMinutes`);
      assert.equal(decStr(fields[5]), expected.currency, `${label}: currency`);
      assert.equal(decStr(fields[6]), expected.exchangeTimezone, `${label}: exchangeTimezone`);
      assert.equal(decStr(fields[7]), expected.source, `${label}: source`);
      assert.equal(expected.source, 'Yahoo Finance');
      const closes = fields[8].split(',').filter(Boolean).map(decNum);
      assert.equal(closes.length, expected.closes.length, `${label}: closes length`);
      closes.forEach((close, k) => near(close, expected.closes[k], `${label}: closes[${k}]`));
      const points = fields[9].split(';').filter(Boolean).map(point => point.split(','));
      assert.equal(points.length, expectedPoints.length, `${label}: points length`);
      points.forEach(([stamp, date, price], k) => {
        near(decNum(stamp), expectedPoints[k].timestamp, `${label}: points[${k}].timestamp`);
        assert.equal(decStr(date), expectedPoints[k].date, `${label}: points[${k}].date`);
        near(decNum(price), expectedPoints[k].price, `${label}: points[${k}].price`);
      });
      break;
    }
    case 'alert': {
      const expected = canRaiseTechnicalAlert(entry.quote, entry.historyLength, entry.now);
      assert.equal(row, expected ? '1' : '0', `${label}: ${JSON.stringify(entry.quote)} history=${entry.historyLength}`);
      break;
    }
    case 'iso': {
      const expected = getYahooQuote({ meta: { regularMarketTime: entry.seconds } }).quotedAt;
      assert.equal(decStr(row), expected, `${label}: isoTime(${entry.seconds})`);
      break;
    }
    case 'day': {
      const points = pointsOf(entry.seconds, entry.zone);
      assert.equal(points.length, 1, `${label}: ${entry.seconds} must be a valid instant`);
      assert.equal(decStr(row), points[0].date, `${label}: exchangeDay(${entry.seconds}, ${JSON.stringify(entry.zone)})`);
      break;
    }
    case 'day-throws': {
      assert.throws(() => new Date(entry.seconds * 1000).toISOString(), RangeError);
      assert.equal(row, 'throws', `${label}: exchangeDay(${entry.seconds}) must throw`);
      break;
    }
    case 'parse': {
      const expected = Date.parse(entry.text);
      near(decNum(row), expected, `${label}: Date.parse(${JSON.stringify(entry.text)})`);
      break;
    }
    default: throw new Error(`unknown case kind ${entry.kind}`);
  }
}
console.log(`${cases.length} native/JavaScript marketdata parity cases passed`);

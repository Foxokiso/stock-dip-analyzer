import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finvizOptionsUrl, isOptionSymbol, parseFinvizOptionsPage } from '../src/utils/finvizOptions.js';

// Live https://finviz.com/stock?t=AAPL&ty=oc&e=2026-12-18, trimmed to strikes 335-375.
const page = readFileSync(new URL('./fixtures/finviz-options-AAPL-2026-12-18.html', import.meta.url), 'utf8');
const wrap = (data) => `<html><script id="route-init-data" type="application/json">${JSON.stringify(data)}</script></html>`;
const record = (changes = {}) => ({ ticker: 'XYZ', exDate: 270115, strike: 50, type: 'call', bidPrice: 1, askPrice: 1.2, openInterest: 10, lastVolume: 3, iv: 0.3, delta: 0.5, gamma: 0.1, theta: -0.02, vega: 0.05, lastClose: 1.1, lastTime: '2026-11-13T15:59:43', ...changes });
const chain = (options, changes = {}) => wrap({ ticker: 'XYZ', expiries: ['2027-01-15'], currentExpiry: '2027-01-15', lastClose: 51, lastTime: 1794603590, options, ...changes });

test('the chain URL is the stock page on finviz.com, an allowed host, with the expiration when one is chosen', () => {
    assert.equal(finvizOptionsUrl('aapl'), 'https://finviz.com/stock?t=AAPL&ty=oc');
    assert.equal(finvizOptionsUrl('BRK-B', '2026-12-18'), 'https://finviz.com/stock?t=BRK-B&ty=oc&e=2026-12-18');
    assert.equal(finvizOptionsUrl('brk.b'), 'https://finviz.com/stock?t=BRK-B&ty=oc', 'Finviz answers BRK-B and returns 404 for BRK.B');
    assert.equal(finvizOptionsUrl('AAPL', '12/18/2026'), 'https://finviz.com/stock?t=AAPL&ty=oc', 'a malformed expiration is not sent');
    for (const bad of ['', 'AAPL&e=x', '../x', 'A'.repeat(11), null]) {
        assert.equal(isOptionSymbol(bad), false);
        assert.throws(() => finvizOptionsUrl(bad), /ticker symbol/);
    }
});

test('the live page gives the expirations, the underlying and each strike with its call and put', () => {
    const result = parseFinvizOptionsPage(page);
    assert.equal(result.symbol, 'AAPL');
    assert.equal(result.expiry, '2026-12-18');
    assert.equal(result.expiries.length, 26);
    assert.ok(result.expiries.includes('2027-01-15'));
    assert.equal(result.underlying, 356.27);
    assert.equal(result.underlyingAt, '2026-11-13T20:59:50.000Z');
    assert.deepEqual(result.strikes.map(row => row.strike), [335, 340, 345, 350, 355, 360, 365, 370, 375]);
    const call = result.strikes[3].call;
    assert.deepEqual(call, {
        id: '2026-12-18|call|350', expiry: '2026-12-18', type: 'call', strike: 350,
        bid: 13.9, ask: 14.6, mid: 14.25, width: call.width, last: 14.25, volume: 910, openInterest: 27560,
        iv: 0.23143017, delta: 0.631479, gamma: 0.014924281, theta: -0.15810032, vega: 0.41481045,
        lastTradeAt: '2026-11-13 15:59',
    });
    assert.ok(Math.abs(call.width - 0.7) < 1e-9);
    assert.equal(result.strikes[3].put.type, 'put');
});

test('unknown values stay unknown: no zero stands in for a missing quote', () => {
    const { strikes } = parseFinvizOptionsPage(chain([
        record({ bidPrice: null, askPrice: 0, iv: 0, delta: 'x', lastTime: null, lastVolume: undefined }),
        record({ type: 'put', bidPrice: 2, askPrice: 1.5 }),
    ]));
    const { call, put } = strikes[0];
    assert.deepEqual([call.bid, call.ask, call.mid, call.width, call.iv, call.delta, call.lastTradeAt, call.volume], [null, null, null, null, null, null, null, null]);
    assert.deepEqual([put.bid, put.ask, put.mid, put.width], [2, 1.5, null, null], 'a crossed market has no midpoint');
    // A zero bid is a real quote.
    assert.equal(parseFinvizOptionsPage(chain([record({ bidPrice: 0, askPrice: 0.05 })])).strikes[0].call.mid, 0.025);
});

test('records of another expiration, and malformed ones, are left out', () => {
    const { strikes } = parseFinvizOptionsPage(chain([record(), record({ exDate: 270219, strike: 55 }), record({ strike: -1 }), record({ type: 'future' }), record({ exDate: 'soon' })]));
    assert.deepEqual(strikes.map(row => row.strike), [50]);
});

test('a page without a chain throws instead of returning an empty one', () => {
    for (const html of ['', '<html></html>', wrap({ ticker: 'XYZ' }), '<script id="route-init-data">{not json</script>', '<script id="route-init-data">{"ticker":"X","options":[]}']) {
        assert.throws(() => parseFinvizOptionsPage(html), /options chain unavailable/);
    }
    assert.throws(() => parseFinvizOptionsPage(chain([])), /no option contracts/);
});

test('a page of unclosed script tags is refused quickly', () => {
    const started = performance.now();
    assert.throws(() => parseFinvizOptionsPage('<script x'.repeat(200_000)), /unavailable/);
    assert.ok(performance.now() - started < 2000);
});

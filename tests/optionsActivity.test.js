import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFinvizOptionsPage } from '../src/utils/finvizOptions.js';
import { UNUSUAL_MIN_VOLUME, contractActivity, unusualContracts } from '../src/utils/optionsActivity.js';

const wrap = (data) => `<html><script id="route-init-data" type="application/json">${JSON.stringify(data)}</script></html>`;
const record = (changes = {}) => ({ ticker: 'XYZ', exDate: 270115, strike: 50, type: 'call', bidPrice: 1, askPrice: 1.2, openInterest: 100, lastVolume: 150, iv: 0.3, delta: 0.5, lastClose: 1.1, lastTime: '2026-11-13T15:59:43', ...changes });
const parse = (options) => parseFinvizOptionsPage(wrap({ ticker: 'XYZ', expiries: ['2027-01-15'], currentExpiry: '2027-01-15', lastClose: 51, lastTime: 1794603590, options }));
const only = (changes) => parse([record(changes)]).strikes[0].call;

test('a contract is unusual when it trades at least the minimum and more than its open interest', () => {
    assert.equal(UNUSUAL_MIN_VOLUME, 100);
    assert.equal(contractActivity(only({ lastVolume: 150, openInterest: 100 })).unusual, true);
    assert.equal(contractActivity(only({ lastVolume: 99, openInterest: 10 })).unusual, false, 'under the minimum volume');
    assert.equal(contractActivity(only({ lastVolume: 100, openInterest: 10 })).unusual, true, 'the minimum itself counts');
    assert.equal(contractActivity(only({ lastVolume: 100, openInterest: 100 })).unusual, false, 'volume equal to open interest is not above it');
    assert.equal(contractActivity(only({ lastVolume: 500, openInterest: 5000 })).unusual, false);
});

test('unknown volume or open interest is never unusual and has no ratio', () => {
    for (const changes of [{ lastVolume: undefined }, { lastVolume: null }, { openInterest: null }, { openInterest: undefined }]) {
        const activity = contractActivity(only(changes));
        assert.equal(activity.unusual, false);
        assert.equal(activity.ratio, null);
    }
    assert.equal(contractActivity(null).unusual, false);
    assert.equal(contractActivity({}).premium, null);
});

test('the ratio is volume over open interest, and "new" when there is no open interest', () => {
    assert.equal(contractActivity(only({ lastVolume: 250, openInterest: 100 })).ratio, 2.5);
    const fresh = contractActivity(only({ lastVolume: 300, openInterest: 0 }));
    assert.equal(fresh.ratio, Infinity);
    assert.equal(fresh.unusual, true);
    assert.equal(contractActivity(only({ lastVolume: 0, openInterest: 0 })).ratio, null, 'no volume against no open interest says nothing');
});

test('the premium is volume x price x 100, at the midpoint, else the last trade, else unknown', () => {
    // bid 1, ask 1.2: midpoint 1.1.
    assert.deepEqual([contractActivity(only({ lastVolume: 200 })).premium, contractActivity(only({ lastVolume: 200 })).premiumBasis], [22000, 'mid']);
    // A one-sided quote has no midpoint: the last trade stands in, and is labelled.
    const oneSided = contractActivity(only({ lastVolume: 200, bidPrice: 0, askPrice: null, lastClose: 0.5 }));
    assert.deepEqual([oneSided.premium, oneSided.premiumBasis], [10000, 'last']);
    const none = contractActivity(only({ lastVolume: 200, bidPrice: null, askPrice: null, lastClose: null }));
    assert.deepEqual([none.premium, none.premiumBasis], [null, null]);
});

test('unusualContracts lists calls and puts by premium, unknown premium last, and honours the limit', () => {
    const chain = parse([
        record({ strike: 40, lastVolume: 300, openInterest: 100, bidPrice: 2, askPrice: 2 }),                       // 60,000
        record({ strike: 40, type: 'put', lastVolume: 900, openInterest: 100, bidPrice: 1, askPrice: 1 }),            // 90,000
        record({ strike: 45, lastVolume: 400, openInterest: 100, bidPrice: null, askPrice: null, lastClose: null }), // no premium
        record({ strike: 50, lastVolume: 50, openInterest: 10 }),                                                    // under the minimum
        record({ strike: 55, lastVolume: 100, openInterest: 5000 }),                                                 // below its open interest
    ]);
    const found = unusualContracts(chain);
    assert.deepEqual(found.map(item => [item.contract.strike, item.contract.type, item.premium]), [[40, 'put', 90000], [40, 'call', 60000], [45, 'call', null]]);
    assert.deepEqual(unusualContracts(chain, 1).map(item => item.contract.id), ['2027-01-15|put|40']);
    assert.deepEqual(unusualContracts(null), []);
    assert.deepEqual(unusualContracts({ strikes: [] }), []);
});

test('on the recorded AAPL December chain nothing trades above its open interest', () => {
    const chain = parseFinvizOptionsPage(readFileSync(new URL('./fixtures/finviz-options-AAPL-2026-12-18.html', import.meta.url), 'utf8'));
    assert.deepEqual(unusualContracts(chain), []);
    // The busiest contract there, the 360 call, traded 7,413 against 27,858 open: a 0.27 ratio.
    const busiest = contractActivity(chain.strikes.find(row => row.strike === 360).call);
    assert.equal(busiest.volume, 7413);
    assert.equal(busiest.unusual, false);
    assert.ok(Math.abs(busiest.ratio - 7413 / 27858) < 1e-12);
});

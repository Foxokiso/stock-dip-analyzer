import test from 'node:test';
import assert from 'node:assert/strict';
import { allows, shownCondition } from '../src/utils/alertGates.js';
import { analyzeStock } from '../src/utils/scoring.js';
import { dispatchAlertsFromAnalysis, resetScans } from '../src/state/scanStore.js';
import { DEFAULT_SETTINGS } from '../src/state/settingsSchema.js';

const defaults = DEFAULT_SETTINGS.alerts;
const prefs = (changes) => ({ ...defaults, ...changes });

// The 'stock-alert' detail a scan raises from these closes and live price, as
// scanStore does for a Yahoo quote a minute old. A bare EventTarget stands in for window.
const raisedFrom = (t, closes, price) => {
    const events = [];
    globalThis.window = new EventTarget();
    globalThis.window.addEventListener('stock-alert', (event) => events.push(event.detail));
    t.after(() => { delete globalThis.window; });
    resetScans(); // every condition armed
    const analysis = analyzeStock(closes, price);
    dispatchAlertsFromAnalysis('XYZ', analysis, {
        price, closes, quotedAt: new Date(Date.now() - 60_000).toISOString(), delayMinutes: null,
        exchangeTimezone: 'America/New_York', source: 'Yahoo Finance',
    });
    assert.equal(events.length, 1, 'the scan raised one alert');
    return { analysis, detail: events[0] };
};

// One month of closes: a run-up to a 20.00 closing high 12 sessions before the
// current one, a pullback, and today's close at 20.60, above it.
const BREAKOUT = [15, 15.5, 16, 16.4, 16.9, 17.3, 17.8, 18.4, 18.9, 19.5, 20, 19.6, 19.1, 18.7, 18.4, 18.6, 18.9, 19.1, 19.3, 19.2, 19.5, 19.8, 20.6];
// A fall from a 100 closing high to 50, then 14 rising sessions to 74: a bullish
// trend after a bounce, still 26% below the high.
const BULLISH = [100, 92, 84, 76, 68, 60, 52, 50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 71, 72, 73, 74];

test('a breakout a scan raises is shown at the default settings, though its dip score is under the minimum score', (t) => {
    const { analysis, detail } = raisedFrom(t, BREAKOUT, 20.6);
    assert.equal(analysis.isBreakout, true);
    // The current session is the peak: no dip and no bounce to score.
    assert.ok(analysis.score < defaults.minScore, `scored ${analysis.score}`);
    assert.equal(detail.score, analysis.score);
    assert.deepEqual(shownCondition(defaults, detail), { type: 'breakout', color: 'blue', message: 'Price $20.60 is above its prior one-month closing high.' });
    // Whatever the minimum score; only its own switch turns it off.
    for (const minScore of [0, 50, 100]) assert.equal(shownCondition(prefs({ minScore }), detail)?.type, 'breakout', `minimum score ${minScore}`);
    assert.equal(shownCondition(prefs({ breakout: false }), detail), null);
});

test('the minimum score still gates Bullish alerts', (t) => {
    const { analysis, detail } = raisedFrom(t, BULLISH, 74);
    assert.equal(detail.type, 'bullish');
    assert.equal(analysis.score, 50);
    assert.equal(shownCondition(defaults, detail), null, 'under the default minimum score of 60');
    assert.equal(shownCondition(prefs({ minScore: 50 }), detail)?.type, 'bullish');
    // At the threshold, and from an emitter that attached no score.
    assert.equal(allows(defaults, 'bullish', 59), false);
    assert.equal(allows(defaults, 'bullish', 60), true);
    assert.equal(allows(defaults, 'bullish', null), true);
    assert.equal(shownCondition(defaults, { type: 'bullish', score: 'high' })?.type, 'bullish', 'a score that is not a number is none');
});

test('breakout, breakdown and bearish alerts are shown whatever the score', () => {
    for (const type of ['breakout', 'breakdown', 'bearish']) {
        assert.equal(allows(prefs({ minScore: 100 }), type, 0), true, type);
    }
    assert.equal(allows(prefs({ minScore: 100 }), 'bullish', 99), false);
});

test('each alert type is shown only while its own switch is on, and an unknown type never', () => {
    const switches = { breakout: 'breakout', breakdown: 'breakdown', bullish: 'trend', bearish: 'trend' };
    for (const [type, setting] of Object.entries(switches)) {
        assert.equal(allows(defaults, type, 100), true, `${type} is on by default`);
        assert.equal(allows(prefs({ [setting]: false }), type, 100), false, `${setting} off drops ${type}`);
        for (const other of ['breakout', 'breakdown', 'trend'].filter(name => name !== setting)) {
            assert.equal(allows(prefs({ [other]: false }), type, 100), true, `${other} off keeps ${type}`);
        }
    }
    for (const type of ['earnings', '', null, undefined]) assert.equal(allows(defaults, type, 100), false, String(type));
});

test('the first condition the settings allow is shown, so a type switched off never hides the next', () => {
    const detail = { type: 'breakdown', score: 15, conditions: [
        { type: 'breakdown', color: 'amber', message: 'At the low' },
        { type: 'bearish', color: 'blue', message: 'Trending down' },
    ] };
    assert.equal(shownCondition(defaults, detail), detail.conditions[0]);
    assert.equal(shownCondition(prefs({ breakdown: false }), detail), detail.conditions[1]);
    assert.equal(shownCondition(prefs({ breakdown: false, trend: false }), detail), null);
    // An alert that names one condition, and one that names none.
    assert.equal(shownCondition(defaults, { type: 'bearish', score: 15 })?.type, 'bearish');
    assert.equal(shownCondition(defaults, {}), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { parseHTML } from 'linkedom';
import { startVisibleInterval, useVisibleInterval } from '../src/utils/useVisibleInterval.js';

const MINUTE = 60_000;

// A document whose visibility the test sets; set() fires visibilitychange.
const fakeDocument = (initial = 'visible') => {
    const listeners = new Set();
    return {
        visibilityState: initial,
        listeners,
        addEventListener: (type, listener) => { if (type === 'visibilitychange') listeners.add(listener); },
        removeEventListener: (type, listener) => { if (type === 'visibilitychange') listeners.delete(listener); },
        set(state) {
            this.visibilityState = state;
            listeners.forEach(listener => listener());
        },
    };
};

// Intervals on a manual clock: advance() runs every tick that falls due, in order.
const fakeTimers = () => {
    let now = 0, nextId = 1;
    const intervals = new Map();
    return {
        setInterval: (callback, ms) => {
            intervals.set(nextId, { callback, ms, due: now + ms });
            return nextId++;
        },
        clearInterval: (id) => { intervals.delete(id); },
        get active() { return intervals.size; },
        advance(ms) {
            const end = now + ms;
            for (;;) {
                const next = [...intervals.values()].filter(({ due }) => due <= end).sort((a, b) => a.due - b.due)[0];
                if (!next) break;
                now = next.due;
                next.due += next.ms;
                next.callback();
            }
            now = end;
        },
    };
};

const counter = () => {
    const calls = { count: 0 };
    return { calls, callback: () => { calls.count++; } };
};

test('runs every interval while the window is visible', () => {
    const doc = fakeDocument(), timers = fakeTimers(), { calls, callback } = counter();
    startVisibleInterval(callback, 5, { doc, timers });
    timers.advance(5 * MINUTE - 1);
    assert.equal(calls.count, 0);
    timers.advance(1);
    assert.equal(calls.count, 1);
    timers.advance(10 * MINUTE);
    assert.equal(calls.count, 3);
});

test('ticks that fall due while hidden are skipped; showing the window runs one catch-up and restarts the interval', () => {
    const doc = fakeDocument(), timers = fakeTimers(), { calls, callback } = counter();
    startVisibleInterval(callback, 5, { doc, timers });
    timers.advance(MINUTE);
    doc.set('hidden');
    timers.advance(11 * MINUTE); // the ticks at 5 and 10 min fall due while hidden
    assert.equal(calls.count, 0);
    doc.set('visible'); // at 12 min
    assert.equal(calls.count, 1, 'one catch-up for both missed ticks');
    timers.advance(3 * MINUTE);
    assert.equal(calls.count, 1, 'the old phase (a tick at 15 min) is gone');
    timers.advance(2 * MINUTE);
    assert.equal(calls.count, 2, 'the next tick is a full interval after the catch-up');
});

test('showing the window when no tick was missed runs nothing extra', () => {
    const doc = fakeDocument(), timers = fakeTimers(), { calls, callback } = counter();
    startVisibleInterval(callback, 5, { doc, timers });
    timers.advance(MINUTE);
    doc.set('hidden');
    timers.advance(2 * MINUTE);
    doc.set('visible');
    assert.equal(calls.count, 0);
    timers.advance(2 * MINUTE);
    assert.equal(calls.count, 1, 'the regular tick at 5 min');
});

test('a catch-up is owed once', () => {
    const doc = fakeDocument(), timers = fakeTimers(), { calls, callback } = counter();
    startVisibleInterval(callback, 5, { doc, timers });
    doc.set('hidden');
    timers.advance(6 * MINUTE);
    doc.set('visible');
    assert.equal(calls.count, 1);
    doc.set('hidden');
    timers.advance(MINUTE);
    doc.set('visible');
    assert.equal(calls.count, 1, 'nothing was missed the second time');
});

test('a visibilitychange that leaves the window hidden does not catch up', () => {
    const doc = fakeDocument(), timers = fakeTimers(), { calls, callback } = counter();
    startVisibleInterval(callback, 5, { doc, timers });
    doc.set('hidden');
    timers.advance(6 * MINUTE);
    doc.set('hidden'); // a repeated event: still hidden, so the catch-up waits
    assert.equal(calls.count, 0);
    doc.set('visible');
    assert.equal(calls.count, 1);
});

test('a document that starts hidden waits for the window to be shown', () => {
    const doc = fakeDocument('hidden'), timers = fakeTimers(), { calls, callback } = counter();
    startVisibleInterval(callback, 1, { doc, timers });
    timers.advance(30 * MINUTE);
    assert.equal(calls.count, 0);
    doc.set('visible');
    assert.equal(calls.count, 1);
});

test('whileHidden keeps ticking while hidden and has nothing to catch up', () => {
    const doc = fakeDocument('hidden'), timers = fakeTimers(), { calls, callback } = counter();
    startVisibleInterval(callback, 5, { doc, timers, whileHidden: true });
    timers.advance(10 * MINUTE);
    assert.equal(calls.count, 2);
    doc.set('visible');
    assert.equal(calls.count, 2);
    timers.advance(5 * MINUTE);
    assert.equal(calls.count, 3);
});

test('minutes of zero or less schedule nothing', () => {
    for (const minutes of [0, -1, Number.NaN, undefined]) {
        const doc = fakeDocument(), timers = fakeTimers(), { calls, callback } = counter();
        const stop = startVisibleInterval(callback, minutes, { doc, timers });
        assert.equal(timers.active, 0, `minutes ${minutes}`);
        assert.equal(doc.listeners.size, 0, `minutes ${minutes}`);
        timers.advance(60 * MINUTE);
        doc.set('hidden');
        doc.set('visible');
        stop();
        assert.equal(calls.count, 0, `minutes ${minutes}`);
    }
});

test('stop clears the interval and the visibility listener', () => {
    const doc = fakeDocument(), timers = fakeTimers(), { calls, callback } = counter();
    const stop = startVisibleInterval(callback, 5, { doc, timers });
    doc.set('hidden');
    timers.advance(6 * MINUTE); // a missed tick, so a listener left behind would catch up
    stop();
    assert.equal(timers.active, 0);
    assert.equal(doc.listeners.size, 0);
    doc.set('visible');
    timers.advance(20 * MINUTE);
    assert.equal(calls.count, 0);
});

// ── the hook, rendered by React 19 on a DOM ──
const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
const setVisibility = (state) => {
    visibility = state;
    document.dispatchEvent(new window.Event('visibilitychange'));
};
const { createRoot } = await import('react-dom/client');

const Probe = ({ minutes, onTick, whileHidden, resetKey }) => {
    useVisibleInterval(onTick, minutes, { whileHidden, resetKey });
    return null;
};
const mount = () => {
    const root = createRoot(document.createElement('div'));
    return {
        render: (props) => act(() => root.render(createElement(Probe, props))),
        unmount: () => act(() => root.unmount()),
    };
};

test('the hook runs the latest callback without restarting the interval', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    visibility = 'visible';
    const calls = [];
    const probe = mount();
    probe.render({ minutes: 1, onTick: () => calls.push('first') });
    t.mock.timers.tick(MINUTE / 2);
    probe.render({ minutes: 1, onTick: () => calls.push('second') });
    t.mock.timers.tick(MINUTE / 2);
    assert.deepEqual(calls, ['second'], 'the re-render kept the running interval and its phase');
    probe.render({ minutes: 2, onTick: () => calls.push('slower') });
    t.mock.timers.tick(MINUTE);
    assert.deepEqual(calls, ['second'], 'a new interval length restarts the timer');
    t.mock.timers.tick(MINUTE);
    assert.deepEqual(calls, ['second', 'slower']);
    probe.render({ minutes: 0, onTick: () => calls.push('off') });
    t.mock.timers.tick(10 * MINUTE);
    assert.deepEqual(calls, ['second', 'slower'], 'zero minutes turns it off');
    probe.unmount();
});

test('the hook restarts the interval when resetKey changes', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    visibility = 'visible';
    const calls = [];
    const probe = mount();
    probe.render({ minutes: 1, onTick: () => calls.push('tech'), resetKey: 'tech' });
    t.mock.timers.tick(MINUTE / 2);
    // A new target, fetched by the page as soon as it was picked.
    probe.render({ minutes: 1, onTick: () => calls.push('energy'), resetKey: 'energy' });
    t.mock.timers.tick(MINUTE / 2);
    assert.deepEqual(calls, [], 'the old schedule does not refetch the new target half a minute later');
    t.mock.timers.tick(MINUTE / 2);
    assert.deepEqual(calls, ['energy'], 'the next tick is a full interval after the change');
    t.mock.timers.tick(MINUTE / 2);
    probe.render({ minutes: 1, onTick: () => calls.push('same target'), resetKey: 'energy' });
    t.mock.timers.tick(MINUTE / 2);
    assert.deepEqual(calls, ['energy', 'same target'], 'an unchanged key keeps the schedule');
    probe.unmount();
});

test('the hook pauses while hidden and stops on unmount', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    visibility = 'visible';
    const calls = [];
    const probe = mount();
    probe.render({ minutes: 1, onTick: () => calls.push('tick') });
    setVisibility('hidden');
    t.mock.timers.tick(3 * MINUTE);
    assert.deepEqual(calls, []);
    setVisibility('visible');
    assert.deepEqual(calls, ['tick'], 'one catch-up');
    setVisibility('hidden');
    t.mock.timers.tick(MINUTE); // missed again, then the desk goes away
    probe.unmount();
    setVisibility('visible');
    t.mock.timers.tick(10 * MINUTE);
    assert.deepEqual(calls, ['tick'], 'no catch-up and no ticks after unmount');
});

test('the hook keeps ticking while hidden when asked to', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    visibility = 'hidden';
    const calls = [];
    const probe = mount();
    probe.render({ minutes: 1, onTick: () => calls.push('tick'), whileHidden: true });
    t.mock.timers.tick(2 * MINUTE);
    assert.deepEqual(calls, ['tick', 'tick']);
    probe.render({ minutes: 1, onTick: () => calls.push('tick'), whileHidden: false });
    t.mock.timers.tick(2 * MINUTE);
    assert.deepEqual(calls, ['tick', 'tick'], 'turning it off pauses the hidden window again');
    probe.unmount();
    visibility = 'visible';
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { createTradingViewLoader, mountTradingViewWidget } from '../src/utils/tradingView.js';

const environment = () => ({ window: {}, document: new DOMParser().parseFromString('<html><head></head><body><div id="chart"></div></body></html>', 'text/html') });

test('concurrent chart callers share one script promise and initialized API', async () => {
    const context = environment();
    const load = createTradingViewLoader(context);
    const first = load(), second = load();
    assert.equal(first, second);
    assert.equal(context.document.querySelectorAll('script').length, 1);
    context.window.TradingView = { widget: class {} };
    context.document.querySelector('script').onload();
    assert.equal(await first, context.window.TradingView);
    assert.equal(await second, context.window.TradingView);
    assert.equal(load(), first);
});

test('network failure rejects current callers and a later load can retry', async () => {
    const context = environment();
    const load = createTradingViewLoader(context);
    const failed = load();
    context.document.querySelector('script').onerror();
    await assert.rejects(failed, /unavailable|network/i);
    assert.equal(context.document.querySelectorAll('script').length, 0);
    const retry = load();
    context.window.TradingView = { widget: class {} };
    context.document.querySelector('script').onload();
    assert.equal(await retry, context.window.TradingView);
    assert.notEqual(retry, failed);
});

test('a loaded script without widget API fails and does not poison retries', async () => {
    const context = environment();
    const load = createTradingViewLoader(context);
    const failed = load();
    context.document.querySelector('script').onload();
    await assert.rejects(failed, /initialize|unavailable/i);
    const retry = load();
    context.window.TradingView = { widget: class {} };
    context.document.querySelector('script').onload();
    assert.equal(await retry, context.window.TradingView);
});

test('timeout is bounded, removes failed script, and a late callback cannot break a retry', async () => {
    const context = environment();
    const load = createTradingViewLoader({ ...context, timeoutMs: 15 });
    const failed = load();
    const lateCallback = context.document.querySelector('script').onload;
    await assert.rejects(failed, /time|unavailable/i);
    assert.equal(context.document.querySelectorAll('script').length, 0);
    const retry = load();
    context.window.TradingView = { widget: class {} };
    lateCallback();
    context.document.querySelector('script').onload();
    assert.equal(await retry, context.window.TradingView);
});

test('canceling a delayed AAPL mount cannot draw into the active MSFT chart', async () => {
    const context = environment();
    const load = createTradingViewLoader(context);
    const container = context.document.getElementById('chart');
    const disposeOld = mountTradingViewWidget(container, { symbol: 'AAPL' }, { load });
    disposeOld();
    const disposeCurrent = mountTradingViewWidget(container, { symbol: 'MSFT' }, { load });
    context.window.TradingView = { widget: class {
        constructor({ symbol }) { this.element = context.document.createElement('div'); this.element.textContent = symbol; container.appendChild(this.element); }
        remove() { this.element.remove(); }
    } };
    context.document.querySelector('script').onload();
    await load();
    await Promise.resolve();
    assert.equal(container.textContent, 'MSFT');
    disposeCurrent();
    assert.equal(container.textContent, '');
});

test('active loader failure is reported while canceled consumers remain silent', async () => {
    const context = environment();
    const load = createTradingViewLoader(context);
    const container = context.document.getElementById('chart');
    const errors = [];
    const disposeOld = mountTradingViewWidget(container, { symbol: 'AAPL' }, { load, onError: error => errors.push(`AAPL:${error.message}`) });
    disposeOld();
    mountTradingViewWidget(container, { symbol: 'MSFT' }, { load, onError: error => errors.push(`MSFT:${error.message}`) });
    const failed = load();
    context.document.querySelector('script').onerror();
    await assert.rejects(failed, /unavailable|network/i);
    await Promise.resolve();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^MSFT:/);
});

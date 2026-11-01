import test from 'node:test';
import assert from 'node:assert/strict';
import { getInvoke, hasDesktop, invoke } from '../src/utils/bridge.js';
import { loadPreload } from './helpers/mainProcess.js';

// Runs fn with globalThis.window set to the given object, then removes it.
async function withWindow(win, fn) {
    globalThis.window = win;
    try {
        return await fn();
    } finally {
        delete globalThis.window;
    }
}

const legacy = (invokeFn) => ({ require: (name) => (name === 'electron' ? { ipcRenderer: { invoke: invokeFn } } : null) });

test('the shipped bridge, window.dipAnalyzer.invoke, is preferred and receives the channel and arguments', async () => {
    const calls = [];
    await withWindow({
        dipAnalyzer: { invoke: async (...args) => { calls.push(['bridge', ...args]); return 'from preload'; } },
        ...legacy(async (...args) => { calls.push(['legacy', ...args]); return 'from require'; }),
    }, async () => {
        assert.equal(hasDesktop(), true);
        assert.equal(await getInvoke()('fetch-yahoo-chart', 'AAPL', '1mo', '1d'), 'from preload');
        assert.equal(await invoke('fetch-url', 'https://finviz.com/'), 'from preload');
    });
    assert.deepEqual(calls, [
        ['bridge', 'fetch-yahoo-chart', 'AAPL', '1mo', '1d'],
        ['bridge', 'fetch-url', 'https://finviz.com/'],
    ]);
});

test("the legacy window.require('electron') shape still works for the browser regression scripts", async () => {
    const calls = [];
    await withWindow(legacy(async (...args) => { calls.push(args); return 'from require'; }), async () => {
        assert.equal(await getInvoke()('fetch-url', 'https://news.google.com/rss'), 'from require');
    });
    assert.deepEqual(calls, [['fetch-url', 'https://news.google.com/rss']]);
});

test('without a desktop bridge there is no invoke, and invoke() rejects with the standard message', async () => {
    for (const win of [
        {},
        { dipAnalyzer: {} },
        { require: () => { throw new Error('require is not available'); } },
        { require: () => ({ ipcRenderer: {} }) },
    ]) {
        await withWindow(win, async () => {
            assert.equal(getInvoke(), null);
            assert.equal(hasDesktop(), false);
            await assert.rejects(invoke('fetch-url', 'https://finviz.com/'), /requires the desktop app connection/);
        });
    }
    assert.equal(getInvoke(), null, 'outside a browser');
});

test('the preload contract: what preload.cjs exposes is what the renderer calls', async () => {
    const { exposed, calls } = loadPreload(async (channel, url) => `<html>${url}</html>`);
    await withWindow({ dipAnalyzer: exposed.get('dipAnalyzer') }, async () => {
        assert.equal(await getInvoke()('fetch-url', 'https://finviz.com/futures'), '<html>https://finviz.com/futures</html>');
        await assert.rejects(getInvoke()('open-external', 'https://evil.example/'), /Unknown desktop channel/);
    });
    assert.deepEqual(calls, [['fetch-url', 'https://finviz.com/futures']]);
});

test("Electron's IPC wrapping is removed, so the desks show the provider's own words", async () => {
    const rejectWith = (message) => ({ dipAnalyzer: { invoke: async () => { throw new Error(message); } } });
    for (const [electronMessage, readable] of [
        ["Error invoking remote method 'fetch-url': Error: Finviz returned HTTP 429 Too Many Requests", 'Finviz returned HTTP 429 Too Many Requests'],
        ["Error invoking remote method 'fetch-url': TypeError: fetch failed", 'fetch failed'],
        ["Error invoking remote method 'fetch-yahoo-chart': TimeoutError: Request timed out after 12 s", 'Request timed out after 12 s'],
        ["Error invoking remote method 'fetch-yahoo-chart': Error: Yahoo Finance returned HTTP 404 Not Found: No data found, symbol may be delisted", 'Yahoo Finance returned HTTP 404 Not Found: No data found, symbol may be delisted'],
        ['Unknown desktop channel: open-external', 'Unknown desktop channel: open-external'],
        ['Error: kept, because Electron did not wrap it', 'Error: kept, because Electron did not wrap it'],
    ]) {
        await withWindow(rejectWith(electronMessage), async () => {
            await assert.rejects(getInvoke()('fetch-url', 'https://finviz.com/'), { message: readable });
            await assert.rejects(invoke('fetch-url', 'https://finviz.com/'), { message: readable });
        });
    }
});

test('a bridge that throws synchronously still yields a rejected promise', async () => {
    await withWindow({ dipAnalyzer: { invoke: () => { throw new Error("Error invoking remote method 'configure-network': Error: offline"); } } }, async () => {
        const pending = getInvoke()('configure-network', { requestTimeoutSeconds: 20 });
        assert.ok(pending instanceof Promise);
        await assert.rejects(pending, { message: 'offline' });
    });
});

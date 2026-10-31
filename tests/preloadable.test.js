import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createElement, Component, Suspense } from 'react';
import { parseHTML } from 'linkedom';
import { preloadable } from '../src/utils/preloadable.js';

const Page = () => createElement('p', null, 'page');

// An import that fails `failures` times (a chunk the dev server or disk could
// not serve), then resolves to the page module.
const flakyImport = (failures) => {
    const calls = { count: 0 };
    const factory = () => {
        calls.count++;
        return calls.count <= failures
            ? Promise.reject(new Error(`chunk failed #${calls.count}`))
            : Promise.resolve({ default: Page });
    };
    return { factory, calls };
};

// Calls the component the way React does: it returns an element, or throws a
// promise (suspend) or an Error (for the nearest error boundary).
const render = (Lazy) => {
    try {
        return { element: Lazy({}) };
    } catch (thrown) {
        return { thrown };
    }
};

test('a rejected import is not cached: the next preload() imports again and succeeds', async () => {
    const { factory, calls } = flakyImport(1);
    const Lazy = preloadable(factory);
    await assert.rejects(Lazy.preload(), /chunk failed #1/);
    assert.equal(await Lazy.preload(), Page);
    assert.equal(calls.count, 2);
});

test('concurrent callers share one import', async () => {
    const { factory, calls } = flakyImport(0);
    const Lazy = preloadable(factory);
    const warmUp = Lazy.preload();
    assert.equal(Lazy.preload(), warmUp);
    assert.equal(render(Lazy).thrown, warmUp, 'a render during the warm-up suspends on the same import');
    assert.equal(await warmUp, Page);
    assert.equal(calls.count, 1);
    assert.equal(render(Lazy).element.type, Page, 'once loaded, a render returns the page synchronously');
    await Lazy.preload();
    assert.equal(calls.count, 1, 'a loaded module is never imported again');
});

test('a failed warm-up is retried by the next render', async () => {
    const { factory, calls } = flakyImport(1);
    const Lazy = preloadable(factory);
    await assert.rejects(Lazy.preload(), /chunk failed #1/);
    const { thrown } = render(Lazy);
    assert.equal(typeof thrown?.then, 'function', 'the render suspends on a new import, not on the old rejection');
    assert.equal(calls.count, 2);
    await thrown;
    assert.equal(render(Lazy).element.type, Page);
});

test('a render waiting on a failed import throws its Error until the next preload()', async () => {
    const { factory, calls } = flakyImport(1);
    const Lazy = preloadable(factory);
    const { thrown: pending } = render(Lazy);
    await assert.rejects(pending, /chunk failed #1/);
    // React renders once more right after an error; both renders must report it.
    for (let attempt = 0; attempt < 2; attempt++) {
        const { thrown } = render(Lazy);
        assert.ok(thrown instanceof Error, 'an Error, not a promise React would wait on again');
        assert.match(thrown.message, /chunk failed #1/);
    }
    assert.equal(calls.count, 1, 'reporting the error does not start another import');
    assert.equal(await Lazy.preload(), Page);
    assert.equal(calls.count, 2);
    assert.equal(render(Lazy).element.type, Page);
});

// ── the same contract under React 19 on a DOM ──
const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = document;
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');

class Boundary extends Component {
    state = { error: null };
    static getDerivedStateFromError(error) {
        return { error };
    }
    render() {
        return this.state.error ? createElement('p', null, `failed: ${this.state.error.message}`) : this.props.children;
    }
}

// Mounts <Boundary><Suspense><Lazy/></Suspense></Boundary>, counting renders,
// and waits until the root reads `expected` (React holds a fallback ~300 ms).
const mountUntil = async (Lazy, expected) => {
    let renders = 0;
    const Counted = () => {
        renders++;
        return createElement(Lazy);
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const quietError = console.error;
    console.error = () => {};
    try {
        root.render(createElement(Boundary, null, createElement(Suspense, { fallback: createElement('p', null, 'loading') }, createElement(Counted))));
        for (let waited = 0; waited < 3000 && container.textContent !== expected; waited += 25) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return { text: container.textContent, renders };
    } finally {
        root.unmount();
        container.remove();
        console.error = quietError;
    }
};

test('React shows a failed import in the error boundary instead of re-rendering forever', async () => {
    const { factory, calls } = flakyImport(Infinity);
    const { text, renders } = await mountUntil(preloadable(factory), 'failed: chunk failed #1');
    assert.equal(text, 'failed: chunk failed #1');
    assert.ok(renders < 10, `rendered ${renders} times`);
    assert.equal(calls.count, 1);
});

test('React renders the page after a failed warm-up', async () => {
    const { factory, calls } = flakyImport(1);
    const Lazy = preloadable(factory);
    await assert.rejects(Lazy.preload(), /chunk failed #1/);
    const { text } = await mountUntil(Lazy, 'page');
    assert.equal(text, 'page');
    assert.equal(calls.count, 2);
});

// ── the app's error boundary (components/ErrorBoundary.jsx, its JSX compiled
// with Vite's esbuild transform) showing a failed stock page as routes change ──
const boundaryUrl = new URL('../src/components/ErrorBoundary.jsx', import.meta.url);
const { transformWithEsbuild } = await import('vite');
const { code: boundarySource } = await transformWithEsbuild(await readFile(boundaryUrl, 'utf8'), fileURLToPath(boundaryUrl), { jsx: 'automatic' });
registerHooks({
    load: (url, context, nextLoad) => (url === boundaryUrl.href
        ? { format: 'module', source: boundarySource, shortCircuit: true }
        : nextLoad(url, context)),
});
const { default: ErrorBoundary } = await import(boundaryUrl.href);

// Renders <ErrorBoundary resetKey={path}> around the desk for `path`
// synchronously, the way App.jsx's routed desk does (pass `{}` as the boundary
// props for one without a key), and collects the errors the boundary logs.
const mountDesks = (desks) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const caught = [];
    const quietError = console.error;
    console.error = (...args) => {
        if (String(args[0]).startsWith('Render error caught by an error boundary')) caught.push(args[1]);
    };
    let resetBoundary = null;
    const Fallback = ({ error, reset }) => {
        resetBoundary = reset;
        return createElement('p', null, `failed: ${error.message}`);
    };
    const open = (path, props = { resetKey: path }) => flushSync(() => root.render(createElement(ErrorBoundary, { ...props, fallback: Fallback },
        createElement(Suspense, { fallback: createElement('p', null, 'loading') }, createElement(desks[path])))));
    const reset = () => flushSync(() => resetBoundary());
    const unmount = () => {
        root.unmount();
        container.remove();
        console.error = quietError;
    };
    return { container, caught, open, reset, unmount };
};

test('a desk that fails as its route opens is caught once, and leaving it resets the boundary', async () => {
    const { factory, calls } = flakyImport(Infinity);
    const StockPage = preloadable(factory);
    await assert.rejects(render(StockPage).thrown, /chunk failed #1/); // the stock page's import has failed
    const desks = { '/': () => createElement('p', null, 'overview'), '/stock/AAPL': StockPage, '/futures': () => createElement('p', null, 'futures') };
    const { container, caught, open, unmount } = mountDesks(desks);
    try {
        open('/');
        assert.equal(container.textContent, 'overview');
        // The route (resetKey) changes in the same render that catches the
        // failure; that error belongs to the new route and must stay.
        open('/stock/AAPL');
        assert.equal(container.textContent, 'failed: chunk failed #1');
        assert.equal(caught.length, 1, 'caught and logged once, not rendered again and caught twice');
        open('/futures');
        assert.equal(container.textContent, 'futures', 'leaving the failed desk renders the next one');
        open('/stock/AAPL');
        assert.equal(container.textContent, 'failed: chunk failed #1');
        assert.equal(caught.length, 2);
        assert.equal(calls.count, 1);
    } finally {
        unmount();
    }
});

test('reset() renders a failed part of the window again', () => {
    let broken = true;
    const Workspace = () => {
        if (broken) throw new Error('workspace failed');
        return createElement('p', null, 'workspace');
    };
    const { container, caught, open, reset, unmount } = mountDesks({ workspace: Workspace });
    try {
        open('workspace', {}); // no resetKey, like the top-level boundary
        assert.equal(container.textContent, 'failed: workspace failed');
        broken = false;
        reset();
        assert.equal(container.textContent, 'workspace');
        assert.equal(caught.length, 1);
    } finally {
        unmount();
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { stripInlineHandlers } from '../src/utils/inertHtml.js';
import { parseFinvizScreener } from '../src/utils/finviz.js';

test('inline event handlers are removed in every quoting style and nothing else changes', () => {
    const html = '<a onclick="track(\'x\')" href="/quote?t=AAPL" onmouseover=\'hover()\' data-on="keep" ONLOAD=go()>AAPL</a><td>Lyondell on=1</td>';
    assert.equal(stripInlineHandlers(html), '<a href="/quote?t=AAPL" data-on="keep">AAPL</a><td>Lyondell on=1</td>');
});

test('non-strings pass through untouched', () => {
    assert.equal(stripInlineHandlers(null), null);
    assert.equal(stripInlineHandlers(undefined), undefined);
});

test('a screener page full of handlers still parses to the same rows', () => {
    const grid = readFileSync(new URL('./fixtures/finviz-overview-grid-2026-10-21.html', import.meta.url), 'utf8');
    const noisy = grid.replace(/<div aria-colindex/g, '<div onclick="row()" onmouseenter=\'hi()\' aria-colindex');
    assert.ok(noisy.includes('onclick='));
    assert.ok(!stripInlineHandlers(noisy).includes('onclick='));
    const options = { DOMParser, fetchedAt: '2026-10-21T09:00:00.000Z' };
    assert.deepEqual(parseFinvizScreener(noisy, options), parseFinvizScreener(grid, options));
});

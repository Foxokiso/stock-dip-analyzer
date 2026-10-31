import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { stripInlineHandlers } from '../src/utils/inertHtml.js';
import { parseFinvizScreener } from '../src/utils/finviz.js';

// The pattern before the linear-time fix: the reference for what must be removed.
const PREVIOUS_INLINE_HANDLER = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

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

test('long whitespace runs are stripped in linear time', () => {
    for (const run of [' '.repeat(100_000), '\n    '.repeat(20_000), '\t \r\n'.repeat(25_000)]) {
        const html = `<td>${run}x</td><a${run}onclick="go()"${run}href="/quote?t=AAPL">AAPL</a>${run}`;
        const started = performance.now();
        const stripped = stripInlineHandlers(html);
        const elapsed = performance.now() - started;
        assert.equal(stripped, `<td>${run}x</td><a${run}href="/quote?t=AAPL">AAPL</a>${run}`);
        // About a millisecond when linear; the quadratic pattern needed many seconds per run.
        assert.ok(elapsed < 500, `stripping took ${elapsed.toFixed(1)} ms`);
    }
});

test('the linear pattern removes exactly what the previous pattern removed', () => {
    const page = readFileSync(new URL('./fixtures/finviz-overview-2026.html', import.meta.url), 'utf8');
    const expected = page.replace(PREVIOUS_INLINE_HANDLER, '');
    assert.ok(expected.length < page.length);
    assert.equal(stripInlineHandlers(page), expected);
    // Seeded xorshift, so a failure names a reproducible input.
    let state = 27;
    const pick = (items) => {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        return items[(state >>> 0) % items.length];
    };
    const pieces = [' ', '  ', '\t', '\n', 'on', 'ON', ' on', 'click', 'load=', '=', '"', "'", '>', '<a', 'x', '1'];
    for (let sample = 0; sample < 5000; sample++) {
        let html = '';
        for (let length = 0; length < 30; length++) html += pick(pieces);
        assert.equal(stripInlineHandlers(html), html.replace(PREVIOUS_INLINE_HANDLER, ''), JSON.stringify(html));
    }
});

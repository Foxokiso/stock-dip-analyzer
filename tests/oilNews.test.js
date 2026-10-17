import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { parseOilNews } from '../src/utils/oilNews.js';

const item = (title, link = 'https://example.com/report') => `<item><title>${title} - Example Wire</title><link>${link}</link><pubDate>Fri, 09 Oct 2026 15:30:00 GMT</pubDate><source>Example Wire</source></item>`;
const feed = (items) => `<rss><channel>${items}</channel></rss>`;

test('RSS exposes publication date and source independently of retrieval time', () => {
    const [headline] = parseOilNews(feed(item('Oil tanker traffic resumes')), { DOMParser });
    assert.equal(headline.title, 'Oil tanker traffic resumes');
    assert.equal(headline.source, 'Example Wire');
    assert.equal(headline.publishedAt, '2026-10-09T15:30:00.000Z');
    assert.equal(headline.link, 'https://example.com/report');
});

test('de-escalation terms and deal language do not invent a conflict flag', () => {
    const headlines = parseOilNews(feed(item('Ceasefire talks continue') + item('Oil firm strikes a deal', 'https://example.com/deal') + item('Refinery warns of higher costs', 'https://example.com/costs')), { DOMParser });
    assert.deepEqual(headlines.map(headline => headline.highImpact), [false, false, false]);
});

test('conflict keyword matches are flagged and missing dates remain null', () => {
    const [headline] = parseOilNews(feed('<item><title>Drone attack disrupts refinery output</title><link>https://example.com/attack</link></item>'), { DOMParser });
    assert.equal(headline.highImpact, true);
    assert.equal(headline.publishedAt, null);
});

test('unsafe headline URLs are excluded and duplicate links appear once', () => {
    const headlines = parseOilNews(feed(item('Unsafe', 'javascript:alert(1)') + item('One') + item('Duplicate')), { DOMParser });
    assert.equal(headlines.length, 1);
    assert.equal(headlines[0].title, 'One');
});

test('non-RSS responses fail explicitly while a valid empty RSS feed is empty', () => {
    assert.throws(() => parseOilNews('<html><title>Access denied</title></html>', { DOMParser }), /unavailable|invalid/i);
    assert.deepEqual(parseOilNews(feed(''), { DOMParser }), []);
});

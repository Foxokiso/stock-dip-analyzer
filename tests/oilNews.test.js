import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { parseOilNews } from '../src/utils/oilNews.js';

const item = (title, link = 'https://example.com/report') => `<item><title>${title} - Example Wire</title><link>${link}</link><pubDate>Fri, 09 Oct 2026 15:30:00 GMT</pubDate><source>Example Wire</source></item>`;
const feed = (items) => `<rss><channel>${items}</channel></rss>`;
// An item published `minutesAgo` before 2026-10-31 03:00 UTC (null: no pubDate), linked by index.
const dated = (title, minutesAgo, index) => `<item><title>${title} - Example Wire</title><link>https://example.com/${index}</link>${
    minutesAgo === null ? '' : `<pubDate>${new Date(Date.UTC(2026, 9, 31, 3) - minutesAgo * 60_000).toUTCString()}</pubDate>`}<source>Example Wire</source></item>`;
const indexOf = (headline) => Number(headline.link.split('/').pop());

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

test('shows the 15 newest headlines newest first, whatever order the feed ranks them in', () => {
    // Google News search feeds are ranked by relevance: the newest item can sit far down the feed.
    const ages = [600, 30, 1200, 5, 90, 45, 400, 15, 720, 60, 240, 120, 180, 1000, 300, 900, 360, 4];
    const headlines = parseOilNews(feed(ages.map((age, index) => dated(`Report ${index}`, age, index)).join('')), { DOMParser });
    assert.deepEqual(headlines.map(indexOf), [17, 3, 7, 1, 5, 9, 4, 11, 12, 10, 14, 16, 6, 0, 8]);
    assert.equal(headlines[0].publishedAt, '2026-10-31T02:56:00.000Z');
});

test('undated items come after dated ones, and equal times keep feed order', () => {
    const headlines = parseOilNews(feed([
        dated('No date', null, 0), dated('Older', 60, 1), dated('Same time A', 10, 2),
        dated('No date either', null, 3), dated('Same time B', 10, 4), dated('Newest', 1, 5),
    ].join('')), { DOMParser });
    assert.deepEqual(headlines.map(indexOf), [5, 2, 4, 1, 0, 3]);
});

test('high-impact matches lead, and each group stays newest first', () => {
    const headlines = parseOilNews(feed([
        dated('Refinery output steady', 50, 0), dated('Tanker struck near Hormuz', 40, 1), dated('OPEC meets', 5, 2),
        dated('Drone attack on terminal', 20, 3), dated('Brent edges up', 30, 4),
    ].join('')), { DOMParser });
    assert.deepEqual(headlines.map(indexOf), [3, 1, 2, 4, 0]);
    assert.deepEqual(headlines.map(headline => headline.highImpact), [true, true, false, false, false]);
});

test('the <source> element names the publisher, and only its exact suffix leaves the title', () => {
    const publisher = 'ABC News - Breaking News, Latest News and Videos';
    const headlines = parseOilNews(feed([
        `<item><title>Oil rises 2% - ${publisher}</title><link>https://example.com/1</link><source url="https://abcnews.go.com">${publisher}</source></item>`,
        '<item><title>Brent - WTI spread widens</title><link>https://example.com/2</link><source>Reuters</source></item>',
        '<item><title>Crude slips - OilPrice.com</title><link>https://example.com/3</link><source>Crude Oil Prices Today | OilPrice.com</source></item>',
    ].join('')), { DOMParser });
    assert.deepEqual(headlines.map(({ title, source }) => [title, source]), [
        ['Oil rises 2%', publisher],
        ['Brent - WTI spread widens', 'Reuters'],
        ['Crude slips - OilPrice.com', 'Crude Oil Prices Today | OilPrice.com'],
    ]);
});

test('without a usable <source>, the text after the last " - " is taken as the publisher', () => {
    const [headline] = parseOilNews(feed('<item><title>Brent - WTI spread widens - Wire</title><link>https://example.com/1</link><source> </source></item>'), { DOMParser });
    assert.equal(headline.title, 'Brent - WTI spread widens');
    assert.equal(headline.source, 'Wire');
});

// Chromium's XML DOM names a prefixed element as the DOM standard says: <media:title> has the
// localName "title" and the prefix "media". linkedom keeps "media:title" as its localName, so
// this parser relabels prefixed elements the browser's way.
class BrowserNamesDOMParser extends DOMParser {
    parseFromString(markup, type) {
        const doc = super.parseFromString(markup, type);
        for (const element of doc.querySelectorAll('*')) {
            const [prefix, localName] = element.localName.split(':');
            if (localName) Object.defineProperties(element, { prefix: { value: prefix }, localName: { value: localName } });
        }
        return doc;
    }
}

test("fields come from the item's own unprefixed children, never namespaced or nested ones", () => {
    const xml = '<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item>'
        + '<media:group><title>Photo caption</title><link>https://example.com/photo</link></media:group>'
        + '<media:title>Media title</media:title>'
        + '<title>Real headline - Wire</title><link>https://example.com/real</link><source>Wire</source>'
        + '<pubDate>Fri, 30 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>';
    for (const Parser of [DOMParser, BrowserNamesDOMParser]) {
        const [headline] = parseOilNews(xml, { DOMParser: Parser });
        assert.equal(headline.title, 'Real headline');
        assert.equal(headline.link, 'https://example.com/real');
        assert.equal(headline.source, 'Wire');
        assert.equal(headline.publishedAt, '2026-10-30T12:00:00.000Z');
    }
});

test('non-RSS responses fail explicitly while a valid empty RSS feed is empty', () => {
    assert.throws(() => parseOilNews('<html><title>Access denied</title></html>', { DOMParser }), /unavailable|invalid/i);
    assert.deepEqual(parseOilNews(feed(''), { DOMParser }), []);
});

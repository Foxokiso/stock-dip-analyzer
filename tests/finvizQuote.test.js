import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { finvizQuoteUrl, parseFinvizQuotePage } from '../src/utils/finvizQuote.js';

const options = { DOMParser };
// Live https://finviz.com/stock?t=AAPL&p=d, 2026-10-31: snapshot tables and the first 31 headlines.
const quotePage = readFileSync(new URL('./fixtures/finviz-quote-AAPL-2026-10-31.html', import.meta.url), 'utf8');
const newsTable = (rows) => `<table id="news-table">${rows}</table>`;
const newsRow = (stamp, href, title, publisher) => `<tr><td>${stamp}</td><td><div class="news-link-left"><a href="${href}">${title}</a></div>${publisher === undefined ? '' : `<div class="news-link-right"><span>(${publisher})</span></div>`}</td></tr>`;

test('live quote page reads every Key Statistics label from its own cell', () => {
    const { stats } = parseFinvizQuotePage(quotePage, options);
    assert.equal(stats.size, 83);
    const shown = ['Market Cap', 'P/E', 'Forward P/E', 'EPS (ttm)', 'Dividend TTM', 'Beta', 'RSI (14)', 'Volume', 'Avg Volume',
        'Rel Volume', '52W High', '52W Low', 'Target Price', 'Short Float', 'Perf Week', 'Perf Month'];
    assert.deepEqual(shown.map(label => stats.get(label)), ['5029.59B', '39.51', '36.07', '8.72', '1.06 (0.31%)', '1.08', '55.35',
        '67,841,735', '43.36M', '1.56', '351.73 -2.02%', '243.42 41.58%', '334.65', '0.90%', '-0.89%', '4.33%']);
    assert.equal(stats.get('Price'), '344.63');
    // Finviz's empty cell (an Elite-only field) is unavailable, not an empty string.
    assert.equal(stats.get('Trades'), null);
    assert.equal(stats.has('52W Range'), false, 'the old combined label no longer exists');
});

test('52-week bounds come from the 52W High and 52W Low fields', () => {
    const page = parseFinvizQuotePage(quotePage, options);
    assert.equal(page.fiftyTwoWeekHigh, 351.73);
    assert.equal(page.fiftyTwoWeekLow, 243.42);
});

test('each headline keeps the publisher Finviz names beside it, not the link host', () => {
    const { news } = parseFinvizQuotePage(quotePage, options);
    assert.equal(news.length, 31);
    assert.deepEqual(news[1], {
        time: 'Oct-30-26 05:47PM',
        title: 'Apple overtakes Nvidia to become worlds most valuable company amid tech selloff',
        link: 'https://finance.yahoo.com/markets/stocks/articles/apple-overtakes-nvidia-become-world-214753575.html',
        source: 'Investing.com',
    });
    assert.deepEqual(news.slice(0, 10).map(item => item.source), ['Barrons.com', 'Investing.com', 'Bloomberg', 'CNBC TV', 'Barrons.com',
        "Investor's Business Daily", 'Proactive', 'MarketWatch', "Investor's Business Daily", 'Quartz']);
    // A story hosted on Finviz resolves to an absolute link and still names its publisher.
    assert.deepEqual(news[16], {
        time: 'Oct-29-26 01:08PM',
        title: 'The Week Ahead: More Inflation Data to Kick Off November',
        link: 'https://finviz.com/news/411852/the-week-ahead-more-inflation-data-to-kick-off-november',
        source: "Schaeffer's Research",
    });
});

test('time-only headline rows take the date printed on the first headline of that day', () => {
    const { news } = parseFinvizQuotePage(quotePage, options);
    assert.deepEqual(news.slice(14, 18).map(item => item.time), ['Oct-30-26 05:27AM', 'Oct-30-26 01:36AM', 'Oct-29-26 01:08PM', 'Oct-29-26 12:32PM']);
    assert.equal(news[22].time, 'Oct-28-26 08:13PM');
    assert.equal(news[30].time, 'Oct-28-26 01:47PM');
});

test('missing or blank statistics stay unavailable instead of becoming zero', () => {
    const changed = quotePage
        .replace('351.73 <small class="text-2xs"><span class="color-text is-negative">-2.02%</span></small>', '-')
        .replace('>52W Low<', '>52W Lo<')
        .replace('<b>39.51</b>', '<b>-</b>');
    const page = parseFinvizQuotePage(changed, options);
    assert.equal(page.stats.get('52W High'), null);
    assert.equal(page.fiftyTwoWeekHigh, null);
    assert.equal(page.stats.has('52W Low'), false);
    assert.equal(page.fiftyTwoWeekLow, null);
    assert.equal(page.stats.get('P/E'), null);
    assert.equal(page.stats.get('Forward P/E'), '36.07');

    const sparse = parseFinvizQuotePage('<table class="snapshot-table2"><tr><td>52W High</td><td>0.00 -100.00%</td><td>52W Low</td><td>12.40%</td></tr></table>', options);
    assert.equal(sparse.fiftyTwoWeekHigh, null, 'a zero bound is not a price');
    assert.equal(sparse.fiftyTwoWeekLow, null, 'a bare percentage is not a price');
    assert.deepEqual(sparse.news, []);
});

test('snapshot cells pair within their own row, so a malformed row cannot shift later values', () => {
    const { stats } = parseFinvizQuotePage('<table class="snapshot-table2"><tr><td>Beta</td></tr><tr><td>P/E</td><td>12.5</td><td>EPS (ttm)</td><td>1.10</td></tr></table>', options);
    assert.deepEqual([...stats], [['P/E', '12.5'], ['EPS (ttm)', '1.10']]);
});

test('unsafe and link-less headline rows are skipped, but a date they carry still applies', () => {
    const { news } = parseFinvizQuotePage(newsTable([
        newsRow('Oct-29-26 09:00AM', 'javascript:alert(1)', 'Unsafe', 'Zacks'),
        '<tr><td>08:30AM</td><td id="IC_D_3x8_1"><span>Loading…</span></td></tr>',
        newsRow('08:00AM', '/news/1/example', 'Hosted on Finviz', 'InvestorsHub'),
        newsRow('07:00AM', 'https://finance.yahoo.com/example', 'No publisher named'),
        '<tr><td>06:00AM</td><td>extra</td><td><a href="https://example.com/">Three cells</a></td></tr>',
    ].join('')), options);
    assert.deepEqual(news, [
        { time: 'Oct-29-26 08:00AM', title: 'Hosted on Finviz', link: 'https://finviz.com/news/1/example', source: 'InvestorsHub' },
        // An unnamed publisher stays unknown; the syndicating host is not a publisher.
        { time: 'Oct-29-26 07:00AM', title: 'No publisher named', link: 'https://finance.yahoo.com/example', source: null },
    ]);
});

test('a challenge page with neither table is an explicit unavailable error', () => {
    assert.throws(() => parseFinvizQuotePage('<html><title>Just a moment...</title></html>', options), /unavailable|schema/i);
});

test('inline event handlers are removed before the markup is parsed', () => {
    const received = [];
    class RecordingParser {
        parseFromString(html, type) {
            received.push(html);
            return new DOMParser().parseFromString(html, type);
        }
    }
    const noisy = quotePage.replaceAll('<tr class="cursor-pointer has-label">', '<tr class="cursor-pointer has-label" onclick="trackAndOpenNews(event)">');
    assert.ok(noisy.includes('onclick='));
    const page = parseFinvizQuotePage(noisy, { DOMParser: RecordingParser });
    assert.equal(received.length, 1);
    assert.ok(!received[0].includes('onclick='));
    assert.deepEqual(page, parseFinvizQuotePage(quotePage, options));
});

test('the quote page is requested at its canonical /stock URL, with the symbol encoded', () => {
    assert.equal(finvizQuoteUrl('AAPL'), 'https://finviz.com/stock?t=AAPL&p=d');
    assert.equal(finvizQuoteUrl('BRK-B'), 'https://finviz.com/stock?t=BRK-B&p=d');
    const url = new URL(finvizQuoteUrl('A&B=C'));
    assert.equal(url.searchParams.get('t'), 'A&B=C');
    assert.equal(url.searchParams.get('p'), 'd');
});

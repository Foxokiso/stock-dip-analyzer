import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { parseFinvizScreener, parseFinvizScreenerPage, resolveFinvizNewsUrl } from '../src/utils/finviz.js';

const overview = (rows) => `<table><tr><th>No.</th><th>Ticker</th><th>Company</th><th>Sector</th><th>Industry</th><th>Country</th><th>Market Cap</th><th>P/E</th><th>Price</th><th>Change</th><th>Volume</th></tr>${rows}</table>`;
const row = (symbol, price = '123.45', change = '-2.31%') => `<tr><td>1</td><td><a href="quote.ashx?t=${symbol}">${symbol}</a></td><td>Example Corp</td><td>Technology</td><td>Software</td><td>USA</td><td>1.5B</td><td>20.5</td><td>${price}</td><td>${change}</td><td>1,234,567</td></tr>`;
const options = { DOMParser, fetchedAt: '2026-10-10T12:00:00.000Z' };
const currentGrid = readFileSync(new URL('./fixtures/finviz-overview-grid-2026-10-17.html', import.meta.url), 'utf8');
const idGrid = readFileSync(new URL('./fixtures/finviz-overview-grid-2026-10-21.html', import.meta.url), 'utf8');
const quoteFields = ({ symbol, name, sector, price, change, volume, marketCap }) => ({ symbol, name, sector, price, change, volume, marketCap });
const idGridRows = [
    { symbol: 'NDLS', name: 'Noodles & Company', sector: 'Consumer Cyclical', price: 5.57, change: -59.72, volume: 1, marketCap: 33240000 },
    { symbol: 'TKNO', name: 'Alpha Teknova Inc', sector: 'Healthcare', price: 5.16, change: -30.18, volume: 31497, marketCap: 277030000 },
];
// Inserts an unknown "Exchange" column at grid column `at`, shifting the later columns.
const withExtraGridColumn = (html, at) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const row of doc.querySelectorAll('[role="row"]')) {
        const cells = [...row.querySelectorAll('[aria-colindex]')];
        const next = cells.find(cell => cell.getAttribute('aria-colindex') === String(at));
        const neighbour = next ?? cells.at(-1);
        for (const cell of cells) {
            const index = Number(cell.getAttribute('aria-colindex'));
            if (index >= at) cell.setAttribute('aria-colindex', String(index + 1));
        }
        const extra = neighbour.cloneNode(false);
        extra.setAttribute('aria-colindex', String(at));
        extra.setAttribute('data-column-id', 'exchange');
        extra.removeAttribute('aria-label');
        extra.textContent = extra.getAttribute('role') === 'columnheader' ? 'Exchange' : 'NASD';
        neighbour.parentNode.insertBefore(extra, next ?? neighbour.nextSibling);
    }
    return doc.toString();
};

test('overview accepts direct ticker rows and ignores wrapping layout tables', () => {
    const html = `<table><tr><td>${overview(row('AAPL'))}</td><td><a href="quote.ashx?t=1">1</a></td></tr></table>`;
    const stocks = parseFinvizScreener(html, options);
    assert.equal(stocks.length, 1);
    assert.equal(stocks[0].symbol, 'AAPL');
    assert.equal(stocks[0].price, 123.45);
    assert.equal(stocks[0].change, -2.31);
    assert.equal(stocks[0].volume, 1234567);
    assert.equal(stocks[0].marketCap, 1500000000);
    assert.equal(stocks[0].changePercentage, -2.31);
    assert.equal(stocks[0].delayMinutes, 1);
    assert.equal(stocks[0].quotedAt, null);
    assert.equal(stocks[0].fetchedAt, '2026-10-10T12:00:00.000Z');
});

test('missing and malformed numeric values stay unavailable rather than zero', () => {
    // NVDA keeps each column readable, so the malformed cells are judged one at a time.
    const stocks = parseFinvizScreener(overview(row('AAPL', '-', 'Infinity%') + row('MSFT', '12oops', '0.00%') + row('NVDA')), options);
    assert.equal(stocks[0].price, null);
    assert.equal(stocks[0].change, null);
    assert.equal(stocks[1].price, null);
    assert.equal(stocks[1].change, 0);
    assert.equal(stocks[2].price, 123.45);
    // A price of 0.00 is not a price.
    assert.equal(parseFinvizScreener(overview(row('AAPL', '0.00')), options)[0].price, null);
});

test('typographic minus signs and no-break or thin spaces inside numbers are read', () => {
    const cases = [
        ['\u22125.23%', -5.23], ['\u20135.23%', -5.23], ['-5.23\u00a0%', -5.23], ['+1.25%', 1.25],
    ];
    for (const [text, expected] of cases) {
        assert.equal(parseFinvizScreener(overview(row('AAPL', '10', text)), options)[0].change, expected, JSON.stringify(text));
    }
    const html = overview(row('AAPL').replace('1.5B', '1.5\u2009B').replace('1,234,567', '68\u00a0105\u202f173'));
    const [stock] = parseFinvizScreener(html, options);
    assert.equal(stock.marketCap, 1500000000);
    assert.equal(stock.volume, 68105173);
    assert.equal(parseFinvizScreener(overview(row('AAPL').replace('1.5B', '1.2T')), options)[0].marketCap, 1.2e12);
});

test('a parenthesised number is never read as negative', () => {
    const stocks = parseFinvizScreener(overview(row('AAPL', '10', '(5.23%)') + row('MSFT')), options);
    assert.equal(stocks[0].change, null);
    assert.equal(stocks[1].change, -2.31);
});

test('a required numeric column with no readable value fails as a schema change', () => {
    assert.throws(() => parseFinvizScreener(overview(row('AAPL', '10', '(5.23%)') + row('MSFT', '11', '\u22125.23 pct')), options),
        /Finviz screener schema changed: change unparseable/);
    assert.throws(() => parseFinvizScreener(overview(row('AAPL', '$12.50') + row('MSFT', '$9.10')), options),
        /Finviz screener schema changed: price unparseable/);
    // Cells holding no value at all are unavailable, not a schema change.
    const empty = parseFinvizScreener(overview(row('AAPL', '-') + row('MSFT', '\u2014')), options);
    assert.deepEqual(empty.map(stock => stock.price), [null, null]);
    // Optional columns never fail the page.
    assert.equal(parseFinvizScreener(overview(row('AAPL').replace('1.5B', '1.5 bn')), options)[0].marketCap, null);
});

test('ETF views guard their ranking metrics the same way', () => {
    const performance = (month, year) => `<table><tr><th>No.</th><th>Ticker</th><th>Perf Month</th><th>Perf Year</th><th>Price</th><th>Change</th></tr><tr><td>1</td><td><a href="quote.ashx?t=SPY">SPY</a></td><td>${month}</td><td>${year}</td><td>600</td><td>-0.25%</td></tr></table>`;
    assert.equal(parseFinvizScreener(performance('4.2%', '-'), { ...options, view: '141' })[0].perfYear, null);
    assert.throws(() => parseFinvizScreener(performance('4.2%', 'n/a'), { ...options, view: '141' }), /perfYear unparseable/);
    const dividend = (value) => `<table><tr><th>No.</th><th>Ticker</th><th>Dividend</th><th>Price</th><th>Change</th></tr><tr><td>1</td><td><a href="quote.ashx?t=SCHD">SCHD</a></td><td>${value}</td><td>25</td><td>0.5%</td></tr></table>`;
    assert.equal(parseFinvizScreener(dividend('-'), { ...options, view: '161' })[0].dividendYield, null);
    assert.throws(() => parseFinvizScreener(dividend('3,8 %'), { ...options, view: '161' }), /dividendYield unparseable/);
});

test('rejects numeric tickers and quote-link text mismatch', () => {
    const html = overview(row('1') + row('AAPL').replace('t=AAPL', 't=MSFT') + row('BRK-B'));
    assert.deepEqual(parseFinvizScreener(html, options).map(stock => stock.symbol), ['BRK-B']);
});

test('actual saved Finviz overview does not emit a layout row as symbol 1', () => {
    const html = readFileSync(new URL('./fixtures/finviz-overview-2026.html', import.meta.url), 'utf8');
    const stocks = parseFinvizScreener(html, options);
    assert.deepEqual(stocks.map(stock => stock.symbol), [
        'TSM', 'WMT', 'XOM', 'JNJ', 'ABBV', 'CVX', 'GE', 'NVS', 'TM', 'HSBC', 'RTX', 'GEV', 'MCD', 'SHEL', 'VZ', 'BHP', 'AMGN', 'SCCO', 'TJX', 'TTE',
    ]);
    assert.deepEqual(quoteFields(stocks[0]), { symbol: 'TSM', name: 'Taiwan Semiconductor Manufacturing ADR', sector: 'Technology', price: 371.45, change: -0.83, volume: 7620688, marketCap: 1926550000000 });
    assert.deepEqual(quoteFields(stocks[19]), { symbol: 'TTE', name: 'TotalEnergies SE', sector: 'Energy', price: 80.44, change: 0.12, volume: 1297253, marketCap: 170910000000 });
    assert.ok(stocks.every(stock => stock.price > 0 && Number.isFinite(stock.change) && stock.fetchedAt === options.fetchedAt));
});

test('the 2026-10-31 screener/stocks grid, page 2, keeps every field of its rows', () => {
    const html = readFileSync(new URL('./fixtures/finviz-overview-grid-2026-10-31-r21.html', import.meta.url), 'utf8');
    assert.deepEqual(parseFinvizScreener(html, options).map(quoteFields), [
        { symbol: 'ENHA', name: 'Enhanced Group Inc', sector: 'Consumer Defensive', price: 9.43, change: -26.96, volume: 97888, marketCap: 373100000 },
        { symbol: 'LVWR', name: 'LiveWire Group Inc', sector: 'Consumer Cyclical', price: 0.66, change: -26.67, volume: 660103, marketCap: 135570000 },
        { symbol: 'RUBI', name: 'Rubico Inc', sector: 'Industrials', price: 2.03, change: -26.52, volume: 159248, marketCap: 1020000 },
    ]);
});

test('the current ETF performance and dividend grids read their ranking metrics by column id', () => {
    const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
    const performance = parseFinvizScreener(fixture('finviz-etf-grid-141-2026-10-31.html'), { ...options, view: '141' });
    assert.deepEqual(performance.map(({ symbol, price, change, volume, perfMonth, perfYear }) => ({ symbol, price, change, volume, perfMonth, perfYear })), [
        { symbol: 'IREZ', price: 22.77, change: 17.25, volume: 1057855, perfMonth: 130.23, perfYear: null },
        { symbol: 'QBTZ', price: 35.11, change: 16.37, volume: 125870, perfMonth: 109.36, perfYear: -79.01 },
    ]);
    const dividend = parseFinvizScreener(fixture('finviz-etf-grid-161-2026-10-31.html'), { ...options, view: '161' });
    assert.deepEqual(dividend.map(({ symbol, name, price, change, volume, dividendYield }) => ({ symbol, name, price, change, volume, dividendYield })), [
        { symbol: 'SMUP', name: 'T-REX 2X Long SMR Daily Target ETF', price: 1.52, change: -10.29, volume: 147610, dividendYield: 345.51 },
        { symbol: 'MAAY', name: 'GraniteShares YieldBOOST MARA ETF', price: 3.85, change: -3.03, volume: 96725, dividendYield: 299.84 },
    ]);
    // The performance grid labels "Perf Month" in aria-label; its id still binds it when that text changes.
    const relabelled = fixture('finviz-etf-grid-141-2026-10-31.html').replace('aria-label="Perf Month"', 'aria-label="1M Perf"');
    assert.equal(parseFinvizScreener(relabelled, { ...options, view: '141' })[0].perfMonth, 130.23);
});

test('challenge HTML is an explicit unavailable error', () => {
    assert.throws(() => parseFinvizScreener('<html><title>Just a moment...</title></html>', options), /unavailable|schema|blocked/i);
});

test('a changed data-row link schema fails explicitly instead of clearing a prior scan', () => {
    const html = overview(row('AAPL').replace('quote.ashx?t=', 'unknown-page?t='));
    assert.throws(() => parseFinvizScreener(html, options), /unavailable|schema/i);
});

test('current live Change percent header is recognized without shifting fields', () => {
    const html = overview(row('AAPL')).replace('<th>Change</th>', '<th>Change %</th>');
    const [stock] = parseFinvizScreener(html, options);
    assert.equal(stock.changePercentage, -2.31);
    assert.equal(stock.price, 123.45);
});

test('current stock URL and decorative logo link do not replace the actual ticker', () => {
    const html = overview(row('AAPL')).replace('<a href="quote.ashx?t=AAPL">AAPL</a>', '<a class="company-ticker" href="stock?t=AAPL"><span>A</span></a><a class="tab-link" href="stock?t=AAPL">AAPL</a>');
    const [stock] = parseFinvizScreener(html, options);
    assert.equal(stock.symbol, 'AAPL');
    assert.equal(stock.change, -2.31);
});

test('performance view reads month and year metrics from their own columns', () => {
    const html = '<table><tr><th>No.</th><th>Ticker</th><th>Perf Week</th><th>Perf Month</th><th>Perf Year</th><th>Price</th><th>Change</th><th>Volume</th></tr><tr><td>1</td><td><a href="quote.ashx?t=SPY">SPY</a></td><td>0.5%</td><td>4.2%</td><td>12.1%</td><td>600</td><td>-0.25%</td><td>50M</td></tr></table>';
    const [stock] = parseFinvizScreener(html, { ...options, view: '141' });
    assert.equal(stock.perfMonth, 4.2);
    assert.equal(stock.perfYear, 12.1);
    assert.equal(stock.change, -0.25);
    assert.equal(stock.volume, 50000000);
});

test('financial view reads dividend yield rather than day change', () => {
    const html = '<table><tr><th>No.</th><th>Ticker</th><th>Dividend</th><th>ROA</th><th>Price</th><th>Change</th><th>Volume</th></tr><tr><td>1</td><td><a href="quote.ashx?t=SCHD">SCHD</a></td><td>3.8%</td><td>-</td><td>25</td><td>0.5%</td><td>10M</td></tr></table>';
    const [stock] = parseFinvizScreener(html, { ...options, view: '161' });
    assert.equal(stock.dividendYield, 3.8);
    assert.equal(stock.change, 0.5);
});

test('live Finviz ARIA grid preserves quote fields and ignores logo initials in ticker links', () => {
    const stocks = parseFinvizScreener(currentGrid, options);
    assert.deepEqual(stocks.map(({ symbol, name, sector, price, change, volume, marketCap }) =>
        ({ symbol, name, sector, price, change, volume, marketCap })), [
        { symbol: 'MDXH', name: 'MDxHealth SA', sector: 'Healthcare', price: 0.21, change: -65.77, volume: 17311280, marketCap: 19710000 },
        { symbol: 'GUTS', name: 'Fractyl Health Inc', sector: 'Healthcare', price: 1.55, change: -62.74, volume: 15098473, marketCap: 20560000 },
    ]);
    assert.ok(stocks.every(stock => stock.quotedAt === null && stock.fetchedAt === options.fetchedAt));
});

test('2026-10-21 grid with short header labels, sort indicators and data-ticker cells still parses', () => {
    const stocks = parseFinvizScreener(idGrid, options);
    assert.deepEqual(stocks.map(quoteFields), idGridRows);
    // Without its column id, a header whose full name only exists in aria-label
    // must not be read from its visible text.
    const unidentified = idGrid.replace(' data-column-id="change"', '').replace('aria-label="Change %"', 'aria-label="Something else"');
    assert.throws(() => parseFinvizScreener(unidentified, options), /unavailable|schema/i);
});

test('grid columns are bound by their data-column-id, so a relabelled aria-label changes nothing', () => {
    for (const label of ['Change %, sorted ascending', 'Something else']) {
        const html = idGrid.replace('aria-label="Change %"', `aria-label="${label}"`);
        assert.deepEqual(parseFinvizScreener(html, options).map(quoteFields), idGridRows);
    }
    // A header without an id still binds by its own accessible name.
    assert.deepEqual(parseFinvizScreener(idGrid.replace(' data-column-id="sector"', ''), options).map(quoteFields), idGridRows);
});

test('an extra column is tolerated wherever it appears', () => {
    for (const at of [3, 7, 12]) {
        assert.deepEqual(parseFinvizScreener(withExtraGridColumn(idGrid, at), options).map(quoteFields), idGridRows, `extra grid column at ${at}`);
    }
    const legacy = overview(row('AAPL')).replace('<th>Sector</th>', '<th>Sector</th><th>Exchange</th>').replace('<td>Technology</td>', '<td>Technology</td><td>NASD</td>');
    const [stock] = parseFinvizScreener(legacy, options);
    assert.deepEqual(quoteFields(stock), { symbol: 'AAPL', name: 'Example Corp', sector: 'Technology', price: 123.45, change: -2.31, volume: 1234567, marketCap: 1500000000 });
});

test('a required column that neither its id nor its name identifies, or that two columns claim, fails', () => {
    const unnamed = idGrid.replace('data-column-id="sector" data-sortable', 'data-column-id="segment" data-sortable')
        .replace('<span class="fv-table_header-label">Sector</span>', '<span class="fv-table_header-label">Segment</span>');
    assert.throws(() => parseFinvizScreener(unnamed, options), /unavailable|schema/i);
    const doubled = idGrid.replace('data-column-id="PE"', 'data-column-id="price"');
    assert.throws(() => parseFinvizScreener(doubled, options), /unavailable|schema/i);
    const legacy = overview(row('AAPL')).replace('<th>Sector</th>', '<th>Segment</th>');
    assert.throws(() => parseFinvizScreener(legacy, options), /unavailable|schema/i);
});

test('a column whose id names a field wins over another that only shares its name', () => {
    // A new column with an unknown id, labelled "Price" beside the column whose id is price.
    const namesake = idGrid.replace('data-column-id="PE"', 'data-column-id="priceTarget"')
        .replace('<span class="fv-table_header-label">P/E</span>', '<span class="fv-table_header-label">Price</span>');
    assert.deepEqual(parseFinvizScreener(namesake, options).map(quoteFields), idGridRows);
    // Without ids, two columns of the same name stay ambiguous.
    const legacy = overview(row('AAPL')).replace('<th>P/E</th>', '<th>Price</th>');
    assert.throws(() => parseFinvizScreener(legacy, options), /unavailable|schema/i);
});

test('data-ticker names the row only when the cell links to the same finviz.com quote', () => {
    const relinked = idGrid.replace('<span>NDLS</span>', '<span>Noodles</span>');
    assert.deepEqual(parseFinvizScreener(relinked, options).map(stock => stock.symbol), ['NDLS', 'TKNO']);
    const mismatched = idGrid.replace('data-ticker="NDLS"', 'data-ticker="MSFT"');
    assert.deepEqual(parseFinvizScreener(mismatched, options).map(stock => stock.symbol), ['TKNO']);
});

test('a page reports its numbered rows, its first row number and the result count it states', () => {
    const meta = (html) => {
        const { rows, ...page } = parseFinvizScreenerPage(html, options);
        return { rows: rows.length, ...page };
    };
    assert.deepEqual(meta(readFileSync(new URL('./fixtures/finviz-overview-2026.html', import.meta.url), 'utf8')), { rows: 20, dataRows: 20, firstRowNumber: 1, total: 899 });
    assert.deepEqual(meta(idGrid), { rows: 2, dataRows: 2, firstRowNumber: 1, total: 5609 });
    assert.deepEqual(meta(readFileSync(new URL('./fixtures/finviz-overview-grid-2026-10-31-r21.html', import.meta.url), 'utf8')), { rows: 3, dataRows: 3, firstRowNumber: 21, total: 5620 });
    assert.deepEqual(meta(currentGrid), { rows: 2, dataRows: 2, firstRowNumber: 1, total: null });
    // A row the parser skips still counts as a row of the page.
    assert.deepEqual(meta(overview(row('AAPL') + row('MSFT').replace('quote.ashx', 'unknown-page'))), { rows: 1, dataRows: 2, firstRowNumber: 1, total: null });
    // A stated count below a row number on the page is not trusted.
    assert.equal(meta(idGrid.replace('aria-rowcount="5610"', 'aria-rowcount="2"')).total, null);
    // The array API that the desks use is unchanged.
    assert.deepEqual(parseFinvizScreener(idGrid, options), parseFinvizScreenerPage(idGrid, options).rows);
});

test('grid column indices preserve values when visual lane and cell order changes', () => {
    const doc = new DOMParser().parseFromString(currentGrid, 'text/html');
    for (const lane of doc.querySelectorAll('[data-lane]')) {
        [...lane.children].reverse().forEach(cell => lane.appendChild(cell));
    }
    for (const row of doc.querySelectorAll('[role="row"]')) {
        [...row.children].reverse().forEach(lane => row.appendChild(lane));
    }
    assert.deepEqual(parseFinvizScreener(doc.toString(), options), parseFinvizScreener(currentGrid, options));
});

test('grid missing or duplicated column indices fail instead of shifting quote values', () => {
    for (const replacement of ['', 'aria-colindex="8"']) {
        const html = currentGrid.replaceAll('aria-colindex="9"', replacement);
        assert.throws(() => parseFinvizScreener(html, options), /unavailable|schema/i);
    }
});

test('grid ticker links must match their visible ticker and Finviz host', () => {
    for (const href of ['/quote?t=WRONG', 'https://example.com/quote?t=MDXH']) {
        const doc = new DOMParser().parseFromString(currentGrid, 'text/html');
        for (const row of [...doc.querySelectorAll('[role="row"]')].slice(1)) {
            row.querySelector('[role="gridcell"][aria-colindex="2"] a').setAttribute('href', href);
        }
        assert.throws(() => parseFinvizScreener(doc.toString(), options), /unavailable|schema/i);
    }
});

test('Finviz news resolves relative links against the source, preserving external publishers', () => {
    assert.equal(resolveFinvizNewsUrl('/news/403721/taiwan-semiconductor-posts-record-q3-results-time-to-buy-the-dip'),
        'https://finviz.com/news/403721/taiwan-semiconductor-posts-record-q3-results-time-to-buy-the-dip');
    assert.equal(resolveFinvizNewsUrl('https://finance.yahoo.com/example'), 'https://finance.yahoo.com/example');
    assert.equal(resolveFinvizNewsUrl('//finance.yahoo.com/example'), 'https://finance.yahoo.com/example');
    for (const href of [null, '', ' ', 'javascript:alert(1)', 'data:text/html,test', 'file:///C:/example', 'http://[']) {
        assert.equal(resolveFinvizNewsUrl(href), null);
    }
});

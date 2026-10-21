import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { parseFinvizScreener } from '../src/utils/finviz.js';

const overview = (rows) => `<table><tr><th>No.</th><th>Ticker</th><th>Company</th><th>Sector</th><th>Industry</th><th>Country</th><th>Market Cap</th><th>P/E</th><th>Price</th><th>Change</th><th>Volume</th></tr>${rows}</table>`;
const row = (symbol, price = '123.45', change = '-2.31%') => `<tr><td>1</td><td><a href="quote.ashx?t=${symbol}">${symbol}</a></td><td>Example Corp</td><td>Technology</td><td>Software</td><td>USA</td><td>1.5B</td><td>20.5</td><td>${price}</td><td>${change}</td><td>1,234,567</td></tr>`;
const options = { DOMParser, fetchedAt: '2026-10-10T12:00:00.000Z' };

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
    const stocks = parseFinvizScreener(overview(row('AAPL', '-', 'Infinity%') + row('MSFT', '12oops', '0.00%')), options);
    assert.equal(stocks[0].price, null);
    assert.equal(stocks[0].change, null);
    assert.equal(stocks[1].price, null);
    assert.equal(stocks[1].change, 0);
});

test('rejects numeric tickers and quote-link text mismatch', () => {
    const html = overview(row('1') + row('AAPL').replace('t=AAPL', 't=MSFT') + row('BRK-B'));
    assert.deepEqual(parseFinvizScreener(html, options).map(stock => stock.symbol), ['BRK-B']);
});

test('actual saved Finviz overview does not emit a layout row as symbol 1', () => {
    const html = readFileSync(new URL('../finviz_output.html', import.meta.url), 'utf8');
    const stocks = parseFinvizScreener(html, options);
    assert.ok(stocks.length > 0);
    assert.ok(stocks.every(stock => /^[A-Z][A-Z0-9.-]*$/.test(stock.symbol)));
    assert.ok(stocks.every(stock => stock.symbol !== '1'));
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';

globalThis.DOMParser = DOMParser;
const { startScan, getScan, scanKey, subscribeScans, resetScans, scanAge, PAGE_SIZE, HYDRATE_CONCURRENCY } = await import('../src/state/scanStore.js');

// ─── Fixture builders: legacy table markup, which the shared parser accepts ──
const header = '<tr><th>No.</th><th>Ticker</th><th>Company</th><th>Sector</th><th>Industry</th><th>Country</th><th>Market Cap</th><th>P/E</th><th>Price</th><th>Change</th><th>Volume</th></tr>';
const row = (n, symbol, change, sector = 'Technology') => `<tr><td>${n}</td><td><a href="quote.ashx?t=${symbol}">${symbol}</a></td><td>${symbol} Corp</td><td>${sector}</td><td>Software</td><td>USA</td><td>1.5B</td><td>20</td><td>10.5</td><td>${change}%</td><td>1,000</td></tr>`;
const table = (rows) => `<table>${header}${rows.join('')}</table>`;
const symbolAt = (page, i, tag = 'A') => `${tag}${page}X${i}`;
const losersPage = (page, { count = PAGE_SIZE, tag = 'A', sector } = {}) =>
    table(Array.from({ length: count }, (_, i) => row(page * PAGE_SIZE + i + 1, symbolAt(page, i, tag), (-(9 - page) - i * 0.1).toFixed(2), sector)));
const yahoo = (price = 12) => {
    const closes = Array.from({ length: 22 }, (_, i) => 10 + Math.sin(i));
    return { chart: { result: [{
        meta: { regularMarketPrice: price, regularMarketTime: 1760000000, previousClose: 11, exchangeDataDelayedBy: 0,
            fiftyTwoWeekLow: 5, fiftyTwoWeekHigh: 20, exchangeTimezoneName: 'America/New_York' },
        timestamp: closes.map((_, i) => 1758000000 + i * 86400),
        indicators: { quote: [{ close: closes }] },
    }] } };
};
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const pageOf = (url) => (Number(new URL(url).searchParams.get('r')) - 1) / PAGE_SIZE;

// A fake desktop bridge: `pages(page)` returns HTML (or throws), `chartDelay` paces Yahoo.
const bridge = ({ pages, chartDelay = 0, pageDelay = () => 0, yahooFor = () => yahoo() } = {}) => {
    const calls = { pages: [], charts: [] };
    let inFlightCharts = 0, peakCharts = 0;
    const invoke = async (channel, ...args) => {
        if (channel === 'fetch-url') {
            const page = pageOf(args[0]);
            calls.pages.push(page);
            await wait(pageDelay(page));
            return pages(page);
        }
        if (channel === 'fetch-yahoo-chart') {
            calls.charts.push(args[0]);
            inFlightCharts++; peakCharts = Math.max(peakCharts, inFlightCharts);
            await wait(chartDelay);
            inFlightCharts--;
            return yahooFor(args[0]);
        }
        throw new Error(`unexpected channel ${channel}`);
    };
    return { invoke, calls, peak: () => peakCharts };
};
const params = (targetCount = 40, extra = {}) => ({ sector: '', excludedSectors: [], targetCount, ...extra });

test.beforeEach(() => resetScans());

test('rows stream in page order before any score, then every row is scored', async () => {
    const snapshots = [];
    const key = scanKey(params(40));
    const stop = subscribeScans(() => snapshots.push(getScan(key)));
    const { invoke, calls, peak } = bridge({ pages: (page) => (page < 2 ? losersPage(page) : table([])), chartDelay: 5 });

    const scan = await startScan(params(40), { invoke });
    stop();

    assert.equal(scan.loading, false);
    assert.equal(scan.error, '');
    assert.ok(scan.completedAt, 'a complete scan records when it finished');
    assert.equal(scan.stocks.length, 40);
    assert.equal(scan.stocks[0].symbol, symbolAt(0, 0));
    assert.equal(scan.stocks[20].symbol, symbolAt(1, 0));
    assert.ok(scan.stocks.every(stock => stock.analysis && Number.isFinite(stock.recoveryProbability)), 'every row carries a score');
    assert.ok(scan.stocks.every(stock => stock.fiftyTwoWeekLow === 5 && stock.fiftyTwoWeekHigh === 20), '52-week range comes from the chart metadata');
    assert.ok(scan.stocks.every(stock => stock.stale === undefined), 'fresh rows are never marked stale');

    const firstRows = snapshots.find(snapshot => snapshot.stocks.length > 0);
    assert.ok(firstRows.stocks.every(stock => stock.analysis === null), 'rows are shown before their scores arrive');
    assert.ok(snapshots.some(snapshot => snapshot.phase === 'quotes'));
    assert.ok(snapshots.some(snapshot => snapshot.phase === 'analysis'));
    assert.ok(peak() > 1 && peak() <= HYDRATE_CONCURRENCY, `scoring ran ${peak()} wide`);
    assert.equal(new Set(calls.charts).size, 40, 'each symbol is scored exactly once');
});

test('a slow early page never lets a later page publish ahead of it', async () => {
    const key = scanKey(params(40));
    const seen = [];
    const stop = subscribeScans(() => { const scan = getScan(key); if (scan.stocks.length) seen.push(scan.stocks.map(stock => stock.symbol)); });
    const { invoke } = bridge({ pages: (page) => (page < 2 ? losersPage(page) : table([])), pageDelay: (page) => (page === 0 ? 40 : 0) });
    await startScan(params(40), { invoke });
    stop();
    assert.equal(seen[0][0], symbolAt(0, 0), 'the first published row is from page 1');
    assert.ok(seen.every(symbols => symbols.every((symbol, i) => i === 0 || !(symbol.startsWith('A0') && symbols[i - 1].startsWith('A1')))), 'page 2 rows always follow page 1 rows');
});

test('a short page of gainers ends the scan with what exists', async () => {
    const pages = (page) => (page === 0 ? losersPage(0, { count: 12 }) : table([row(13, 'UP1', '2.50')]));
    const { invoke } = bridge({ pages });
    const scan = await startScan(params(100), { invoke });
    assert.deepEqual(scan.stocks.map(stock => stock.symbol), Array.from({ length: 12 }, (_, i) => symbolAt(0, i)));
    assert.ok(scan.completedAt);
});

test('excluded and mismatched sectors are left out while the target count is still reached', async () => {
    const pages = (page) => (page < 3 ? losersPage(page, { sector: page === 1 ? 'Energy' : 'Technology' }) : table([]));
    const { invoke } = bridge({ pages });
    const scan = await startScan(params(30, { excludedSectors: ['energy'] }), { invoke });
    assert.equal(scan.stocks.length, 30);
    assert.ok(scan.stocks.every(stock => !stock.symbol.startsWith('A1')), 'the energy page was skipped');
});

test('a newer run for the same scope supersedes the older one', async () => {
    let tag = 'A';
    const { invoke } = bridge({ pages: (page) => (page < 1 ? losersPage(page, { tag }) : table([])), chartDelay: 30 });
    const first = startScan(params(20), { invoke });
    await wait(5);
    tag = 'B';
    const second = startScan(params(20), { invoke });
    const [, scan] = await Promise.all([first, second]);
    assert.equal(scan.loading, false);
    assert.ok(scan.stocks.every(stock => stock.symbol.startsWith('B')), 'only the newer run is visible');
    assert.ok(scan.stocks.every(stock => stock.analysis), 'the newer run finished scoring');
    assert.deepEqual(getScan(scanKey(params(20))), scan);
});

test('a failing screener keeps the previous rows, marks them stale and forgets the completion time', async () => {
    const good = bridge({ pages: (page) => (page < 1 ? losersPage(page) : table([])) });
    const before = await startScan(params(20), { invoke: good.invoke });
    assert.ok(before.completedAt);
    const bad = bridge({ pages: () => { throw new Error('HTTP error! status: 403'); } });
    const scan = await startScan(params(20), { invoke: bad.invoke });
    assert.match(scan.error, /403/);
    assert.equal(scan.completedAt, null);
    assert.equal(scan.stocks.length, 20);
    assert.ok(scan.stocks.every(stock => stock.stale === true));
    assert.equal(scanAge(scan), Infinity, 'a failed scan is never reused');
});

test('a page failure after rows arrived keeps those rows fresh and reports the stop', async () => {
    const pages = (page) => { if (page === 0) return losersPage(0); throw new Error('HTTP error! status: 500'); };
    const { invoke } = bridge({ pages });
    const scan = await startScan(params(60), { invoke });
    assert.equal(scan.stocks.length, 20);
    assert.ok(scan.stocks.every(stock => stock.stale === undefined && stock.analysis));
    assert.match(scan.error, /stopped after 20 names/);
    assert.equal(scan.completedAt, null);
});

test('scanAge measures from completion and the desktop bridge is required', async () => {
    const { invoke } = bridge({ pages: (page) => (page < 1 ? losersPage(page) : table([])) });
    const scan = await startScan(params(20), { invoke, now: () => '2026-10-21T09:00:00.000Z' });
    assert.equal(scanAge(scan, Date.parse('2026-10-21T09:00:30.000Z')), 30000);
    const offline = await startScan(params(20, { sector: 'technology' }), { invoke: null });
    assert.match(offline.error, /desktop app connection/);
    assert.deepEqual(offline.stocks, []);
});

test('a symbol whose chart fails is shown as unavailable without blocking the others', async () => {
    const { invoke } = bridge({ pages: (page) => (page < 1 ? losersPage(page) : table([])), yahooFor: (symbol) => { if (symbol === symbolAt(0, 3)) throw new Error('HTTP error! status: 401'); return yahoo(); } });
    const scan = await startScan(params(20), { invoke });
    const failed = scan.stocks.find(stock => stock.symbol === symbolAt(0, 3));
    assert.equal(failed.analysis, null);
    assert.equal(failed.analysisUnavailable, true);
    assert.equal(failed.recoveryProbability, null);
    assert.equal(scan.stocks.filter(stock => stock.analysis).length, 19);
    assert.ok(scan.completedAt);
});

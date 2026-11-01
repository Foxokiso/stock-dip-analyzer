import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';

globalThis.DOMParser = DOMParser;
const {
    startScan, getScan, scanKey, subscribeScans, watchScan, focusScan, resetScans, scanAge, dispatchAlertsFromAnalysis,
    PAGE_SIZE, PAGE_CONCURRENCY, HYDRATE_CONCURRENCY, CHART_FAILURE_CUTOFF, PHOTONICS_TICKERS,
} = await import('../src/state/scanStore.js');
const { clearChartCache } = await import('../src/utils/chartCache.js');

// ─── Fixture builders: legacy table markup, which the shared parser accepts ──
const header = '<tr><th>No.</th><th>Ticker</th><th>Company</th><th>Sector</th><th>Industry</th><th>Country</th><th>Market Cap</th><th>P/E</th><th>Price</th><th>Change</th><th>Volume</th></tr>';
const row = (n, symbol, change, sector = 'Technology') => `<tr><td>${n}</td><td><a href="quote.ashx?t=${symbol}">${symbol}</a></td><td>${symbol} Corp</td><td>${sector}</td><td>Software</td><td>USA</td><td>1.5B</td><td>20</td><td>10.5</td><td>${change}%</td><td>1,000</td></tr>`;
// `total` adds the page's "#1 / N Total" result count.
const table = (rows, total = null) => `${total === null ? '' : `<div>#1 / ${total} Total</div>`}<table>${header}${rows.join('')}</table>`;
const symbolAt = (page, i, tag = 'A') => `${tag}${page}X${i}`;
const losersPage = (page, { count = PAGE_SIZE, tag = 'A', sector, total = null } = {}) =>
    table(Array.from({ length: count }, (_, i) => row(page * PAGE_SIZE + i + 1, symbolAt(page, i, tag), (-(9 - page) - i * 0.1).toFixed(2), sector)), total);
// A page of losers at any depth (losersPage turns to gainers past page 9).
const fullPage = (page) => table(Array.from({ length: PAGE_SIZE }, (_, i) => row(page * PAGE_SIZE + i + 1, symbolAt(page, i), '-5.00')));
// Screener position of a symbolAt() name.
const indexOf = (symbol) => { const [, page, i] = /^[A-Z](\d+)X(\d+)$/.exec(symbol); return Number(page) * PAGE_SIZE + Number(i); };
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
// Waits until `condition` holds, a millisecond at a time and for at most a second.
const until = async (condition) => { for (let i = 0; i < 1000 && !condition(); i++) await wait(1); assert.ok(condition()); };
const pageOf = (url) => (Number(new URL(url).searchParams.get('r')) - 1) / PAGE_SIZE;

// A fake desktop bridge: `pages(page, url)` returns HTML (or throws), `pageDelay(page, url)`
// and `chartDelay` pace Finviz and Yahoo.
const bridge = ({ pages, chartDelay = 0, pageDelay = () => 0, yahooFor = () => yahoo() } = {}) => {
    const calls = { pages: [], urls: [], charts: [] };
    let inFlightCharts = 0, peakCharts = 0, inFlightPages = 0, peakPages = 0;
    const invoke = async (channel, ...args) => {
        if (channel === 'fetch-url') {
            const page = pageOf(args[0]);
            calls.pages.push(page);
            calls.urls.push(args[0]);
            inFlightPages++; peakPages = Math.max(peakPages, inFlightPages);
            await wait(pageDelay(page, args[0]));
            inFlightPages--;
            return pages(page, args[0]);
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
    return { invoke, calls, peak: () => peakCharts, peakPages: () => peakPages };
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
    assert.ok(scan.stocks.every(stock => !('avgVolume' in stock)), 'no provider in the scan supplies an average volume');

    const firstRows = snapshots.find(snapshot => snapshot.stocks.length > 0);
    assert.ok(firstRows.stocks.every(stock => stock.analysis === null), 'rows are shown before their scores arrive');
    assert.ok(snapshots.every(snapshot => snapshot.retained === 0), 'a first scan has nothing to retain');
    // Every field of the scan state is one the Overview reads.
    assert.deepEqual([...new Set(snapshots.flatMap(Object.keys))].sort(), ['completedAt', 'error', 'loading', 'retained', 'stocks']);
    assert.ok(peak() > 1 && peak() <= HYDRATE_CONCURRENCY, `scoring ran ${peak()} wide`);
    assert.equal(calls.charts.length, 40, 'one chart request per row');
    assert.deepEqual([...calls.charts].sort(), scan.stocks.map(stock => stock.symbol).sort(), 'each symbol is scored exactly once');
    assert.deepEqual([...calls.pages].sort((a, b) => a - b), [0, 1], 'two pages for 40 names');
});

test('screener pages are requested at their canonical URL, offset and sector filter included', async () => {
    const { invoke, calls } = bridge({ pages: (page) => (page < 2 ? losersPage(page) : table([])) });
    await startScan(params(40), { invoke });
    await startScan(params(20, { sector: 'technology' }), { invoke });
    assert.deepEqual(calls.urls, [
        'https://finviz.com/screener/stocks?v=111&o=change&r=1',
        'https://finviz.com/screener/stocks?v=111&o=change&r=21',
        'https://finviz.com/screener/stocks?v=111&o=change&r=1&f=sec_technology',
    ]);
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
    const { invoke, calls } = bridge({ pages });
    const scan = await startScan(params(100), { invoke });
    assert.deepEqual(scan.stocks.map(stock => stock.symbol), Array.from({ length: 12 }, (_, i) => symbolAt(0, i)));
    assert.ok(scan.completedAt);
    assert.equal(calls.charts.length, 12);
});

test('a name that is flat on the day is not a dip', async () => {
    const pages = () => table([row(1, 'DOWN1', '-1.00'), row(2, 'DOWN2', '-0.50'), row(3, 'FLAT', '0.00'), row(4, 'UP', '0.25')]);
    const { invoke, calls } = bridge({ pages });
    const scan = await startScan(params(20), { invoke });
    assert.deepEqual(scan.stocks.map(stock => stock.symbol), ['DOWN1', 'DOWN2']);
    assert.deepEqual(calls.charts, ['DOWN1', 'DOWN2']);
});

test('excluded and mismatched sectors are left out while the target count is still reached', async () => {
    const pages = (page) => (page < 3 ? losersPage(page, { sector: page === 1 ? 'Energy' : 'Technology' }) : table([]));
    const { invoke, calls } = bridge({ pages });
    const scan = await startScan(params(30, { excludedSectors: ['energy'] }), { invoke });
    assert.equal(scan.stocks.length, 30);
    assert.ok(scan.stocks.every(stock => !stock.symbol.startsWith('A1')), 'the energy page was skipped');
    assert.deepEqual([...calls.pages].sort((a, b) => a - b), [0, 1, 2]);
    assert.equal(calls.charts.length, 30, 'excluded names are never scored');
});

test('a sector picked on the Overview is scanned in full even when Settings excludes it', async () => {
    const pages = (page) => (page < 2 ? losersPage(page, { sector: 'Energy' }) : table([]));
    const { invoke, calls } = bridge({ pages });
    const scan = await startScan(params(30, { sector: 'energy', excludedSectors: ['energy', 'utilities'] }), { invoke });
    assert.equal(scan.stocks.length, 30);
    assert.ok(scan.stocks.every(stock => stock.sector === 'Energy'));
    assert.ok(calls.urls.every(url => new URL(url).searchParams.get('f') === 'sec_energy'));
    // Exclusions stay out of a picked sector's scope, so changing them keeps its scan reusable.
    assert.equal(scanKey(params(30, { sector: 'energy', excludedSectors: ['energy'] })), scanKey(params(30, { sector: 'energy' })));
    assert.deepEqual(getScan(scanKey(params(30, { sector: 'energy' }))), scan);
    assert.notEqual(scanKey(params(30, { excludedSectors: ['energy'] })), scanKey(params(30)), 'broad scans still key on them');
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

test('a refresh keeps every previous row, score and time on screen until that row is rescored', async () => {
    let version = 1;
    const pages = (page) => (page < 2 ? losersPage(page).replaceAll('<td>10.5</td>', version === 1 ? '<td>10.5</td>' : '<td>11.5</td>') : table([]));
    // The refresh's second page lands after the first page's scores have been published.
    const pageDelay = (page) => (version === 2 && page === 1 ? 250 : 0);
    const { invoke } = bridge({ pages, pageDelay, chartDelay: 5, yahooFor: () => yahoo(version === 1 ? 12 : 13) });
    const first = await startScan(params(40), { invoke });
    assert.equal(first.stocks.filter(stock => stock.analysis).length, 40);

    version = 2;
    const key = scanKey(params(40));
    const snapshots = [];
    const stop = subscribeScans(() => snapshots.push(getScan(key)));
    const second = await startScan(params(40), { invoke });
    stop();
    const during = snapshots.filter(scan => scan.loading);
    for (const scan of during) {
        assert.equal(scan.stocks.length, 40);
        assert.equal(scan.stocks.filter(stock => stock.analysis).length, 40, 'no row loses its score while the refresh runs');
        const kept = scan.stocks.filter(stock => first.stocks.includes(stock));
        // A row is the previous one, untouched, or a fresh quote with its fresh score.
        assert.ok(scan.stocks.every(stock => first.stocks.includes(stock) || (stock.price === 11.5 && stock.analysis.currentPrice === 13)));
        assert.equal(scan.retained, kept.length);
    }
    assert.ok(during.some(scan => scan.retained === 20), 'the refreshed first page replaced its rows while the second page was still on its way');
    assert.ok(second.stocks.every(stock => stock.price === 11.5 && stock.analysis.currentPrice === 13 && !first.stocks.includes(stock)));
    assert.equal(second.retained, 0);
});

test('rows the refresh no longer lists leave once it has published past them, or at the end', async () => {
    let tag = 'A';
    const pages = (page) => (page === 0 ? losersPage(0, { tag }) : page === 1 && tag === 'A' ? losersPage(1) : table([]));
    const { invoke } = bridge({ pages, chartDelay: 5 });
    const first = await startScan(params(40), { invoke });
    tag = 'B';
    const key = scanKey(params(40));
    const seen = [];
    const stop = subscribeScans(() => seen.push(getScan(key).stocks.map(stock => stock.symbol)));
    const second = await startScan(params(40), { invoke });
    stop();
    const fresh = Array.from({ length: 20 }, (_, i) => symbolAt(0, i, 'B'));
    const oldSecondPage = first.stocks.slice(20).map(stock => stock.symbol);
    assert.deepEqual(seen.find(symbols => symbols.includes(fresh[0])), [...fresh, ...oldSecondPage], 'the old first page went, the old second page stayed');
    assert.deepEqual(second.stocks.map(stock => stock.symbol), fresh, 'the end of the run drops what it did not list');
    assert.equal(second.error, '');
});

test('a refresh that stops early shows only the rows it retrieved', async () => {
    let failing = false;
    const pages = (page) => {
        if (failing && page === 1) throw new Error('HTTP error! status: 500');
        return page < 2 ? losersPage(page) : table([]);
    };
    const { invoke } = bridge({ pages });
    const first = await startScan(params(40), { invoke });
    failing = true;
    const scan = await startScan(params(40), { invoke });
    assert.equal(scan.error, 'Scan stopped after 20 names. HTTP error! status: 500. The rows shown were retrieved in this scan.');
    assert.deepEqual(scan.stocks.map(stock => stock.symbol), first.stocks.slice(0, 20).map(stock => stock.symbol));
    assert.ok(scan.stocks.every(stock => !first.stocks.includes(stock) && stock.analysis));
});

test('scopes scanned at the same time share 4 page and 8 chart slots, and the newest is served first', async () => {
    const sectorOf = (url) => new URL(url).searchParams.get('f')?.replace('sec_', '') ?? '';
    const names = { '': 'Technology', technology: 'Technology', energy: 'Energy' };
    const pages = (page, url) => (page < 5 ? losersPage(page, { sector: names[sectorOf(url)] }) : table([]));
    const { invoke, calls, peak, peakPages } = bridge({ pages, pageDelay: () => 5, chartDelay: 5 });
    const scans = await Promise.all([
        startScan(params(100), { invoke }),
        startScan(params(100, { sector: 'technology' }), { invoke }),
        startScan(params(100, { sector: 'energy' }), { invoke }),
    ]);
    assert.deepEqual(scans.map(scan => scan.stocks.length), [100, 100, 100]);
    assert.ok(scans.every(scan => scan.completedAt && scan.stocks.every(stock => stock.analysis)));
    assert.ok(peakPages() <= PAGE_CONCURRENCY, `${peakPages()} screener pages in flight`);
    assert.ok(peak() <= HYDRATE_CONCURRENCY, `${peak()} Yahoo charts in flight`);
    assert.equal(calls.charts.length, 300, 'each scope scores each of its rows once');
    // The first scope takes every page slot; as they free up, the scope started
    // last goes ahead of the one started second.
    assert.deepEqual(calls.urls.slice(0, 8).map(sectorOf), ['', '', '', '', 'energy', 'energy', 'energy', 'energy']);
});

test('a scope put back on screen while it loads goes ahead of a newer scope left behind', async () => {
    const tagOf = (url) => (url.includes('sec_energy') ? 'E' : 'A');
    const pages = (page, url) => (page > 0 ? table([]) : losersPage(0, { tag: tagOf(url), sector: tagOf(url) === 'E' ? 'Energy' : 'Technology' }));
    const lastChart = async ({ backOnScreen }) => {
        resetScans();
        // The energy rows arrive while the first scope's charts hold every slot.
        const { invoke, calls } = bridge({ pages, pageDelay: (page, url) => (tagOf(url) === 'E' ? 10 : 0), chartDelay: 20 });
        const first = startScan(params(20), { invoke });
        const energy = startScan(params(20, { sector: 'energy' }), { invoke });
        // What the Overview does when it returns to the first scope and adopts its run.
        const stop = backOnScreen ? watchScan(scanKey(params(20)), () => {}) : () => {};
        const scans = await Promise.all([first, energy]);
        stop();
        assert.ok(scans.every(scan => scan.completedAt && scan.stocks.length === 20 && scan.stocks.every(stock => stock.analysis)));
        return Object.fromEntries(['A', 'E'].map(tag => [tag, calls.charts.findLastIndex(symbol => symbol.startsWith(tag))]));
    };
    const left = await lastChart({ backOnScreen: false });
    assert.ok(left.E < left.A, 'left alone, the scope started last is served first');
    const shown = await lastChart({ backOnScreen: true });
    assert.ok(shown.A < shown.E, 'the scope on screen again is served first');
});

test('focusScan serves an older run the Overview adopts ahead of a newer run it left', async () => {
    const tagOf = (url) => (url.includes('sec_energy') ? 'E' : 'A');
    const pages = (page, url) => (page > 0 ? table([]) : losersPage(0, { tag: tagOf(url), sector: tagOf(url) === 'E' ? 'Energy' : 'Technology' }));
    const older = scanKey(params(20));
    const newer = scanKey(params(20, { sector: 'energy' }));
    const lastChart = async ({ adopt }) => {
        resetScans();
        // The newer scope's rows arrive while the older scope's charts hold every slot.
        const { invoke, calls } = bridge({ pages, pageDelay: (page, url) => (tagOf(url) === 'E' ? 10 : 0), chartDelay: 20 });
        // The Overview returns to the older scope as the newer scope's rows arrive.
        let adopted = false;
        const stop = subscribeScans(() => {
            if (adopt && !adopted && getScan(newer).stocks.length > 0) { adopted = true; focusScan(older); }
        });
        const scans = await Promise.all([startScan(params(20), { invoke }), startScan(params(20, { sector: 'energy' }), { invoke })]);
        stop();
        assert.equal(adopted, adopt);
        assert.ok(scans.every(scan => scan.completedAt && scan.stocks.length === 20 && scan.stocks.every(stock => stock.analysis)));
        return Object.fromEntries(['A', 'E'].map(tag => [tag, calls.charts.findLastIndex(symbol => symbol.startsWith(tag))]));
    };
    const left = await lastChart({ adopt: false });
    assert.ok(left.E < left.A, 'left alone, the newer run is served first');
    const focused = await lastChart({ adopt: true });
    assert.ok(focused.A < focused.E, 'the older run, focused again as the newer run\'s rows arrive, is served first');
});

test('focusScan reorders requests already waiting for a chart slot', async (t) => {
    const tagOf = (url) => (url.includes('sec_energy') ? 'B' : url.includes('sec_technology') ? 'N' : 'O');
    const pages = (page, url) => (page > 0 ? table([]) : losersPage(0, { tag: tagOf(url), sector: tagOf(url) === 'B' ? 'Energy' : 'Technology' }));
    const older = scanKey(params(20)), newer = scanKey(params(20, { sector: 'technology' }));
    const servedFirst = async ({ focus }) => {
        resetScans();
        // A third scope holds every chart slot until the gate opens (at the latest when the test ends).
        let open;
        const gate = new Promise(resolve => { open = resolve; });
        t.after(open);
        const { invoke, calls } = bridge({ pages, yahooFor: (symbol) => (symbol.startsWith('B') ? gate.then(() => yahoo()) : yahoo()) });
        const runs = [startScan(params(20, { sector: 'energy' }), { invoke }), startScan(params(20), { invoke }), startScan(params(20, { sector: 'technology' }), { invoke })];
        await wait(5);
        // Both runs have their rows, and their scoring waits for a slot.
        assert.ok([older, newer].every(key => getScan(key).stocks.length === 20));
        assert.equal(calls.charts.map(symbol => symbol[0]).join(''), 'B'.repeat(HYDRATE_CONCURRENCY));
        if (focus) focusScan(older);
        open();
        const scans = await Promise.all(runs);
        assert.ok(scans.every(scan => scan.completedAt && scan.stocks.length === 20 && scan.stocks.every(stock => stock.analysis)));
        // Each slot the busy scope frees goes to the run ranked highest at that moment.
        return calls.charts.slice(HYDRATE_CONCURRENCY, 2 * HYDRATE_CONCURRENCY).map(symbol => symbol[0]).join('');
    };
    assert.equal(await servedFirst({ focus: false }), 'N'.repeat(HYDRATE_CONCURRENCY), 'left alone, the run started last is served first');
    assert.equal(await servedFirst({ focus: true }), 'O'.repeat(HYDRATE_CONCURRENCY), 'the older run, focused while its requests wait, is served first');
});

test('a superseded run never sends the requests it still had waiting for a slot', async (t) => {
    let tag = 'T';
    const pages = (page, url) => (page > 0 ? table([]) : url.includes('sec_energy') ? losersPage(0, { tag: 'S', sector: 'Energy' }) : losersPage(0, { tag }));
    // The busy scope holds every chart slot until the gate opens (at the latest when the test ends).
    let open;
    const gate = new Promise(resolve => { open = resolve; });
    t.after(open);
    const { invoke, calls } = bridge({ pages, yahooFor: (symbol) => (symbol.startsWith('S') ? gate.then(() => yahoo()) : yahoo()) });
    const key = scanKey(params(20));
    const listed = (prefix) => getScan(key).stocks.length === 20 && getScan(key).stocks.every(stock => stock.symbol.startsWith(prefix));
    const busy = startScan(params(20, { sector: 'energy' }), { invoke });
    await until(() => calls.charts.length === HYDRATE_CONCURRENCY);
    const superseded = startScan(params(20), { invoke }); // its rows' charts queue behind
    await until(() => listed('T'));
    tag = 'U';
    const latest = startScan(params(20), { invoke });
    await until(() => listed('U'));
    open();
    const [, , scan] = await Promise.all([busy, superseded, latest]);
    assert.ok(scan.stocks.every(stock => stock.symbol.startsWith('U') && stock.analysis));
    assert.equal(calls.charts.filter(symbol => symbol.startsWith('T')).length, 0);
    assert.equal(calls.charts.length, 40);
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
    const { invoke, calls } = bridge({ pages });
    const scan = await startScan(params(60), { invoke });
    assert.deepEqual([...calls.pages].sort((a, b) => a - b), [0, 1, 2], 'no page is requested after a failure');
    assert.equal(calls.charts.length, 20);
    assert.equal(scan.stocks.length, 20);
    assert.ok(scan.stocks.every(stock => stock.stale === undefined && stock.analysis));
    assert.match(scan.error, /stopped after 20 names/);
    assert.equal(scan.completedAt, null);
});

test('a page whose change column no longer parses stops the scan with a schema error', async () => {
    const unreadable = table(Array.from({ length: PAGE_SIZE }, (_, i) => row(i + 1, symbolAt(0, i), 'n/a')));
    const { invoke, calls } = bridge({ pages: (page) => (page === 0 ? unreadable : losersPage(page)) });
    const scan = await startScan(params(20), { invoke });
    assert.match(scan.error, /Finviz screener schema changed: change unparseable/);
    assert.deepEqual(scan.stocks, []);
    assert.equal(scan.completedAt, null);
    assert.deepEqual(calls.pages, [0], 'the scan stops on its first page');
    assert.equal(calls.charts.length, 0, 'nothing is scored');
});

test('a row the parser skips does not end the scan early', async () => {
    const pages = (page) => (page === 0 ? losersPage(0).replace('quote.ashx?t=A0X3', 'unknown-page?t=A0X3') : losersPage(page));
    const { invoke, calls } = bridge({ pages });
    const scan = await startScan(params(100), { invoke });
    assert.equal(scan.stocks.length, 100);
    assert.ok(!scan.stocks.some(stock => stock.symbol === symbolAt(0, 3)));
    assert.equal(scan.stocks.at(-1).symbol, symbolAt(5, 0), 'the 100th name comes from page 6');
    assert.equal(scan.error, '');
    assert.ok(scan.completedAt);
    assert.deepEqual([...calls.pages].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
});

test('a page offset Finviz ignored stops paging and is reported instead of repeating rows', async () => {
    const { invoke, calls } = bridge({ pages: () => losersPage(0) });
    const scan = await startScan(params(100), { invoke });
    assert.deepEqual(scan.stocks.map(stock => stock.symbol), Array.from({ length: 20 }, (_, i) => symbolAt(0, i)));
    assert.equal(scan.error, 'Scan stopped after 20 names. Finviz returned rows from No. 1 for the page starting at No. 21. The rows shown were retrieved in this scan.');
    assert.equal(scan.completedAt, null);
    // Page 1 plus at most PAGE_CONCURRENCY pages past it, never MAX_PAGES.
    assert.ok(calls.pages.length <= 1 + PAGE_CONCURRENCY, `${calls.pages.length} screener requests`);
});

test('the stated result count ends paging, and a failed page past it does not fail the scan', async () => {
    const pages = (page) => {
        if (page < 2) return losersPage(page, { count: page === 0 ? PAGE_SIZE : 10, total: 30 });
        throw new Error('HTTP error! status: 429');
    };
    const { invoke, calls } = bridge({ pages });
    const scan = await startScan(params(100), { invoke });
    assert.equal(scan.stocks.length, 30);
    assert.equal(scan.error, '');
    assert.ok(scan.completedAt, 'a complete scan stays reusable');
    assert.deepEqual([...calls.pages].sort((a, b) => a - b), [0, 1, 2, 3], 'nothing past the first look-ahead');
});

test('a slow first page does not send the other workers ahead', async () => {
    const pages = (page) => losersPage(page);
    const slow = bridge({ pages, pageDelay: (page) => (page === 0 ? 40 : 0) });
    await startScan(params(20), { invoke: slow.invoke });
    assert.deepEqual(slow.calls.pages, [0], 'one page is all a depth of 20 needs');
    const deeper = bridge({ pages, pageDelay: (page) => (page === 0 ? 40 : 0) });
    const scan = await startScan(params(100), { invoke: deeper.invoke });
    assert.equal(scan.stocks.length, 100);
    assert.deepEqual([...deeper.calls.pages].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

test('a slow first page holds a deep scan to PAGE_CONCURRENCY pages ahead of what it has published', async () => {
    // At depth 500 the target allows 25 pages, so only the concurrency bound holds the look-ahead.
    let requestedBeforeFirst = null;
    const { invoke, calls } = bridge({
        pages: (page) => { if (page === 0) requestedBeforeFirst = calls.pages.length; return fullPage(page); },
        pageDelay: (page) => (page === 0 ? 60 : 0),
    });
    const scan = await startScan(params(500), { invoke });
    assert.equal(scan.stocks.length, 500);
    assert.equal(requestedBeforeFirst, PAGE_CONCURRENCY, `${requestedBeforeFirst} pages requested while the first was in flight`);
    assert.equal(calls.pages.length, 25, 'each page once');
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
    assert.equal(scan.error, '', 'one failed chart is a row-level gap, not a scan error');
});

test('a scan whose every chart request failed says so and is not reused', async () => {
    // The first failure is quoted as one sentence, whether or not it ends with a full stop.
    for (const [yahooFor, reason] of [
        [() => { throw new Error('HTTP error! status: 429'); }, 'HTTP error! status: 429.'],
        [() => ({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }), 'No data found, symbol may be delisted.'],
        [() => ({ chart: { result: [] } }), `Yahoo Finance returned no chart for ${symbolAt(0, 0)}.`],
    ]) {
        resetScans();
        const { invoke, calls } = bridge({ pages: (page) => (page < 1 ? losersPage(page) : table([])), yahooFor });
        const scan = await startScan(params(20), { invoke });
        assert.equal(scan.error, `Yahoo Finance scoring failed for all 20 names: ${reason} Technical scores are unavailable.`);
        assert.equal(scan.completedAt, null);
        assert.equal(scanAge(scan), Infinity, 'the next visit rescans');
        assert.equal(scan.stocks.length, 20, 'the Finviz rows stay on screen');
        assert.ok(scan.stocks.every(stock => stock.analysisUnavailable && stock.stale === undefined));
        assert.equal(calls.charts.length, 20);
    }
});

test('too little history everywhere is not a provider failure', async () => {
    const thin = () => {
        const chart = yahoo();
        const result = chart.chart.result[0];
        result.timestamp = result.timestamp.slice(-10);
        result.indicators.quote[0].close = result.indicators.quote[0].close.slice(-10);
        return chart;
    };
    const { invoke } = bridge({ pages: (page) => (page < 1 ? losersPage(page) : table([])), yahooFor: thin });
    const scan = await startScan(params(20), { invoke });
    assert.equal(scan.error, '');
    assert.ok(scan.completedAt);
    assert.ok(scan.stocks.every(stock => stock.analysisUnavailable));
});

// ─── Yahoo failing name after name: scoring stops early ─────────────────────
// Each chart request settles in one timer turn, so they settle in screener order.
const timedOut = () => { throw new Error('Request timed out after 12 s'); };
const stoppedEarly = (reason, skipped) => `Yahoo Finance scoring failed for ${CHART_FAILURE_CUTOFF} names in a row: ${reason} Scoring stopped early, so technical scores are unavailable for ${skipped} more names.`;

test('a deep scan whose Yahoo requests keep failing stops scoring instead of waiting out every request', async () => {
    const { invoke, calls } = bridge({ pages: fullPage, yahooFor: timedOut });
    const scan = await startScan(params(500), { invoke });
    // The cutoff, plus the requests already in flight when it was reached; not 500 timeouts.
    const sent = CHART_FAILURE_CUTOFF + HYDRATE_CONCURRENCY - 1;
    assert.equal(calls.charts.length, sent);
    assert.equal(scan.stocks.length, 500, 'every Finviz row is still shown');
    assert.ok(scan.stocks.every(stock => stock.analysisUnavailable && stock.analysis === null && stock.recoveryProbability === null && stock.stale === undefined));
    assert.equal(scan.error, stoppedEarly('Request timed out after 12 s.', 500 - sent));
    assert.equal(scan.completedAt, null);
    assert.equal(scanAge(scan), Infinity, 'the next visit rescans');
    assert.equal(scan.loading, false);
});

test('a single Yahoo answer resets the count of failures in a row', async () => {
    // One name short of the cutoff, an answer, then failures to the end.
    const recovered = bridge({ pages: fullPage, yahooFor: (symbol) => (indexOf(symbol) === CHART_FAILURE_CUTOFF - 1 ? yahoo() : timedOut()) });
    const scan = await startScan(params(100), { invoke: recovered.invoke });
    // The count restarts after the answer: the stop comes with the cutoff-th failure after it.
    const sent = 2 * CHART_FAILURE_CUTOFF + HYDRATE_CONCURRENCY - 1;
    assert.equal(recovered.calls.charts.length, sent);
    assert.deepEqual(scan.stocks.flatMap((stock, index) => (stock.analysis ? [index] : [])), [CHART_FAILURE_CUTOFF - 1], 'the name Yahoo answered is scored');
    assert.equal(scan.error, stoppedEarly('Request timed out after 12 s.', 100 - sent));

    // Failures scattered between answers never stop scoring.
    resetScans();
    const scattered = bridge({ pages: fullPage, yahooFor: (symbol) => (indexOf(symbol) % 11 === 10 ? yahoo() : timedOut()) });
    const whole = await startScan(params(100), { invoke: scattered.invoke });
    assert.equal(scattered.calls.charts.length, 100);
    assert.equal(whole.stocks.filter(stock => stock.analysis).length, 9);
    assert.equal(whole.error, '', 'failed rows are row-level gaps, as before');
    assert.ok(whole.completedAt);
});

test('an outage after Yahoo has answered keeps the earlier scores and names the reason the failures began', async () => {
    const yahooFor = (symbol) => {
        const index = indexOf(symbol);
        if (index === 5) return { chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } };
        return index < 20 ? yahoo() : timedOut();
    };
    const { invoke, calls } = bridge({ pages: fullPage, yahooFor });
    const scan = await startScan(params(100), { invoke });
    const sent = 20 + CHART_FAILURE_CUTOFF + HYDRATE_CONCURRENCY - 1;
    assert.equal(calls.charts.length, sent);
    assert.equal(scan.error, stoppedEarly('Request timed out after 12 s.', 100 - sent), 'not the earlier, unrelated failure');
    assert.equal(scan.stocks.length, 100);
    assert.deepEqual(scan.stocks.flatMap((stock, index) => (stock.analysis ? [index] : [])), Array.from({ length: 20 }, (_, i) => i).filter(i => i !== 5));
    assert.equal(scan.completedAt, null);
});

test('cached charts neither end nor extend a run of Yahoo failures, and are still served once scoring stops', async (t) => {
    clearChartCache();
    t.after(clearChartCache);
    let now = Date.parse('2026-10-30T14:00:00Z');
    t.mock.method(Date, 'now', () => now);
    // Retrieved a minute ago: names Yahoo scored, alternating with names it refused.
    const refused = { chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } };
    const warm = bridge({ pages: (page) => (page < 2 ? fullPage(page) : table([])), yahooFor: (symbol) => (indexOf(symbol) % 2 ? refused : yahoo()) });
    const earlier = await startScan(params(40), { invoke: warm.invoke });
    const retrievedAt = Object.fromEntries(earlier.stocks.filter(stock => stock.analysis).map(stock => [stock.symbol, stock.analysis.quote.fetchedAt]));
    assert.equal(Object.keys(retrievedAt).length, 20);
    now += 60000;
    // A deeper scope where every other name is new and Yahoo now answers nothing.
    const mixed = (page) => table(Array.from({ length: PAGE_SIZE }, (_, i) => {
        const n = page * PAGE_SIZE + i;
        return row(n + 1, n % 2 ? `NEW${n}` : symbolAt(Math.floor(n / 2 / PAGE_SIZE), (n / 2) % PAGE_SIZE), '-5.00');
    }));
    const cold = bridge({ pages: mixed, yahooFor: timedOut });
    const scan = await startScan(params(80), { invoke: cold.invoke, chartCacheSeconds: 600 });
    assert.ok(cold.calls.charts.every(symbol => symbol.startsWith('NEW')), 'cached names are not requested');
    // Only Yahoo's own failures count, so the stop comes with the cutoff-th of them wherever cached answers fall.
    const sent = CHART_FAILURE_CUTOFF + HYDRATE_CONCURRENCY - 1;
    assert.equal(cold.calls.charts.length, sent);
    assert.equal(scan.error, stoppedEarly('Request timed out after 12 s.', 40 - sent), 'the new names never requested');
    const scored = scan.stocks.filter(stock => stock.analysis);
    assert.deepEqual(Object.fromEntries(scored.map(stock => [stock.symbol, stock.analysis.quote.fetchedAt])), retrievedAt,
        'every cached score is shown with its original retrieval time, those listed after the stop included');
});

test('a run that stops scoring never sends the chart requests it still had waiting for a slot', async (t) => {
    // Another scope holds half the chart slots until the gate opens, so the run's requests queue for the rest.
    const held = HYDRATE_CONCURRENCY / 2;
    let open;
    const gate = new Promise(resolve => { open = resolve; });
    t.after(open);
    const pages = (page, url) => (url.includes('sec_energy') ? losersPage(0, { tag: 'B', sector: 'Energy' }) : page < 2 ? losersPage(page, { tag: 'F' }) : table([]));
    const { invoke, calls } = bridge({ pages, yahooFor: (symbol) => (symbol.startsWith('B') ? gate.then(() => yahoo()) : timedOut()) });
    const busy = startScan(params(held, { sector: 'energy' }), { invoke });
    const scan = await startScan(params(40), { invoke });
    // The cutoff, plus one request in each slot the run had when it was reached.
    const sent = CHART_FAILURE_CUTOFF + HYDRATE_CONCURRENCY - held;
    assert.equal(calls.charts.filter(symbol => symbol.startsWith('F')).length, sent);
    assert.equal(scan.error, stoppedEarly('Request timed out after 12 s.', 40 - sent));
    assert.ok(scan.stocks.every(stock => stock.analysisUnavailable));
    open();
    assert.ok((await busy).stocks.every(stock => stock.analysis));
});

test('rows listed after scoring stopped are unavailable at once, even while another scope holds every chart slot', async (t) => {
    let openPage, openCharts;
    const pageGate = new Promise(resolve => { openPage = resolve; });
    const chartGate = new Promise(resolve => { openCharts = resolve; });
    t.after(() => { openPage(); openCharts(); });
    const pages = (page, url) => (url.includes('sec_energy') ? losersPage(0, { tag: 'B', sector: 'Energy' })
        : page === 0 ? losersPage(0, { tag: 'F' }) : page === 1 ? pageGate.then(() => losersPage(1, { tag: 'F' })) : table([]));
    const { invoke, calls } = bridge({ pages, yahooFor: (symbol) => (symbol.startsWith('B') ? chartGate.then(() => yahoo()) : timedOut()) });
    const sentFor = (tag) => calls.charts.filter(symbol => symbol.startsWith(tag)).length;
    // The first page's names fail and stop the scoring...
    const failing = startScan(params(40), { invoke });
    await until(() => sentFor('F') === PAGE_SIZE);
    await wait(5);
    // ...then another scope takes every chart slot before the second page arrives.
    const busy = startScan(params(20, { sector: 'energy' }), { invoke });
    await until(() => sentFor('B') === HYDRATE_CONCURRENCY);
    openPage();
    const ended = await Promise.race([failing.then(() => true), wait(50).then(() => false)]);
    openCharts();
    assert.ok(ended, 'the run ends without waiting for a slot');
    const scan = await failing;
    assert.equal(sentFor('F'), PAGE_SIZE);
    assert.equal(scan.error, stoppedEarly('Request timed out after 12 s.', PAGE_SIZE));
    assert.ok((await busy).completedAt);
});

// ─── Alerts: a bare EventTarget stands in for window ─────────────────────────
const listenForAlerts = (t) => {
    const events = [];
    globalThis.window = new EventTarget();
    globalThis.window.addEventListener('stock-alert', (event) => events.push(event.detail));
    t.after(() => { delete globalThis.window; });
    return events;
};
// canRaiseTechnicalAlert compares the quote time with Date.now().
const setClock = (t, iso) => {
    let now = Date.parse(iso);
    t.mock.method(Date, 'now', () => now);
    return (next) => { now = Date.parse(next); };
};
const freshQuote = (quotedAt, extra = {}) => ({
    price: 100, closes: Array(22).fill(100), quotedAt, delayMinutes: 0, exchangeTimezone: 'America/New_York', source: 'Yahoo Finance', ...extra,
});
const conditions = (flags = {}) => ({
    isBreakout: false, isBreakdown: false, trend: 'neutral', trendAlertEligible: true, dipPercentage: 10, currentPrice: 100, score: 55, ...flags,
});

test('an alert is raised when its condition turns true, not again while it holds, and again once it has cleared', (t) => {
    const events = listenForAlerts(t);
    const clock = setClock(t, '2026-10-30T14:01:00Z');
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true }), freshQuote('2026-10-30T14:00:00Z'));
    clock('2026-10-30T14:06:00Z');
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true }), freshQuote('2026-10-30T14:05:30Z')); // a new trade, same condition
    assert.equal(events.length, 1);
    dispatchAlertsFromAnalysis('XYZ', conditions(), freshQuote('2026-10-30T14:05:40Z'));
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true }), freshQuote('2026-10-30T14:05:50Z'));
    assert.deepEqual(events.map(event => event.type), ['breakdown', 'breakdown']);
    assert.equal(globalThis.window._stockAlertsEmitted, undefined);
});

test('a condition that persists is raised again when a new exchange-local day starts', (t) => {
    const events = listenForAlerts(t);
    const clock = setClock(t, '2026-10-30T19:56:00Z'); // 15:56 in New York
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true }), freshQuote('2026-10-30T19:55:00Z'));
    clock('2026-10-31T00:01:00Z'); // past midnight UTC, still Friday in New York
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true }), freshQuote('2026-10-31T00:00:30Z'));
    assert.equal(events.length, 1);
    clock('2026-11-02T14:31:00Z'); // Monday 09:31 in New York
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true }), freshQuote('2026-11-02T14:30:30Z'));
    assert.equal(events.length, 2);
    assert.equal(events[1].quotedAt, '2026-11-02T14:30:30Z');
});

test('conditions turning true together raise one alert, and one already seen stays silent when left alone', (t) => {
    const events = listenForAlerts(t);
    setClock(t, '2026-10-30T14:01:00Z');
    const quote = freshQuote('2026-10-30T14:00:00Z');
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true, trend: 'bearish' }), quote);
    dispatchAlertsFromAnalysis('XYZ', conditions({ trend: 'bearish' }), quote);
    assert.deepEqual(events.map(event => event.type), ['breakdown'], 'the bearish trend was already true');
    dispatchAlertsFromAnalysis('XYZ', conditions(), quote);
    dispatchAlertsFromAnalysis('XYZ', conditions({ trend: 'bearish' }), quote);
    dispatchAlertsFromAnalysis('ABC', conditions({ trend: 'bearish' }), quote);
    assert.deepEqual(events.map(event => `${event.symbol} ${event.type}`), ['XYZ breakdown', 'XYZ bearish', 'ABC bearish']);
});

test('the one alert lists every condition that turned true with it, in precedence order, so a filtered one does not hide the next', (t) => {
    const events = listenForAlerts(t);
    setClock(t, '2026-10-30T14:01:00Z');
    const quote = freshQuote('2026-10-30T14:00:00Z');
    const deep = { dipPercentage: 18, currentPrice: 82 };
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true, trend: 'bearish', ...deep }), quote);
    assert.equal(events.length, 1, 'one alert per symbol and refresh');
    assert.deepEqual(events[0].conditions, [
        { type: 'breakdown', color: 'amber', message: 'Price $82.00 is no more than 0.5% above the lowest close since its one-month closing high, 18.0% below that high.' },
        { type: 'bearish', color: 'blue', message: 'EMA5 is below EMA10 and price is more than 1% below EMA5: $82.00.' },
    ]);
    assert.deepEqual({ type: events[0].type, color: events[0].color, message: events[0].message }, events[0].conditions[0]);
    // Both are marked as raised, whichever one the alert layer shows.
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true, trend: 'bearish', ...deep }), quote);
    assert.equal(events.length, 1);
    // Only conditions that turned true are listed: here the breakdown, not the bearish trend that held.
    dispatchAlertsFromAnalysis('XYZ', conditions({ trend: 'bearish', ...deep }), quote);
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true, trend: 'bearish', ...deep }), quote);
    assert.deepEqual(events.map(event => event.conditions.map(condition => condition.type)), [['breakdown', 'bearish'], ['breakdown']]);
});

test('alert messages describe the observed condition and carry the quote provenance and score', (t) => {
    const events = listenForAlerts(t);
    setClock(t, '2026-10-30T14:01:00Z');
    const quote = freshQuote('2026-10-30T14:00:00Z');
    dispatchAlertsFromAnalysis('AMB', conditions({ isBreakdown: true, dipPercentage: 18, currentPrice: 82, score: 60 }), quote);
    dispatchAlertsFromAnalysis('LOW', conditions({ isBreakdown: true, dipPercentage: 10, currentPrice: 90 }), quote);
    dispatchAlertsFromAnalysis('UP', conditions({ isBreakout: true, currentPrice: 120.5 }), quote);
    dispatchAlertsFromAnalysis('BULL', conditions({ trend: 'bullish', currentPrice: 105 }), quote);
    dispatchAlertsFromAnalysis('EARLY', conditions({ trend: 'bullish', trendAlertEligible: false }), quote);
    dispatchAlertsFromAnalysis('BEAR', conditions({ trend: 'bearish', currentPrice: 95, score: undefined }), quote);
    assert.deepEqual(events.map(({ symbol, type, color, message, score }) => ({ symbol, type, color, message, score })), [
        { symbol: 'AMB', type: 'breakdown', color: 'amber', score: 60, message: 'Price $82.00 is no more than 0.5% above the lowest close since its one-month closing high, 18.0% below that high.' },
        { symbol: 'LOW', type: 'breakdown', color: 'blue', score: 55, message: 'Price $90.00 is no more than 0.5% above the lowest close since its one-month closing high.' },
        { symbol: 'UP', type: 'breakout', color: 'blue', score: 55, message: 'Price $120.50 is above its prior one-month closing high.' },
        { symbol: 'BULL', type: 'bullish', color: 'blue', score: 55, message: 'EMA5 is above EMA10 and price is more than 1% above EMA5: $105.00.' },
        { symbol: 'BEAR', type: 'bearish', color: 'blue', score: null, message: 'EMA5 is below EMA10 and price is more than 1% below EMA5: $95.00.' },
    ]);
    assert.ok(events.every(event => event.quotedAt === quote.quotedAt && event.source === 'Yahoo Finance' && event.delayMinutes === 0
        && event.timestamp === Date.parse('2026-10-30T14:01:00Z')));
});

test('a quote too old or with a stated delay raises nothing and leaves the condition armed', (t) => {
    const events = listenForAlerts(t);
    setClock(t, '2026-10-30T14:11:00Z');
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true }), freshQuote('2026-10-30T14:00:00Z'));
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true }), freshQuote('2026-10-30T14:10:30Z', { delayMinutes: 15 }));
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true }), freshQuote('2026-10-30T14:10:30Z', { closes: Array(14).fill(100) }));
    assert.equal(events.length, 0);
    dispatchAlertsFromAnalysis('XYZ', conditions({ isBreakdown: true }), freshQuote('2026-10-30T14:10:30Z'));
    assert.equal(events.length, 1);
});

test('resetScans re-arms every alert', (t) => {
    const events = listenForAlerts(t);
    setClock(t, '2026-10-30T14:01:00Z');
    const quote = freshQuote('2026-10-30T14:00:00Z');
    dispatchAlertsFromAnalysis('XYZ', conditions({ trend: 'bearish' }), quote);
    dispatchAlertsFromAnalysis('XYZ', conditions({ trend: 'bearish' }), quote);
    resetScans();
    dispatchAlertsFromAnalysis('XYZ', conditions({ trend: 'bearish' }), quote);
    assert.equal(events.length, 2);
});

// A month of falling closes with the live price under all of them: a breakdown
// 48% below the one-month closing high, with a bearish trend.
const breakdownChart = (quotedAt) => {
    const closes = Array.from({ length: 22 }, (_, i) => 20 - i * 0.45);
    return { chart: { result: [{
        meta: { regularMarketPrice: 10.4, regularMarketTime: quotedAt, previousClose: 10.6, exchangeDataDelayedBy: 0, exchangeTimezoneName: 'America/New_York' },
        timestamp: closes.map((_, i) => quotedAt - (closes.length - 1 - i) * 86400),
        indicators: { quote: [{ close: closes }] },
    }] } };
};

test('a scan raises one alert per symbol whose condition turned true, and a refresh does not repeat them', async (t) => {
    const events = listenForAlerts(t);
    const clock = setClock(t, '2026-10-30T14:01:00Z');
    let quotedAt = Date.parse('2026-10-30T14:00:00Z') / 1000;
    const { invoke } = bridge({ pages: (page) => (page < 1 ? losersPage(page) : table([])), yahooFor: () => breakdownChart(quotedAt) });
    const scan = await startScan(params(20), { invoke });
    assert.deepEqual(events.map(event => event.symbol).sort(), scan.stocks.map(stock => stock.symbol).sort());
    assert.ok(events.every(event => event.type === 'breakdown' && event.color === 'amber' && event.quotedAt === '2026-10-30T14:00:00.000Z'
        && event.score === scan.stocks.find(stock => stock.symbol === event.symbol).recoveryProbability));
    assert.ok(events.every(event => event.conditions.map(condition => condition.type).join() === 'breakdown,bearish'), 'the bearish trend that turned true with each breakdown is listed');
    // A refresh a minute later: new trades, the same conditions.
    clock('2026-10-30T14:02:00Z');
    quotedAt += 60;
    await startScan(params(20), { invoke });
    assert.equal(events.length, 20, 'unchanged conditions stay silent on refresh');
});

// ─── Photonics basket: Yahoo only ────────────────────────────────────────────
const photonicsChart = (symbol) => {
    const chart = yahoo();
    chart.chart.result[0].meta.longName = `${symbol} Inc`;
    return chart;
};

test('the Photonics basket scores its eight symbols from Yahoo alone and completes', async () => {
    const { invoke, calls } = bridge({ pages: () => { throw new Error('the basket needs no screener'); }, yahooFor: photonicsChart });
    const scan = await startScan(params(20, { sector: 'photonics' }), { invoke });
    assert.deepEqual(scan.stocks.map(stock => stock.symbol), PHOTONICS_TICKERS);
    assert.ok(scan.stocks.every(stock => stock.name === `${stock.symbol} Inc` && stock.source === 'Yahoo Finance' && stock.analysis && stock.stale === undefined));
    assert.ok(scan.stocks.every(stock => !('avgVolume' in stock)));
    assert.equal(scan.error, '');
    assert.ok(scan.completedAt);
    assert.deepEqual(calls.pages, []);
    assert.deepEqual([...calls.charts].sort(), [...PHOTONICS_TICKERS].sort());
});

test('a Photonics refresh keeps a failed symbol\'s previous quote marked stale, and an incomplete basket is not reused', async () => {
    let failing = ['LITE'];
    const yahooFor = (symbol) => { if (failing.includes(symbol)) throw new Error('HTTP error! status: 429'); return photonicsChart(symbol); };
    const { invoke } = bridge({ pages: () => table([]), yahooFor });
    const partial = await startScan(params(20, { sector: 'photonics' }), { invoke });
    assert.deepEqual(partial.stocks[0], {
        symbol: 'LITE', name: 'LITE', source: 'Yahoo Finance', price: null, changePercentage: null, delayMinutes: null,
        quotedAt: null, fetchedAt: null, analysis: null, recoveryProbability: null, analysisUnavailable: true,
    }, 'a symbol never retrieved is shown unavailable');
    assert.match(partial.error, /Some Photonics quotes are unavailable/);
    assert.equal(partial.completedAt, null);

    failing = [];
    const full = await startScan(params(20, { sector: 'photonics' }), { invoke });
    assert.ok(full.completedAt);
    failing = ['COHR'];
    const refreshed = await startScan(params(20, { sector: 'photonics' }), { invoke });
    const cohr = refreshed.stocks.find(stock => stock.symbol === 'COHR');
    assert.deepEqual(cohr, { ...full.stocks.find(stock => stock.symbol === 'COHR'), stale: true }, 'the previous quote keeps its own times');
    assert.ok(refreshed.stocks.filter(stock => stock.symbol !== 'COHR').every(stock => stock.stale === undefined && stock.analysis));
    assert.equal(refreshed.completedAt, null);

    failing = [...PHOTONICS_TICKERS];
    const down = await startScan(params(20, { sector: 'photonics' }), { invoke });
    assert.match(down.error, /^Photonics quotes are unavailable/);
    assert.ok(down.stocks.every(stock => stock.stale === true));
    assert.equal(down.completedAt, null);
});

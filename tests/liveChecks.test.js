import test from 'node:test';
import assert from 'node:assert/strict';
import { liveFailures } from '../scripts/live-checks.mjs';

// The shape scripts/verify-live-electron.mjs writes to artifacts/live/report.json
// after a clean dev-mode run (no CSP meta outside a packaged build).
const cleanReport = () => ({
    overview: { firstRow: 2100, firstScore: 3500, scoredAll: 9800, complete: true, rows: 100, rendered: 100, scored: 97, unavailable: 3 },
    routes: ['cold', 'warm'].flatMap(pass => [
        { name: 'futures', pass, ms: { mount: 12, data: 900, playwrightData: 950 }, extraMs: {} },
        { name: 'stock-AAPL', pass, ms: { mount: 20, data: 1300, playwrightData: 1350 }, extraMs: { chart: 1400, tradingView: 6100 } },
        { name: 'settings', pass, ms: { mount: 8, data: 9, playwrightData: 40 }, extraMs: {} },
    ]),
    returnVisit: { mount: 10, firstRow: 15, firstScore: 16, playwrightRow: 60, rows: 100 },
    isolation: {
        nodeRequire: 'undefined', process: 'undefined', bridge: 'function', bridgeKeys: ['invoke'], csp: null,
        unknownChannel: 'Unknown desktop channel: fs-read',
        refusedHost: "Error invoking remote method 'fetch-url': Error: Refused request: only HTTPS req",
        tradingViewFrame: 1, tradingViewSandbox: 'allow-scripts allow-same-origin',
        webview: { url: 'https://finviz.com/stock?t=AAPL&p=d' },
        guests: [{ url: 'https://finviz.com/stock?t=AAPL&p=d', node: false }],
    },
    clipboard: 'Copied to the clipboard.',
    cspViolations: [],
    pageErrors: [],
    consoleErrors: ['Failed to analyze XYZ Error: Yahoo Finance returned HTTP 404 Not Found: No data found, symbol may be delisted'],
    mainProcessErrors: ['Yahoo Fetch error: Error: Yahoo Finance returned HTTP 404 Not Found'],
    screenshotErrors: ['overview: Timeout 60000ms exceeded'],
});
const withChange = (change) => { const report = cleanReport(); change(report); return report; };

test('a clean live run passes; provider noise and screenshot timeouts are not failures', () => {
    assert.deepEqual(liveFailures(cleanReport()), { failures: [], warnings: [] });
});

test('every renderer and guest isolation regression fails the run', () => {
    const cases = [
        [r => { r.isolation.nodeRequire = 'function'; }, /window\.require is function/],
        [r => { r.isolation.process = 'object'; }, /window\.process is object/],
        [r => { r.isolation.bridge = 'undefined'; }, /dipAnalyzer\.invoke is undefined/],
        [r => { r.isolation.bridgeKeys = ['invoke', 'send']; }, /exposes \["invoke","send"\]/],
        [r => { r.isolation.unknownChannel = 'resolved'; }, /unknown channel answered "resolved"/],
        [r => { r.isolation.refusedHost = 'resolved'; }, /off the allowlist answered "resolved"/],
        [r => { r.isolation.tradingViewSandbox = 'allow-scripts allow-same-origin allow-popups'; }, /TradingView iframe is sandboxed as/],
        [r => { r.isolation.tradingViewSandbox = null; }, /TradingView iframe is sandboxed as "null"/],
        [r => { r.isolation.guests[0].node = true; }, /research viewer at https:\/\/finviz\.com\/stock\?t=AAPL&p=d reaches Node \(true\)/],
        [r => { r.isolation.guests[0].node = 'probe failed: Script failed to execute'; }, /reaches Node \(probe failed/],
        [r => { r.isolation.guests = []; }, /no research viewer was attached/],
        [r => { r.isolation = { error: 'TimeoutError: locator.waitFor' }; }, /isolation: the probe did not complete \(TimeoutError/],
        [r => { delete r.isolation; }, /isolation: the probe did not complete$/],
    ];
    for (const [change, expected] of cases) {
        const { failures } = liveFailures(withChange(change));
        assert.equal(failures.length, 1, `${expected}: ${failures}`);
        assert.match(failures[0], expected);
    }
});

test('a packaged build must carry the Content Security Policy; the dev server need not', () => {
    assert.deepEqual(liveFailures(cleanReport(), { packaged: true }).failures, ['isolation: the packaged renderer has no Content Security Policy']);
    const packaged = withChange(r => { r.isolation.csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"; });
    assert.deepEqual(liveFailures(packaged, { packaged: true }).failures, []);
});

test('page errors, CSP violations, refused requests and a refused clipboard fail the run', () => {
    const cases = [
        [r => { r.pageErrors = ['TypeError: x is not a function']; }, /page errors: 1, first TypeError/],
        [r => { r.cspViolations = [{ count: 3, key: 'img-src | https://example.com/a.png | :0 | ' }]; }, /csp: 1 kind\(s\) of violation, first img-src/],
        [r => { r.consoleErrors.push("Failed to analyze BRK B Error: Refused chart request: \"BRK B\" is not a valid ticker symbol."); }, /refused requests: 1, first Failed to analyze BRK B/],
        [r => { r.consoleErrors.push('Error loading Finviz data: Error: Refused redirect to https://evil.example.'); }, /refused requests: 1/],
        [r => { r.mainProcessErrors.push("Error occurred in handler for 'fetch-yahoo-chart': Error: Refused chart request: \"^VIX X\" is not a valid ticker symbol."); }, /refused requests: 1, first Error occurred in handler/],
        [r => { r.clipboard = 'Clipboard unavailable — the text is selected; copy it manually.'; }, /clipboard: Settings → Backup → Copy reported "Clipboard unavailable/],
        [r => { delete r.clipboard; }, /reported "nothing"/],
    ];
    for (const [change, expected] of cases) {
        const { failures } = liveFailures(withChange(change));
        assert.equal(failures.length, 1, `${expected}: ${failures}`);
        assert.match(failures[0], expected);
    }
});

test('desks without live data fail the run, or only warn when live data is optional', () => {
    const empty = withChange(r => {
        r.overview = { firstRow: null, firstScore: null, scoredAll: null, complete: false, rows: 0, rendered: 0, scored: 0, unavailable: 0 };
        r.routes[1].ms = { mount: 20, data: null, playwrightData: null };
        r.routes[4].extraMs.tradingView = null;
        r.returnVisit = { mount: 10, firstRow: null, firstScore: null, playwrightRow: null, rows: 0 };
    });
    const expected = [
        'overview: no live screener row appeared',
        'overview: the scan listed no rows',
        'overview: no row was scored',
        'overview: the scan was still running after 120 s',
        'stock-AAPL (cold): no live data appeared',
        'stock-AAPL (warm): tradingView never appeared',
        'return visit: no Overview row on returning',
        'return visit: the Overview showed no rows',
    ];
    assert.deepEqual(liveFailures(empty), { failures: expected, warnings: [] });
    assert.deepEqual(liveFailures(empty, { dataOptional: true }), { failures: [], warnings: expected });
    // A security failure still fails a run whose live data is optional.
    empty.isolation.nodeRequire = 'function';
    assert.deepEqual(liveFailures(empty, { dataOptional: true }).failures, ['isolation: window.require is function in the renderer']);
});

test('a run that died part-way fails with its fatal error first', () => {
    const report = { fatal: 'Error: dev server did not start', routes: [], consoleErrors: [], pageErrors: [] };
    const { failures } = liveFailures(report);
    assert.equal(failures[0], 'fatal: Error: dev server did not start');
    assert.ok(failures.includes('isolation: the probe did not complete'));
    assert.ok(failures.includes('overview: no live screener row appeared'));
});

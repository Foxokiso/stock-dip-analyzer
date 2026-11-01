// Live end-to-end check of the Electron app: real Finviz/Yahoo data, no fixtures.
// Starts the renderer dev server (or drives a packaged build when ELECTRON_EXE
// is set), launches Electron through Playwright, walks every route twice
// (cold, then warm), and times what a user feels:
//   boot      process launch → renderer DOM ready
//   firstRow  Overview reload → first live screener row
//   firstScore / scoredAll   first Yahoo-scored row / the scan finished, every row scored or unavailable
//   mount     route change → page root rendered (in-page MutationObserver)
//   data      route change → first live value on that page
//   return    back to Overview → rows and scores shown again
// It then checks what it measured (scripts/live-checks.mjs) and exits 1, listing
// every failed check, when the renderer reaches Node or more than the one-function
// bridge, a guest viewer reaches Node or is outside the hardened research session,
// a refused request, an error in the app's own scripts or a CSP violation occurred,
// Copy did not reach the clipboard, or a desk showed no live data. Errors whose
// stack points at a third-party script (TradingView's chart) are listed as
// warnings; errors with no source count as the app's.
// Usage: node scripts/verify-live-electron.mjs        (artifacts/live/*.png + report.json)
//   env LIVE_SCAN_DEPTH=100   scan depth written into the app settings before measuring
//   env ELECTRON_EXE=<path>   check a packaged "DDS response.exe" instead of the dev build
//   env LIVE_DATA_OPTIONAL=1  report missing live data as warnings (a provider outage) and
//                             fail on the security and app checks only
// Settings → Backup → Copy is pressed once, so the system clipboard ends up holding
// the app's settings export.
import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { errorSource, liveFailures, startDevServer } from './live-checks.mjs';

// The session main.cjs's will-attach-webview handler gives every guest (RESEARCH_PARTITION).
const RESEARCH_PARTITION = 'research';
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(root, 'artifacts', 'live');
await mkdir(outDir, { recursive: true });
const scanDepth = Number(process.env.LIVE_SCAN_DEPTH) > 0 ? Number(process.env.LIVE_SCAN_DEPTH) : 100;
const report = { startedAt: new Date().toISOString(), scanDepth, boot: {}, overview: {}, routes: [], returnVisit: {}, consoleErrors: [], pageErrors: [], mainProcessErrors: [], screenshotErrors: [] };
const now = () => performance.now();
const ms = (value) => (value === null || value === undefined ? null : Math.round(value));

const packagedExe = process.env.ELECTRON_EXE || null;
// The renderer dev server. Node runs Vite itself, as CI does, so kill() stops the server:
// started through npx, the signal stopped only npm and its shell (cmd.exe on Windows), and
// the server stayed on 5174. startDevServer refuses whatever already answers there and
// fails at once, with Vite's own reason, when the server exits before it answers. The
// server is stopped whenever this process exits, also when the reporting below throws.
const waitForServer = async () => {
  if (packagedExe) return;
  const vite = await startDevServer({ url: 'http://127.0.0.1:5174/', cwd: root,
    command: [process.execPath, path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5174', '--strictPort'] });
  process.once('exit', () => vite.kill());
};

// Routes with selectors that only match live values, never chrome or placeholders.
// A TradingView frame stays transparent (opacity 0) until the chart has answered
// its ready handshake, so only a frame without the opacity counts as shown.
const TRADINGVIEW_SHOWN = 'iframe:not([style*="opacity"])';
const ROUTES = [
  { name: 'futures', hash: '/futures', root: '.futures-page', data: { sel: '.futures-table tbody tr td.numeric', text: '\\d' } },
  { name: 'stock-AAPL', hash: '/stock/AAPL', root: '.stock-details', data: { sel: '.stock-details strong', text: '\\$\\d' }, extra: { chart: { sel: '.recharts-surface' }, tradingView: { sel: `#tv_stockdetail_chart ${TRADINGVIEW_SHOWN}` } } },
  { name: 'etfs', hash: '/etfs', root: '.etf-awards-page', data: { sel: '.etf-leader-row' } },
  { name: 'oil', hash: '/oil', root: '.oil-watch-page', data: { sel: '.oil-row', text: '\\$\\d' } },
  { name: 'discovery', hash: '/discovery', root: '.discovery-page', data: { sel: '.discovery-stock-row', text: '\\$\\d' }, extra: { tradingView: { sel: `#tv_discovery_chart ${TRADINGVIEW_SHOWN}` } } },
  { name: 'settings', hash: '/settings', root: '.settings-page', data: { sel: '.settings-section' } },
];
const OVERVIEW = { name: 'overview', hash: '/', root: '.dashboard', data: { sel: '.dash-row .dash-symbol' }, extra: { score: { sel: '.dash-verdict', text: '\\(\\d+\\)' } } };

let app, page;
// Content Security Policy violations, with their source, so a blocked resource
// or inline handler can be traced to the library that caused it. A renderer that
// hung never answers, so the read gives up after 5 s, and the report says so
// instead of claiming there were none.
const collectCsp = async () => {
  const violations = await Promise.race([
    page.evaluate(() => window.__cspViolations || []),
    new Promise((resolve, reject) => setTimeout(reject, 5000, new Error('the renderer did not answer within 5 s'))),
  ]).catch((error) => { report.cspError = String(error).slice(0, 200); return []; });
  const groups = new Map();
  for (const v of violations) {
    const key = `${v.directive} | ${v.blocked} | ${v.source}:${v.line} | ${v.sample}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  report.cspViolations = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, count]) => ({ count, key }));
};
try {
  await waitForServer();
  const launchedAt = now();
  app = packagedExe
    ? await electron.launch({ executablePath: packagedExe, args: [], timeout: 60000 })
    : await electron.launch({ args: [path.join(root, 'main.cjs')], cwd: root, timeout: 60000 });
  // Provider failures the main process logs ("Fetch error: … Finviz returned HTTP 429 …").
  // Electron logs the harness's own refused-host probe as "Refused request: …", so this
  // pattern deliberately leaves that wording out. live-checks fails the run on a refused
  // chart request (an app bug) and only warns on a refused redirect (the provider's answer).
  app.process().stderr?.on('data', chunk => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (/fetch error|returned HTTP [45]\d\d|Refused (chart request|redirect)|Could not reach|timed out|TimeoutError/i.test(line)) report.mainProcessErrors.push(line.slice(0, 200));
    }
  });
  // Dev mode opens DevTools, which Playwright also reports as a window; pick the
  // renderer by URL, then close DevTools because it stalls screenshots.
  const isRenderer = (w) => (packagedExe ? w.url().startsWith('file:') : w.url().startsWith('http://127.0.0.1:5174'));
  await app.firstWindow();
  page = app.windows().find(isRenderer);
  if (!page) page = await app.waitForEvent('window', { predicate: isRenderer, timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.webContents.closeDevTools()));
  await page.waitForLoadState('domcontentloaded');
  report.boot.domReady = ms(now() - launchedAt);
  const baseUrl = packagedExe ? page.url().split('#')[0] : 'http://127.0.0.1:5174/';
  report.target = packagedExe ? `packaged ${packagedExe}` : 'dev server';
  report.baseUrl = baseUrl;
  page.on('console', msg => { if (msg.type() === 'error') report.consoleErrors.push(msg.text().slice(0, 300)); });
  // Playwright also reports uncaught errors from cross-site frames (TradingView's
  // chart), so each error keeps its source for live-checks to tell them apart.
  page.on('pageerror', err => report.pageErrors.push({ message: String(err).slice(0, 300), source: errorSource(err.stack) }));
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      if (window.__cspViolations.length < 200) window.__cspViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber, sample: (e.sample || '').slice(0, 120) });
    });
  });
  await page.setViewportSize({ width: 1440, height: 1050 });

  const count = (sel) => page.locator(sel).count();
  const textOf = async (sel) => (await page.locator(sel).first().textContent({ timeout: 2000 }).catch(() => '')) || '';
  // The Overview's row count, "Showing X of Y": the table renders up to 100 of the Y.
  const rowTotal = async () => Number(/\bof (\d+)/.exec(await textOf('.dash-table-count'))?.[1] ?? 0);
  const shot = async (name) => {
    try { await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false, timeout: 60000, animations: 'disabled' }); return true; }
    catch (error) { report.screenshotErrors.push(`${name}: ${String(error).slice(0, 120)}`); return false; }
  };
  const matcher = ({ sel, text }) => (text ? page.locator(sel).filter({ hasText: new RegExp(text) }) : page.locator(sel));
  const waitForData = async (spec, timeout) => {
    try { await matcher(spec).first().waitFor({ timeout }); return true; } catch { return false; }
  };

  // In-page probe: timestamps each selector's first appearance relative to the
  // hash change, so the numbers are the app's own, not Playwright's polling.
  const armProbe = (targets) => page.evaluate((specs) => {
    const probe = { t0: performance.now(), hits: {} };
    window.__liveProbe = probe;
    const matches = ({ sel, text }) => {
      const re = text ? new RegExp(text) : null;
      for (const el of document.querySelectorAll(sel)) if (!re || re.test(el.textContent || '')) return true;
      return false;
    };
    const check = () => {
      for (const [key, spec] of Object.entries(specs)) {
        if (probe.hits[key] === undefined && matches(spec)) probe.hits[key] = performance.now() - probe.t0;
      }
      if (Object.keys(probe.hits).length === Object.keys(specs).length) observer.disconnect();
    };
    const observer = new MutationObserver(check);
    // The TradingView frame is revealed by an attribute change (its inline opacity is
    // cleared on widgetReady), so style changes count as well as added nodes.
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style'] });
    window.addEventListener('hashchange', () => { probe.t0 = performance.now(); probe.hits = {}; check(); }, { once: true });
  }, targets);
  const readProbe = () => page.evaluate(() => window.__liveProbe?.hits || {});

  // Pin the scan depth in the app's own settings document so runs are comparable,
  // then reload: the reload is the "cold" Overview measurement (JS parse, mount, live scan).
  await page.evaluate((depth) => {
    const key = 'dipAnalyzerSettingsV2';
    let doc = null;
    try { doc = JSON.parse(localStorage.getItem(key) || 'null'); } catch { doc = null; }
    if (!doc || typeof doc !== 'object') doc = { version: 2 };
    doc.scanner = { ...(doc.scanner || {}), scanDepth: depth };
    localStorage.setItem(key, JSON.stringify(doc));
  }, scanDepth);
  await page.goto(`${baseUrl}#/`);
  const reloadAt = now();
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  report.overview.domReady = ms(now() - reloadAt);
  report.overview.firstRow = (await waitForData(OVERVIEW.data, 60000)) ? ms(now() - reloadAt) : null;
  report.overview.firstScore = (await waitForData(OVERVIEW.extra.score, 60000)) ? ms(now() - reloadAt) : null;
  // The scan is over when its spinner goes, every row scored or marked unavailable.
  // The table renders only the first 100 rows of its sort, so the total comes from
  // its "Showing X of Y" line, and every row is put on screen before counting scores.
  while (now() - reloadAt < 120000 && (await count('.dash-spinner')) > 0) await page.waitForTimeout(250);
  report.overview.complete = (await count('.dash-spinner')) === 0;
  report.overview.scoredAll = report.overview.complete ? ms(now() - reloadAt) : null;
  await page.getByRole('button', { name: /^Show all \(\d+\)$/ }).click({ timeout: 2000 }).catch(() => { /* 100 rows or fewer */ });
  report.overview.rows = await rowTotal();
  report.overview.rendered = await count('.dash-row');
  report.overview.scored = await matcher(OVERVIEW.extra.score).count();
  report.overview.unavailable = await page.locator('.dash-verdict').filter({ hasText: /^Unavailable$/ }).count();
  report.overview.sourceBanner = (await textOf('.dash-source-text')).trim().slice(0, 120);
  console.log(JSON.stringify({ overview: report.overview }));
  await shot('overview');

  async function visit(route, pass) {
    const targets = { root: { sel: route.root }, data: route.data, ...(route.extra || {}) };
    await armProbe(targets);
    const t0 = now();
    await page.goto(`${baseUrl}#${route.hash}`);
    const got = await waitForData(route.data, 45000);
    const playwrightData = got ? ms(now() - t0) : null;
    for (const key of Object.keys(route.extra || {})) await waitForData(route.extra[key], 20000);
    await page.waitForTimeout(150);
    const hits = await readProbe();
    const entry = { name: route.name, pass, ms: { mount: ms(hits.root), data: ms(hits.data), playwrightData }, extraMs: {} };
    for (const key of Object.keys(route.extra || {})) entry.extraMs[key] = ms(hits[key]);
    if (route.name === 'futures') {
      entry.rows = await count('.futures-table tbody tr');
      entry.cached = await count('.futures-table tbody .quote-status.cached');
    }
    if (route.name === 'etfs') entry.rows = await count('.etf-leader-row');
    if (route.name === 'oil') entry.rows = await count('.oil-row');
    if (route.name === 'discovery') entry.rows = await count('.discovery-stock-row');
    if (route.name === 'stock-AAPL') entry.priceText = (await textOf('.stock-details strong')).trim().slice(0, 24);
    console.log(JSON.stringify(entry));
    if (pass === 'cold') entry.screenshot = await shot(route.name);
    report.routes.push(entry);
    return entry;
  }

  for (const route of ROUTES) await visit(route, 'cold');

  // Security posture of the renderer: no Node or Electron reachable from the
  // page, only the bridge; the TradingView chart is a sandboxed frame under the
  // CSP; the embedded Finviz viewer is a guest whose page cannot reach Node,
  // asked from the main process because the renderer cannot see into it.
  try {
    await page.goto(`${baseUrl}#/stock/AAPL`);
    await page.locator('.stock-details').first().waitFor({ timeout: 20000 });
    report.isolation = await page.evaluate(() => ({
      nodeRequire: typeof window.require,
      process: typeof window.process,
      bridge: typeof window.dipAnalyzer?.invoke,
      bridgeKeys: Object.keys(window.dipAnalyzer || {}),
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content?.slice(0, 80) || null,
    }));
    report.isolation.unknownChannel = await page.evaluate(() => window.dipAnalyzer?.invoke('fs-read', 'x').then(() => 'resolved', e => String(e.message || e)));
    report.isolation.refusedHost = await page.evaluate(() => window.dipAnalyzer?.invoke('fetch-url', 'https://example.com/').then(() => 'resolved', e => String(e.message || e).slice(0, 80)));
    const tradingView = page.locator('#tv_stockdetail_chart iframe').first();
    await tradingView.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    report.isolation.tradingViewFrame = await page.locator('#tv_stockdetail_chart iframe').count();
    report.isolation.tradingViewSandbox = await tradingView.getAttribute('sandbox', { timeout: 2000 }).catch(() => null);
    await page.getByRole('button', { name: 'Finviz', exact: true }).first().click({ timeout: 5000 }).catch(() => page.locator('text=Finviz').first().click());
    report.isolation.webview = await page.evaluate(() => new Promise(resolve => {
      const view = document.querySelector('webview');
      if (!view) return resolve('no webview element');
      // getURL() throws until the guest has fired dom-ready, and after the element is
      // gone; the fallback timer is cleared once the probe has an answer, so it never
      // fires on a page the run has already left.
      let timer;
      const finish = (value) => { clearTimeout(timer); resolve(value); };
      const done = () => { let url = view.src; try { url = view.getURL() || url; } catch { /* not ready: keep src */ } finish({ url }); };
      view.addEventListener('did-finish-load', done, { once: true });
      // Third-party frames inside the guest page (ads, trackers) fail all the time; only the page itself counts.
      view.addEventListener('did-fail-load', (e) => { if (e.isMainFrame) finish({ failed: e.errorDescription || 'load failed' }); });
      timer = setTimeout(done, 15000);
    }));
    // Per guest: the Node probe shows its page cannot reach Node; its session shows
    // that main.cjs's will-attach-webview ran, as only that handler puts a guest in
    // the research partition, next to the preferences it hardens. (The element's
    // nodeintegration attribute says nothing about either.)
    report.isolation.guests = await app.evaluate(({ webContents, session }, partition) => Promise.all(webContents.getAllWebContents()
      .filter((contents) => contents.getType() === 'webview')
      .map(async (contents) => ({
        url: contents.getURL(),
        node: await contents.executeJavaScript("typeof process === 'object' && typeof process.versions?.node === 'string'")
          .catch((error) => `probe failed: ${error.message}`),
        research: contents.session === session.fromPartition(partition),
      }))), RESEARCH_PARTITION);
    console.log(JSON.stringify({ isolation: report.isolation }));
  } catch (error) {
    report.isolation = { error: String(error).slice(0, 200) };
  }

  // Settings → Backup → Copy: main.cjs grants the clipboard write to the app page,
  // which a browser run cannot show. The window is focused first, as Chromium
  // refuses clipboard writes from an unfocused document.
  try {
    await page.goto(`${baseUrl}#/settings`);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.focus()));
    await page.getByRole('button', { name: 'Copy', exact: true }).click({ timeout: 10000 });
    const status = page.locator('.settings-field', { has: page.getByLabel('Export', { exact: true }) }).locator('.settings-status');
    await status.filter({ hasText: /\S/ }).waitFor({ timeout: 5000 });
    report.clipboard = (await status.textContent()).trim();
  } catch (error) {
    report.clipboard = `probe failed: ${String(error).slice(0, 120)}`;
  }
  console.log(JSON.stringify({ clipboard: report.clipboard }));

  // Back to the Overview: a retained scan should be on screen immediately.
  {
    await armProbe({ root: { sel: OVERVIEW.root }, data: OVERVIEW.data, score: OVERVIEW.extra.score });
    const t0 = now();
    await page.goto(`${baseUrl}#/`);
    const got = await waitForData(OVERVIEW.data, 60000);
    await waitForData(OVERVIEW.extra.score, 30000);
    await page.waitForTimeout(150);
    const hits = await readProbe();
    report.returnVisit = { mount: ms(hits.root), firstRow: ms(hits.data), firstScore: ms(hits.score), playwrightRow: got ? ms(now() - t0) : null, rows: await rowTotal() };
    console.log(JSON.stringify({ returnVisit: report.returnVisit }));
  }
  for (const route of ROUTES) await visit(route, 'warm');
} catch (error) {
  report.fatal = String(error).slice(0, 400);
  console.error('fatal:', report.fatal);
} finally {
  // Also after a run that died part-way: a violation may be why it did.
  if (page) await collectCsp().catch(() => {});
  if (report.cspViolations?.length) console.log(JSON.stringify({ cspViolations: report.cspViolations }));
  report.finishedAt = new Date().toISOString();
  const { failures, warnings } = liveFailures(report, { packaged: Boolean(packagedExe), dataOptional: process.env.LIVE_DATA_OPTIONAL === '1' });
  Object.assign(report, { failures, warnings });
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const byName = {};
  for (const r of report.routes) (byName[r.name] ||= {})[r.pass] = r.ms;
  console.log('\nroute          mount(cold) data(cold) mount(warm) data(warm)');
  for (const [name, m] of Object.entries(byName)) {
    const f = v => String(v ?? '—').padStart(10);
    console.log(`${name.padEnd(14)} ${f(m.cold?.mount)} ${f(m.cold?.data)} ${f(m.warm?.mount)} ${f(m.warm?.data)}`);
  }
  console.log(JSON.stringify({ boot: report.boot, overview: report.overview, returnVisit: report.returnVisit, isolation: report.isolation, clipboard: report.clipboard, routes: report.routes.length, consoleErrors: report.consoleErrors.length, pageErrors: report.pageErrors.length, mainProcessErrors: report.mainProcessErrors.length, screenshotErrors: report.screenshotErrors.length, fatal: report.fatal || null, out: outDir }));
  for (const warning of warnings) console.log(`WARN ${warning}`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(failures.length ? `\n${failures.length} live check(s) failed` : `\nall live checks passed${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  try { await app?.close(); } catch { /* already gone */ }
  process.exit(failures.length ? 1 : 0);
}

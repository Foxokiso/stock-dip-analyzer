// Live end-to-end check of the Electron app: real Finviz/Yahoo data, no fixtures.
// Starts the renderer dev server (or drives a packaged build when ELECTRON_EXE
// is set), launches Electron through Playwright, walks every route twice
// (cold, then warm), and times what a user feels:
//   boot      process launch → renderer DOM ready
//   firstRow  Overview reload → first live screener row
//   firstScore / scoredAll   first and last Yahoo-scored row
//   mount     route change → page root rendered (in-page MutationObserver)
//   data      route change → first live value on that page
//   return    back to Overview → rows and scores shown again
// Usage: node scripts/verify-live-electron.mjs        (artifacts/live/*.png + report.json)
//   env LIVE_SCAN_DEPTH=100   scan depth written into the app settings before measuring
//   env ELECTRON_EXE=<path>   check a packaged "DDS response.exe" instead of the dev build
import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(root, 'artifacts', 'live');
await mkdir(outDir, { recursive: true });
const scanDepth = Number(process.env.LIVE_SCAN_DEPTH) > 0 ? Number(process.env.LIVE_SCAN_DEPTH) : 100;
const report = { startedAt: new Date().toISOString(), scanDepth, boot: {}, overview: {}, routes: [], returnVisit: {}, consoleErrors: [], pageErrors: [], mainProcessErrors: [] };
const now = () => performance.now();
const ms = (value) => (value === null || value === undefined ? null : Math.round(value));

const packagedExe = process.env.ELECTRON_EXE || null;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const vite = packagedExe ? null : spawn(npx, ['vite', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' });
const waitForServer = async () => {
  if (packagedExe) return;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:5174/'); if (r.ok) return; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('dev server did not start');
};

// Routes with selectors that only match live values, never chrome or placeholders.
const ROUTES = [
  { name: 'futures', hash: '/futures', root: '.futures-page', data: { sel: '.futures-table tbody tr td.numeric', text: '\\d' } },
  { name: 'stock-AAPL', hash: '/stock/AAPL', root: '.stock-details', data: { sel: '.stock-details strong', text: '\\$\\d' }, extra: { chart: { sel: '.recharts-surface' }, tradingView: { sel: '#tv_stockdetail_chart iframe' } } },
  { name: 'etfs', hash: '/etfs', root: '.etf-awards-page', data: { sel: '.etf-leader-row' } },
  { name: 'oil', hash: '/oil', root: '.oil-watch-page', data: { sel: '.oil-row', text: '\\$\\d' } },
  { name: 'discovery', hash: '/discovery', root: '.discovery-page', data: { sel: '.discovery-stock-row', text: '\\$\\d' }, extra: { tradingView: { sel: '#tv_discovery_chart iframe' } } },
  { name: 'settings', hash: '/settings', root: '.settings-page', data: { sel: '.settings-section' } },
];
const OVERVIEW = { name: 'overview', hash: '/', root: '.dashboard', data: { sel: '.dash-row .dash-symbol' }, extra: { score: { sel: '.dash-verdict', text: '\\(\\d+\\)' } } };

let app;
try {
  await waitForServer();
  const launchedAt = now();
  app = packagedExe
    ? await electron.launch({ executablePath: packagedExe, args: [], timeout: 60000 })
    : await electron.launch({ args: [path.join(root, 'main.cjs')], cwd: root, timeout: 60000 });
  app.process().stderr?.on('data', chunk => {
    for (const line of String(chunk).split(/\r?\n/)) {
      // status 400 is the harness's own refused-host probe, not a provider error.
      if (/fetch error|status: 4(0[1-9]|[1-9]\d)|status: 5\d\d|TimeoutError/i.test(line)) report.mainProcessErrors.push(line.slice(0, 200));
    }
  });
  // Dev mode opens DevTools, which Playwright also reports as a window; pick the
  // renderer by URL, then close DevTools because it stalls screenshots.
  const isRenderer = (w) => (packagedExe ? w.url().startsWith('file:') : w.url().startsWith('http://127.0.0.1:5174'));
  await app.firstWindow();
  let page = app.windows().find(isRenderer);
  if (!page) page = await app.waitForEvent('window', { predicate: isRenderer, timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.webContents.closeDevTools()));
  await page.waitForLoadState('domcontentloaded');
  report.boot.domReady = ms(now() - launchedAt);
  const baseUrl = packagedExe ? page.url().split('#')[0] : 'http://127.0.0.1:5174/';
  report.target = packagedExe ? `packaged ${packagedExe}` : 'dev server';
  page.on('console', msg => { if (msg.type() === 'error') report.consoleErrors.push(msg.text().slice(0, 300)); });
  page.on('pageerror', err => report.pageErrors.push(String(err).slice(0, 300)));
  await page.setViewportSize({ width: 1440, height: 1050 });

  const count = (sel) => page.locator(sel).count();
  const textOf = async (sel) => (await page.locator(sel).first().textContent({ timeout: 2000 }).catch(() => '')) || '';
  const shot = async (name) => {
    try { await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false, timeout: 60000, animations: 'disabled' }); return true; }
    catch (error) { report.pageErrors.push(`screenshot ${name}: ${String(error).slice(0, 120)}`); return false; }
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
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
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
  // Scores keep arriving; stop when the count is stable for 3 s or everything is scored.
  let scored = 0, stableFor = 0, rows = 0;
  while (stableFor < 3000 && now() - reloadAt < 120000) {
    await page.waitForTimeout(250);
    rows = await count('.dash-row');
    const next = await matcher(OVERVIEW.extra.score).count();
    stableFor = next === scored ? stableFor + 250 : 0;
    scored = next;
    if (rows > 0 && scored >= rows) break;
  }
  report.overview.scoredAll = ms(now() - reloadAt - stableFor);
  report.overview.rows = rows;
  report.overview.scored = scored;
  report.overview.unavailable = await page.locator('.dash-verdict').filter({ hasText: /^Unavailable$/ }).count();
  report.overview.sourceBanner = (await textOf('.dash-source-text')).trim().slice(0, 120);
  report.overview.mockMarkers = (await count('text=Zombie Corp')) + (await count('text=Mock News'));
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
    entry.mockMarkers = (await count('text=Zombie Corp')) + (await count('text=Mock News'));
    console.log(JSON.stringify(entry));
    if (pass === 'cold') entry.screenshot = await shot(route.name);
    report.routes.push(entry);
    return entry;
  }

  for (const route of ROUTES) await visit(route, 'cold');

  // Security posture of the renderer: no Node or Electron reachable from the
  // page, only the bridge; the embedded Finviz viewer loads as a sandboxed
  // guest; the TradingView chart frame appears under the CSP.
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
    await page.locator('#tv_stockdetail_chart iframe').first().waitFor({ timeout: 15000 }).catch(() => {});
    report.isolation.tradingViewFrame = await page.locator('#tv_stockdetail_chart iframe').count();
    await page.getByRole('button', { name: 'Finviz', exact: true }).first().click({ timeout: 5000 }).catch(() => page.locator('text=Finviz').first().click());
    report.isolation.webview = await page.evaluate(() => new Promise(resolve => {
      const view = document.querySelector('webview');
      if (!view) return resolve('no webview element');
      const done = () => resolve({ url: view.getURL?.() || view.src, nodeIntegration: view.hasAttribute('nodeintegration') });
      view.addEventListener('did-finish-load', done, { once: true });
      // Third-party frames inside the guest page (ads, trackers) fail all the time; only the page itself counts.
      view.addEventListener('did-fail-load', (e) => { if (e.isMainFrame) resolve({ failed: e.errorDescription || 'load failed' }); });
      setTimeout(done, 15000);
    }));
    console.log(JSON.stringify({ isolation: report.isolation }));
  } catch (error) {
    report.isolation = { error: String(error).slice(0, 200) };
  }

  // Back to the Overview: a retained scan should be on screen immediately.
  {
    await armProbe({ root: { sel: OVERVIEW.root }, data: OVERVIEW.data, score: OVERVIEW.extra.score });
    const t0 = now();
    await page.goto(`${baseUrl}#/`);
    const got = await waitForData(OVERVIEW.data, 60000);
    await waitForData(OVERVIEW.extra.score, 30000);
    await page.waitForTimeout(150);
    const hits = await readProbe();
    report.returnVisit = { mount: ms(hits.root), firstRow: ms(hits.data), firstScore: ms(hits.score), playwrightRow: got ? ms(now() - t0) : null, rows: await count('.dash-row') };
    console.log(JSON.stringify({ returnVisit: report.returnVisit }));
  }
  for (const route of ROUTES) await visit(route, 'warm');
} catch (error) {
  report.fatal = String(error).slice(0, 400);
  console.error('fatal:', report.fatal);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const byName = {};
  for (const r of report.routes) (byName[r.name] ||= {})[r.pass] = r.ms;
  console.log('\nroute          mount(cold) data(cold) mount(warm) data(warm)');
  for (const [name, m] of Object.entries(byName)) {
    const f = v => String(v ?? '—').padStart(10);
    console.log(`${name.padEnd(14)} ${f(m.cold?.mount)} ${f(m.cold?.data)} ${f(m.warm?.mount)} ${f(m.warm?.data)}`);
  }
  console.log(JSON.stringify({ boot: report.boot, overview: report.overview, returnVisit: report.returnVisit, isolation: report.isolation, routes: report.routes.length, consoleErrors: report.consoleErrors.length, pageErrors: report.pageErrors.length, mainProcessErrors: report.mainProcessErrors.length, fatal: report.fatal || null, out: outDir }));
  try { await app?.close(); } catch { /* already gone */ }
  vite?.kill();
  process.exit(report.fatal ? 1 : 0);
}

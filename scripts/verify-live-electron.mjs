// Live end-to-end check of the Electron app: real Finviz/Yahoo data, no fixtures.
// Starts the renderer dev server, launches Electron through Playwright, walks the
// routes, times first live rows, records console/page errors and takes screenshots.
// Usage: node scripts/verify-live-electron.mjs   (writes artifacts/live/*.png + report.json)
import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(root, 'artifacts', 'live');
await mkdir(outDir, { recursive: true });
const report = { startedAt: new Date().toISOString(), routes: [], consoleErrors: [], pageErrors: [] };
const now = () => performance.now();

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const vite = spawn(npx, ['vite', '--host', '127.0.0.1', '--port', '5174'], { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' });
const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:5174/'); if (r.ok) return; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('dev server did not start');
};

let app;
try {
  await waitForServer();
  app = await electron.launch({ args: [path.join(root, 'main.cjs')], cwd: root, timeout: 60000 });
  // Dev mode opens DevTools, which Playwright also reports as a window; pick the
  // renderer by URL, then close DevTools because it stalls screenshots.
  const isRenderer = (w) => w.url().startsWith('http://127.0.0.1:5174');
  await app.firstWindow();
  let page = app.windows().find(isRenderer);
  if (!page) page = await app.waitForEvent('window', { predicate: isRenderer, timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.webContents.closeDevTools()));
  await page.waitForLoadState('domcontentloaded');
  page.on('console', msg => { if (msg.type() === 'error') report.consoleErrors.push(msg.text().slice(0, 300)); });
  page.on('pageerror', err => report.pageErrors.push(String(err).slice(0, 300)));
  await page.setViewportSize({ width: 1440, height: 1050 });

  const settle = (ms = 700) => page.waitForTimeout(ms);
  const count = (sel) => page.locator(sel).count();
  const textOf = async (sel) => (await page.locator(sel).first().textContent({ timeout: 2000 }).catch(() => '')) || '';
  const shot = async (name) => {
    try { await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false, timeout: 60000, animations: 'disabled' }); return true; }
    catch (error) { report.pageErrors.push(`screenshot ${name}: ${String(error).slice(0, 120)}`); return false; }
  };

  async function route(name, hash, readySelector, extra) {
    const t0 = now();
    const entry = { name, hash, ms: {} };
    await page.goto(`http://127.0.0.1:5174/#${hash}`);
    entry.ms.navigate = Math.round(now() - t0);
    try {
      await page.locator(readySelector).first().waitFor({ timeout: 45000 });
      entry.ms.firstData = Math.round(now() - t0);
    } catch {
      entry.ms.firstData = null;
    }
    if (extra) {
      try { Object.assign(entry, await extra(entry)); } catch (error) { entry.extraError = String(error).slice(0, 200); }
    }
    await settle(1200);
    entry.ms.total = Math.round(now() - t0);
    entry.mockMarkers = (await count('text=Zombie Corp')) + (await count('text=Mock News'));
    entry.unavailableNotices = await count('text=/unavailable/i');
    console.log(JSON.stringify(entry));
    entry.screenshot = await shot(name);
    report.routes.push(entry);
    return entry;
  }

  // Overview: live Finviz screener rows + Yahoo hydration
  await route('overview', '/', 'table tbody tr', async () => {
    const rows = await count('table tbody tr');
    let scored = 0;
    for (let i = 0; i < 20 && scored < 5; i++) { await settle(1000); scored = await count('text=/Strong Buy|Buy|Hold|Sell/'); }
    return { rows, scoredBadges: scored, sourceBanner: (await textOf('.source-banner')).trim().slice(0, 160) };
  });
  await route('futures', '/futures', '.futures-table tbody tr', async () => ({
    rows: await count('.futures-table tbody tr'),
    statusChips: await count('.futures-table tbody .quote-status'),
    cached: await count('.futures-table tbody .quote-status.cached'),
    banner: (await textOf('.source-banner')).trim().slice(0, 160),
  }));
  await route('stock-AAPL', '/stock/AAPL', '.recharts-surface', async () => ({
    externalLinks: await count('a[href^="http"]'),
    priceText: (await textOf('text=/\\$\\d/')).trim().slice(0, 40),
  }));
  await route('etfs', '/etfs', 'text=/\\d+\\.\\d+%/');
  await route('oil', '/oil', 'text=/\\d+\\.\\d+/');
  await route('discovery', '/discovery', 'text=/\\d+\\.\\d+/');
  await route('settings', '/settings', 'text=Appearance');
} catch (error) {
  report.fatal = String(error).slice(0, 400);
  console.error('fatal:', report.fatal);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ routes: report.routes.length, consoleErrors: report.consoleErrors.length, pageErrors: report.pageErrors.length, fatal: report.fatal || null, out: outDir }));
  try { await app?.close(); } catch { /* already gone */ }
  vite.kill();
  process.exit(report.fatal ? 1 : 0);
}

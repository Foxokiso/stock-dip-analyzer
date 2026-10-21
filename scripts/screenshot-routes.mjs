// Route screenshots for visual review. Mirrors scripts/verify-ui.mjs: fonts and
// TradingView are aborted, and the Futures desk is fed the recorded Finviz
// fixture through the same window.require stub so it renders real rows. Every
// other route has no IPC bridge in a browser and shows its unavailable state.
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const outDir = fileURLToPath(new URL('../artifacts/screens/', import.meta.url));
const baseUrl = process.env.UI_BASE_URL || 'http://127.0.0.1:5174';
const liveData = await readFile(new URL('../tests/fixtures/futures-reference.json', import.meta.url), 'utf8');

const SIZES = {
  desktop: { width: 1440, height: 1050 },
  mobile: { width: 390, height: 844 },
};
const ROUTES = [
  { name: 'dashboard', path: '/#/' },
  { name: 'futures', path: '/#/futures', futures: true },
  { name: 'etfs', path: '/#/etfs' },
  { name: 'oil', path: '/#/oil' },
  { name: 'discovery', path: '/#/discovery' },
  { name: 'stock-AAPL', path: '/#/stock/AAPL' },
  { name: 'settings', path: '/#/settings' },
];
const SHOTS = [
  ...ROUTES.map((route) => ({ ...route, size: 'desktop' })),
  { ...ROUTES[0], size: 'mobile' },
  { ...ROUTES[1], size: 'mobile' },
];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const errors = [];
const written = [];
try {
  for (const shot of SHOTS) {
    const context = await browser.newContext({ viewport: SIZES[shot.size] });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${shot.name}-${shot.size}: ${error.message}`));
    await page.route(/https:\/\/(s3\.tradingview|fonts\.googleapis|fonts\.gstatic)/, (route) => route.abort());
    if (shot.futures) {
      await page.addInitScript(({ liveData }) => {
        window.__failQuotes = false;
        window.require = () => ({ ipcRenderer: { invoke: async (_method, url) => {
          if (window.__failQuotes) throw new Error('Controlled network failure');
          if (url.includes('/api/futures_all')) return liveData;
          throw new Error('Unexpected endpoint');
        } } });
      }, { liveData });
    }
    await page.goto(baseUrl + shot.path);
    if (shot.futures) {
      await page.locator('.futures-table tbody tr').nth(58).waitFor();
    } else {
      await page.waitForTimeout(900);
    }
    assert.equal(await page.getByText('Zombie Corp', { exact: true }).count(), 0, `${shot.name}: Zombie Corp present`);
    assert.equal(await page.getByText('Mock News', { exact: false }).count(), 0, `${shot.name}: Mock News present`);
    const file = `${outDir}${shot.name}-${shot.size}.png`;
    await page.screenshot({ path: file, fullPage: true });
    written.push(file);
    await context.close();
  }
} finally {
  await browser.close();
}
assert.deepEqual(errors, []);
console.log(JSON.stringify({ screenshots: written, pageErrors: errors }, null, 2));

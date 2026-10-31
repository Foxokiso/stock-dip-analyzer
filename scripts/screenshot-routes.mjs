// Route screenshots for visual review. Mirrors scripts/verify-ui.mjs: fonts and
// TradingView's hosts (the chart iframe) are aborted, and the Futures desk is fed
// the recorded Finviz fixture through the bridge the packaged app ships
// (window.dipAnalyzer = { invoke }) so it renders real rows. Every other route has
// no bridge in a browser and is shot once its unavailable notice is up.
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
// `ready` is what each desk shows once it has settled: the fixture's last row, or
// its own unavailable notice.
const ROUTES = [
  { name: 'dashboard', path: '/#/', ready: 'text="Market data requires the desktop app connection. No sample quotes are shown."' },
  { name: 'futures', path: '/#/futures', futures: true, ready: '.futures-table tbody tr >> nth=58' },
  { name: 'etfs', path: '/#/etfs', ready: 'text="Rankings unavailable."' },
  { name: 'oil', path: '/#/oil', ready: 'text="Oil Watch quotes require the desktop app connection."' },
  { name: 'discovery', path: '/#/discovery', ready: 'text="Scanner unavailable."' },
  { name: 'stock-AAPL', path: '/#/stock/AAPL', ready: 'text="52-week position unavailable"' },
  { name: 'settings', path: '/#/settings', ready: 'text="Not reported by Yahoo’s chart endpoint"' },
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
    await page.route(/https:\/\/([a-z0-9-]+\.)*tradingview\.com|fonts\.googleapis|fonts\.gstatic/, (route) => route.abort());
    if (shot.futures) {
      await page.addInitScript(({ liveData }) => {
        if (window !== window.top) return;
        window.dipAnalyzer = { invoke: async (channel, url) => {
          if (channel === 'configure-network') return {};
          if (channel === 'fetch-url' && url === 'https://finviz.com/api/futures_all?timeframe=i5') return liveData;
          throw new Error(`Error invoking remote method '${channel}': Error: No recorded response for ${url}`);
        } };
      }, { liveData });
    }
    await page.goto(baseUrl + shot.path);
    await page.locator(shot.ready).first().waitFor();
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

// Live smoke test of every Finviz screener view the app depends on, without
// Electron: fetch each page with the app's browser headers, run the shared
// parser, and report rows, timing and HTTP status. Exit code 1 when any view
// yields no rows, so a Finviz markup change is caught in seconds.
// Usage: node scripts/verify-finviz-live.mjs
import { DOMParser } from 'linkedom';
import { parseFinvizScreener } from '../src/utils/finviz.js';
import { parseFinvizFutures } from '../src/services/futures.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Mirrors the URLs built in Dashboard/scanStore, ETFAwards and Discovery.
const VIEWS = [
  { name: 'overview losers p1', url: 'https://finviz.com/screener.ashx?v=111&o=change&r=1', view: '111', expectNegative: true },
  { name: 'overview losers p2', url: 'https://finviz.com/screener.ashx?v=111&o=change&r=21', view: '111', expectNegative: true },
  { name: 'overview sector', url: 'https://finviz.com/screener.ashx?v=111&o=change&r=1&f=sec_technology', view: '111' },
  { name: 'etf 1-month', url: 'https://finviz.com/screener.ashx?v=141&f=ind_exchangetradedfund&o=-perf4w', view: '141', field: 'perfMonth' },
  { name: 'etf dividend', url: 'https://finviz.com/screener.ashx?v=161&f=ind_exchangetradedfund&o=-dividendyield', view: '161', field: 'dividendYield' },
  { name: 'etf 1-year', url: 'https://finviz.com/screener.ashx?v=141&f=ind_exchangetradedfund&o=-perf52w', view: '141', field: 'perfYear' },
  { name: 'discovery', url: 'https://finviz.com/screener.ashx?v=111&f=ta_unusualvolume,ta_volatility_mo5&o=-volume', view: '111' },
];

let failures = 0;
const line = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(20)} ${detail}`); if (!ok) failures++; };

for (const spec of VIEWS) {
  const started = performance.now();
  try {
    const response = await fetch(spec.url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const html = await response.text();
    const elapsed = Math.round(performance.now() - started);
    if (!response.ok) { line(spec.name, false, `HTTP ${response.status} in ${elapsed} ms`); continue; }
    const rows = parseFinvizScreener(html, { DOMParser, view: spec.view });
    const priced = rows.filter(row => row.price !== null).length;
    const negative = rows.filter(row => row.changePercentage !== null && row.changePercentage < 0).length;
    const metric = spec.field ? rows.filter(row => Number.isFinite(row[spec.field])).length : null;
    const ok = rows.length > 0 && priced === rows.length && (!spec.expectNegative || negative > 0) && (metric === null || metric > 0);
    line(spec.name, ok, `${rows.length} rows, ${priced} priced, ${negative} losers${metric === null ? '' : `, ${metric} with ${spec.field}`}, ${elapsed} ms, first ${rows[0]?.symbol ?? '—'} ${rows[0]?.price ?? ''}`);
  } catch (error) {
    line(spec.name, false, `${String(error.message || error).slice(0, 120)} after ${Math.round(performance.now() - started)} ms`);
  }
}

// Futures JSON API used by the Futures desk.
{
  const started = performance.now();
  try {
    const response = await fetch('https://finviz.com/api/futures_all?timeframe=i5', { headers: { ...HEADERS, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    const snapshot = parseFinvizFutures(text, { fetchedAt: new Date().toISOString(), timeframe: 'i5', sourceUrl: 'https://finviz.com/api/futures_all?timeframe=i5' });
    const available = snapshot.quotes.filter(quote => quote.price !== null).length;
    line('futures api', response.ok && available > 0, `HTTP ${response.status}, ${snapshot.quotes.length} instruments, ${available} priced, ${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    line('futures api', false, String(error.message || error).slice(0, 120));
  }
}

console.log(failures ? `\n${failures} view(s) failed` : '\nall Finviz views parse');
process.exit(failures ? 1 : 0);

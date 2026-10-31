// Live smoke test of every Finviz screener view the app depends on, without
// Electron: fetch each page with the app's browser headers, run the shared
// parser, and report rows, paging, timing and HTTP status. Exit code 1 when a
// view yields no rows, starts at the wrong row or ignores its sector filter,
// or when a URL its desk requests as canonical is redirected, so a Finviz
// markup or URL change is caught in seconds.
// Usage: node scripts/verify-finviz-live.mjs
import { DOMParser } from 'linkedom';
import { parseFinvizScreenerPage } from '../src/utils/finviz.js';
import { parseFinvizFutures } from '../src/services/futures.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// The screener views of scanStore, ETFAwards and Discovery, each at exactly
// the URL its desk requests; change them together. The Overview and Discovery
// request Finviz's canonical URLs, which must answer without a redirect (a
// redirect costs round trips and has silently dropped a filter before).
// Discovery's unusual volume is a signal (s=): as a filter (f=) Finviz lists
// it but does not apply it. The ETF desk still requests legacy screener.ashx
// URLs, which Finviz redirects (the dividend view to v=181); `redirects` marks
// a URL checked through its redirect, as the desk requests it.
const VIEWS = [
  { name: 'overview losers p1', url: 'https://finviz.com/screener/stocks?v=111&o=change&r=1', view: '111', expectNegative: true, firstRow: 1 },
  { name: 'overview losers p2', url: 'https://finviz.com/screener/stocks?v=111&o=change&r=21', view: '111', expectNegative: true, firstRow: 21 },
  { name: 'overview sector', url: 'https://finviz.com/screener/stocks?v=111&o=change&r=1&f=sec_technology', view: '111', sector: 'Technology' },
  { name: 'etf 1-month', url: 'https://finviz.com/screener.ashx?v=141&f=ind_exchangetradedfund&o=-perf4w', view: '141', field: 'perfMonth', redirects: true },
  { name: 'etf dividend', url: 'https://finviz.com/screener.ashx?v=161&f=ind_exchangetradedfund&o=-dividendyield', view: '161', field: 'dividendYield', redirects: true },
  { name: 'etf 1-year', url: 'https://finviz.com/screener.ashx?v=141&f=ind_exchangetradedfund&o=-perf52w', view: '141', field: 'perfYear', redirects: true },
  { name: 'discovery', url: 'https://finviz.com/screener/stocks?v=111&s=ta_unusualvolume&f=ta_volatility_mo5&o=-volume', view: '111' },
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
    const { rows, firstRowNumber, total } = parseFinvizScreenerPage(html, { DOMParser, view: spec.view });
    const priced = rows.filter(row => row.price !== null).length;
    const negative = rows.filter(row => row.changePercentage !== null && row.changePercentage < 0).length;
    const metric = spec.field ? rows.filter(row => Number.isFinite(row[spec.field])).length : null;
    // Page 2's symbols are not compared with page 1's: ranks move during market hours.
    const paged = spec.firstRow === undefined || firstRowNumber === spec.firstRow;
    const filtered = spec.sector === undefined || rows.every(row => row.sector === spec.sector);
    const canonical = !response.redirected || spec.redirects;
    const ok = rows.length > 0 && priced === rows.length && (!spec.expectNegative || negative > 0) && (metric === null || metric > 0) && paged && filtered && canonical;
    line(spec.name, ok, `${rows.length} rows from No. ${firstRowNumber ?? '—'} of ${total ?? '?'}, ${priced} priced, ${negative} losers${metric === null ? '' : `, ${metric} with ${spec.field}`}${filtered ? '' : `, not all ${spec.sector}`}, ${elapsed} ms, first ${rows[0]?.symbol ?? '—'} ${rows[0]?.price ?? ''}${response.redirected ? `, redirected to ${response.url}` : ''}`);
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

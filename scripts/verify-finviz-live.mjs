// Live smoke test of every Finviz page the app depends on, without Electron:
// fetch each with the app's browser headers, run the app's own parser, and report
// rows, paging, timing and HTTP status. Exit code 1 when a screener view yields no
// rows, starts at the wrong row or ignores its sector filter or signal, when the
// stock page's quote page loses a statistic, its 52-week bounds or its headline
// publishers, or when any of these URLs is redirected, so a Finviz markup or URL
// change is caught in seconds.
// Usage: node scripts/verify-finviz-live.mjs
import { DOMParser } from 'linkedom';
import { parseFinvizScreenerPage } from '../src/utils/finviz.js';
import { finvizQuoteUrl, parseFinvizQuotePage } from '../src/utils/finvizQuote.js';
import { parseFinvizFutures } from '../src/services/futures.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// The screener views of scanStore, ETFAwards and Discovery, each at exactly
// the URL its desk requests; change them together. Every desk requests Finviz's
// canonical URLs, which must answer without a redirect (a redirect costs round
// trips and has silently dropped a filter before). Discovery's unusual volume
// is a signal (s=): as a filter (f=) Finviz lists it but does not apply it, so
// the page's applied-filters line must name it.
const VIEWS = [
  { name: 'overview losers p1', url: 'https://finviz.com/screener/stocks?v=111&o=change&r=1', view: '111', expectNegative: true, firstRow: 1 },
  { name: 'overview losers p2', url: 'https://finviz.com/screener/stocks?v=111&o=change&r=21', view: '111', expectNegative: true, firstRow: 21 },
  { name: 'overview sector', url: 'https://finviz.com/screener/stocks?v=111&o=change&r=1&f=sec_technology', view: '111', sector: 'Technology' },
  { name: 'etf 1-month', url: 'https://finviz.com/screener/etf?v=141&f=etf_sectype_exchangetradedfund&o=-perf4w', view: '141', field: 'perfMonth' },
  { name: 'etf dividend', url: 'https://finviz.com/screener/etf?v=161&f=etf_sectype_exchangetradedfund&o=-dividendyield', view: '161', field: 'dividendYield' },
  { name: 'etf 1-year', url: 'https://finviz.com/screener/etf?v=141&f=etf_sectype_exchangetradedfund&o=-perf52w', view: '141', field: 'perfYear' },
  { name: 'discovery', url: 'https://finviz.com/screener/stocks?v=111&s=ta_unusualvolume&f=ta_volatility_mo5&o=-volume', view: '111', signal: 'ta_unusualvolume' },
];

let failures = 0;
const line = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(20)} ${detail}`); if (!ok) failures++; };
// The "Filters: … Signal: …" line Finviz prints above its results.
const appliedFilters = (html) => new DOMParser().parseFromString(html, 'text/html')
  .querySelector('[data-testid="screener-split-applied-filters"]')?.textContent.replace(/\s+/g, ' ').trim() ?? '';

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
    const applied = spec.signal === undefined || appliedFilters(html).includes(spec.signal);
    const ok = rows.length > 0 && priced === rows.length && (!spec.expectNegative || negative > 0) && (metric === null || metric > 0) && paged && filtered && applied && !response.redirected;
    line(spec.name, ok, `${rows.length} rows from No. ${firstRowNumber ?? '—'} of ${total ?? '?'}, ${priced} priced, ${negative} losers${metric === null ? '' : `, ${metric} with ${spec.field}`}${filtered ? '' : `, not all ${spec.sector}`}${applied ? '' : `, ${spec.signal} not applied (${appliedFilters(html) || 'no filters line'})`}, ${elapsed} ms, first ${rows[0]?.symbol ?? '—'} ${rows[0]?.price ?? ''}${response.redirected ? `, redirected to ${response.url}` : ''}`);
  } catch (error) {
    line(spec.name, false, `${String(error.message || error).slice(0, 120)} after ${Math.round(performance.now() - started)} ms`);
  }
}

// The stock page's quote page, at the canonical URL it requests, through its own
// parser: the Key Statistics labels the page shows (with its Dividend fallback),
// enough statistics overall, the 52-week bounds its position strip reads ('52W
// Range' disappeared unnoticed once), and headlines that name their publisher.
const STOCK_PAGE_STATS = ['Market Cap', 'P/E', 'Forward P/E', 'EPS (ttm)', ['Dividend TTM', 'Dividend %'], 'Beta', 'RSI (14)', 'Volume', 'Avg Volume',
  'Rel Volume', '52W High', '52W Low', 'Target Price', 'Short Float', 'Perf Week', 'Perf Month'];
{
  const started = performance.now();
  try {
    const response = await fetch(finvizQuoteUrl('AAPL'), { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const html = await response.text();
    const elapsed = Math.round(performance.now() - started);
    if (!response.ok) {
      line('quote page', false, `HTTP ${response.status} in ${elapsed} ms`);
    } else {
      const { stats, news, fiftyTwoWeekHigh, fiftyTwoWeekLow } = parseFinvizQuotePage(html, { DOMParser });
      const missing = STOCK_PAGE_STATS.filter(label => ![label].flat().some(name => stats.has(name)));
      const published = news.filter(item => item.source).length;
      const bounded = fiftyTwoWeekLow > 0 && fiftyTwoWeekHigh > fiftyTwoWeekLow;
      const ok = stats.size >= 60 && missing.length === 0 && bounded && news.length >= 10 && published >= news.length * 0.8 && !response.redirected;
      line('quote page', ok, `${stats.size} statistics${missing.length ? `, missing ${missing.flat().join(', ')}` : ''}, 52W ${fiftyTwoWeekLow ?? '—'} to ${fiftyTwoWeekHigh ?? '—'}, ${news.length} headlines, ${published} with a publisher, ${elapsed} ms${response.redirected ? `, redirected to ${response.url}` : ''}`);
    }
  } catch (error) {
    line('quote page', false, `${String(error.message || error).slice(0, 120)} after ${Math.round(performance.now() - started)} ms`);
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

console.log(failures ? `\n${failures} check(s) failed` : '\nall Finviz pages parse');
process.exit(failures ? 1 : 0);

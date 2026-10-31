// The Overview scan, kept outside React so it survives leaving the page.
//
// One scan per scope (sector, excluded sectors, depth). Screener pages are
// fetched a few at a time and published as soon as each contiguous page lands;
// Yahoo scoring starts on the first rows while later pages are still arriving
// and is flushed to the table in small batches. Every run draws on the same
// request slots, and the scope started or put on screen last is served first.
// Navigating away does not cancel a run: coming back adopts whatever is in
// flight, or reuses a recently completed scan whose rows keep their original
// retrieval times.
import { useCallback, useSyncExternalStore } from 'react';
import { analyzeStock } from '../utils/scoring.js';
import { getYahooQuote, canRaiseTechnicalAlert } from '../utils/marketData.js';
import { formatPrice } from '../utils/format.js';
import { parseFinvizScreenerPage } from '../utils/finviz.js';
import { fetchYahooChart } from '../utils/chartCache.js';
import { createQueue, drainQueue, createLimiter } from '../utils/pool.js';

export const PHOTONICS_TICKERS = ['LITE', 'COHR', 'IPGP', 'MKSI', 'FN', 'CAMT', 'ONTO', 'VIAV'];
export const PAGE_SIZE = 20;          // Finviz screener rows per page
export const MAX_PAGES = 50;
export const PAGE_CONCURRENCY = 4;    // screener pages in flight, across all runs
export const HYDRATE_CONCURRENCY = 8; // Yahoo chart requests in flight, across all runs
export const FLUSH_MS = 120;          // how often arriving scores are pushed to the table

// Settings exclusions narrow broad "any sector" scans only; a sector picked on
// the Overview is scanned in full, so its scope ignores them.
export const scanKey = ({ sector = '', excludedSectors = [], targetCount }) =>
    JSON.stringify([sector, sector ? [] : [...excludedSectors].sort(), targetCount]);

// `retained` counts the rows of an earlier run still on screen while a refresh replaces them.
const EMPTY_SCAN = Object.freeze({ stocks: [], loading: false, phase: null, error: '', startedAt: null, completedAt: null, retained: 0 });
const scans = new Map();   // key -> scan state
const runs = new Map();    // key -> latest run id
const listeners = new Set();
// Request slots shared by every run, so scopes scanned at the same time stay
// within one budget. Requests are served by their scope's latest promotion:
// starting a run promotes its scope, and so does putting it on screen, so a
// scope still loading when the Overview returns to it goes back in front.
const pageSlots = createLimiter(PAGE_CONCURRENCY);
const chartSlots = createLimiter(HYDRATE_CONCURRENCY);
const priorities = new Map(); // key -> promotion number, highest served first
let promotions = 0;
const promote = (key) => priorities.set(key, ++promotions);

export const getScan = (key) => scans.get(key) ?? EMPTY_SCAN;
export const subscribeScans = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
/** Subscribe for the scope on screen: its requests go ahead of scopes left behind. */
export const watchScan = (key, listener) => { promote(key); return subscribeScans(listener); };
export const useScan = (key) => useSyncExternalStore(useCallback((listener) => watchScan(key, listener), [key]), () => getScan(key));
export const scanAge = (scan, now = Date.now()) => (scan.completedAt ? now - Date.parse(scan.completedAt) : Infinity);
export const resetScans = () => { scans.clear(); runs.clear(); priorities.clear(); alertStates.clear(); };

const emit = () => { for (const listener of listeners) listener(); };
const patch = (key, changes) => { scans.set(key, { ...getScan(key), ...changes }); emit(); };
const positive = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);
const normalizedSector = (value) => (value || '').toLowerCase().replace(/[^a-z]/g, '');
// Provider messages quoted in a scan error may or may not end with a full stop.
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

// ─── Alerts raised from a fresh analysis ─────────────────────────────────────
// An alert is raised when its condition turns true and stays silent while the
// condition holds on later refreshes. It re-arms when the condition clears or
// when a new exchange-local day starts.
const ALERT_TYPES = ['breakout', 'breakdown', 'bullish', 'bearish']; // precedence among conditions turning true together
const alertStates = new Map(); // `${symbol}|${type}` -> exchange day on which the condition was last seen true
const dayFormats = new Map();  // exchange time zone -> Intl.DateTimeFormat
const exchangeDayOf = (quote) => {
    const timeZone = quote.exchangeTimezone || 'UTC';
    try {
        if (!dayFormats.has(timeZone)) dayFormats.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
        return dayFormats.get(timeZone).format(new Date(quote.quotedAt));
    } catch {
        return quote.quotedAt.slice(0, 10);
    }
};

export const dispatchAlertsFromAnalysis = (symbol, analysis, quote) => {
    if (typeof window === 'undefined' || !analysis || !canRaiseTechnicalAlert(quote, quote?.closes?.length ?? 0)) return;
    const { isBreakout, isBreakdown, trend, trendAlertEligible, dipPercentage, currentPrice } = analysis;
    const active = {
        breakout: isBreakout,
        breakdown: isBreakdown,
        bullish: trend === 'bullish' && trendAlertEligible,
        bearish: trend === 'bearish' && trendAlertEligible,
    };
    const day = exchangeDayOf(quote);
    let type = null;
    for (const candidate of ALERT_TYPES) {
        const key = `${symbol}|${candidate}`;
        if (!active[candidate]) { alertStates.delete(key); continue; }
        if (alertStates.get(key) !== day) type ??= candidate; // one alert even if several turn true at once
        alertStates.set(key, day);
    }
    if (!type) return;

    const price = formatPrice(currentPrice);
    const amber = type === 'breakdown' && dipPercentage >= 15;
    const message = {
        breakout: `Price ${price} is above its prior one-month closing high.`,
        breakdown: `Price ${price} is no more than 0.5% above the lowest close since its one-month closing high${amber ? `, ${dipPercentage.toFixed(1)}% below that high` : ''}.`,
        bullish: `EMA5 is above EMA10 and price is more than 1% above EMA5: ${price}.`,
        bearish: `EMA5 is below EMA10 and price is more than 1% below EMA5: ${price}.`,
    }[type];
    window.dispatchEvent(new CustomEvent('stock-alert', {
        detail: { symbol, type, color: amber ? 'amber' : 'blue', message, timestamp: Date.now(), quotedAt: quote.quotedAt, source: quote.source, delayMinutes: quote.delayMinutes,
            score: Number.isFinite(analysis.score) ? analysis.score : null },
    }));
};

// ─── Yahoo scoring for one symbol (fixed one-month daily series) ─────────────
const fetchQuote = async (chart, symbol) => {
    const { json, fetchedAt } = await chart(symbol);
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(json?.chart?.error?.description || `Yahoo Finance returned no chart for ${symbol}.`);
    return { meta: result.meta || {}, ...getYahooQuote(result, { range: '1mo', fetchedAt }) };
};

// Null when the chart has no price or too little history. A failed request
// rejects instead, so a scan can tell a provider failure from thin data.
const analyzeSymbol = async (symbol, chart) => {
    const quote = await fetchQuote(chart, symbol);
    if (quote.price === null) return null;
    const analysis = analyzeStock(quote.closes, quote.price);
    return analysis ? { ...analysis, quote } : null;
};

const scoredRow = (row, analysis) => ({
    ...row,
    recoveryProbability: analysis?.score ?? null,
    isZombie: analysis?.isZombie ?? false,
    // The 52-week range only exists in the Yahoo chart metadata that arrives with the score.
    fiftyTwoWeekLow: positive(analysis?.quote?.meta?.fiftyTwoWeekLow) ?? row.fiftyTwoWeekLow,
    fiftyTwoWeekHigh: positive(analysis?.quote?.meta?.fiftyTwoWeekHigh) ?? row.fiftyTwoWeekHigh,
    analysis,
    analysisUnavailable: !analysis,
});

// ─── Photonics basket: Yahoo only ────────────────────────────────────────────
async function scanPhotonics(key, chart, stale) {
    const previous = getScan(key).stocks;
    const results = await Promise.all(PHOTONICS_TICKERS.map(async (symbol) => {
        try {
            const quote = await fetchQuote(chart, symbol);
            if (quote.price === null) return null;
            const analysis = analyzeStock(quote.closes, quote.price);
            return {
                ...quote, symbol, name: quote.meta.longName ?? quote.meta.shortName ?? symbol,
                changePercentage: quote.changePct, volume: quote.meta.regularMarketVolume ?? null,
                marketCap: null,
                fiftyTwoWeekLow: positive(quote.meta.fiftyTwoWeekLow),
                fiftyTwoWeekHigh: positive(quote.meta.fiftyTwoWeekHigh),
                recoveryProbability: analysis?.score ?? null,
                isZombie: analysis?.isZombie ?? false,
                analysis: analysis ? { ...analysis, quote } : null,
            };
        } catch { return null; }
    }));
    if (stale()) return { complete: false };
    const valid = results.filter(Boolean);
    if (valid.length === 0) throw new Error('Photonics quotes are unavailable. Retained quotes keep their original source times.');
    const stocks = PHOTONICS_TICKERS.map(symbol => valid.find(stock => stock.symbol === symbol)
        ?? (previous.find(stock => stock.symbol === symbol)
            ? { ...previous.find(stock => stock.symbol === symbol), stale: true }
            : { symbol, name: symbol, source: 'Yahoo Finance', price: null, changePercentage: null,
                delayMinutes: null, quotedAt: null, fetchedAt: null, analysis: null,
                recoveryProbability: null, analysisUnavailable: true }));
    patch(key, { stocks, error: valid.length < PHOTONICS_TICKERS.length ? 'Some Photonics quotes are unavailable. Only confirmed provider data is shown.' : '' });
    valid.forEach(stock => dispatchAlertsFromAnalysis(stock.symbol, stock.analysis, stock.analysis?.quote));
    return { complete: valid.length === PHOTONICS_TICKERS.length };
}

// ─── Finviz screener pages → Yahoo scores, streamed ──────────────────────────
async function scanScreener(key, { sector, excludedSectors, targetCount }, fetchPage, chart, stale, timers) {
    const excluded = sector ? [] : excludedSectors;
    const accepts = (stock) => stock.changePercentage !== null && stock.changePercentage < 0
        && !excluded.includes(normalizedSector(stock.sector))
        && !(sector && normalizedSector(stock.sector) !== sector);
    // The canonical screener URL: screener.ashx now costs two redirects per page.
    const pageUrl = (page) => `https://finviz.com/screener/stocks?v=111&o=change&r=${page * PAGE_SIZE + 1}${sector ? `&f=sec_${encodeURIComponent(sector)}` : ''}`;

    const combined = new Map();   // symbol -> row, in screener order
    const pages = [];             // page index -> parsed rows
    const pending = createQueue(); // rows waiting for a score
    let flushed = 0, next = 0, stopAt = MAX_PAGES;
    let failure = null, failedPage = Infinity; // the earliest page that failed

    // A refresh keeps the previous scan on screen until this run replaces it.
    // A symbol listed again keeps its previous row, score and original times
    // until it is rescored; one no longer listed goes once this run has
    // published past its old position, or when the run ends.
    const previous = getScan(key).stocks;
    const carried = new Map(previous.map(row => [row.symbol, row]));
    const rescored = new Set();
    const publish = ({ final = false } = {}) => {
        const shown = [...combined.values()].map(row => (rescored.has(row.symbol) ? row : carried.get(row.symbol) ?? row));
        const unlisted = final ? [] : previous.slice(combined.size).filter(row => !combined.has(row.symbol));
        const retained = shown.filter(row => carried.get(row.symbol) === row).length + unlisted.length;
        patch(key, { stocks: [...shown, ...unlisted], retained });
    };

    // Rows are published strictly in page order, so a fast later page never
    // jumps ahead of a slow earlier one.
    const flushPages = () => {
        const added = [];
        while (flushed < stopAt && pages[flushed] !== undefined && combined.size < targetCount) {
            for (const stock of pages[flushed]) {
                if (combined.size >= targetCount) break;
                if (!accepts(stock) || combined.has(stock.symbol)) continue;
                const row = { ...stock, fiftyTwoWeekLow: null, fiftyTwoWeekHigh: null, recoveryProbability: null, isZombie: false, analysis: null };
                combined.set(stock.symbol, row);
                added.push(row);
            }
            flushed++;
        }
        if (added.length > 0) { pending.push(...added); publish(); }
    };

    // Look-ahead is bounded: at most PAGE_CONCURRENCY pages past the published
    // ones, and only while the pages already requested could still fall short
    // of the target. A slow early page therefore never sends the others on to
    // MAX_PAGES. Workers that may not claim yet wait for a page to land.
    const waiting = [];
    const pageLanded = () => new Promise(resolve => waiting.push(resolve));
    const pageWorker = async () => {
        while (!stale() && !failure && next < stopAt && combined.size < targetCount) {
            if (next >= flushed + PAGE_CONCURRENCY || combined.size + (next - flushed) * PAGE_SIZE >= targetCount) {
                await pageLanded();
                continue;
            }
            const page = next++;
            try {
                const html = await fetchPage(pageUrl(page));
                if (stale()) return;
                const { rows, dataRows, firstRowNumber, total } = parseFinvizScreenerPage(html);
                const expected = page * PAGE_SIZE + 1;
                if (firstRowNumber !== null && firstRowNumber !== expected) {
                    // Past the end of the results Finviz clamps the offset; anywhere
                    // else it ignored it, and the page would repeat rows already shown.
                    if (total === null || expected <= total) throw new Error(`Finviz returned rows from No. ${firstRowNumber} for the page starting at No. ${expected}.`);
                    stopAt = Math.min(stopAt, page);
                } else {
                    pages[page] = rows;
                    // Sorted by change ascending: the stated total, a short page or a
                    // page of gainers ends the losers. A row the parser skipped still
                    // counts toward a full page.
                    if (total !== null) stopAt = Math.min(stopAt, Math.ceil(total / PAGE_SIZE));
                    if (dataRows < PAGE_SIZE || rows.every(stock => stock.changePercentage !== null && stock.changePercentage >= 0)) stopAt = Math.min(stopAt, page + 1);
                    flushPages();
                }
            } catch (error) {
                if (page < failedPage) { failedPage = page; failure = error; }
            } finally {
                waiting.splice(0).forEach(resolve => resolve());
            }
        }
    };

    let scored = new Map();
    let flushTimer = null;
    const flushScores = () => {
        flushTimer = null;
        if (stale() || scored.size === 0) return;
        const batch = scored;
        scored = new Map();
        for (const [symbol, analysis] of batch) {
            const row = combined.get(symbol);
            if (row) combined.set(symbol, scoredRow(row, analysis)); // keeps its position
            rescored.add(symbol);
        }
        publish();
    };
    const scheduleFlush = () => { if (flushTimer === null) flushTimer = timers.setTimeout(flushScores, FLUSH_MS); };

    const paging = Promise.all(Array.from({ length: PAGE_CONCURRENCY }, pageWorker)).finally(() => {
        if (!stale()) patch(key, { phase: 'analysis' });
        pending.close();
    });
    let attempted = 0, failedCharts = 0, chartFailure = null;
    const scoring = drainQueue(pending, HYDRATE_CONCURRENCY, async (row) => {
        let analysis = null, error = null;
        try { analysis = await analyzeSymbol(row.symbol, chart); } catch (failed) { error = failed; }
        if (stale()) return;
        attempted++;
        if (error) {
            console.error(`Failed to analyze ${row.symbol}`, error);
            failedCharts++;
            chartFailure ??= error;
        }
        scored.set(row.symbol, analysis);
        if (analysis) dispatchAlertsFromAnalysis(row.symbol, analysis, analysis.quote);
        scheduleFlush();
    }, { shouldStop: stale });
    await Promise.all([paging, scoring]);
    if (flushTimer !== null) timers.clearTimeout(flushTimer);
    flushScores();
    if (stale()) return { complete: false };

    // A failed page matters only when the scan ended short because of it; one
    // past the end of the results never fails an otherwise complete scan.
    const errors = [];
    if (failure && failedPage < stopAt && combined.size < targetCount) {
        if (combined.size === 0) throw failure;
        errors.push(`Scan stopped after ${combined.size} names. ${sentence(failure.message || 'Finviz quotes are unavailable')} The rows shown were retrieved in this scan.`);
    }
    // Every chart request failing means Yahoo refused or could not be reached,
    // not that every name lacks history. Such a scan is not reused.
    if (attempted > 0 && failedCharts === attempted) {
        errors.push(`Yahoo Finance scoring failed for all ${attempted} names: ${sentence(chartFailure.message || 'request failed')} Technical scores are unavailable.`);
    }
    publish({ final: true }); // previous rows this run did not list again go now
    if (errors.length > 0) patch(key, { error: errors.join(' ') });
    return { complete: errors.length === 0 };
}

/**
 * Start (or restart) the scan for a scope. A newer run for the same scope
 * supersedes the older one, whose remaining state writes are dropped.
 * @param {{ sector?: string, excludedSectors?: string[], targetCount: number }} params
 * @param {{ invoke?: Function, chartCacheSeconds?: number, now?: () => string, timers?: { setTimeout: Function, clearTimeout: Function } }} [options]
 */
export async function startScan(params, { invoke = null, chartCacheSeconds = 0, now = () => new Date().toISOString(), timers = globalThis } = {}) {
    const key = scanKey(params);
    const runId = (runs.get(key) ?? 0) + 1;
    runs.set(key, runId);
    const stale = () => runs.get(key) !== runId;
    promote(key);
    patch(key, { loading: true, phase: 'quotes', error: '', startedAt: now(), retained: getScan(key).stocks.length });
    try {
        if (!invoke) throw new Error('Market data requires the desktop app connection. No sample quotes are shown.');
        // A superseded run's request still waiting for a slot is dropped when its turn comes.
        const request = (slots, channel, ...args) => slots.run(() => (stale() ? Promise.reject(new Error('Superseded scan request dropped.')) : invoke(channel, ...args)),
            () => priorities.get(key) ?? 0);
        const fetchPage = (url) => request(pageSlots, 'fetch-url', url);
        const chart = (symbol) => fetchYahooChart((channel, ...args) => request(chartSlots, channel, ...args), symbol, { range: '1mo', interval: '1d', ttlSeconds: chartCacheSeconds });
        const { complete } = params.sector === 'photonics'
            ? await scanPhotonics(key, chart, stale)
            : await scanScreener(key, params, fetchPage, chart, stale, timers);
        if (!stale()) patch(key, { completedAt: complete ? now() : null });
    } catch (error) {
        if (!stale()) {
            patch(key, {
                error: error.message || 'Finviz quotes are unavailable. Please retry.',
                completedAt: null,
                stocks: getScan(key).stocks.map(stock => ({ ...stock, stale: true })),
            });
        }
    } finally {
        if (!stale()) patch(key, { loading: false, phase: null, retained: 0 });
    }
    return getScan(key);
}

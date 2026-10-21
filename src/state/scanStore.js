// The Overview scan, kept outside React so it survives leaving the page.
//
// One scan per scope (sector, excluded sectors, depth). Screener pages are
// fetched a few at a time and published as soon as each contiguous page lands;
// Yahoo scoring starts on the first rows while later pages are still arriving
// and is flushed to the table in small batches. Navigating away does not cancel
// a run: coming back adopts whatever is in flight, or reuses a recently
// completed scan whose rows keep their original retrieval times.
import { useSyncExternalStore } from 'react';
import { analyzeStock } from '../utils/scoring.js';
import { getYahooQuote, canRaiseTechnicalAlert } from '../utils/marketData.js';
import { formatPrice } from '../utils/format.js';
import { parseFinvizScreener } from '../utils/finviz.js';
import { fetchYahooChart } from '../utils/chartCache.js';
import { createQueue, drainQueue } from '../utils/pool.js';

export const PHOTONICS_TICKERS = ['LITE', 'COHR', 'IPGP', 'MKSI', 'FN', 'CAMT', 'ONTO', 'VIAV'];
export const PAGE_SIZE = 20;          // Finviz screener rows per page
export const MAX_PAGES = 50;
export const PAGE_CONCURRENCY = 4;    // screener pages in flight
export const HYDRATE_CONCURRENCY = 8; // Yahoo chart requests in flight
export const FLUSH_MS = 120;          // how often arriving scores are pushed to the table

export const scanKey = ({ sector = '', excludedSectors = [], targetCount }) =>
    JSON.stringify([sector, [...excludedSectors].sort(), targetCount]);

const EMPTY_SCAN = Object.freeze({ stocks: [], loading: false, phase: null, error: '', startedAt: null, completedAt: null });
const scans = new Map();   // key -> scan state
const runs = new Map();    // key -> latest run id
const listeners = new Set();

export const getScan = (key) => scans.get(key) ?? EMPTY_SCAN;
export const subscribeScans = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
export const useScan = (key) => useSyncExternalStore(subscribeScans, () => getScan(key));
export const scanAge = (scan, now = Date.now()) => (scan.completedAt ? now - Date.parse(scan.completedAt) : Infinity);
export const resetScans = () => { scans.clear(); runs.clear(); };

const emit = () => { for (const listener of listeners) listener(); };
const patch = (key, changes) => { scans.set(key, { ...getScan(key), ...changes }); emit(); };
const positive = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);
const normalizedSector = (value) => (value || '').toLowerCase().replace(/[^a-z]/g, '');

// ─── Alerts raised from a fresh analysis ─────────────────────────────────────
export const dispatchAlertsFromAnalysis = (symbol, analysis, quote) => {
    if (typeof window === 'undefined' || !analysis || !canRaiseTechnicalAlert(quote, quote?.closes?.length ?? 0)) return;
    const { isBreakout, isBreakdown, trend, trendAlertEligible, dipPercentage, currentPrice } = analysis;
    const isBullish = trend === 'bullish' && trendAlertEligible;
    const isBearish = trend === 'bearish' && trendAlertEligible;
    if (!(isBreakdown || isBreakout || isBullish || isBearish)) return;

    if (!window._stockAlertsEmitted) window._stockAlertsEmitted = new Set();
    const typeStr = isBreakout ? 'breakout' : isBreakdown ? 'breakdown' : isBullish ? 'bullish' : 'bearish';
    const cacheKey = `${symbol}-${typeStr}-${quote.quotedAt}`;
    if (window._stockAlertsEmitted.has(cacheKey)) return;
    window._stockAlertsEmitted.add(cacheKey);

    let alertColor = 'blue';
    let message = '';
    if (isBreakdown && dipPercentage >= 15) {
        alertColor = 'amber';
        message = `Price is near the post-peak closing low, ${dipPercentage.toFixed(1)}% below its closing peak, at ${formatPrice(currentPrice)}.`;
    } else if (isBreakout) {
        message = `Price is near the post-peak closing high at ${formatPrice(currentPrice)}.`;
    } else if (isBreakdown) {
        message = `Price is near the post-peak closing low at ${formatPrice(currentPrice)}.`;
    } else if (isBullish) {
        message = `EMA5 is above EMA10 and price is more than 1% above EMA5: ${formatPrice(currentPrice)}.`;
    } else if (isBearish) {
        message = `EMA5 is below EMA10 and price is more than 1% below EMA5: ${formatPrice(currentPrice)}.`;
    }
    window.dispatchEvent(new CustomEvent('stock-alert', {
        detail: { symbol, type: typeStr, color: alertColor, message, timestamp: Date.now(), quotedAt: quote.quotedAt, source: quote.source, delayMinutes: quote.delayMinutes,
            score: Number.isFinite(analysis.score) ? analysis.score : null },
    }));
};

// ─── Yahoo scoring for one symbol (fixed one-month daily series) ─────────────
const fetchQuote = async (chart, symbol) => {
    const { json, fetchedAt } = await chart(symbol);
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    return { meta: result.meta || {}, ...getYahooQuote(result, { range: '1mo', fetchedAt }) };
};

const analyzeSymbol = async (symbol, chart) => {
    try {
        const quote = await fetchQuote(chart, symbol);
        if (!quote || quote.price === null) return null;
        const analysis = analyzeStock(quote.closes, quote.price);
        return analysis ? { ...analysis, quote } : null;
    } catch (error) {
        console.error(`Failed to analyze ${symbol}`, error);
        return null;
    }
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
            if (!quote || quote.price === null) return null;
            const analysis = analyzeStock(quote.closes, quote.price);
            return {
                ...quote, symbol, name: quote.meta.longName ?? quote.meta.shortName ?? symbol,
                changePercentage: quote.changePct, volume: quote.meta.regularMarketVolume ?? null,
                avgVolume: null, marketCap: null,
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
async function scanScreener(key, { sector, excludedSectors, targetCount }, invoke, chart, stale, timers) {
    const accepts = (stock) => stock.changePercentage !== null && stock.changePercentage < 0
        && !excludedSectors.includes(normalizedSector(stock.sector))
        && !(sector && normalizedSector(stock.sector) !== sector);
    const pageUrl = (page) => `https://finviz.com/screener.ashx?v=111&o=change&r=${page * PAGE_SIZE + 1}${sector ? `&f=sec_${encodeURIComponent(sector)}` : ''}`;

    const combined = new Map();   // symbol -> row, in screener order
    const pages = [];             // page index -> parsed rows
    const pending = createQueue(); // rows waiting for a score
    let flushed = 0, next = 0, stopAt = MAX_PAGES, failure = null;
    const publish = () => patch(key, { stocks: [...combined.values()] });

    // Rows are published strictly in page order, so a fast later page never
    // jumps ahead of a slow earlier one.
    const flushPages = () => {
        const added = [];
        while (flushed < stopAt && pages[flushed] !== undefined && combined.size < targetCount) {
            for (const stock of pages[flushed]) {
                if (combined.size >= targetCount) break;
                if (!accepts(stock) || combined.has(stock.symbol)) continue;
                const row = { ...stock, avgVolume: null, fiftyTwoWeekLow: null, fiftyTwoWeekHigh: null, recoveryProbability: null, isZombie: false, analysis: null };
                combined.set(stock.symbol, row);
                added.push(row);
            }
            flushed++;
        }
        if (added.length > 0) { pending.push(...added); publish(); }
    };

    const pageWorker = async () => {
        while (!stale() && !failure) {
            const page = next;
            if (page >= stopAt || combined.size >= targetCount) return;
            next++;
            try {
                const html = await invoke('fetch-url', pageUrl(page));
                if (stale()) return;
                const rows = parseFinvizScreener(html);
                pages[page] = rows;
                // Sorted by change ascending: a short page or a page of gainers ends the losers.
                if (rows.length < PAGE_SIZE || rows.every(stock => stock.changePercentage !== null && stock.changePercentage >= 0)) stopAt = Math.min(stopAt, page + 1);
                flushPages();
            } catch (error) {
                failure ??= error;
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
        }
        publish();
    };
    const scheduleFlush = () => { if (flushTimer === null) flushTimer = timers.setTimeout(flushScores, FLUSH_MS); };

    const paging = Promise.all(Array.from({ length: PAGE_CONCURRENCY }, pageWorker)).finally(() => {
        if (!stale()) patch(key, { phase: 'analysis' });
        pending.close();
    });
    const scoring = drainQueue(pending, HYDRATE_CONCURRENCY, async (row) => {
        const analysis = await analyzeSymbol(row.symbol, chart);
        if (stale()) return;
        scored.set(row.symbol, analysis);
        if (analysis) dispatchAlertsFromAnalysis(row.symbol, analysis, analysis.quote);
        scheduleFlush();
    }, { shouldStop: stale });
    await Promise.all([paging, scoring]);
    if (flushTimer !== null) timers.clearTimeout(flushTimer);
    flushScores();

    if (failure) {
        if (combined.size === 0) throw failure;
        if (!stale()) patch(key, { error: `Scan stopped after ${combined.size} names. ${failure.message || 'Finviz quotes are unavailable.'} The rows shown were retrieved in this scan.` });
        return { complete: false };
    }
    return { complete: true };
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
    patch(key, { loading: true, phase: 'quotes', error: '', startedAt: now() });
    try {
        if (!invoke) throw new Error('Market data requires the desktop app connection. No sample quotes are shown.');
        const chart = (symbol) => fetchYahooChart(invoke, symbol, { range: '1mo', interval: '1d', ttlSeconds: chartCacheSeconds });
        const { complete } = params.sector === 'photonics'
            ? await scanPhotonics(key, chart, stale)
            : await scanScreener(key, params, invoke, chart, stale, timers);
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
        if (!stale()) patch(key, { loading: false, phase: null });
    }
    return getScan(key);
}

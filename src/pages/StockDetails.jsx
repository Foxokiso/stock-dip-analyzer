import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, TrendingDown, AlertTriangle, ArrowUpRight, RefreshCw, BarChart3 } from 'lucide-react';
import { ComposedChart, Area, Line, ReferenceLine, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { analyzeStock, computeSMASeries } from '../utils/scoring';
import { formatPrice, formatQuoteTime } from '../utils/format';
import { getYahooQuote, getYahooChartPoints } from '../utils/marketData';
import { fetchYahooChart } from '../utils/chartCache';
import { getInvoke } from '../utils/bridge.js';
import { useSettings } from '../state/settingsContext.js';
import { finvizQuoteUrl, parseFinvizQuotePage } from '../utils/finvizQuote.js';
import { mountTradingViewWidget } from '../utils/tradingView';
import { useVisibleInterval } from '../utils/useVisibleInterval.js';
import '../styles/pages/stock-details.css';

const RESOURCE_TABS = [
    { id: 'tradingview', label: 'TradingView', type: 'widget' },
    { id: 'finviz',      label: 'Finviz',       type: 'webview', url: finvizQuoteUrl },
    { id: 'chartmill',   label: 'Chartmill',    type: 'webview', url: (s) => `https://www.chartmill.com/stock/quote/${encodeURIComponent(s)}/technical-rating` },
    { id: 'stockcharts', label: 'StockCharts',  type: 'webview', url: (s) => `https://stockcharts.com/h-sc/ui?s=${encodeURIComponent(s)}` },
    { id: 'fidelity',    label: 'Fidelity',     type: 'webview', url: (s) => `https://digital.fidelity.com/prgw/digital/research/quote/dashboard/summary?symbol=${encodeURIComponent(s)}` },
    { id: 'yahoo',       label: 'Yahoo Finance',type: 'webview', url: (s) => `https://finance.yahoo.com/quote/${encodeURIComponent(s)}` },
];

const InternalResourceViewer = ({ symbol, theme }) => {
    const [activeTab, setActiveTab] = useState('tradingview');
    const tvContainerRef = useRef(null);
    const [chartError, setChartError] = useState(null);
    const [chartRetry, setChartRetry] = useState(0);
    const tab = RESOURCE_TABS.find(t => t.id === activeTab);

    useEffect(() => {
        const container = tvContainerRef.current;
        if (activeTab !== 'tradingview' || !container) return;
        // The chart follows the app theme, as on Discovery: a theme switch remounts it.
        return mountTradingViewWidget(container, {
            symbol, interval: 'D', timezone: 'America/New_York', theme, style: '1', locale: 'en', hide_side_toolbar: false,
        }, {
            onReady: () => setChartError(null),
            onError: error => setChartError({ symbol, message: error.message }),
        });
    }, [activeTab, symbol, chartRetry, theme]);

    return (
        <div className="glass-panel sd-panel sd-resource-panel">
            {/* Tab bar */}
            <div className="sd-segmented sd-resource-tabs" role="group" aria-label="Research sources">
                {RESOURCE_TABS.map(t => (
                    <button
                        key={t.id}
                        type="button"
                        className="sd-segment"
                        aria-pressed={activeTab === t.id}
                        onClick={() => setActiveTab(t.id)}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {/* TradingView Widget */}
            {activeTab === 'tradingview' && chartError?.symbol === symbol && (
                <div className="data-notice" role="status">
                    <span>{chartError.message}</span>
                    <button type="button" className="btn btn-outline" onClick={() => setChartRetry(previous => previous + 1)}>Retry chart</button>
                </div>
            )}
            {activeTab === 'tradingview' && (
                <div id="tv_stockdetail_chart" ref={tvContainerRef} className="sd-embed" />
            )}

            {/* Webview for all other tabs */}
            {tab?.type === 'webview' && (
                <webview
                    key={activeTab + symbol}
                    src={tab.url(symbol)}
                    className="sd-embed"
                    allowpopups="true"
                />
            )}
        </div>
    );
};

const RANGES = [
    { value: '1mo', label: '1M' },
    { value: '3mo', label: '3M' },
    { value: '6mo', label: '6M' },
    { value: '1y',  label: '1Y' },
];

const RANGE_TEXT = { '1mo': '1-month', '3mo': '3-month', '6mo': '6-month', '1y': '1-year' };

// Finviz snapshot labels shown in the Key Statistics grid, in display order.
const STAT_DEFS = [
    { label: 'Market Cap' },
    { label: 'P/E' },
    { label: 'Forward P/E' },
    { label: 'EPS (ttm)' },
    { label: 'Dividend TTM', fallback: 'Dividend %' },
    { label: 'Beta' },
    // Finviz's own figure (Wilder's RSI), not the simple RSI in the page header.
    { label: 'RSI (14)', title: "Finviz's RSI (14), Wilder's method" },
    { label: 'Volume' },
    { label: 'Avg Volume' },
    { label: 'Rel Volume' },
    // Finviz prints the bound, then the price's distance from it: "351.73 -2.02%".
    { label: '52W High', distance: true, title: "Finviz's 52-week high, then the price's distance from it" },
    { label: '52W Low', distance: true, title: "Finviz's 52-week low, then the price's distance from it" },
    { label: 'Target Price' },
    { label: 'Short Float' },
    { label: 'Perf Week' },
    { label: 'Perf Month' },
];

// Chromium parses SVG presentation attributes and inline styles as CSS, so the
// role tokens reach Recharts as var() references: the marks re-skin on a theme
// switch without a computed-style snapshot. The tooltip is an HTML div whose
// default inline style is merged key by key, so longhands override its defaults.
const CHART_TOOLTIP_STYLE = {
    backgroundColor: 'var(--bg-raised)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--radius-sm)',
    boxShadow: 'var(--glass-shadow)',
    color: 'var(--text-main)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    padding: '7px 10px',
};
const CHART_TOOLTIP_LABEL_STYLE = { color: 'var(--text-muted)', marginBottom: 4 };
// Item colour is left to Recharts so each row carries its own series stroke.
const CHART_TOOLTIP_ITEM_STYLE = { paddingTop: 2, paddingBottom: 2 };
const CHART_TOOLTIP_CURSOR = { stroke: 'var(--line-strong)', strokeDasharray: '3 3' };
const CHART_TICK = { fill: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)' };
const CHART_AXIS_LINE = { stroke: 'var(--line)' };

// Price axis. A flat $5 pad ('dataMin - 5') sends every sub-$5 name below zero and
// flattens its line. The domain spans the plotted closes and both reference lines (so
// they stay in view), padded by 8 % of that span or 1 % of the high, whichever is more
// (a flat or narrow series still gets room), and never below zero. Ticks sit on a 1-2-5
// step and print the decimals the step needs, so sub-$1 names stay legible and no two
// ticks share a label.
const priceAxis = (values) => {
    const prices = values.filter(value => Number.isFinite(value) && value > 0);
    if (prices.length === 0) return null;
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const pad = Math.max((high - low) * 0.08, high * 0.01);
    const domain = [Math.max(0, low - pad), high + pad];
    const rough = (domain[1] - domain[0]) / 5;
    let exponent = Math.floor(Math.log10(rough));
    const fraction = rough / 10 ** exponent;
    let unit = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
    if (unit === 10) { unit = 1; exponent += 1; }
    const step = unit * 10 ** exponent;
    const decimals = Math.min(20, Math.max(2, -exponent));
    const ticks = [];
    for (let index = Math.ceil(domain[0] / step); index * step <= domain[1]; index++) {
        ticks.push(Number((index * step).toFixed(decimals)));
    }
    return { domain, ticks, decimals };
};

// formatPrice keeps two decimals app-wide (the native parity suite mirrors it), so the
// chart's own precision stays here: tick labels follow the step, and the tooltip shows
// sub-$1 closes to the 1/100 cent they are quoted in.
const chartPrice = (value, decimals) => (Number.isFinite(value) ? `$${value.toFixed(decimals)}` : '—');

// Desktop bridge in the legacy { ipcRenderer.invoke } shape this page uses throughout.
const getElectron = () => {
    const invoke = getInvoke();
    return invoke ? { ipcRenderer: { invoke } } : null;
};

const positiveOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

// Tones name the brief's semantic roles in the stylesheet (success / warning /
// danger / muted) and follow the verdict label, as on every page: buys are
// success, Hold is warning, Sell and Strong Sell are danger. The score box and
// the dip pill take the chip's tone, so the box's bands are the verdict bands
// (80/60/40/20). The scorer's own colour strings are never rendered.
const VERDICT_TONES = { 'Strong Buy': 'success', Buy: 'success', Hold: 'warning', Sell: 'danger', 'Strong Sell': 'danger' };
const verdictTone = (verdict) => VERDICT_TONES[verdict?.label] ?? 'muted';

const factorTone = (points) => (points > 0 ? 'up' : points < 0 ? 'down' : 'flat');

const StockDetails = ({ autoRefreshInterval = 0 }) => {
    const { symbol } = useParams();
    const { settings } = useSettings();
    const electron = useMemo(() => getElectron(), []);
    const chartCacheSeconds = settings.data.chartCacheSeconds;
    const [range, setRange] = useState('1mo');
    const [chartData, setChartData] = useState([]);
    const [finvizPage, setFinvizPage] = useState(null); // parseFinvizQuotePage result | null
    const [technicalQuote, setTechnicalQuote] = useState(null);
    const [technicalPoints, setTechnicalPoints] = useState([]);
    const [technicalError, setTechnicalError] = useState('');
    const [technicalStale, setTechnicalStale] = useState(false);
    // Every source starts loading on mount, so the first paint says "loading", not "unavailable".
    const [technicalRefreshing, setTechnicalRefreshing] = useState(true);
    const [finvizError, setFinvizError] = useState('');
    const [finvizStale, setFinvizStale] = useState(false);
    const [finvizRefreshing, setFinvizRefreshing] = useState(true);
    const [finvizFetchedAt, setFinvizFetchedAt] = useState(null);
    const [chartLoading, setChartLoading] = useState(true);
    const [chartError, setChartError] = useState(false);
    const [chartRetry, setChartRetry] = useState(0);
    const [dataScope, setDataScope] = useState({ symbol, range });

    // Fetched data belongs to the symbol (and the chart to the range) it was
    // requested for. A switch drops it here, while rendering: React discards this
    // render and runs it again before anything is committed, so no frame pairs the
    // new symbol or range with the previous one's numbers. Clearing it in the
    // effects instead left a painted frame of the old stock under the new symbol.
    if (dataScope.symbol !== symbol || dataScope.range !== range) {
        setDataScope({ symbol, range });
        setChartData([]);
        setChartError(false);
        setChartLoading(true);
        if (dataScope.symbol !== symbol) {
            setTechnicalQuote(null);
            setTechnicalPoints([]);
            setTechnicalError('');
            setTechnicalStale(false);
            setTechnicalRefreshing(true);
            setFinvizPage(null);
            setFinvizFetchedAt(null);
            setFinvizError('');
            setFinvizStale(false);
            setFinvizRefreshing(true);
        }
    }

    // Refresh data, Retry and the auto-refresh tick re-run every fetch below. The
    // loading state is set here, in the same render, rather than by the effects.
    const refresh = () => {
        setChartRetry(value => value + 1);
        setChartLoading(true);
        setChartError(false);
        setTechnicalRefreshing(true);
        setTechnicalError('');
        setFinvizRefreshing(true);
        setFinvizError('');
    };

    // Effect A: fetch the price chart whenever symbol or range changes. Only the
    // chart panel waits for it: the header and score (Yahoo 1-month history), the
    // research viewer and the Finviz sections each load and fail on their own.
    // A failed refresh keeps this chart's own earlier points; another symbol's or
    // range's never reach it (see above).
    useEffect(() => {
        let cancelled = false;

        const finish = () => {
            if (!cancelled) setChartLoading(false);
        };

        const loadChart = async () => {
            if (!electron) {
                setChartError(true);
                finish();
                return;
            }

            try {
                const { json: yahooData } = await fetchYahooChart(electron.ipcRenderer.invoke, symbol, { range, interval: '1d', ttlSeconds: chartCacheSeconds });
                const result = yahooData?.chart?.result?.[0];
                if (cancelled) return;
                if (result) {
                    const points = getYahooChartPoints(result);
                    if (points.length === 0) throw new Error('No usable chart points returned.');
                    setChartData(points);
                } else {
                    setChartError(true);
                }
            } catch (err) {
                console.error("Error loading chart data:", err);
                if (!cancelled) {
                    setChartError(true);
                }
            } finally {
                finish();
            }
        };

        loadChart();
        return () => { cancelled = true; };
    }, [electron, symbol, range, chartRetry, chartCacheSeconds]);

    // The score uses a fixed month regardless of the chart's selected display range.
    useEffect(() => {
        let cancelled = false;
        const loadTechnical = async () => {
            if (!electron) {
                setTechnicalError('Market data requires the desktop app connection. No sample quotes are shown.');
                setTechnicalStale(true);
                setTechnicalRefreshing(false);
                return;
            }
            try {
                const { json, fetchedAt } = await fetchYahooChart(electron.ipcRenderer.invoke, symbol, { range: '1mo', interval: '1d', ttlSeconds: chartCacheSeconds });
                const result = json?.chart?.result?.[0];
                const quote = getYahooQuote(result, { range: '1mo', fetchedAt });
                if (quote.price === null || quote.closes.length < 15) throw new Error('Quote or sufficient daily history is unavailable from Yahoo Finance.');
                if (!cancelled) {
                    // The chart metadata also carries the 52-week range (the Overview's source for it).
                    setTechnicalQuote({
                        ...quote,
                        fiftyTwoWeekLow: positiveOrNull(result.meta?.fiftyTwoWeekLow),
                        fiftyTwoWeekHigh: positiveOrNull(result.meta?.fiftyTwoWeekHigh),
                    });
                    setTechnicalPoints(getYahooChartPoints(result));
                    setTechnicalStale(false);
                }
            } catch (error) {
                if (!cancelled) {
                    setTechnicalError(error.message || 'Technical history is unavailable.');
                    setTechnicalStale(true);
                }
            } finally {
                if (!cancelled) setTechnicalRefreshing(false);
            }
        };
        loadTechnical();
        return () => { cancelled = true; };
    }, [electron, symbol, chartRetry, chartCacheSeconds]);

    useVisibleInterval(refresh, autoRefreshInterval, { resetKey: symbol });

    // Finviz statistics and news have their own retrieval time and error state.
    useEffect(() => {
        let cancelled = false;

        const loadFinviz = async () => {
            const electron = getElectron();

            if (!electron) {
                setFinvizError('Finviz statistics and news require the desktop app connection.');
                setFinvizStale(true);
                setFinvizRefreshing(false);
                return;
            }

            try {
                const finvizHtml = await electron.ipcRenderer.invoke('fetch-url', finvizQuoteUrl(symbol));
                const page = parseFinvizQuotePage(finvizHtml);
                if (!cancelled) {
                    setFinvizPage(page);
                    setFinvizFetchedAt(new Date().toISOString());
                    setFinvizStale(false);
                }
            } catch (err) {
                console.error("Error loading Finviz data:", err);
                if (!cancelled) {
                    setFinvizError('Finviz statistics and news refresh failed. Please retry.');
                    setFinvizStale(true);
                }
            } finally {
                if (!cancelled) setFinvizRefreshing(false);
            }
        };

        loadFinviz();
        return () => { cancelled = true; };
    }, [symbol, chartRetry]);

    // Shared scoring engine on the fetched closes.
    const closes = useMemo(() => chartData.map(d => d.price), [chartData]);
    const analysis = useMemo(() => technicalQuote ? analyzeStock(technicalQuote.closes, technicalQuote.price) : null, [technicalQuote]);
    const smaSeries = useMemo(() => computeSMASeries(closes, 20), [closes]);
    const plotData = useMemo(
        () => chartData.map((d, i) => ({ ...d, sma: smaSeries[i] })),
        [chartData, smaSeries]
    );

    const score = analysis?.score ?? null;
    const verdict = analysis?.verdict ?? null;
    const currentPrice = technicalQuote?.price ?? null;
    const peakPrice = analysis?.peakPrice ?? null;
    const peakIndex = analysis?.peakIndex ?? 0;
    const dipPercentage = analysis ? analysis.dipPercentage.toFixed(2) : null;
    const recentLow = analysis?.recentLow ?? null;
    const rsi = analysis?.rsi ?? null;
    const trend = analysis?.trend ?? null;

    const axis = useMemo(
        () => priceAxis([...plotData.map(point => point.price), peakPrice, recentLow]),
        [plotData, peakPrice, recentLow]
    );

    const peakDate = analysis && technicalQuote && peakPrice > Math.max(...technicalQuote.closes)
        ? formatQuoteTime(technicalQuote.quotedAt) : technicalPoints[peakIndex]?.date ?? 'Unavailable';

    // Where the price "normalized" before the crash (average of up to 5 days leading up to the peak)
    let normalizedHigh = peakPrice;
    if (peakIndex >= 1) {
        const daysToAverage = Math.min(peakIndex, 5);
        const prePeakPrices = technicalPoints.slice(peakIndex - daysToAverage, peakIndex).map(d => d.price);
        normalizedHigh = prePeakPrices.reduce((a, b) => a + b, 0) / prePeakPrices.length;
    }

    const tone = verdictTone(verdict);

    // Header pill tones. The dip is read through its rating, so its pill matches the
    // verdict; an unavailable dip is shown as unavailable, not as a signal.
    const dipTone = dipPercentage === null ? 'muted' : tone;
    const rsiTone = rsi === null
        ? 'muted'
        : rsi <= 30 ? 'success' : rsi >= 70 ? 'danger' : 'muted';
    const trendTone = trend === 'bullish'
        ? 'success'
        : trend === 'bearish' ? 'danger' : 'muted';
    const trendLabel = trend ? trend.charAt(0).toUpperCase() + trend.slice(1) : '—';

    // A section with nothing retrieved yet says it is loading rather than unavailable.
    const technicalPending = technicalRefreshing && !technicalQuote;
    const finvizPending = finvizRefreshing && !finvizFetchedAt;

    const stats = finvizPage?.stats.size > 0 ? finvizPage.stats : null;
    const news = useMemo(() => finvizPage?.news.slice(0, 10) ?? [], [finvizPage]);

    // 52-week bounds from Finviz's '52W High' / '52W Low', else from the Yahoo chart
    // metadata; the caption names the source shown. Finviz's bounds can lag the
    // session: on a new high its 52W High reads like "184.88 1.28%", the price above
    // it. A price outside them is placed on Yahoo's range instead, which counts today.
    const fiftyTwoWeek = useMemo(() => {
        const sources = [
            { low: finvizPage?.fiftyTwoWeekLow, high: finvizPage?.fiftyTwoWeekHigh, source: 'Finviz' },
            { low: technicalQuote?.fiftyTwoWeekLow, high: technicalQuote?.fiftyTwoWeekHigh, source: 'Yahoo Finance' },
        ].filter(({ low, high }) => low > 0 && high > low);
        return sources.find(({ low, high }) => currentPrice >= low && currentPrice <= high) ?? sources[0] ?? null;
    }, [finvizPage, technicalQuote, currentPrice]);

    const fiftyTwoWeekPct = fiftyTwoWeek && currentPrice > 0
        ? Math.min(100, Math.max(0, ((currentPrice - fiftyTwoWeek.low) / (fiftyTwoWeek.high - fiftyTwoWeek.low)) * 100))
        : null;
    // A price beyond every source's bounds is named as such, not pinned to 0 % or 100 %.
    const fiftyTwoWeekPosition = fiftyTwoWeekPct === null ? null
        : currentPrice > fiftyTwoWeek.high ? `above the ${fiftyTwoWeek.source} 52-week high`
        : currentPrice < fiftyTwoWeek.low ? `below the ${fiftyTwoWeek.source} 52-week low`
        : `${fiftyTwoWeekPct.toFixed(0)}% of the ${fiftyTwoWeek.source} 52-week range`;

    const rangeLabel = RANGES.find(r => r.value === range)?.label ?? '1M';
    const rangeText = RANGE_TEXT[range] ?? '1-month';

    return (
        <div className="stock-details">
            <Link to="/" className="btn btn-outline sd-back">
                <ArrowLeft size={16} /> Back to Dashboard
            </Link>

            <div className="sd-header">
                <div>
                    <h1 className="sd-title" tabIndex={-1}>
                        <span className="sd-symbol">{symbol}</span>
                        {!technicalPending && (
                            <>
                                <span className={`sd-pill sd-pill--${dipTone}`}>
                                    <TrendingDown size={14} /> {dipPercentage === null ? 'Dip unavailable' : `${dipPercentage}% below 1M closing high`}
                                </span>
                                <span className={`sd-pill sd-pill--${rsiTone}`} title="Simple 14-period RSI over one month of closes; Finviz and TradingView show Wilder's RSI">
                                    Simple RSI {rsi !== null ? rsi.toFixed(0) : '—'}
                                </span>
                                <span className={`sd-pill sd-pill--${trendTone}`}>
                                    {trendLabel}
                                </span>
                            </>
                        )}
                    </h1>
                    {technicalPending ? (
                        <p className="sd-quote-line sd-quote-line--pending" role="status">
                            <RefreshCw size={14} className="sd-spin" /> Analyzing {symbol}: loading the Yahoo Finance quote and 1-month history…
                        </p>
                    ) : (
                        <p className="sd-quote-line">
                            <span>Latest Quote: <strong>{formatPrice(currentPrice)}</strong></span>
                            <span className="sd-quote-sep" aria-hidden="true">|</span>
                            <span>Peak: <strong>{formatPrice(peakPrice)}</strong> on {peakDate}</span>
                            <span className="sd-quote-sep" aria-hidden="true">|</span>
                            <span>Pre-peak average: <strong>{formatPrice(normalizedHigh)}</strong></span>
                        </p>
                    )}
                </div>
                <button type="button" className="btn btn-primary sd-refresh" onClick={refresh} disabled={chartLoading}>
                    <RefreshCw size={14} /> Refresh data
                </button>
            </div>

            <div className="data-source-line sd-source-line">
                {technicalPending ? (
                    <span>Yahoo Finance · Loading quote…</span>
                ) : (
                    <span>Yahoo Finance · Quote: {formatQuoteTime(technicalQuote?.quotedAt)} · Retrieved: {formatQuoteTime(technicalQuote?.fetchedAt)} · {technicalQuote?.delayMinutes == null ? 'Delay unknown' : `${technicalQuote.delayMinutes} minute delay`}</span>
                )}
                {technicalQuote && technicalRefreshing && <span className="sd-source-refreshing">· Refreshing; previous quote retained</span>}
                {technicalQuote && technicalStale && <span className="sd-source-stale">· Cached quote; refresh failed</span>}
            </div>
            {technicalError && <p className="data-notice" role="alert">{technicalError}</p>}

            {/* Internal Resource Viewer */}
            <InternalResourceViewer symbol={symbol} theme={settings.appearance.theme} />


            <div className="glass-panel sd-panel sd-chart-panel">
                <div className="sd-panel-head">
                    <h2>
                        Price Action ({rangeLabel})
                        {chartLoading && <RefreshCw size={16} className="sd-spin" />}
                    </h2>
                    <div className="sd-segmented sd-range-switch" role="group" aria-label="Chart range">
                        {RANGES.map(r => (
                            <button
                                key={r.value}
                                type="button"
                                className="sd-segment"
                                aria-pressed={range === r.value}
                                onClick={() => setRange(r.value)}
                            >
                                {r.label}
                            </button>
                        ))}
                    </div>
                </div>
                {chartError && plotData.length > 0 && <p className="data-notice" role="alert">Chart refresh failed. Previously retrieved historical points are retained.</p>}
                {chartError && plotData.length === 0 ? (
                    <div className="sd-chart-empty">
                        <p>
                            Failed to load {rangeText} chart data for {symbol}.
                        </p>
                        <button type="button" className="btn btn-outline" onClick={refresh}>
                            Retry
                        </button>
                    </div>
                ) : chartLoading && plotData.length === 0 ? (
                    <div className="sd-chart-empty" role="status">
                        <RefreshCw size={28} className="sd-spin" />
                        <p>Loading {rangeText} chart data for {symbol}…</p>
                    </div>
                ) : (
                <div className="sd-chart">
                <ResponsiveContainer width="100%" height={320}>
                    <ComposedChart data={plotData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                        <defs>
                            <linearGradient id="sdPriceFill" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="var(--secondary)" stopOpacity={0.46} />
                                <stop offset="95%" stopColor="var(--secondary)" stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                        <XAxis dataKey="date" stroke="var(--line)" tick={CHART_TICK} tickLine={false} axisLine={CHART_AXIS_LINE} minTickGap={24} />
                        <YAxis stroke="var(--line)" domain={axis?.domain ?? ['auto', 'auto']} ticks={axis?.ticks} tick={CHART_TICK} tickFormatter={value => chartPrice(value, axis?.decimals ?? 2)} tickLine={false} axisLine={false} width={72} />
                        <Tooltip
                            cursor={CHART_TOOLTIP_CURSOR}
                            contentStyle={CHART_TOOLTIP_STYLE}
                            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                            itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                            formatter={(value, name) => [chartPrice(value, value < 1 ? 4 : 2), name]}
                        />
                        <Area type="monotone" dataKey="price" name="Price" stroke="var(--secondary)" strokeWidth={2} fillOpacity={1} fill="url(#sdPriceFill)" dot={false} activeDot={{ r: 4, fill: 'var(--secondary)', stroke: 'var(--bg-dark)', strokeWidth: 2 }} isAnimationActive={false} />
                        <Line type="monotone" dataKey="sma" name="SMA 20" stroke="var(--primary)" strokeWidth={1.5} dot={false} activeDot={{ r: 3, fill: 'var(--primary)', stroke: 'var(--bg-dark)', strokeWidth: 2 }} connectNulls isAnimationActive={false} />
                        {peakPrice > 0 && (
                            <ReferenceLine
                                y={peakPrice}
                                stroke="var(--primary-x)"
                                strokeDasharray="4 4"
                                label={{ value: '1M closing high', position: 'insideTopRight', fill: 'var(--primary-x)', fontSize: 11 }}
                            />
                        )}
                        {recentLow !== null && (
                            <ReferenceLine
                                y={recentLow}
                                stroke="var(--danger)"
                                strokeDasharray="4 4"
                                label={{ value: 'Post-peak closing low', position: 'insideBottomRight', fill: 'var(--danger)', fontSize: 11 }}
                            />
                        )}
                    </ComposedChart>
                </ResponsiveContainer>
                </div>
                )}
            </div>

            {/* Key Statistics (Finviz snapshot) */}
            <div className="glass-panel sd-panel sd-stats-panel">
                <h2>
                    <BarChart3 size={18} className="sd-icon--primary" />
                    Key Statistics (Finviz)
                </h2>
                <p className="sd-meta">Finviz · delayed 1 minute · quote time unavailable · {finvizPending ? 'retrieving…' : `retrieved ${formatQuoteTime(finvizFetchedAt)}`}</p>
                {finvizFetchedAt && finvizRefreshing && <p className="sd-meta sd-meta--refreshing">Refreshing · previous statistics and headlines retained.</p>}
                {finvizFetchedAt && finvizStale && <p className="data-notice">Cached statistics and headlines · original retrieval time retained.</p>}
                {finvizError && <p className="data-notice" role="alert">{finvizError}</p>}
                {stats ? (
                    <div className="sd-stats-grid">
                        {STAT_DEFS.map(def => {
                            const value = stats.get(def.label)
                                ?? (def.fallback ? stats.get(def.fallback) : undefined)
                                ?? '—';
                            // The parser collapses whitespace, so one space parts bound and distance.
                            const split = def.distance ? value.indexOf(' ') : -1;
                            return (
                                <div key={def.label} className="sd-stat" title={def.title}>
                                    <div className="sd-stat-label">{def.label}</div>
                                    <div className="sd-stat-value">
                                        {split > 0 ? (
                                            <>{value.slice(0, split)}<span className="sd-stat-sub">{value.slice(split + 1)}</span></>
                                        ) : value}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : finvizPending ? (
                    <p className="sd-empty" role="status">Loading Finviz statistics…</p>
                ) : (
                    <p className="sd-empty">Statistics unavailable</p>
                )}
                {/* Outside the Finviz grid: the Yahoo bounds still place the price when Finviz
                    fails. It waits for both sources rather than show Yahoo's range first and
                    then switch to Finviz's. */}
                {technicalPending || finvizPending ? null : fiftyTwoWeekPosition === null ? (
                    <p className="sd-empty">52-week position unavailable</p>
                ) : (
                    <div className="sd-range">
                        <div className="sd-range-label">52-Week Position</div>
                        <div className="sd-range-row">
                            <span className="sd-range-bound">{formatPrice(fiftyTwoWeek.low)}</span>
                            <div
                                className="sd-range-track"
                                role="img"
                                aria-label={`52-week position: current ${formatPrice(currentPrice)}, ${fiftyTwoWeekPosition} (${formatPrice(fiftyTwoWeek.low)} to ${formatPrice(fiftyTwoWeek.high)})`}
                            >
                                <div className="sd-range-marker" style={{ left: `${fiftyTwoWeekPct}%` }} />
                            </div>
                            <span className="sd-range-bound">{formatPrice(fiftyTwoWeek.high)}</span>
                        </div>
                        <div className="sd-range-caption">
                            Current {formatPrice(currentPrice)} — {fiftyTwoWeekPosition}
                        </div>
                    </div>
                )}
            </div>

            <div className="sd-grid">
                <div className="glass-panel sd-panel sd-analysis-panel">
                    <h2>
                        <AlertTriangle size={18} className="sd-icon--warning" />
                        Technical Analysis (1M)
                    </h2>
                    <p className="sd-analysis-text">
                        {technicalPending ? (
                            <>Loading the 1-month Yahoo Finance history…</>
                        ) : !analysis ? (
                            <>No score is available. At least 15 valid daily closes and a provider quote are required.</>
                        ) : (
                            <>Over the fixed 1-month daily history, {symbol} is {dipPercentage}% below its closing high of {formatPrice(peakPrice)}. The score combines dip depth, bounce distance, EMA momentum, and simple RSI(14). It is a technical heuristic from price history, not a forecast or a recovery probability.</>
                        )}
                    </p>

                    {/* Factor-by-factor score breakdown */}
                    {analysis && analysis.factors.length > 0 && (
                        <div className="sd-factors">
                            {analysis.factors.map((f, idx) => (
                                <div key={idx} className="sd-factor">
                                    <span className={`sd-factor-points sd-factor-points--${factorTone(f.points)}`}>
                                        {f.points > 0 ? `+${f.points}` : `${f.points}`}
                                    </span>
                                    <div className="sd-factor-body">
                                        <div className="sd-factor-label">{f.label}</div>
                                        <div className="sd-factor-detail">{f.detail}</div>
                                    </div>
                                </div>
                            ))}
                            <p className="sd-factor-note">
                                Score starts at 50; factors sum and clamp to 0–100.
                            </p>
                        </div>
                    )}

                    {analysis && (
                    <div className={`sd-score sd-score--${tone}`}>
                        <ArrowUpRight size={18} />
                        <span className="sd-score-value">{`Technical Score: ${score}/100`}</span>
                        {verdict && (
                            <span className={`sd-verdict sd-verdict--${tone}`}>
                                {verdict.label}
                            </span>
                        )}
                    </div>
                    )}
                </div>

                <div className="glass-panel sd-panel sd-news-panel">
                    <h2>Recent Headlines (Finviz)</h2>
                    {news.length === 0 ? (
                        finvizPending
                            ? <p className="sd-empty" role="status">Loading Finviz headlines…</p>
                            : <p className="sd-empty">{finvizError ? 'News unavailable from Finviz.' : 'No recent headlines returned.'}</p>
                    ) : (
                        <ul className="sd-news-list">
                            {news.map((item, idx) => (
                                <li key={idx} className="sd-news-item">
                                    <div className="sd-news-meta">
                                        <span className="sd-news-time">{item.time} ET</span>
                                        {item.source && (
                                            <span className="sd-news-source">{item.source}</span>
                                        )}
                                    </div>
                                    <h3 className="sd-news-title">
                                        <a href={item.link} target="_blank" rel="noreferrer">
                                            {item.title}
                                        </a>
                                    </h3>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
};

export default StockDetails;

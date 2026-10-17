import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, TrendingDown, AlertTriangle, ArrowUpRight, RefreshCw, BarChart3 } from 'lucide-react';
import { ComposedChart, Area, Line, ReferenceLine, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { analyzeStock, computeSMASeries } from '../utils/scoring';
import { formatPrice, formatQuoteTime } from '../utils/format';
import { getYahooQuote, getYahooChartPoints } from '../utils/marketData';
import { mountTradingViewWidget } from '../utils/tradingView';
import '../styles/pages/stock-details.css';

const RESOURCE_TABS = [
    { id: 'tradingview', label: 'TradingView', type: 'widget' },
    { id: 'finviz',      label: 'Finviz',       type: 'webview', url: (s) => `https://finviz.com/quote.ashx?t=${s}&p=d` },
    { id: 'chartmill',   label: 'Chartmill',    type: 'webview', url: (s) => `https://www.chartmill.com/stock/quote/${s}/technical-rating` },
    { id: 'stockcharts', label: 'StockCharts',  type: 'webview', url: (s) => `https://stockcharts.com/h-sc/ui?s=${s}` },
    { id: 'fidelity',    label: 'Fidelity',     type: 'webview', url: (s) => `https://digital.fidelity.com/prgw/digital/research/quote/dashboard/summary?symbol=${s}` },
    { id: 'yahoo',       label: 'Yahoo Finance',type: 'webview', url: (s) => `https://finance.yahoo.com/quote/${s}` },
];

const InternalResourceViewer = ({ symbol }) => {
    const [activeTab, setActiveTab] = useState('tradingview');
    const tvContainerRef = useRef(null);
    const [chartError, setChartError] = useState(null);
    const [chartRetry, setChartRetry] = useState(0);
    const tab = RESOURCE_TABS.find(t => t.id === activeTab);

    useEffect(() => {
        const container = tvContainerRef.current;
        if (activeTab !== 'tradingview' || !container) return;
        return mountTradingViewWidget(container, {
            autosize: true, symbol, interval: 'D', timezone: 'America/New_York', theme: 'dark',
            style: '1', locale: 'en', enable_publishing: false, hide_side_toolbar: false,
            container_id: 'tv_stockdetail_chart',
        }, {
            onReady: () => setChartError(null),
            onError: error => setChartError({ symbol, message: error.message }),
        });
    }, [activeTab, symbol, chartRetry]);

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
    { label: 'RSI (14)' },
    { label: 'Volume' },
    { label: 'Avg Volume' },
    { label: 'Rel Volume' },
    { label: '52W High' },
    { label: '52W Low' },
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

const getElectron = () => (
    typeof window !== 'undefined' && typeof window.require === 'function'
        ? window.require('electron')
        : null
);

// Tones name the brief's semantic roles in the stylesheet (success / warning /
// danger / muted). The scorer's own colour strings are never rendered.
const scoreTone = (score, isZombie) => {
    if (isZombie) return 'muted';
    if (score >= 70) return 'success';
    if (score >= 40) return 'warning';
    return 'danger';
};

const VERDICT_TONES = { 'Strong Buy': 'success', Buy: 'success', Hold: 'warning', Sell: 'danger', 'Strong Sell': 'danger' };
const verdictTone = (verdict, isZombie) => (isZombie ? 'muted' : (VERDICT_TONES[verdict?.label] ?? 'muted'));

const factorTone = (points) => (points > 0 ? 'up' : points < 0 ? 'down' : 'flat');

const StockDetails = ({ autoRefreshInterval = 0 }) => {
    const { symbol } = useParams();
    const [range, setRange] = useState('1mo');
    const [chartData, setChartData] = useState([]);
    const [news, setNews] = useState([]);
    const [stats, setStats] = useState(null); // Map<label, value> | null
    const [technicalQuote, setTechnicalQuote] = useState(null);
    const [technicalPoints, setTechnicalPoints] = useState([]);
    const [technicalError, setTechnicalError] = useState('');
    const [technicalStale, setTechnicalStale] = useState(false);
    const [technicalRefreshing, setTechnicalRefreshing] = useState(false);
    const [finvizError, setFinvizError] = useState('');
    const [finvizStale, setFinvizStale] = useState(false);
    const [finvizRefreshing, setFinvizRefreshing] = useState(false);
    const [finvizFetchedAt, setFinvizFetchedAt] = useState(null);
    const [loading, setLoading] = useState(true);        // full-page, first load of a symbol only
    const [chartLoading, setChartLoading] = useState(true); // chart panel only (range switches)
    const [chartError, setChartError] = useState(false);
    const [chartRetry, setChartRetry] = useState(0);
    const lastSymbolRef = useRef(null);
    const chartScopeRef = useRef(null);
    const technicalSymbolRef = useRef(null);
    const finvizSymbolRef = useRef(null);

    // Effect A: fetch the price chart whenever symbol or range changes.
    // Only a NEW SYMBOL gates the whole page behind the spinner; range switches
    // keep the body (resource viewer, stats, news) mounted and just refresh the
    // chart panel. Old data is cleared on symbol change and on failure so a
    // failed fetch can never render the previous stock's numbers.
    useEffect(() => {
        let cancelled = false;
        const isNewSymbol = lastSymbolRef.current !== symbol;
        if (isNewSymbol) {
            lastSymbolRef.current = symbol;
            setLoading(true);
        }
        setChartLoading(true);
        const chartScope = `${symbol}:${range}`;
        if (chartScopeRef.current !== chartScope) {
            chartScopeRef.current = chartScope;
            setChartData([]);
        }
        setChartError(false);

        const finish = () => {
            if (cancelled) return;
            setChartLoading(false);
            setLoading(false);
        };

        const loadChart = async () => {
            const electron = getElectron();

            if (!electron) {
                setChartError(true);
                finish();
                return;
            }

            try {
                const yahooData = await electron.ipcRenderer.invoke('fetch-yahoo-chart', symbol, range, '1d');
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
    }, [symbol, range, chartRetry]);

    // The score uses a fixed month regardless of the chart's selected display range.
    useEffect(() => {
        let cancelled = false;
        if (technicalSymbolRef.current !== symbol) {
            technicalSymbolRef.current = symbol;
            setTechnicalQuote(null);
            setTechnicalPoints([]);
            setTechnicalStale(false);
        }
        setTechnicalRefreshing(true);
        setTechnicalError('');
        const loadTechnical = async () => {
            const electron = getElectron();
            if (!electron) {
                setTechnicalError('Market data requires the desktop app connection. No sample quotes are shown.');
                setTechnicalStale(true);
                setTechnicalRefreshing(false);
                return;
            }
            try {
                const json = await electron.ipcRenderer.invoke('fetch-yahoo-chart', symbol, '1mo', '1d');
                const result = json?.chart?.result?.[0];
                const quote = getYahooQuote(result, { range: '1mo' });
                if (quote.price === null || quote.closes.length < 15) throw new Error('Quote or sufficient daily history is unavailable from Yahoo Finance.');
                if (!cancelled) {
                    setTechnicalQuote(quote);
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
    }, [symbol, chartRetry]);

    useEffect(() => {
        if (autoRefreshInterval <= 0) return;
        const timer = setInterval(() => setChartRetry(value => value + 1), autoRefreshInterval * 60 * 1000);
        return () => clearInterval(timer);
    }, [autoRefreshInterval]);

    // Finviz statistics and news have their own retrieval time and error state.
    useEffect(() => {
        let cancelled = false;
        if (finvizSymbolRef.current !== symbol) {
            finvizSymbolRef.current = symbol;
            setNews([]);
            setStats(null);
            setFinvizFetchedAt(null);
            setFinvizStale(false);
        }
        setFinvizRefreshing(true);
        setFinvizError('');

        const loadFinviz = async () => {
            const electron = getElectron();

            if (!electron) {
                setFinvizError('Finviz statistics and news require the desktop app connection.');
                setFinvizStale(true);
                setFinvizRefreshing(false);
                return;
            }

            try {
                const finvizUrl = `https://finviz.com/quote.ashx?t=${symbol}&p=d`;
                const finvizHtml = await electron.ipcRenderer.invoke('fetch-url', finvizUrl);
                const parser = new DOMParser();
                const doc = parser.parseFromString(finvizHtml, 'text/html');

                // --- News (up to 10 items) ---
                const newsRows = doc.querySelectorAll('#news-table tr');
                const extractedNews = [];
                let lastDate = "";

                for (let i = 0; i < newsRows.length && extractedNews.length < 10; i++) {
                    const row = newsRows[i];
                    const cells = row.querySelectorAll('td');
                    if (cells.length === 2) {
                        const timeRaw = cells[0].textContent.trim();
                        // Finviz formats times like "Oct-14-23 09:00AM" or just "09:00AM" if it's the same day
                        if (timeRaw.includes(' ')) {
                            lastDate = timeRaw.split(' ')[0];
                        }

                        const time = timeRaw.includes(' ') ? timeRaw : `${lastDate} ${timeRaw}`;

                        const linkEl = cells[1].querySelector('a');
                        if (linkEl) {
                            let source = '';
                            try {
                                source = new URL(linkEl.href).hostname.replace(/^www\./, '');
                            } catch {
                                source = '';
                            }
                            extractedNews.push({
                                time,
                                title: linkEl.textContent.trim(),
                                link: linkEl.href,
                                source,
                            });
                        }
                    }
                }

                // --- Key statistics: snapshot table comes in label/value cell pairs ---
                const snapshotCells = doc.querySelectorAll('.snapshot-table2 td');
                const statMap = new Map();
                for (let i = 0; i + 1 < snapshotCells.length; i += 2) {
                    const label = snapshotCells[i].textContent.trim();
                    const value = snapshotCells[i + 1].textContent.trim();
                    if (label) statMap.set(label, value);
                }

                if (!cancelled) {
                    if (statMap.size === 0 && extractedNews.length === 0) throw new Error('Finviz page did not contain a recognized statistics or news table.');
                    setNews(extractedNews);
                    setStats(statMap.size > 0 ? statMap : null);
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
    const isZombie = analysis?.isZombie ?? false;
    const currentPrice = technicalQuote?.price ?? null;
    const peakPrice = analysis?.peakPrice ?? null;
    const peakIndex = analysis?.peakIndex ?? 0;
    const dipPercentage = analysis ? analysis.dipPercentage.toFixed(2) : null;
    const recentLow = analysis?.recentLow ?? null;
    const rsi = analysis?.rsi ?? null;
    const trend = analysis?.trend ?? null;

    const peakDate = analysis && technicalQuote && peakPrice > Math.max(...technicalQuote.closes)
        ? formatQuoteTime(technicalQuote.quotedAt) : technicalPoints[peakIndex]?.date ?? 'Unavailable';

    // Where the price "normalized" before the crash (average of up to 5 days leading up to the peak)
    let normalizedHigh = peakPrice;
    if (peakIndex >= 1) {
        const daysToAverage = Math.min(peakIndex, 5);
        const prePeakPrices = technicalPoints.slice(peakIndex - daysToAverage, peakIndex).map(d => d.price);
        normalizedHigh = prePeakPrices.reduce((a, b) => a + b, 0) / prePeakPrices.length;
    }

    const boxTone = scoreTone(score, isZombie);
    const chipTone = verdictTone(verdict, isZombie);

    // Header pill tones: an unavailable dip is shown as unavailable, not as a signal.
    const dipTone = isZombie || dipPercentage === null ? 'muted' : 'danger';
    const rsiTone = rsi === null
        ? 'muted'
        : rsi <= 30 ? 'success' : rsi >= 70 ? 'danger' : 'muted';
    const trendTone = trend === 'bullish'
        ? 'success'
        : trend === 'bearish' ? 'danger' : 'muted';
    const trendLabel = trend ? trend.charAt(0).toUpperCase() + trend.slice(1) : '—';

    // 52-week bounds parsed from Finviz's "52W Range" value, e.g. "12.34 - 56.78"
    const fiftyTwoWeek = useMemo(() => {
        if (!stats) return null;
        const raw = stats.get('52W Range');
        if (!raw) return null;
        const m = raw.match(/([\d.,]+)\s*-\s*([\d.,]+)/);
        if (!m) return null;
        const low = parseFloat(m[1].replace(/,/g, ''));
        const high = parseFloat(m[2].replace(/,/g, ''));
        if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return null;
        return { low, high };
    }, [stats]);

    const fiftyTwoWeekPct = fiftyTwoWeek && currentPrice > 0
        ? Math.min(100, Math.max(0, ((currentPrice - fiftyTwoWeek.low) / (fiftyTwoWeek.high - fiftyTwoWeek.low)) * 100))
        : null;

    const rangeLabel = RANGES.find(r => r.value === range)?.label ?? '1M';
    const rangeText = RANGE_TEXT[range] ?? '1-month';

    return (
        <div className="stock-details">
            <Link to="/" className="btn btn-outline sd-back">
                <ArrowLeft size={16} /> Back to Dashboard
            </Link>

            {loading ? (
                <div className="sd-loading" role="status">
                    <RefreshCw size={40} className="sd-spin" />
                    <p>Analyzing {symbol}...</p>
                </div>
            ) : (
                <>
                    <div className="sd-header">
                        <div>
                            <h1 className="sd-title">
                                <span className="sd-symbol">{symbol}</span>
                                <span className={`sd-pill sd-pill--${dipTone}`}>
                                    <TrendingDown size={14} /> {dipPercentage === null ? 'Dip unavailable' : `${dipPercentage}% below 1M closing high`}
                                </span>
                                <span className={`sd-pill sd-pill--${rsiTone}`}>
                                    RSI {rsi !== null ? rsi.toFixed(0) : '—'}
                                </span>
                                <span className={`sd-pill sd-pill--${trendTone}`}>
                                    {trendLabel}
                                </span>
                            </h1>
                            <p className="sd-quote-line">
                                <span>Latest Quote: <strong>{formatPrice(currentPrice)}</strong></span>
                                <span className="sd-quote-sep" aria-hidden="true">|</span>
                                <span>Peak: <strong>{formatPrice(peakPrice)}</strong> on {peakDate}</span>
                                <span className="sd-quote-sep" aria-hidden="true">|</span>
                                <span>Pre-peak average: <strong>{formatPrice(normalizedHigh)}</strong></span>
                            </p>
                        </div>
                        <button type="button" className="btn btn-primary sd-refresh" onClick={() => setChartRetry(value => value + 1)} disabled={chartLoading}>
                            <RefreshCw size={14} /> Refresh data
                        </button>
                    </div>

                    <div className="data-source-line sd-source-line">
                        <span>Yahoo Finance · Quote: {formatQuoteTime(technicalQuote?.quotedAt)} · Retrieved: {formatQuoteTime(technicalQuote?.fetchedAt)} · {technicalQuote?.delayMinutes == null ? 'Delay unknown' : `${technicalQuote.delayMinutes} minute delay`}</span>
                        {technicalQuote && technicalRefreshing && <span className="sd-source-refreshing">· Refreshing; previous quote retained</span>}
                        {technicalQuote && technicalStale && <span className="sd-source-stale">· Cached quote; refresh failed</span>}
                    </div>
                    {technicalError && <p className="data-notice" role="alert">{technicalError}</p>}

                    {/* Internal Resource Viewer */}
                    <InternalResourceViewer symbol={symbol} />


                    <div className="glass-panel sd-panel sd-chart-panel">
                        <div className="sd-panel-head">
                            <h3>
                                Price Action ({rangeLabel})
                                {chartLoading && <RefreshCw size={16} className="sd-spin" />}
                            </h3>
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
                                <button type="button" className="btn btn-outline" onClick={() => setChartRetry(n => n + 1)}>
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
                                <YAxis stroke="var(--line)" domain={['dataMin - 5', 'dataMax + 5']} tick={CHART_TICK} tickLine={false} axisLine={false} width={52} />
                                <Tooltip
                                    cursor={CHART_TOOLTIP_CURSOR}
                                    contentStyle={CHART_TOOLTIP_STYLE}
                                    labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                                    itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                                    formatter={(value, name) => [formatPrice(value), name]}
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
                        <h3>
                            <BarChart3 size={18} className="sd-icon--primary" />
                            Key Statistics (Finviz)
                        </h3>
                        <p className="sd-meta">Finviz · delayed 1 minute · quote time unavailable · retrieved {formatQuoteTime(finvizFetchedAt)}</p>
                        {finvizFetchedAt && finvizRefreshing && <p className="sd-meta sd-meta--refreshing">Refreshing · previous statistics and headlines retained.</p>}
                        {finvizFetchedAt && finvizStale && <p className="data-notice">Cached statistics and headlines · original retrieval time retained.</p>}
                        {finvizError && <p className="data-notice" role="alert">{finvizError}</p>}
                        {stats ? (
                            <>
                                <div className="sd-stats-grid">
                                    {STAT_DEFS.map(def => {
                                        const value = stats.get(def.label)
                                            ?? (def.fallback ? stats.get(def.fallback) : undefined)
                                            ?? '—';
                                        return (
                                            <div key={def.label} className="sd-stat">
                                                <div className="sd-stat-label">{def.label}</div>
                                                <div className="sd-stat-value">{value}</div>
                                            </div>
                                        );
                                    })}
                                </div>
                                {fiftyTwoWeekPct !== null && (
                                    <div className="sd-range">
                                        <div className="sd-range-label">52-Week Position</div>
                                        <div className="sd-range-row">
                                            <span className="sd-range-bound">{formatPrice(fiftyTwoWeek.low)}</span>
                                            <div className="sd-range-track" aria-hidden="true">
                                                <div className="sd-range-marker" style={{ left: `${fiftyTwoWeekPct}%` }} />
                                            </div>
                                            <span className="sd-range-bound">{formatPrice(fiftyTwoWeek.high)}</span>
                                        </div>
                                        <div className="sd-range-caption">
                                            Current {formatPrice(currentPrice)} — {fiftyTwoWeekPct.toFixed(0)}% of the 52-week range
                                        </div>
                                    </div>
                                )}
                            </>
                        ) : (
                            <p className="sd-empty">Statistics unavailable</p>
                        )}
                    </div>

                    <div className="sd-grid">
                        <div className="glass-panel sd-panel sd-analysis-panel">
                            <h3>
                                <AlertTriangle size={18} className="sd-icon--warning" />
                                Technical Analysis (1M)
                            </h3>
                            <p className="sd-analysis-text">
                                {!analysis ? (
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
                            <div className={`sd-score sd-score--${boxTone}`}>
                                <ArrowUpRight size={18} />
                                <span className="sd-score-value">{`Technical Score: ${score}/100`}</span>
                                {verdict && (
                                    <span className={`sd-verdict sd-verdict--${chipTone}`}>
                                        {verdict.label}
                                    </span>
                                )}
                            </div>
                            )}
                        </div>

                        <div className="glass-panel sd-panel sd-news-panel">
                            <h3>Recent Headlines (Finviz)</h3>
                            {news.length === 0 ? (
                                <p className="sd-empty">{finvizError ? 'News unavailable from Finviz.' : 'No recent headlines returned.'}</p>
                            ) : (
                                <ul className="sd-news-list">
                                    {news.map((item, idx) => (
                                        <li key={idx} className="sd-news-item">
                                            <div className="sd-news-meta">
                                                <span className="sd-news-time">{item.time}</span>
                                                {item.source && (
                                                    <span className="sd-news-source">{item.source}</span>
                                                )}
                                            </div>
                                            <h4 className="sd-news-title">
                                                <a href={item.link} target="_blank" rel="noreferrer">
                                                    {item.title}
                                                </a>
                                            </h4>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};

export default StockDetails;

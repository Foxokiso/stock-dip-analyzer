import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, TrendingDown, AlertTriangle, ArrowUpRight, RefreshCw, BarChart3 } from 'lucide-react';
import { ComposedChart, Area, Line, ReferenceLine, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { analyzeStock, computeSMASeries } from '../utils/scoring';
import { formatPrice } from '../utils/format';

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
    const tab = RESOURCE_TABS.find(t => t.id === activeTab);

    // Mount TradingView widget whenever its tab is active
    useEffect(() => {
        if (activeTab !== 'tradingview' || !tvContainerRef.current) return;
        tvContainerRef.current.innerHTML = '';
        const script = document.createElement('script');
        script.src = 'https://s3.tradingview.com/tv.js';
        script.async = true;
        script.onload = () => {
            if (window.TradingView) {
                new window.TradingView.widget({
                    autosize: true,
                    symbol,
                    interval: 'D',
                    timezone: 'America/New_York',
                    theme: 'dark',
                    style: '1',
                    locale: 'en',
                    enable_publishing: false,
                    hide_side_toolbar: false,
                    allow_symbol_change: true,
                    container_id: 'tv_stockdetail_chart',
                });
            }
        };
        tvContainerRef.current.appendChild(script);
    }, [activeTab, symbol]);

    return (
        <div className="glass-panel" style={{ padding: '1.5rem', marginBottom: '2rem' }}>
            {/* Tab bar */}
            <div className="flex-center" style={{ justifyContent: 'flex-start', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                {RESOURCE_TABS.map(t => (
                    <button
                        key={t.id}
                        onClick={() => setActiveTab(t.id)}
                        className="btn"
                        style={{
                            padding: '0.4rem 1rem',
                            fontSize: '0.85rem',
                            background: activeTab === t.id
                                ? 'var(--primary-gradient)'
                                : 'rgba(255,255,255,0.04)',
                            color: activeTab === t.id ? '#030409' : 'var(--text-muted)',
                            border: activeTab === t.id ? 'none' : '1px solid rgba(255,255,255,0.1)',
                            fontWeight: activeTab === t.id ? 700 : 400,
                            transition: 'all 0.2s ease',
                        }}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {/* TradingView Widget */}
            {activeTab === 'tradingview' && (
                <div
                    id="tv_stockdetail_chart"
                    ref={tvContainerRef}
                    style={{ height: '550px', borderRadius: '12px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}
                />
            )}

            {/* Webview for all other tabs */}
            {tab?.type === 'webview' && (
                <webview
                    key={activeTab + symbol}
                    src={tab.url(symbol)}
                    style={{ width: '100%', height: '550px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)' }}
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

const getElectron = () => (
    typeof window !== 'undefined' && typeof window.require === 'function'
        ? window.require('electron')
        : null
);

// ---- Non-Electron (plain browser / vite dev) mock data --------------------
const MOCK_RANGE_POINTS = { '1mo': 22, '3mo': 66, '6mo': 126, '1y': 252 };

const buildMockChart = (range) => {
    const points = MOCK_RANGE_POINTS[range] || 22;
    const now = Date.now();
    const data = [];
    for (let i = 0; i < points; i++) {
        const t = points > 1 ? i / (points - 1) : 0;
        const base = 150 + Math.sin(t * Math.PI * 3) * 8;
        const dip = t > 0.6 ? (t - 0.6) * 55 : 0;
        const price = Number((base - dip + Math.sin(i * 1.7) * 2).toFixed(2));
        const date = new Date(now - (points - 1 - i) * 86400000);
        data.push({ date: `${date.getMonth() + 1}/${date.getDate()}`, price });
    }
    return data;
};

const MOCK_NEWS = [
    { time: 'Jul-03-26 09:00AM', title: 'Mock News: Market Reacts to Fake Earnings', link: 'https://finance.yahoo.com/news/mock', source: 'finance.yahoo.com' },
    { time: 'Jul-02-26 01:20PM', title: 'Mock News: Dow drops 500 points', link: 'https://www.reuters.com/markets/mock', source: 'reuters.com' },
    { time: 'Jul-01-26 11:05AM', title: 'Mock News: Analysts split on recovery odds after the dip', link: 'https://www.marketwatch.com/story/mock', source: 'marketwatch.com' },
];

const MOCK_STATS = new Map([
    ['Market Cap', '12.34B'],
    ['P/E', '18.42'],
    ['Forward P/E', '15.10'],
    ['EPS (ttm)', '2.31'],
    ['Dividend TTM', '1.12 (2.10%)'],
    ['Beta', '1.24'],
    ['RSI (14)', '34.12'],
    ['Volume', '12,345,678'],
    ['Avg Volume', '9.87M'],
    ['Rel Volume', '1.25'],
    ['52W High', '-18.50%'],
    ['52W Low', '12.30%'],
    ['52W Range', '98.51 - 182.94'],
    ['Target Price', '165.00'],
    ['Short Float', '2.15%'],
    ['Perf Week', '-3.42%'],
    ['Perf Month', '-8.15%'],
]);
// ---------------------------------------------------------------------------

const getScoreColor = (score) => {
    if (score >= 70) return 'var(--success)';
    if (score >= 40) return 'var(--warning)';
    return 'var(--danger)';
};

const getScoreBackground = (score) => {
    if (score < 20) return 'rgba(100, 100, 100, 0.1)';
    if (score >= 70) return 'rgba(0, 230, 118, 0.1)';
    if (score >= 40) return 'rgba(255, 234, 0, 0.1)';
    return 'rgba(255, 82, 82, 0.1)';
};

const factorBadgeStyle = (points) => {
    let background = 'rgba(255,255,255,0.06)';
    let color = 'var(--text-muted)';
    if (points > 0) { background = 'rgba(0, 230, 118, 0.15)'; color = 'var(--success)'; }
    else if (points < 0) { background = 'rgba(255, 82, 82, 0.15)'; color = 'var(--danger)'; }
    return {
        background,
        color,
        fontWeight: 700,
        fontSize: '0.8rem',
        padding: '2px 8px',
        borderRadius: '12px',
        minWidth: '38px',
        textAlign: 'center',
        flexShrink: 0,
    };
};

const headerPillStyle = (color) => ({
    color,
    fontSize: '0.85rem',
    padding: '4px 12px',
    borderRadius: '20px',
    gap: '4px',
});

const StockDetails = () => {
    const { symbol } = useParams();
    const [range, setRange] = useState('1mo');
    const [chartData, setChartData] = useState([]);
    const [news, setNews] = useState([]);
    const [stats, setStats] = useState(null); // Map<label, value> | null
    const [loading, setLoading] = useState(true);        // full-page, first load of a symbol only
    const [chartLoading, setChartLoading] = useState(true); // chart panel only (range switches)
    const [chartError, setChartError] = useState(false);
    const [chartRetry, setChartRetry] = useState(0);
    const lastSymbolRef = useRef(null);

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
            setChartData([]);
        }
        setChartLoading(true);
        setChartError(false);

        const finish = () => {
            if (cancelled) return;
            setChartLoading(false);
            setLoading(false);
        };

        const loadChart = async () => {
            const electron = getElectron();

            if (!electron) {
                // Fallback mock data if running in a standard browser
                setTimeout(() => {
                    if (cancelled) return;
                    setChartData(buildMockChart(range));
                    finish();
                }, 600);
                return;
            }

            try {
                const yahooData = await electron.ipcRenderer.invoke('fetch-yahoo-chart', symbol, range, '1d');
                const result = yahooData?.chart?.result?.[0];
                if (cancelled) return;
                if (result) {
                    const timestamps = result.timestamp || [];
                    const closes = result.indicators.quote[0].close;
                    const formattedChartData = timestamps.map((ts, index) => {
                        const date = new Date(ts * 1000);
                        return {
                            date: `${date.getMonth() + 1}/${date.getDate()}`,
                            price: closes[index]
                        };
                    }).filter(d => typeof d.price === 'number' && !Number.isNaN(d.price));
                    setChartData(formattedChartData);
                } else {
                    setChartData([]);
                    setChartError(true);
                }
            } catch (err) {
                console.error("Error loading chart data:", err);
                if (!cancelled) {
                    setChartData([]);
                    setChartError(true);
                }
            } finally {
                finish();
            }
        };

        loadChart();
        return () => { cancelled = true; };
    }, [symbol, range, chartRetry]);

    // Effect B: fetch the Finviz quote page ONCE per symbol (news + key stats).
    useEffect(() => {
        let cancelled = false;
        setNews([]);
        setStats(null);

        const loadFinviz = async () => {
            const electron = getElectron();

            if (!electron) {
                setTimeout(() => {
                    if (cancelled) return;
                    setNews(MOCK_NEWS);
                    setStats(MOCK_STATS);
                }, 800);
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
                    setNews(extractedNews);
                    setStats(statMap.size > 0 ? statMap : null);
                }
            } catch (err) {
                console.error("Error loading Finviz data:", err);
            }
        };

        loadFinviz();
        return () => { cancelled = true; };
    }, [symbol]);

    // Shared scoring engine on the fetched closes.
    const closes = useMemo(() => chartData.map(d => d.price), [chartData]);
    const analysis = useMemo(() => analyzeStock(closes, null), [closes]);
    const smaSeries = useMemo(() => computeSMASeries(closes, 20), [closes]);
    const plotData = useMemo(
        () => chartData.map((d, i) => ({ ...d, sma: smaSeries[i] })),
        [chartData, smaSeries]
    );

    const score = analysis?.score ?? 0;
    const verdict = analysis?.verdict ?? null;
    const isZombie = analysis?.isZombie ?? false;
    const currentPrice = analysis?.currentPrice ?? 0;
    const peakPrice = analysis?.peakPrice ?? 0;
    const peakIndex = analysis?.peakIndex ?? 0;
    const dipPercentage = analysis ? analysis.dipPercentage.toFixed(2) : '0.00';
    const recentLow = analysis?.recentLow ?? null;
    const rsi = analysis?.rsi ?? null;
    const trend = analysis?.trend ?? null;

    const peakDate = chartData[peakIndex]?.date ?? "N/A";

    // Where the price "normalized" before the crash (average of up to 5 days leading up to the peak)
    let normalizedHigh = peakPrice;
    if (peakIndex >= 1) {
        const daysToAverage = Math.min(peakIndex, 5);
        const prePeakPrices = chartData.slice(peakIndex - daysToAverage, peakIndex).map(d => d.price);
        normalizedHigh = prePeakPrices.reduce((a, b) => a + b, 0) / prePeakPrices.length;
    }

    const scoreColor = isZombie ? '#9ca3af' : getScoreColor(score); // improved contrast
    const scoreBg = getScoreBackground(score);

    let scoreClass = '';
    if (isZombie) scoreClass = '';
    else if (score >= 70) scoreClass = 'rating-pulse-success';
    else if (score >= 40) scoreClass = 'rating-pulse-warning';
    else scoreClass = 'rating-pulse-danger';

    // Header pill colors
    const rsiColor = rsi === null
        ? 'var(--text-muted)'
        : rsi <= 30 ? 'var(--success)' : rsi >= 70 ? 'var(--danger)' : 'var(--text-muted)';
    const trendColor = trend === 'bullish'
        ? 'var(--success)'
        : trend === 'bearish' ? 'var(--danger)' : 'var(--text-muted)';
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
            <Link to="/" className="btn btn-outline" style={{ marginBottom: '2rem' }}>
                <ArrowLeft size={16} /> Back to Dashboard
            </Link>

            {loading ? (
                <div className="flex-center" style={{ height: '50vh', flexDirection: 'column', gap: '1rem' }}>
                    <RefreshCw size={40} className="text-muted" style={{ animation: 'spin 1s linear infinite' }} />
                    <p className="text-muted">Analyzing {symbol}...</p>
                </div>
            ) : (
                <>
                    <div className="flex-between" style={{ alignItems: 'flex-start', marginBottom: '2rem' }}>
                        <div>
                            <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                                {symbol}
                                <span className={isZombie ? "glass-panel flex-center" : "glass-panel text-danger flex-center"}
                                    style={{ color: isZombie ? '#9ca3af' : 'var(--danger)', fontSize: '1rem', padding: '4px 12px', borderRadius: '20px', gap: '4px' }}>
                                    <TrendingDown size={14} /> {isZombie ? 'DEAD' : `${dipPercentage}% Dip`}
                                </span>
                                <span className="glass-panel flex-center" style={headerPillStyle(rsiColor)}>
                                    RSI {rsi !== null ? rsi.toFixed(0) : '—'}
                                </span>
                                <span className="glass-panel flex-center" style={headerPillStyle(trendColor)}>
                                    {trendLabel}
                                </span>
                            </h1>
                            <p className="text-muted" style={{ fontSize: '1.1rem', marginTop: '0.5rem' }}>
                                Current Price: <strong style={{ color: 'var(--text-main)' }}>${currentPrice.toFixed(2)}</strong>
                                <span style={{ margin: '0 10px' }}>|</span>
                                Peak: <strong style={{ color: 'var(--text-main)' }}>${peakPrice.toFixed(2)}</strong> on {peakDate}
                                <span style={{ margin: '0 10px' }}>|</span>
                                Baseline Norm: <strong style={{ color: 'var(--text-main)' }}>${normalizedHigh.toFixed(2)}</strong>
                            </p>
                        </div>
                        <button className="btn btn-primary">
                            Add to Watchlist
                        </button>
                    </div>

                    {/* Internal Resource Viewer */}
                    <InternalResourceViewer symbol={symbol} />


                    <div className="glass-panel" style={{ padding: '2rem', height: '420px', marginBottom: '2rem' }}>
                        <div className="flex-between" style={{ marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                Price Action ({rangeLabel})
                                {chartLoading && <RefreshCw size={16} className="text-muted" style={{ animation: 'spin 1s linear infinite' }} />}
                            </h3>
                            <div className="flex-center" style={{ gap: '0.4rem' }}>
                                {RANGES.map(r => (
                                    <button
                                        key={r.value}
                                        onClick={() => setRange(r.value)}
                                        className="btn"
                                        style={{
                                            padding: '0.25rem 0.75rem',
                                            fontSize: '0.75rem',
                                            borderRadius: '20px',
                                            background: range === r.value ? 'var(--primary-gradient)' : 'rgba(255,255,255,0.04)',
                                            color: range === r.value ? '#030409' : 'var(--text-muted)',
                                            border: range === r.value ? 'none' : '1px solid rgba(255,255,255,0.1)',
                                            fontWeight: range === r.value ? 700 : 400,
                                            transition: 'all 0.2s ease',
                                        }}
                                    >
                                        {r.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {chartError ? (
                            <div className="flex-center" style={{ height: 320, flexDirection: 'column', gap: '1rem' }}>
                                <p className="text-muted" style={{ margin: 0 }}>
                                    Failed to load {rangeText} chart data for {symbol}.
                                </p>
                                <button className="btn btn-outline" onClick={() => setChartRetry(n => n + 1)}>
                                    Retry
                                </button>
                            </div>
                        ) : chartLoading && plotData.length === 0 ? (
                            <div className="flex-center" style={{ height: 320 }}>
                                <RefreshCw size={28} className="text-muted" style={{ animation: 'spin 1s linear infinite' }} />
                            </div>
                        ) : (
                        <ResponsiveContainer width="100%" height={320}>
                            <ComposedChart data={plotData}>
                                <defs>
                                    <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="var(--danger)" stopOpacity={0.8} />
                                        <stop offset="95%" stopColor="var(--danger)" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                                <XAxis dataKey="date" stroke="var(--text-muted)" tick={{ fill: 'var(--text-muted)' }} minTickGap={24} />
                                <YAxis stroke="var(--text-muted)" domain={['dataMin - 5', 'dataMax + 5']} tick={{ fill: 'var(--text-muted)' }} />
                                <Tooltip
                                    contentStyle={{ backgroundColor: 'var(--bg-dark)', border: 'var(--glass-border)', borderRadius: '8px' }}
                                    itemStyle={{ color: 'var(--text-main)' }}
                                    formatter={(value, name) => [formatPrice(value), name]}
                                />
                                <Area type="monotone" dataKey="price" name="Price" stroke="var(--danger)" fillOpacity={1} fill="url(#colorPrice)" />
                                <Line type="monotone" dataKey="sma" name="SMA 20" stroke="var(--warning)" strokeWidth={1.5} dot={false} connectNulls />
                                {peakPrice > 0 && (
                                    <ReferenceLine
                                        y={peakPrice}
                                        stroke="var(--danger)"
                                        strokeDasharray="4 4"
                                        label={{ value: 'Peak', position: 'insideTopRight', fill: 'var(--danger)', fontSize: 11 }}
                                    />
                                )}
                                {recentLow !== null && (
                                    <ReferenceLine
                                        y={recentLow}
                                        stroke="var(--success)"
                                        strokeDasharray="4 4"
                                        label={{ value: 'Support', position: 'insideBottomRight', fill: 'var(--success)', fontSize: 11 }}
                                    />
                                )}
                            </ComposedChart>
                        </ResponsiveContainer>
                        )}
                    </div>

                    {/* Key Statistics (Finviz snapshot) */}
                    <div className="glass-panel" style={{ padding: '2rem', marginBottom: '2rem' }}>
                        <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <BarChart3 size={20} color="var(--primary)" />
                            Key Statistics (Finviz)
                        </h3>
                        {stats ? (
                            <>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.75rem' }}>
                                    {STAT_DEFS.map(def => {
                                        const value = stats.get(def.label)
                                            ?? (def.fallback ? stats.get(def.fallback) : undefined)
                                            ?? '—';
                                        return (
                                            <div key={def.label} style={{ padding: '0.75rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                                                <div className="text-muted" style={{ fontSize: '0.75rem', marginBottom: '0.25rem' }}>{def.label}</div>
                                                <div style={{ fontWeight: 700 }}>{value}</div>
                                            </div>
                                        );
                                    })}
                                </div>
                                {fiftyTwoWeekPct !== null && (
                                    <div style={{ marginTop: '1.5rem' }}>
                                        <div className="text-muted" style={{ fontSize: '0.75rem', marginBottom: '0.5rem' }}>52-Week Position</div>
                                        <div className="flex-center" style={{ gap: '0.75rem' }}>
                                            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--success)' }}>{formatPrice(fiftyTwoWeek.low)}</span>
                                            <div style={{ flex: 1, position: 'relative', height: '8px', borderRadius: '4px', background: 'linear-gradient(90deg, rgba(255,82,82,0.5), rgba(255,234,0,0.5), rgba(0,230,118,0.5))' }}>
                                                <div style={{
                                                    position: 'absolute',
                                                    left: `${fiftyTwoWeekPct}%`,
                                                    top: '50%',
                                                    transform: 'translate(-50%, -50%)',
                                                    width: '14px',
                                                    height: '14px',
                                                    borderRadius: '50%',
                                                    background: 'var(--text-main)',
                                                    border: '2px solid var(--bg-dark)',
                                                }} />
                                            </div>
                                            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--danger)' }}>{formatPrice(fiftyTwoWeek.high)}</span>
                                        </div>
                                        <div className="text-muted" style={{ fontSize: '0.75rem', marginTop: '0.4rem', textAlign: 'center' }}>
                                            Current {formatPrice(currentPrice)} — {fiftyTwoWeekPct.toFixed(0)}% of the 52-week range
                                        </div>
                                    </div>
                                )}
                            </>
                        ) : (
                            <p className="text-muted">Statistics unavailable</p>
                        )}
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>
                        <div className="glass-panel" style={{ padding: '2rem' }}>
                            <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <AlertTriangle size={20} color="var(--warning)" />
                                AI Analysis
                            </h3>
                            <p className="text-muted" style={{ lineHeight: '1.7' }}>
                                {!analysis ? (
                                    <>No {rangeText} chart data is available for {symbol}, so no score can be computed. The ticker may be delisted, halted, or temporarily unavailable from the data provider.</>
                                ) : isZombie ? (
                                    <>Based on the {rangeText} historical chart, {symbol} has flatlined into a <strong>ZOMBIE STOCK</strong>. It reached a high of ${peakPrice.toFixed(2)} on {peakDate} but has since crashed {dipPercentage}% with minimal-to-zero signs of recovery volatility. Our AI analysis highly suggests avoiding due to lack of buyer momentum.</>
                                ) : (
                                    <>Based on the {rangeText} historical chart, {symbol} reached a high of ${peakPrice.toFixed(2)} on {peakDate}, after normalizing around ${normalizedHigh.toFixed(2)} prior to that. It has since dropped {dipPercentage}% to its current price. This could indicate an oversold bounce opportunity if the underlying fundamentals remain strong despite the recent negative catalysts found in the news.</>
                                )}
                            </p>

                            {/* Factor-by-factor score breakdown */}
                            {analysis && analysis.factors.length > 0 && (
                                <div style={{ marginTop: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                    {analysis.factors.map((f, idx) => (
                                        <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                                            <span style={factorBadgeStyle(f.points)}>
                                                {f.points > 0 ? `+${f.points}` : `${f.points}`}
                                            </span>
                                            <div>
                                                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{f.label}</div>
                                                <div className="text-muted" style={{ fontSize: '0.8rem', lineHeight: 1.5 }}>{f.detail}</div>
                                            </div>
                                        </div>
                                    ))}
                                    <p className="text-muted" style={{ fontSize: '0.75rem', margin: '0.25rem 0 0 0' }}>
                                        Score starts at 50; factors sum and clamp to 0–100.
                                    </p>
                                </div>
                            )}

                            {analysis && (
                            <div className={scoreClass} style={{ marginTop: '1.5rem', padding: '1rem', background: scoreBg, borderRadius: '8px', border: `1px solid ${scoreColor}` }}>
                                <strong className="flex-center" style={{ gap: '0.5rem', justifyContent: 'flex-start', color: scoreColor, flexWrap: 'wrap' }}>
                                    <ArrowUpRight size={18} /> {isZombie ? `Zombie Classification Score: ${score}/100` : `Recovery Probability Rating: ${score}/100`}
                                    {verdict && (
                                        <span style={{ marginLeft: 'auto', color: verdict.color, fontSize: '0.8rem', border: `1px solid ${verdict.color}`, padding: '2px 10px', borderRadius: '12px' }}>
                                            {verdict.label}
                                        </span>
                                    )}
                                </strong>
                            </div>
                            )}
                        </div>

                        <div className="glass-panel" style={{ padding: '2rem' }}>
                            <h3 style={{ marginTop: 0 }}>Latest News Explaining the Dip</h3>
                            {news.length === 0 ? (
                                <p className="text-muted">No recent news found.</p>
                            ) : (
                                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                    {news.map((item, idx) => (
                                        <li key={idx} style={{ padding: '1rem', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', background: 'rgba(255,255,255,0.02)' }}>
                                            <div className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                                                {item.time}
                                                {item.source && (
                                                    <span style={{ fontSize: '0.75rem', opacity: 0.7, marginLeft: '0.5rem' }}>· {item.source}</span>
                                                )}
                                            </div>
                                            <h4 style={{ margin: '0 0 0.5rem 0' }}>
                                                <a href={item.link} target="_blank" rel="noreferrer" style={{ color: 'var(--text-main)', textDecoration: 'none' }}
                                                    onMouseEnter={(e) => e.target.style.color = 'var(--primary)'}
                                                    onMouseLeave={(e) => e.target.style.color = 'var(--text-main)'}>
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
            <style>{`
                @keyframes spin { 100% { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
};

export default StockDetails;

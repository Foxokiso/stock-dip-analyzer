import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { Search, SlidersHorizontal, RefreshCw, ChevronDown } from 'lucide-react';
import MarketPulse from '../components/MarketPulse';
import { analyzeStock, getVerdict } from '../utils/scoring';
import { formatCompact, formatPct, formatPrice, formatQuoteTime } from '../utils/format';
import { getYahooQuote, canRaiseTechnicalAlert } from '../utils/marketData';
import { parseFinvizScreener } from '../utils/finviz';

// ─── Stable module-level constants — not React dependencies ──────────────────
const PHOTONICS_TICKERS = ['LITE', 'COHR', 'IPGP', 'MKSI', 'FN', 'CAMT', 'ONTO', 'VIAV'];

// ─── Alert dispatch driven by the shared analysis object ─────────────────────
const dispatchAlertsFromAnalysis = (symbol, analysis, quote) => {
    if (!analysis || !canRaiseTechnicalAlert(quote, quote?.closes?.length ?? 0)) return;
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
    let message = "";

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
        detail: { symbol, type: typeStr, color: alertColor, message, timestamp: Date.now(), quotedAt: quote.quotedAt, source: quote.source, delayMinutes: quote.delayMinutes }
    }));
};

// ─── Chart fetch + analysis helpers ──────────────────────────────────────────
const fetchChart = async (symbol, electron, range = '1mo', interval = '1d') => {
    const yahooData = await electron.ipcRenderer.invoke('fetch-yahoo-chart', symbol, range, interval);
    const result = yahooData?.chart?.result?.[0];
    if (!result) return null;
    const quote = getYahooQuote(result, { range });
    return { meta: result.meta || {}, ...quote };
};

// Analysis always uses a fixed one-month Yahoo series and its own timestamped quote.
const analyzeSymbol = async (symbol, electron) => {
    try {
        if (!electron) return null;
        const quote = await fetchChart(symbol, electron);
        if (!quote || quote.price === null) return null;
        const analysis = analyzeStock(quote.closes, quote.price);
        return analysis ? { ...analysis, quote } : null;
    } catch (e) {
        console.error(`Failed to analyze ${symbol}`, e);
        return null;
    }
};

// ─── Sorting ──────────────────────────────────────────────────────────────────
const getSortValue = (s, key) => {
    switch (key) {
        case 'symbol': return s.symbol;
        case 'price': return s.price ?? null;
        case 'dayChange': return s.changePercentage ?? null;
        case 'off30dHigh': return s.analysis?.dipPercentage ?? null;
        case 'volume': return s.volume ?? null;
        case 'relVol': return (s.volume != null && s.avgVolume) ? s.volume / s.avgVolume : null;
        case 'marketCap': return s.marketCap ?? null;
        case 'rsi': return s.analysis?.rsi ?? null;
        case 'score': return s.recoveryProbability ?? null;
        default: return null;
    }
};

// Non-mutating sort; nulls always last; default order = day change ascending.
const sortStocks = (list, sortKey, sortDir) => {
    return [...list].sort((a, b) => {
        const va = sortKey ? getSortValue(a, sortKey) : a.changePercentage;
        const vb = sortKey ? getSortValue(b, sortKey) : b.changePercentage;
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
        if (!sortKey) return cmp; // default: biggest losers first
        return sortDir === 'asc' ? cmp : -cmp;
    });
};

const COLUMNS = [
    { id: 'symbol', label: 'Symbol', sortKey: 'symbol', align: 'left' },
    { id: 'name', label: 'Company', align: 'left' },
    { id: 'price', label: 'Price', sortKey: 'price', align: 'right' },
    { id: 'dayChange', label: 'Day Δ%', sortKey: 'dayChange', align: 'right' },
    { id: 'off30d', label: 'Below 1M Close High', sortKey: 'off30dHigh', align: 'right' },
    { id: 'volume', label: 'Volume', sortKey: 'volume', align: 'right' },
    { id: 'relVol', label: 'RelVol', sortKey: 'relVol', align: 'right' },
    { id: 'mktCap', label: 'Mkt Cap', sortKey: 'marketCap', align: 'right' },
    { id: 'range52', label: '52W Range', align: 'center' },
    { id: 'rsi', label: 'RSI', sortKey: 'rsi', align: 'right' },
    { id: 'trend', label: 'Trend', align: 'center' },
    { id: 'spark', label: '15 bars', align: 'center' },
    { id: 'rating', label: 'Rating', sortKey: 'score', align: 'center' },
    { id: 'expand', label: '', align: 'center' },
];
const COLUMN_COUNT = COLUMNS.length;

// ─── Small presentational helpers ─────────────────────────────────────────────
const Sparkline = ({ data }) => {
    if (!data || data.length < 2) return <span className="text-muted">—</span>;
    const w = 90, h = 26, pad = 2;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    const points = data.map((v, i) => {
        const x = pad + (i / (data.length - 1)) * (w - pad * 2);
        const y = h - pad - ((v - min) / span) * (h - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const up = data[data.length - 1] >= data[0];
    return (
        <svg width={w} height={h} style={{ display: 'inline-block', verticalAlign: 'middle' }}>
            <polyline
                points={points}
                fill="none"
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                style={{ stroke: up ? 'var(--success)' : 'var(--danger)' }}
            />
        </svg>
    );
};

const RangeBar = ({ low, high, price }) => {
    if (low == null || high == null || price == null || high <= low) {
        return <span className="text-muted">—</span>;
    }
    const pct = Math.max(0, Math.min(1, (price - low) / (high - low)));
    return (
        <div
            title={`52W: ${formatPrice(low)} – ${formatPrice(high)}`}
            style={{ width: '70px', height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.12)', position: 'relative', display: 'inline-block', verticalAlign: 'middle' }}
        >
            <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${(pct * 100).toFixed(1)}%`,
                borderRadius: '3px',
                background: pct >= 0.5 ? 'var(--success)' : pct >= 0.25 ? 'var(--warning)' : 'var(--danger)',
                opacity: 0.9
            }} />
        </div>
    );
};

const StatTile = ({ label, value, color }) => (
    <div className="glass-panel" style={{ padding: '0.7rem 1.1rem', flex: '1 1 auto', minWidth: '120px' }}>
        <div className="text-muted" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
        <div style={{ fontSize: '1.1rem', fontWeight: 700, fontFamily: 'var(--font-heading)', color: color || 'var(--text-main)', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
);

const cellStyle = { padding: '0.8rem 0.5rem', whiteSpace: 'nowrap' };

const StockRow = memo(({ stock, expanded, onToggle }) => {
    const score = stock.recoveryProbability;
    const verdict = getVerdict(score, stock.isZombie);
    const analysis = stock.analysis || null;

    const relVol = (stock.volume != null && stock.avgVolume) ? stock.volume / stock.avgVolume : null;
    const rsi = analysis?.rsi ?? null;
    const rsiColor = rsi === null ? 'var(--text-muted)' : rsi <= 30 ? 'var(--success)' : rsi >= 70 ? 'var(--danger)' : 'var(--text-muted)';
    const trend = analysis?.trend || null;

    return (
        <>
            <tr
                style={{
                    borderBottom: expanded ? 'none' : '1px solid rgba(255,255,255,0.05)',
                    cursor: 'pointer',
                    transition: 'background-color 0.15s ease'
                }}
                onClick={() => window.location.hash = `/stock/${stock.symbol}`}
                onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                }}
            >
                <td style={{ ...cellStyle, fontWeight: 'bold', color: 'var(--text-main)' }}>{stock.symbol}</td>
                <td style={{ ...cellStyle, color: 'var(--text-muted)', fontSize: '0.85rem', maxWidth: '28ch', overflow: 'hidden', textOverflow: 'ellipsis' }} title={stock.name}>
                    {stock.name}
                    <div style={{ fontSize: '0.65rem' }}>{stock.source} · {stock.delayMinutes === null ? 'delay unknown' : `${stock.delayMinutes} min delay`}</div>
                    {stock.stale && <div style={{ fontSize: '0.65rem', color: 'var(--warning)' }}>Cached quote · refresh failed</div>}
                    <div style={{ fontSize: '0.65rem' }}>Quote: {formatQuoteTime(stock.quotedAt)}</div>
                    <div style={{ fontSize: '0.65rem' }}>Retrieved: {formatQuoteTime(stock.fetchedAt)}</div>
                </td>
                <td style={{ ...cellStyle, fontWeight: '600', textAlign: 'right' }}>{formatPrice(stock.price)}</td>
                <td style={{ ...cellStyle, textAlign: 'right', color: (stock.changePercentage ?? 0) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {formatPct(stock.changePercentage)}
                </td>
                <td style={{ ...cellStyle, textAlign: 'right', color: analysis ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {analysis ? `-${analysis.dipPercentage.toFixed(1)}%` : '—'}
                </td>
                <td style={{ ...cellStyle, textAlign: 'right', color: 'var(--text-muted)' }}>{formatCompact(stock.volume)}</td>
                <td style={{ ...cellStyle, textAlign: 'right', color: relVol !== null && relVol >= 2 ? 'var(--warning)' : 'var(--text-muted)' }}>
                    {relVol !== null ? `${relVol.toFixed(1)}×` : '—'}
                </td>
                <td style={{ ...cellStyle, textAlign: 'right', color: 'var(--text-muted)' }}>{formatCompact(stock.marketCap)}</td>
                <td style={{ ...cellStyle, textAlign: 'center' }}>
                    <RangeBar low={stock.fiftyTwoWeekLow} high={stock.fiftyTwoWeekHigh} price={stock.price} />
                </td>
                <td style={{ ...cellStyle, textAlign: 'right', color: rsiColor }}>
                    {rsi !== null ? rsi.toFixed(0) : '—'}
                </td>
                <td style={{ ...cellStyle, textAlign: 'center' }}>
                    {trend === 'bullish' && <span style={{ color: 'var(--success)' }}>▲</span>}
                    {trend === 'bearish' && <span style={{ color: 'var(--danger)' }}>▼</span>}
                    {(trend === 'neutral' || trend === null) && <span className="text-muted">—</span>}
                </td>
                <td style={{ ...cellStyle, textAlign: 'center' }}>
                    <Sparkline data={analysis?.sparkline} />
                </td>
                <td style={{ ...cellStyle, textAlign: 'center' }}>
                    <span style={{
                        color: verdict?.color || 'var(--text-muted)',
                        border: '1px solid rgba(148,163,184,0.2)',
                        background: 'rgba(148,163,184,0.04)',
                        padding: '0.2rem 0.6rem',
                        borderRadius: '20px',
                        fontSize: '0.8rem',
                        display: 'inline-block',
                        minWidth: '100px'
                    }}>
                        {verdict ? `${verdict.label} (${score})` : 'Unavailable'}
                    </span>
                </td>
                <td style={{ ...cellStyle, textAlign: 'center' }}>
                    <button
                        onClick={(e) => { e.stopPropagation(); onToggle(stock.symbol); }}
                        title="Score breakdown"
                        aria-label={`Toggle score breakdown for ${stock.symbol}`}
                        style={{
                            background: 'transparent',
                            border: '1px solid rgba(255,255,255,0.1)',
                            borderRadius: '6px',
                            color: 'var(--text-muted)',
                            cursor: 'pointer',
                            padding: '0.15rem 0.3rem',
                            display: 'inline-flex',
                            alignItems: 'center'
                        }}
                    >
                        <ChevronDown size={15} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
                    </button>
                </td>
            </tr>

            {expanded && (
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <td colSpan={COLUMN_COUNT} style={{ padding: '0.4rem 1rem 1rem 1.5rem', background: 'rgba(0,0,0,0.2)' }}>
                        {stock.analysis ? (
                            <div>
                                <p className="text-muted" style={{ fontSize: '0.75rem' }}>Technical score · fixed 1-month daily series · {stock.analysis.quote.source} quote {formatPrice(stock.analysis.currentPrice)} as of {formatQuoteTime(stock.analysis.quote.quotedAt)} · {stock.analysis.quote.delayMinutes === null ? 'delay unknown' : `${stock.analysis.quote.delayMinutes} min delay`}</p>
                                {stock.analysis.factors.map((f) => {
                                    const badgeColor = f.points > 0 ? 'var(--success)' : f.points < 0 ? 'var(--danger)' : 'var(--text-muted)';
                                    return (
                                        <div key={f.label} style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', padding: '0.3rem 0' }}>
                                            <span style={{
                                                color: badgeColor,
                                                border: `1px solid ${badgeColor}40`,
                                                background: `${badgeColor}15`,
                                                borderRadius: '6px',
                                                padding: '0.1rem 0.45rem',
                                                fontSize: '0.75rem',
                                                fontWeight: 700,
                                                minWidth: '38px',
                                                textAlign: 'center',
                                                display: 'inline-block'
                                            }}>
                                                {f.points > 0 ? `+${f.points}` : `${f.points}`}
                                            </span>
                                            <span style={{ fontWeight: 600, fontSize: '0.85rem', minWidth: '130px' }}>{f.label}</span>
                                            <span className="text-muted" style={{ fontSize: '0.85rem' }}>{f.detail}</span>
                                        </div>
                                    );
                                })}
                                <div className="text-muted" style={{ fontSize: '0.72rem', marginTop: '0.5rem', fontStyle: 'italic' }}>
                                    Score starts at 50, factors sum, clamped to 0–100.
                                </div>
                            </div>
                        ) : (
                            <div className="text-muted" style={{ fontSize: '0.85rem' }}>{stock.analysisUnavailable ? 'Technical data unavailable or fewer than 15 valid daily closes.' : 'Technical analysis pending.'}</div>
                        )}
                    </td>
                </tr>
            )}
        </>
    );
});

const Dashboard = ({ excludedSectors = [], autoRefreshInterval = 0, globalFilter = 'All' }) => {
    const [chartCount, setChartCount] = useState(() => {
        const saved = localStorage.getItem('dipAnalyzerChartCount');
        return saved ? Number(saved) : 20;
    });
    const [searchTerm, setSearchTerm] = useState('');
    const [sector, setSector] = useState(() => {
        return localStorage.getItem('dipAnalyzerSector') || '';
    }); // Empty string means "Any Sector"
    const [stocks, setStocks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [scanPhase, setScanPhase] = useState(null);
    const [sortKey, setSortKey] = useState(null); // null = default order (day change asc)
    const [sortDir, setSortDir] = useState('desc');
    const [expandedRows, setExpandedRows] = useState(() => new Set());
    // Monotonic scan counter: state writes from superseded scans are dropped so a
    // slow older run (screener flushes, hydration) can't overwrite a newer one.
    const runSeqRef = useRef(0);
    const inFlightRef = useRef(false);
    const scopeRef = useRef(null);

    useEffect(() => {
        localStorage.setItem('dipAnalyzerChartCount', chartCount);
    }, [chartCount]);

    useEffect(() => {
        localStorage.setItem('dipAnalyzerSector', sector);
    }, [sector]);

    const toggleRow = useCallback((symbol) => {
        setExpandedRows(prev => {
            const next = new Set(prev);
            if (next.has(symbol)) next.delete(symbol);
            else next.add(symbol);
            return next;
        });
    }, []);

    const handleSort = (key) => {
        if (!key) return;
        if (sortKey !== key) {
            setSortKey(key);
            setSortDir('desc');
        } else if (sortDir === 'desc') {
            setSortDir('asc');
        } else {
            setSortKey(null); // third click resets to default order
            setSortDir('desc');
        }
    };

    const fetchFinvizData = useCallback(async (targetCount) => {
        const runId = ++runSeqRef.current;
        inFlightRef.current = true;
        const isStale = () => runSeqRef.current !== runId;
        const requestScope = JSON.stringify([sector, [...excludedSectors].sort(), targetCount]);
        if (scopeRef.current !== requestScope) {
            scopeRef.current = requestScope;
            setStocks([]);
        }
        setLoading(true);
        setScanPhase('quotes');
        setError('');
        try {
            const electron = typeof window.require === 'function' ? window.require('electron') : null;
            if (!electron) throw new Error('Market data requires the desktop app connection. No sample quotes are shown.');

            if (sector === 'photonics') {
                const results = await Promise.all(PHOTONICS_TICKERS.map(async symbol => {
                    try {
                        const quote = await fetchChart(symbol, electron);
                        if (!quote || quote.price === null) return null;
                        const analysis = analyzeStock(quote.closes, quote.price);
                        return {
                            ...quote, symbol, name: quote.meta.longName ?? quote.meta.shortName ?? symbol,
                            changePercentage: quote.changePct, volume: quote.meta.regularMarketVolume ?? null,
                            avgVolume: null, marketCap: null,
                            fiftyTwoWeekLow: quote.meta.fiftyTwoWeekLow ?? null,
                            fiftyTwoWeekHigh: quote.meta.fiftyTwoWeekHigh ?? null,
                            recoveryProbability: analysis?.score ?? null,
                            isZombie: analysis?.isZombie ?? false,
                            analysis: analysis ? { ...analysis, quote } : null,
                        };
                    } catch { return null; }
                }));
                if (isStale()) return;
                const valid = results.filter(Boolean);
                if (valid.length === 0) throw new Error('Photonics quotes are unavailable. Retained quotes keep their original source times.');
                setStocks(previous => PHOTONICS_TICKERS.map(symbol => valid.find(stock => stock.symbol === symbol)
                    ?? (previous.find(stock => stock.symbol === symbol)
                        ? { ...previous.find(stock => stock.symbol === symbol), stale: true }
                        : { symbol, name: symbol, source: 'Yahoo Finance', price: null, changePercentage: null,
                            delayMinutes: null, quotedAt: null, fetchedAt: null, analysis: null,
                            recoveryProbability: null, analysisUnavailable: true })));
                if (valid.length < PHOTONICS_TICKERS.length) setError('Some Photonics quotes are unavailable. Only confirmed provider data is shown.');
                valid.forEach(stock => dispatchAlertsFromAnalysis(stock.symbol, stock.analysis, stock.analysis?.quote));
                return;
            }

            const combined = new Map();
            const normalizedSector = value => (value || '').toLowerCase().replace(/[^a-z]/g, '');
            for (let page = 0; page < 50 && combined.size < targetCount; page++) {
                if (isStale()) return;
                const filters = sector ? `&f=sec_${encodeURIComponent(sector)}` : '';
                const url = `https://finviz.com/screener.ashx?v=111&o=change&r=${page * 20 + 1}${filters}`;
                const html = await electron.ipcRenderer.invoke('fetch-url', url);
                const rows = parseFinvizScreener(html);
                if (isStale()) return;
                for (const stock of rows) {
                    if (stock.changePercentage === null || stock.changePercentage >= 0) continue;
                    const rowSector = normalizedSector(stock.sector);
                    if (excludedSectors.includes(rowSector) || (sector && rowSector !== sector)) continue;
                    combined.set(stock.symbol, {
                        ...stock, avgVolume: null, fiftyTwoWeekLow: null, fiftyTwoWeekHigh: null,
                        recoveryProbability: null, isZombie: false, analysis: null,
                    });
                }
                if (rows.length < 20 || rows.every(stock => stock.changePercentage !== null && stock.changePercentage >= 0)) break;
                if (combined.size < targetCount) await new Promise(resolve => setTimeout(resolve, 300));
            }
            const allStocks = Array.from(combined.values()).slice(0, targetCount);
            if (isStale()) return;
            setStocks(allStocks);
            setScanPhase('analysis');
            // Each score has its own Yahoo source time; never retain a previous scan's score.
            for (let i = 0; i < allStocks.length; i += 5) {
                if (isStale()) return;
                const analyses = await Promise.all(allStocks.slice(i, i + 5).map(async stock => {
                    const analysis = await analyzeSymbol(stock.symbol, electron);
                    return [stock.symbol, analysis];
                }));
                if (isStale()) return;
                const batch = new Map(analyses);
                setStocks(previous => previous.map(row => batch.has(row.symbol)
                    ? { ...row, recoveryProbability: batch.get(row.symbol)?.score ?? null,
                        isZombie: batch.get(row.symbol)?.isZombie ?? false,
                        analysis: batch.get(row.symbol), analysisUnavailable: !batch.get(row.symbol) }
                    : row));
                analyses.forEach(([symbol, analysis]) => {
                    if (analysis) dispatchAlertsFromAnalysis(symbol, analysis, analysis.quote);
                });
            }
        } catch (error) {
            if (!isStale()) {
                setError(error.message || 'Finviz quotes are unavailable. Please retry.');
                setStocks(previous => previous.map(stock => ({ ...stock, stale: true })));
            }
        } finally {
            if (!isStale()) {
                inFlightRef.current = false;
                setLoading(false);
                setScanPhase(null);
            }
        }
    }, [sector, excludedSectors]);

    useEffect(() => {
        fetchFinvizData(chartCount);
        return () => { runSeqRef.current += 1; };
    }, [chartCount, fetchFinvizData]);

    useEffect(() => {
        if (autoRefreshInterval <= 0) return;

        const intervalId = setInterval(() => {
            if (!inFlightRef.current) fetchFinvizData(chartCount);
        }, autoRefreshInterval * 60 * 1000);

        return () => clearInterval(intervalId);
    }, [autoRefreshInterval, chartCount, fetchFinvizData]);

    const filteredStocks = stocks.filter(s => {
        if (!s.symbol.toLowerCase().includes(searchTerm.toLowerCase())) return false;

        if (globalFilter !== 'All') {
            const rating = getVerdict(s.recoveryProbability, s.isZombie)?.label;

            if (globalFilter === 'Sell/Strong Sell') {
                return rating === 'Sell' || rating === 'Strong Sell';
            }
            if (globalFilter === 'Bullish') {
                return s.changePercentage > 0;
            }
            if (globalFilter === 'Bearish') {
                return s.changePercentage < 0;
            }
            return rating === globalFilter;
        }
        return true;
    });

    const displayStocks = sortStocks(filteredStocks, sortKey, sortDir);

    // Summary tiles — live-updating as hydration progresses
    const scanned = stocks.length;
    const knownChanges = stocks.filter(stock => Number.isFinite(stock.changePercentage));
    const avgDayChange = knownChanges.length > 0
        ? knownChanges.reduce((sum, stock) => sum + stock.changePercentage, 0) / knownChanges.length
        : null;
    const buySignals = stocks.filter(s => (s.recoveryProbability ?? 0) >= 60).length;
    const zombieCount = stocks.filter(s => s.isZombie).length;
    const scoredCount = stocks.filter(stock => stock.analysis).length;
    // Only actual losers qualify — an all-green basket must not crown a "dip".
    const deepestDip = stocks.reduce((worst, s) =>
        (s.changePercentage < 0 && (worst === null || s.changePercentage < worst.changePercentage)) ? s : worst, null);

    const stickyThBase = {
        padding: '0.9rem 0.5rem',
        fontWeight: '600',
        fontSize: '0.82rem',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        position: 'sticky',
        top: 0,
        zIndex: 1,
        background: 'rgba(13,17,28,0.92)',
        backdropFilter: 'blur(6px)'
    };

    return (
        <div className="dashboard">
            {/* Market context strip */}
            <div style={{ marginBottom: '1.5rem' }}>
                <MarketPulse autoRefreshInterval={autoRefreshInterval} />
            </div>

            {/* Header Area */}
            <div className="flex-between" style={{ marginBottom: '1.5rem' }}>
                <div>
                    <h2 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        Market Dips Analysis
                        {loading && <RefreshCw size={20} className="text-muted" style={{ animation: 'spin 1s linear infinite' }} />}
                    </h2>
                    <p className="text-muted">Finviz stock quotes • delayed 1 minute • Yahoo Finance technical history.</p>
                </div>

                <div style={{ marginRight: 'auto', paddingLeft: '2rem' }}>
                    <a href="https://www.stockfetcher.com/" target="_blank" rel="noopener noreferrer" className="btn btn-outline flex-center" style={{ gap: '0.5rem', textDecoration: 'none', borderColor: 'var(--primary)', color: 'var(--primary)', padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}>
                        <Search size={14} /> StockFetcher Reference
                    </a>
                </div>

                <div className="flex-center" style={{ gap: '1rem' }}>
                    <div className="flex-center" style={{ padding: '0.5rem 1.2rem', gap: '0.8rem', borderRadius: '30px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.05)', boxShadow: 'inset 0 2px 5px rgba(0,0,0,0.5)' }}>
                        <Search size={18} color="var(--primary)" style={{ opacity: 0.8 }} />
                        <input
                            type="text"
                            placeholder="Search ticker..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-main)',
                                outline: 'none',
                                width: '150px',
                                fontFamily: 'inherit',
                                fontSize: '0.95rem'
                            }}
                        />
                    </div>

                    <div className="flex-center" style={{ padding: '0.5rem 1.2rem', gap: '0.8rem', borderRadius: '30px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.05)', boxShadow: 'inset 0 2px 5px rgba(0,0,0,0.5)' }}>
                        <SlidersHorizontal size={18} color="var(--primary)" style={{ opacity: 0.8 }} />

                        {/* Sector Filter Dropdown */}
                        <select
                            value={sector}
                            onChange={(e) => setSector(e.target.value)}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-main)',
                                outline: 'none',
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                                fontSize: '0.95rem',
                                borderRight: '1px solid rgba(255,255,255,0.1)',
                                paddingRight: '0.8rem',
                                marginRight: '0.8rem'
                            }}
                        >
                            <option value="">Any Sector</option>
                            <option value="basicmaterials">Basic Materials</option>
                            <option value="communicationservices">Communication Services</option>
                            <option value="consumercyclical">Consumer Cyclical</option>
                            <option value="consumerdefensive">Consumer Defensive</option>
                            <option value="energy">Energy</option>
                            <option value="financial">Financial</option>
                            <option value="healthcare">Healthcare</option>
                            <option value="industrials">Industrials</option>
                            <option value="photonics">Photonics Basket</option>
                            <option value="realestate">Real Estate</option>
                            <option value="technology">Technology</option>
                            <option value="utilities">Utilities</option>
                        </select>

                        <select
                            value={chartCount}
                            onChange={(e) => setChartCount(Number(e.target.value))}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-main)',
                                outline: 'none',
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                                fontSize: '0.95rem'
                            }}
                        >
                            <option value={10}>Top 10 Dips</option>
                            <option value={20}>Top 20 Dips</option>
                            <option value={30}>Top 30 Dips</option>
                            <option value={50}>Top 50 Dips</option>
                            <option value={100}>Top 100 Dips</option>
                            <option value={250}>Top 250 Dips</option>
                            <option value={500}>Top 500 Dips</option>
                        </select>
                    </div>
                </div>
            </div>

            <div className="flex-between data-source-line" style={{ marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                <span className="text-muted" style={{ fontSize: '0.8rem' }}>Finviz quote times are unavailable; retrieval time is shown on each row. Technical scores use one month of daily closes and are not recovery probabilities.</span>
                <button className="btn btn-outline" onClick={() => fetchFinvizData(chartCount)} disabled={loading}>
                    <RefreshCw size={14} /> Refresh quotes
                </button>
            </div>
            {error && <p role="alert" className="data-notice">{error}</p>}
            {loading && scanPhase === 'quotes' && stocks.length > 0 && <p role="status" className="data-notice">Refreshing · previous scan retained with its original quote and retrieval times.</p>}

            {/* Summary stat tiles */}
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
                <StatTile label="Scanned" value={scanned} />
                <StatTile
                    label="Avg Day Δ"
                    value={avgDayChange === null ? '—' : formatPct(avgDayChange)}
                    color={avgDayChange === null ? undefined : avgDayChange >= 0 ? 'var(--success)' : 'var(--danger)'}
                />
                <StatTile label="Buy signals (scored)" value={scoredCount ? buySignals : '—'} color={buySignals > 0 ? 'var(--success)' : undefined} />
                <StatTile label="Low scores" value={scoredCount ? zombieCount : '—'} color={zombieCount > 0 ? '#9ca3af' : undefined} />
                <StatTile
                    label="Deepest Dip"
                    value={deepestDip ? `${deepestDip.symbol} ${formatPct(deepestDip.changePercentage)}` : '—'}
                    color={deepestDip ? 'var(--danger)' : undefined}
                />
            </div>

            {/* Stocks Table */}
            <div className="glass-panel" style={{ padding: '1.5rem', overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                    <thead>
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                            {COLUMNS.map(col => {
                                const active = col.sortKey && sortKey === col.sortKey;
                                return (
                                    <th
                                        key={col.id}
                                        onClick={col.sortKey ? () => handleSort(col.sortKey) : undefined}
                                        title={col.sortKey ? 'Click to sort' : undefined}
                                        style={{
                                            ...stickyThBase,
                                            textAlign: col.align,
                                            color: active ? 'var(--primary)' : 'var(--text-muted)',
                                            cursor: col.sortKey ? 'pointer' : 'default'
                                        }}
                                    >
                                        {col.label}{active ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ''}
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {displayStocks.map((stock) => (
                            <StockRow
                                key={stock.symbol}
                                stock={stock}
                                expanded={expandedRows.has(stock.symbol)}
                                onToggle={toggleRow}
                            />
                        ))}

                        {loading && Array.from({ length: Math.max(0, chartCount - stocks.length) }).map((_, i) => (
                            <tr key={`loading-${i}`} style={{ opacity: 0.3 }}>
                                <td colSpan={COLUMN_COUNT} style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                                    Scanning markets #{stocks.length + i + 1}...
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                {!loading && displayStocks.length === 0 && (
                    <div className="text-muted" style={{ padding: '2rem', textAlign: 'center' }}>No stocks found matching your criteria.</div>
                )}
            </div>
            {/* Adding this style locally for the spinner */}
            <style>{`
                @keyframes spin { 100% { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
};

export default Dashboard;

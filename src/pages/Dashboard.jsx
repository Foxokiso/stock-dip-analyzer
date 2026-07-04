import { useState, useEffect, useCallback, memo } from 'react';
import { Search, SlidersHorizontal, RefreshCw, ChevronDown } from 'lucide-react';
import MarketPulse from '../components/MarketPulse';
import { analyzeStock, getVerdict } from '../utils/scoring';
import { formatCompact, formatPct, formatPrice } from '../utils/format';

// ─── Stable module-level constants — not React dependencies ──────────────────
const YAHOO_SCREENER_IDS = [
    'day_losers',                // biggest % losers today
    'most_actives',              // high volume (often volatile dippers)
    'undervalued_growth_stocks', // fundamentally cheap + recent dip
];

const PHOTONICS_TICKERS = ['LITE', 'COHR', 'IPGP', 'MKSI', 'FN', 'CAMT', 'ONTO', 'VIAV'];

const BULLISH_MSGS = ["Bullish divergence detected. Momentum shifting positive.", "Bulls are waking up. Accumulation phase initiated.", "Relative strength is surging.", "Aggressive buying pressure identified."];
const BEARISH_MSGS = ["Bearish trend confirmed. Distribution in progress.", "Bears have control. Selling pressure overwhelming.", "Momentum breaking down. Weakness detected.", "Warning: Bearish cross. Technicals deteriorating."];

// ─── Alert dispatch driven by the shared analysis object ─────────────────────
const dispatchAlertsFromAnalysis = (symbol, analysis) => {
    if (!analysis) return;
    const { isBreakout, isBreakdown, trend, dipPercentage, currentPrice } = analysis;
    const isBullish = trend === 'bullish';
    const isBearish = trend === 'bearish';
    if (!(isBreakdown || isBreakout || isBullish || isBearish)) return;

    if (!window._stockAlertsEmitted) window._stockAlertsEmitted = new Set();

    const typeStr = isBreakout ? 'breakout' : isBreakdown ? 'breakdown' : isBullish ? 'bullish' : 'bearish';
    const cacheKey = `${symbol}-${typeStr}`;
    if (window._stockAlertsEmitted.has(cacheKey)) return;
    window._stockAlertsEmitted.add(cacheKey);

    let alertColor = 'blue';
    let message = "";

    if (isBreakdown && dipPercentage >= 15) {
        alertColor = 'amber';
        message = `AMBER ALERT: Astonishingly huge drop of ${dipPercentage.toFixed(1)}%. Support shattered at $${currentPrice.toFixed(2)}!`;
    } else if (isBreakout) {
        message = `Breaking resistance at $${currentPrice.toFixed(2)}`;
    } else if (isBreakdown) {
        message = `Breaking support at $${currentPrice.toFixed(2)}, accelerating downtrend`;
    } else if (isBullish) {
        message = `${BULLISH_MSGS[Math.floor(Math.random() * BULLISH_MSGS.length)]} $${currentPrice.toFixed(2)}`;
    } else if (isBearish) {
        message = `${BEARISH_MSGS[Math.floor(Math.random() * BEARISH_MSGS.length)]} $${currentPrice.toFixed(2)}`;
    }

    window.dispatchEvent(new CustomEvent('stock-alert', {
        detail: { symbol, type: typeStr, color: alertColor, message, timestamp: Date.now() }
    }));
};

// ─── Chart fetch + analysis helpers ──────────────────────────────────────────
const fetchChart = async (symbol, electron, range = '1mo', interval = '1d') => {
    const yahooData = await electron.ipcRenderer.invoke('fetch-yahoo-chart', symbol, range, interval);
    const result = yahooData?.chart?.result?.[0];
    if (!result) return null;
    const closes = (result.indicators?.quote?.[0]?.close || [])
        .filter(c => c !== null && c !== undefined);
    return { meta: result.meta || {}, closes };
};

// Small synthetic price series so the app still renders analyses in a plain browser.
const buildMockSeries = () => {
    const series = [];
    let price = 40 + Math.random() * 160;
    for (let i = 0; i < 30; i++) {
        price = Math.max(1, price * (1 + (Math.random() - 0.52) * 0.06));
        series.push(Number(price.toFixed(2)));
    }
    return series;
};

// Fetch closes (or synthesize outside Electron), run the shared scoring engine,
// dispatch the same live alerts as before. Returns the full analysis, or null.
const analyzeSymbol = async (symbol, electron, livePrice) => {
    try {
        let closes;
        if (electron) {
            const chart = await fetchChart(symbol, electron);
            closes = chart?.closes || [];
        } else {
            closes = buildMockSeries();
        }
        if (closes.length === 0) return null;
        const analysis = analyzeStock(closes, livePrice);
        if (!analysis) return null;
        dispatchAlertsFromAnalysis(symbol, analysis);
        return analysis;
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
    { id: 'off30d', label: 'Off 30d High %', sortKey: 'off30dHigh', align: 'right' },
    { id: 'volume', label: 'Volume', sortKey: 'volume', align: 'right' },
    { id: 'relVol', label: 'RelVol', sortKey: 'relVol', align: 'right' },
    { id: 'mktCap', label: 'Mkt Cap', sortKey: 'marketCap', align: 'right' },
    { id: 'range52', label: '52W Range', align: 'center' },
    { id: 'rsi', label: 'RSI', sortKey: 'rsi', align: 'right' },
    { id: 'trend', label: 'Trend', align: 'center' },
    { id: 'spark', label: '30d', align: 'center' },
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
    const score = stock.recoveryProbability ?? 50;
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
                    opacity: stock.isZombie ? 0.6 : 1,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease-in-out',
                    willChange: 'transform'
                }}
                onClick={() => window.location.hash = `/stock/${stock.symbol}`}
                onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = 'none';
                }}
            >
                <td style={{ ...cellStyle, fontWeight: 'bold', color: 'var(--text-main)' }}>{stock.symbol}</td>
                <td style={{ ...cellStyle, color: 'var(--text-muted)', fontSize: '0.85rem', maxWidth: '28ch', overflow: 'hidden', textOverflow: 'ellipsis' }} title={stock.name}>
                    {stock.name}
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
                        color: verdict.color,
                        border: `1px solid ${verdict.color}40`,
                        background: `${verdict.color}15`,
                        padding: '0.2rem 0.6rem',
                        borderRadius: '20px',
                        fontSize: '0.8rem',
                        display: 'inline-block',
                        minWidth: '100px'
                    }}>
                        {verdict.label} ({score})
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
                            <div className="text-muted" style={{ fontSize: '0.85rem' }}>Score not hydrated yet.</div>
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
    const [sortKey, setSortKey] = useState(null); // null = default order (day change asc)
    const [sortDir, setSortDir] = useState('desc');
    const [expandedRows, setExpandedRows] = useState(() => new Set());

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

    // Fetch a Yahoo predefined screener and return normalised stock objects
    const fetchYahooScreener = async (scrId, electron) => {
        const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&scrIds=${scrId}&count=100`;
        const html = await electron.ipcRenderer.invoke('fetch-url', url);
        try {
            const json = JSON.parse(html);
            const quotes = json?.finance?.result?.[0]?.quotes || [];
            return quotes.map(q => ({
                symbol: q.symbol,
                name: q.shortName || q.longName || q.symbol,
                price: q.regularMarketPrice || 0,
                changePercentage: q.regularMarketChangePercent || 0,
                dipPercentage: q.regularMarketChangePercent < 0 ? Math.abs(q.regularMarketChangePercent) : 0,
                volume: q.regularMarketVolume ?? null,
                avgVolume: q.averageDailyVolume3Month ?? null,
                marketCap: q.marketCap ?? null,
                fiftyTwoWeekLow: q.fiftyTwoWeekLow ?? null,
                fiftyTwoWeekHigh: q.fiftyTwoWeekHigh ?? null,
                recoveryProbability: null,
                isZombie: false,
                analysis: null,
                source: scrId,
            }));
        } catch { return []; }
    };

    const fetchFinvizData = useCallback(async (targetCount) => {
        setLoading(true);
        try {
            let electron = null;
            if (typeof window !== 'undefined' && typeof window.require === 'function') {
                electron = window.require('electron');
            }

            // Apply the shared analysis result onto a stock in state.
            const applyAnalysis = (symbol, analysis) => {
                if (!analysis) return;
                setStocks(prev => prev.map(s => s.symbol === symbol
                    ? { ...s, recoveryProbability: analysis.score, isZombie: analysis.isZombie, analysis }
                    : s));
            };

            let allStocks = [];

            if (!electron) {
                console.warn('Electron environment not detected. Loading mock dashboard data.');
                allStocks = [
                    { symbol: 'AAPL', name: 'Apple Inc.', price: 173.5, changePercentage: -2.4, dipPercentage: 2.4, volume: 58200000, avgVolume: 52400000, marketCap: 2.7e12, fiftyTwoWeekLow: 143.9, fiftyTwoWeekHigh: 199.6, recoveryProbability: 50, isZombie: false, analysis: null, source: 'mock' },
                    { symbol: 'TSLA', name: 'Tesla Inc.', price: 180.2, changePercentage: -5.1, dipPercentage: 5.1, volume: 112000000, avgVolume: 98000000, marketCap: 5.7e11, fiftyTwoWeekLow: 138.8, fiftyTwoWeekHigh: 299.3, recoveryProbability: 50, isZombie: false, analysis: null, source: 'mock' },
                    { symbol: 'DEAD', name: 'Zombie Corp', price: 0.5, changePercentage: -80.0, dipPercentage: 80.0, volume: 900000, avgVolume: null, marketCap: 12000000, fiftyTwoWeekLow: null, fiftyTwoWeekHigh: null, recoveryProbability: 50, isZombie: false, analysis: null, source: 'mock' },
                    { symbol: 'MSFT', name: 'Microsoft', price: 400.1, changePercentage: 1.2, dipPercentage: 0, volume: 24500000, avgVolume: 26100000, marketCap: 3.0e12, fiftyTwoWeekLow: 309.4, fiftyTwoWeekHigh: 430.8, recoveryProbability: 50, isZombie: false, analysis: null, source: 'mock' }
                ];
                setStocks(allStocks);
                setLoading(false);
                // Hydrate mock analyses via the shared engine on synthetic series.
                allStocks.forEach(async (stock) => {
                    const analysis = await analyzeSymbol(stock.symbol, null, stock.price);
                    applyAnalysis(stock.symbol, analysis);
                });
                return;
            }

            // ── PHOTONICS BASKET OVERRIDE ─────────────────────────────────────
            // Uses the chart API (crumb-free) instead of the unreliable v7 quote API.
            if (sector === 'photonics') {
                const results = await Promise.all(PHOTONICS_TICKERS.map(async (symbol) => {
                    try {
                        const chart = await fetchChart(symbol, electron);
                        if (!chart || chart.closes.length === 0) return null;
                        const { meta, closes } = chart;
                        const lastClose = closes[closes.length - 1];
                        const price = meta.regularMarketPrice ?? lastClose ?? 0;
                        const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
                        const changePercentage = (meta.regularMarketPrice != null && prevClose)
                            ? ((meta.regularMarketPrice - prevClose) / prevClose) * 100
                            : 0;

                        // Reuse the closes we already have for the shared hydration path.
                        const analysis = analyzeStock(closes, price);
                        if (analysis) dispatchAlertsFromAnalysis(symbol, analysis);

                        return {
                            symbol,
                            name: meta.longName ?? meta.shortName ?? symbol,
                            price,
                            changePercentage,
                            dipPercentage: changePercentage < 0 ? Math.abs(changePercentage) : 0,
                            volume: meta.regularMarketVolume ?? null,
                            avgVolume: null,
                            marketCap: null,
                            fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
                            fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
                            recoveryProbability: analysis ? analysis.score : 50,
                            isZombie: analysis ? analysis.isZombie : false,
                            analysis: analysis || null,
                            source: 'photonics',
                        };
                    } catch { return null; }
                }));
                setStocks(results.filter(Boolean));
                setLoading(false);
                return;
            }
            // ── END PHOTONICS ─────────────────────────────────────────────────

            // ── MULTI-SOURCE YAHOO SCREENER FETCH ─────────────────────────────
            const combinedMap = new Map();

            for (const scrId of YAHOO_SCREENER_IDS) {
                const results = await fetchYahooScreener(scrId, electron);
                for (const stock of results) {
                    if (!combinedMap.has(stock.symbol)) {
                        // Defensive: Yahoo screeners rarely return sector, but honour exclusions when present.
                        if (stock.sector && excludedSectors.includes(stock.sector)) continue;
                        if (sector && sector !== '') continue; // sector filter: only show all if no sector selected
                        combinedMap.set(stock.symbol, stock);
                    }
                }
                // Flush incrementally so UI populates immediately
                allStocks = Array.from(combinedMap.values())
                    .filter(s => s.dipPercentage > 0) // only actual dippers
                    .sort((a, b) => b.dipPercentage - a.dipPercentage)
                    .slice(0, targetCount);

                setStocks(prevStocks => allStocks.map(ns => {
                    const ex = prevStocks.find(p => p.symbol === ns.symbol);
                    return ex
                        ? { ...ns, recoveryProbability: ex.recoveryProbability, isZombie: ex.isZombie, analysis: ex.analysis }
                        : { ...ns, recoveryProbability: 50 };
                }));

                await new Promise(r => setTimeout(r, 300));
            }

            // Hydrate analyses (score + factors + technicals) in small batches
            const hydrateScores = async () => {
                const chunkSize = 5;
                for (let i = 0; i < allStocks.length; i += chunkSize) {
                    const chunk = allStocks.slice(i, i + chunkSize);
                    await Promise.all(chunk.map(async stock => {
                        const analysis = await analyzeSymbol(stock.symbol, electron, stock.price);
                        applyAnalysis(stock.symbol, analysis);
                    }));
                    await new Promise(r => setTimeout(r, 800));
                }
            };
            hydrateScores().catch(err => console.error('Error hydrating scores:', err));

        } catch (error) {
            console.error('Failed to fetch screener data', error);
        } finally {
            setLoading(false);
        }
    }, [sector, excludedSectors]);

    useEffect(() => {
        fetchFinvizData(chartCount);
    }, [chartCount, fetchFinvizData]);

    useEffect(() => {
        if (autoRefreshInterval <= 0) return;

        const intervalId = setInterval(() => {
            fetchFinvizData(chartCount);
        }, autoRefreshInterval * 60 * 1000);

        return () => clearInterval(intervalId);
    }, [autoRefreshInterval, chartCount, fetchFinvizData]);

    const filteredStocks = stocks.filter(s => {
        if (!s.symbol.toLowerCase().includes(searchTerm.toLowerCase())) return false;

        if (globalFilter !== 'All') {
            const rating = getVerdict(s.recoveryProbability ?? 50, s.isZombie).label;

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
    const avgDayChange = scanned > 0
        ? stocks.reduce((sum, s) => sum + (s.changePercentage || 0), 0) / scanned
        : null;
    const buySignals = stocks.filter(s => (s.recoveryProbability ?? 0) >= 60).length;
    const zombieCount = stocks.filter(s => s.isZombie).length;
    const deepestDip = stocks.reduce((worst, s) =>
        (worst === null || s.changePercentage < worst.changePercentage) ? s : worst, null);

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
                    <p className="text-muted">Scanning market dippers from Yahoo Finance, Finviz & more.</p>
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

            {/* Summary stat tiles */}
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
                <StatTile label="Scanned" value={scanned} />
                <StatTile
                    label="Avg Day Δ"
                    value={avgDayChange === null ? '—' : formatPct(avgDayChange)}
                    color={avgDayChange === null ? undefined : avgDayChange >= 0 ? 'var(--success)' : 'var(--danger)'}
                />
                <StatTile label="Buy Signals" value={buySignals} color={buySignals > 0 ? 'var(--success)' : undefined} />
                <StatTile label="Zombies" value={zombieCount} color={zombieCount > 0 ? '#9ca3af' : undefined} />
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

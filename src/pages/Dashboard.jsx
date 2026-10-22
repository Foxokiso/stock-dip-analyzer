import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { Search, SlidersHorizontal, RefreshCw, ChevronDown } from 'lucide-react';
import MarketPulse from '../components/MarketPulse';
import { getVerdict } from '../utils/scoring';
import { formatCompact, formatPct, formatPrice, formatQuoteTime } from '../utils/format';
import { useSettings } from '../state/settingsContext.js';
import { getScan, scanAge, scanKey, startScan, useScan } from '../state/scanStore.js';
import { getInvoke } from '../utils/bridge.js';
import '../styles/pages/dashboard.css';

// ─── Stable module-level constants — not React dependencies ──────────────────
const SCAN_DEPTHS = [10, 20, 30, 50, 100, 250, 500];
// Rows still arriving are hinted with a few placeholders, not one per missing name.
const PLACEHOLDER_ROWS = 8;

// settings.scanner.sort → table sort. "change" keeps the legacy default order
// (day change ascending: biggest losers first); the others lead with the
// strongest value. Unknown values fall back to the legacy null-key order.
const SETTINGS_SORT = {
    score: { key: 'score', dir: 'desc' },
    change: { key: 'dayChange', dir: 'asc' },
    dip: { key: 'off30dHigh', dir: 'desc' },
    volume: { key: 'volume', dir: 'desc' },
};
const LEGACY_SORT = { key: null, dir: 'desc' };
const resolveDefaultSort = (sort) => SETTINGS_SORT[sort] ?? LEGACY_SORT;

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

// Chip tone follows the verdict label, never the colour string from the scorer.
const VERDICT_CLASS = {
    'Strong Buy': 'dash-verdict--strong-buy',
    'Buy': 'dash-verdict--buy',
    'Hold': 'dash-verdict--hold',
    'Sell': 'dash-verdict--sell',
    'Strong Sell': 'dash-verdict--strong-sell',
};

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
        <svg width={w} height={h} className={`dash-spark ${up ? 'dash-spark--up' : 'dash-spark--down'}`} aria-hidden="true">
            <polyline points={points} />
        </svg>
    );
};

const RangeBar = ({ low, high, price }) => {
    if (low == null || high == null || price == null || high <= low) {
        return <span className="text-muted">—</span>;
    }
    const pct = Math.max(0, Math.min(1, (price - low) / (high - low)));
    const tone = pct >= 0.5 ? 'ok' : pct >= 0.25 ? 'warn' : 'bad';
    return (
        <div className="dash-range" title={`52W: ${formatPrice(low)} – ${formatPrice(high)}`}>
            <div className={`dash-range-fill dash-range-fill--${tone}`} style={{ width: `${(pct * 100).toFixed(1)}%` }} />
        </div>
    );
};

const StatTile = ({ label, value, tone }) => (
    <div className={`glass-panel dash-stat${tone ? ` dash-stat--${tone}` : ''}`}>
        <div className="dash-stat-label">{label}</div>
        <div className="dash-stat-value">{value}</div>
    </div>
);

const StockRow = memo(({ stock, expanded, onToggle }) => {
    const score = stock.recoveryProbability;
    const verdict = getVerdict(score, stock.isZombie);
    const analysis = stock.analysis || null;

    const relVol = (stock.volume != null && stock.avgVolume) ? stock.volume / stock.avgVolume : null;
    const rsi = analysis?.rsi ?? null;
    const rsiTone = rsi === null ? 'is-muted' : rsi <= 30 ? 'is-up' : rsi >= 70 ? 'is-down' : 'is-muted';
    const trend = analysis?.trend || null;
    const hasChange = Number.isFinite(stock.changePercentage);
    const changeTone = (stock.changePercentage ?? 0) >= 0 ? 'up' : 'down';

    return (
        <>
            <tr
                className={`dash-row${expanded ? ' is-expanded' : ''}`}
                onClick={() => window.location.hash = `/stock/${stock.symbol}`}
            >
                <td className="dash-symbol">{stock.symbol}</td>
                <td className="dash-company" title={stock.name}>
                    {stock.name}
                    <div className="dash-meta">{stock.source} · {stock.delayMinutes === null ? 'delay unknown' : `${stock.delayMinutes} min delay`}</div>
                    {stock.stale && <div className="dash-meta dash-meta--stale">Cached quote · refresh failed</div>}
                    <div className="dash-meta">Quote: {formatQuoteTime(stock.quotedAt)}</div>
                    <div className="dash-meta">Retrieved: {formatQuoteTime(stock.fetchedAt)}</div>
                </td>
                <td className="numeric dash-price">{formatPrice(stock.price)}</td>
                <td className="numeric">
                    {hasChange
                        ? <span className={`dash-delta dash-delta--${changeTone}`}>{formatPct(stock.changePercentage)}</span>
                        : <span className="is-muted">{formatPct(stock.changePercentage)}</span>}
                </td>
                <td className={`numeric ${analysis ? 'is-down' : 'is-muted'}`}>
                    {analysis ? `-${analysis.dipPercentage.toFixed(1)}%` : '—'}
                </td>
                <td className="numeric is-muted">{formatCompact(stock.volume)}</td>
                <td className={`numeric ${relVol !== null && relVol >= 2 ? 'is-warn' : 'is-muted'}`}>
                    {relVol !== null ? `${relVol.toFixed(1)}×` : '—'}
                </td>
                <td className="numeric is-muted">{formatCompact(stock.marketCap)}</td>
                <td className="centered">
                    <RangeBar low={stock.fiftyTwoWeekLow} high={stock.fiftyTwoWeekHigh} price={stock.price} />
                </td>
                <td className={`numeric ${rsiTone}`}>
                    {rsi !== null ? rsi.toFixed(0) : '—'}
                </td>
                <td className="centered">
                    {trend === 'bullish' && <span className="dash-trend dash-trend--up">▲</span>}
                    {trend === 'bearish' && <span className="dash-trend dash-trend--down">▼</span>}
                    {(trend === 'neutral' || trend === null) && <span className="text-muted">—</span>}
                </td>
                <td className="centered">
                    <Sparkline data={analysis?.sparkline} />
                </td>
                <td className="centered">
                    <span className={`dash-verdict${verdict ? ` ${VERDICT_CLASS[verdict.label] ?? ''}` : ''}`}>
                        {verdict ? `${verdict.label} (${score})` : 'Unavailable'}
                    </span>
                </td>
                <td className="centered">
                    <button
                        type="button"
                        className="dash-expand"
                        onClick={(e) => { e.stopPropagation(); onToggle(stock.symbol); }}
                        title="Score breakdown"
                        aria-label={`Toggle score breakdown for ${stock.symbol}`}
                        aria-expanded={expanded}
                    >
                        <ChevronDown size={15} />
                    </button>
                </td>
            </tr>

            {expanded && (
                <tr className="dash-row-detail">
                    <td colSpan={COLUMN_COUNT}>
                        {stock.analysis ? (
                            <div>
                                <p className="dash-detail-meta">Technical score · fixed 1-month daily series · {stock.analysis.quote.source} quote {formatPrice(stock.analysis.currentPrice)} as of {formatQuoteTime(stock.analysis.quote.quotedAt)} · {stock.analysis.quote.delayMinutes === null ? 'delay unknown' : `${stock.analysis.quote.delayMinutes} min delay`}</p>
                                <div className="dash-factors">
                                    {stock.analysis.factors.map((f) => {
                                        const tone = f.points > 0 ? 'up' : f.points < 0 ? 'down' : 'flat';
                                        return (
                                            <div key={f.label} className="dash-factor">
                                                <span className={`dash-factor-points dash-factor-points--${tone}`}>
                                                    {f.points > 0 ? `+${f.points}` : `${f.points}`}
                                                </span>
                                                <span className="dash-factor-label">{f.label}</span>
                                                <span className="dash-factor-detail">{f.detail}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                                <div className="dash-factor-note">
                                    Score starts at 50, factors sum, clamped to 0–100.
                                </div>
                            </div>
                        ) : (
                            <div className="dash-detail-empty">{stock.analysisUnavailable ? 'Technical data unavailable or fewer than 15 valid daily closes.' : 'Technical analysis pending.'}</div>
                        )}
                    </td>
                </tr>
            )}
        </>
    );
});

const Dashboard = ({ excludedSectors = [], autoRefreshInterval = 0, globalFilter = 'All' }) => {
    const { settings } = useSettings();
    // Settings are the source of truth for the scan size and the sort order;
    // a pick made on this page overrides them for the life of the view only.
    const scanDepth = settings.scanner.scanDepth;
    const defaultSort = resolveDefaultSort(settings.scanner.sort);
    const [chartCountOverride, setChartCountOverride] = useState(null);
    const chartCount = chartCountOverride ?? scanDepth;
    const [sortOverride, setSortOverride] = useState(null);
    const { key: sortKey, dir: sortDir } = sortOverride ?? defaultSort;

    const [searchTerm, setSearchTerm] = useState('');
    const [sector, setSector] = useState(() => {
        return localStorage.getItem('dipAnalyzerSector') || '';
    }); // Empty string means "Any Sector"
    const [expandedRows, setExpandedRows] = useState(() => new Set());

    // The scan itself lives in scanStore, so leaving this page never cancels it
    // and coming back shows the retained rows with their original retrieval times.
    const excludedKey = excludedSectors.join(',');
    const scanParams = useMemo(() => ({ sector, excludedSectors: excludedKey ? excludedKey.split(',') : [], targetCount: chartCount }), [sector, excludedKey, chartCount]);
    const key = scanKey(scanParams);
    const { stocks, loading, error, phase: scanPhase } = useScan(key);
    const reuseSeconds = settings.scanner.reuseSeconds;
    const chartCacheSeconds = settings.data.chartCacheSeconds;
    const invoke = useMemo(() => getInvoke(), []);
    const rescan = useCallback(() => startScan(scanParams, { invoke, chartCacheSeconds }), [scanParams, invoke, chartCacheSeconds]);

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

    // Click cycle per column: strongest first, then reversed, then back to the
    // settings default (or reversed again when the default is this column).
    const handleSort = (key) => {
        if (!key) return;
        if (sortKey !== key) { setSortOverride({ key, dir: 'desc' }); return; }
        if (sortDir === 'desc') { setSortOverride({ key, dir: 'asc' }); return; }
        if (defaultSort.key === key && defaultSort.dir === 'asc') { setSortOverride({ key, dir: 'desc' }); return; }
        setSortOverride(null);
    };

    // Mount or scope change: adopt a scan already in flight, reuse a recent one,
    // otherwise start a fresh run (retained rows stay on screen while it runs).
    useEffect(() => {
        const current = getScan(key);
        if (current.loading) return;
        if (scanAge(current) <= reuseSeconds * 1000) return;
        rescan();
    }, [key, reuseSeconds, rescan]);

    useEffect(() => {
        if (autoRefreshInterval <= 0) return;
        const intervalId = setInterval(() => {
            if (!getScan(key).loading) rescan();
        }, autoRefreshInterval * 60 * 1000);
        return () => clearInterval(intervalId);
    }, [autoRefreshInterval, key, rescan]);

    const displayStocks = useMemo(() => {
        const term = searchTerm.toLowerCase();
        const filtered = stocks.filter(s => {
            if (!s.symbol.toLowerCase().includes(term)) return false;
            if (globalFilter === 'All') return true;
            const rating = getVerdict(s.recoveryProbability, s.isZombie)?.label;
            if (globalFilter === 'Sell/Strong Sell') return rating === 'Sell' || rating === 'Strong Sell';
            if (globalFilter === 'Bullish') return s.changePercentage > 0;
            if (globalFilter === 'Bearish') return s.changePercentage < 0;
            return rating === globalFilter;
        });
        return sortStocks(filtered, sortKey, sortDir);
    }, [stocks, searchTerm, globalFilter, sortKey, sortDir]);

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

    // A scan depth imported into settings that is not one of the presets still
    // needs to be selectable, otherwise the control would show blank.
    const scanOptions = SCAN_DEPTHS.includes(chartCount) ? SCAN_DEPTHS : [...SCAN_DEPTHS, chartCount].sort((a, b) => a - b);

    return (
        <div className="dashboard">
            {/* Market context strip */}
            <div className="dashboard-pulse">
                <MarketPulse autoRefreshInterval={autoRefreshInterval} />
            </div>

            {/* Header Area */}
            <div className="flex-between dash-head">
                <div>
                    <h2>
                        Market Dips Analysis
                        {loading && <RefreshCw size={20} className="dash-spinner" aria-hidden="true" />}
                    </h2>
                    <p className="text-muted">Finviz stock quotes • delayed 1 minute • Yahoo Finance technical history.</p>
                </div>

                <div className="dash-head-aside">
                    <a href="https://www.stockfetcher.com/" target="_blank" rel="noopener noreferrer" className="btn btn-outline flex-center dash-reference">
                        <Search size={14} /> StockFetcher Reference
                    </a>
                </div>

                <div className="flex-center dash-controls">
                    <label className="dash-field">
                        <Search size={18} className="dash-field-icon" aria-hidden="true" />
                        <input
                            type="text"
                            placeholder="Search ticker..."
                            aria-label="Search ticker"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </label>

                    <div className="dash-field">
                        <SlidersHorizontal size={18} className="dash-field-icon" aria-hidden="true" />

                        {/* Sector Filter Dropdown */}
                        <select
                            className="dash-field-select--divided"
                            aria-label="Sector"
                            value={sector}
                            onChange={(e) => setSector(e.target.value)}
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
                            aria-label="Scan size"
                            value={chartCount}
                            onChange={(e) => setChartCountOverride(Number(e.target.value))}
                        >
                            {scanOptions.map(depth => <option key={depth} value={depth}>Top {depth} Dips</option>)}
                        </select>
                    </div>
                </div>
            </div>

            <div className="flex-between data-source-line dash-source-line">
                <span className="dash-source-text">Finviz quote times are unavailable; retrieval time is shown on each row. Technical scores use one month of daily closes and are not recovery probabilities.</span>
                <button type="button" className="btn btn-outline" onClick={rescan} disabled={loading}>
                    <RefreshCw size={14} /> Refresh quotes
                </button>
            </div>
            {error && <p role="alert" className="data-notice">{error}</p>}
            {loading && scanPhase === 'quotes' && stocks.length > 0 && <p role="status" className="data-notice">Refreshing · previous scan retained with its original quote and retrieval times.</p>}

            {/* Summary stat tiles */}
            <div className="dash-stats">
                <StatTile label="Scanned" value={scanned} />
                <StatTile
                    label="Avg Day Δ"
                    value={avgDayChange === null ? '—' : formatPct(avgDayChange)}
                    tone={avgDayChange === null ? undefined : avgDayChange >= 0 ? 'up' : 'down'}
                />
                <StatTile label="Buy signals (scored)" value={scoredCount ? buySignals : '—'} tone={buySignals > 0 ? 'up' : undefined} />
                <StatTile label="Low scores" value={scoredCount ? zombieCount : '—'} tone={zombieCount > 0 ? 'muted' : undefined} />
                <StatTile
                    label="Deepest Dip"
                    value={deepestDip ? `${deepestDip.symbol} ${formatPct(deepestDip.changePercentage)}` : '—'}
                    tone={deepestDip ? 'down' : undefined}
                />
            </div>

            {/* Stocks Table */}
            <div className="glass-panel dash-table-panel">
                <table className="dash-table">
                    <thead>
                        <tr>
                            {COLUMNS.map(col => {
                                const active = col.sortKey && sortKey === col.sortKey;
                                return (
                                    <th
                                        key={col.id}
                                        scope="col"
                                        className={`dash-th dash-th--${col.align}${col.sortKey ? ' is-sortable' : ''}${active ? ' is-active' : ''}`}
                                        onClick={col.sortKey ? () => handleSort(col.sortKey) : undefined}
                                        onKeyDown={col.sortKey ? (e) => {
                                            if (e.key !== 'Enter' && e.key !== ' ') return;
                                            e.preventDefault();
                                            handleSort(col.sortKey);
                                        } : undefined}
                                        tabIndex={col.sortKey ? 0 : undefined}
                                        title={col.sortKey ? 'Click to sort' : undefined}
                                        aria-sort={active ? (sortDir === 'desc' ? 'descending' : 'ascending') : undefined}
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

                        {loading && Array.from({ length: Math.min(PLACEHOLDER_ROWS, Math.max(0, chartCount - stocks.length)) }).map((_, i) => (
                            <tr key={`loading-${i}`} className="dash-row-loading">
                                <td colSpan={COLUMN_COUNT}>
                                    Scanning markets #{stocks.length + i + 1}...
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                {!loading && displayStocks.length === 0 && (
                    <div className="dash-empty">No stocks found matching your criteria.</div>
                )}
            </div>
        </div>
    );
};

export default Dashboard;

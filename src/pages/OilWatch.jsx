import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Droplet, Ship, Factory, Layers, Newspaper, ChevronDown, RefreshCw, AlertTriangle } from 'lucide-react';
import MarketPulse from '../components/MarketPulse';
import { analyzeStock, getVerdict } from '../utils/scoring';
import { formatPrice, formatPct, formatQuoteTime } from '../utils/format';
import { getYahooQuote } from '../utils/marketData';
import { parseOilNews } from '../utils/oilNews';

const electron = typeof window !== 'undefined' && typeof window.require === 'function'
    ? window.require('electron')
    : null;

// ─── Energy complex for the pulse strip ──────────────────────────────────────
const ENERGY_TICKERS = [
    { sym: 'CL=F', label: 'WTI Crude', unit: '$/barrel' },
    { sym: 'BZ=F', label: 'Brent Crude', unit: '$/barrel' },
    { sym: 'RB=F', label: 'Gasoline', unit: '$/gallon' },
    { sym: 'NG=F', label: 'Nat Gas', unit: '$/MMBtu' },
    { sym: 'XLE', label: 'Energy Sector' },
];

// ─── Watch baskets ───────────────────────────────────────────────────────────
const TANKERS = [
    { sym: 'FRO', group: 'Crude' },
    { sym: 'DHT', group: 'Crude' },
    { sym: 'INSW', group: 'Crude' },
    { sym: 'NAT', group: 'Crude' },
    { sym: 'TNK', group: 'Crude' },
    { sym: 'STNG', group: 'Product' },
    { sym: 'TRMD', group: 'Product' },
    { sym: 'ASC', group: 'Product' },
    { sym: 'FLNG', group: 'Gas' },
    { sym: 'LPG', group: 'Gas' },
];

const REFINERS = [
    { sym: 'VLO' }, { sym: 'MPC' }, { sym: 'PSX' }, { sym: 'PBF' }, { sym: 'DINO' }, { sym: 'DK' },
];

const OIL_ETFS = [
    { sym: 'USO', note: 'WTI crude' },
    { sym: 'BNO', note: 'Brent crude' },
    { sym: 'XLE', note: 'Energy sector' },
    { sym: 'XOP', note: 'E&P' },
    { sym: 'OIH', note: 'Oil services' },
    { sym: 'CRAK', note: 'Refiners' },
];

const NEWS_QUERY = '"Middle East" oil OR "Strait of Hormuz" OR OPEC OR "oil tanker" OR refinery when:24h';

// ─── One row of a ticker board ───────────────────────────────────────────────
const BoardRow = ({ row, expanded, onToggle }) => {
    const verdict = row.analysis ? getVerdict(row.analysis.score, row.analysis.isZombie) : null;
    const a = row.analysis;
    const rsiColor = a?.rsi == null ? 'var(--text-muted)' : a.rsi <= 30 ? 'var(--success)' : a.rsi >= 70 ? 'var(--danger)' : 'var(--text-muted)';
    const trendGlyph = a?.trend === 'bullish' ? '▲' : a?.trend === 'bearish' ? '▼' : '—';
    const trendColor = a?.trend === 'bullish' ? 'var(--success)' : a?.trend === 'bearish' ? 'var(--danger)' : 'var(--text-muted)';

    return (
        <>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <td style={{ padding: '0.7rem 0.4rem' }}>
                    <Link to={`/stock/${row.sym}`} style={{ fontWeight: 'bold', color: 'var(--text-main)', textDecoration: 'underline' }}>
                        {row.sym}
                    </Link>
                    <div className="text-muted" style={{ fontSize: '0.7rem', maxWidth: '160px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.name}>
                        {row.group || row.note || (row.name && row.name !== row.sym ? row.name : '')}
                    </div>
                    <div className="quote-meta" title={row.fetchedAt ? `Fetched ${formatQuoteTime(row.fetchedAt)}` : undefined}>Quote {formatQuoteTime(row.quotedAt)}</div>
                    <div className="quote-meta">{row.delayMinutes == null ? 'Delay not provided' : `Source delay: ${row.delayMinutes} min`}</div>
                </td>
                <td style={{ padding: '0.7rem 0.4rem', textAlign: 'right', fontWeight: 600 }}>{formatPrice(row.price)}{row.stale && <div className="quote-meta text-warning">Stale</div>}</td>
                <td style={{ padding: '0.7rem 0.4rem', textAlign: 'right', color: row.changePct == null ? 'var(--text-muted)' : row.changePct >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {formatPct(row.changePct)}
                </td>
                <td style={{ padding: '0.7rem 0.4rem', textAlign: 'right', color: a ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {a ? `-${a.dipPercentage.toFixed(1)}%` : '—'}
                </td>
                <td style={{ padding: '0.7rem 0.4rem', textAlign: 'right', color: rsiColor }}>
                    {a?.rsi != null ? a.rsi.toFixed(0) : '—'}
                </td>
                <td style={{ padding: '0.7rem 0.4rem', textAlign: 'center', color: trendColor }}>{trendGlyph}</td>
                <td style={{ padding: '0.7rem 0.4rem', textAlign: 'center' }}>
                    {verdict ? (
                        <span style={{
                            color: verdict.color,
                            border: `1px solid ${verdict.color}40`,
                            background: `${verdict.color}15`,
                            padding: '0.15rem 0.5rem',
                            borderRadius: '20px',
                            fontSize: '0.75rem',
                            whiteSpace: 'nowrap',
                        }}>
                            {verdict.label} ({a.score})
                        </span>
                    ) : <span className="text-muted">—</span>}
                </td>
                <td style={{ padding: '0.7rem 0.2rem', textAlign: 'center' }}>
                    <button
                        onClick={() => onToggle(row.sym)}
                        title="Score breakdown"
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0.2rem' }}
                    >
                        <ChevronDown size={14} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
                    </button>
                </td>
            </tr>
            {expanded && (
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.2)' }}>
                    <td colSpan={8} style={{ padding: '0.75rem 1rem' }}>
                        {a ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                {a.factors.map((f, i) => (
                                    <div key={i} style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline', fontSize: '0.8rem' }}>
                                        <span style={{
                                            minWidth: '34px',
                                            textAlign: 'center',
                                            borderRadius: '10px',
                                            padding: '1px 6px',
                                            fontWeight: 700,
                                            color: f.points > 0 ? 'var(--success)' : f.points < 0 ? 'var(--danger)' : 'var(--text-muted)',
                                            background: f.points > 0 ? 'rgba(16,185,129,0.12)' : f.points < 0 ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.06)',
                                        }}>
                                            {f.points > 0 ? `+${f.points}` : f.points}
                                        </span>
                                        <strong>{f.label}</strong>
                                        <span className="text-muted">{f.detail}</span>
                                    </div>
                                ))}
                                <span className="text-muted" style={{ fontSize: '0.7rem', fontStyle: 'italic' }}>
                                    Score starts at 50; factors sum and clamp to 0–100.
                                </span>
                            </div>
                        ) : (
                            <span className="text-muted" style={{ fontSize: '0.8rem' }}>A technical score requires at least 15 valid daily price observations.</span>
                        )}
                    </td>
                </tr>
            )}
        </>
    );
};

// ─── A titled board of tickers ───────────────────────────────────────────────
const TickerBoard = ({ title, icon, color, rows, loading, expandedRows, onToggle, flexBasis = '420px' }) => (
    <div className="glass-panel" style={{ padding: '1.25rem', flex: `1 1 ${flexBasis}`, minWidth: 0 }}>
        <h3 className="flex-center" style={{ justifyContent: 'flex-start', gap: '0.5rem', marginTop: 0, marginBottom: '0.75rem', color }}>
            {icon}
            {title}
            {loading && <RefreshCw size={14} className="text-muted" style={{ animation: 'spin 1s linear infinite' }} />}
        </h3>
        <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                        {['Symbol', 'Price', 'Day Δ%', 'Off 1M close high', 'RSI', 'Trend', 'Technical rating', ''].map((h, i) => (
                            <th key={i} className="text-muted" style={{ padding: '0.5rem 0.4rem', fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap', textAlign: i === 0 ? 'left' : i >= 5 ? 'center' : 'right' }}>
                                {h}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map(row => (
                        <BoardRow key={row.sym} row={row} expanded={expandedRows.has(row.sym)} onToggle={onToggle} />
                    ))}
                </tbody>
            </table>
            {!loading && rows.length === 0 && (
                <div className="text-muted" style={{ padding: '1rem', textAlign: 'center', fontSize: '0.85rem' }}>
                    No tickers match the current global filter.
                </div>
            )}
        </div>
    </div>
);

// ─── Page ────────────────────────────────────────────────────────────────────
const OilWatch = ({ autoRefreshInterval = 0, globalFilter = 'All' }) => {
    // basket: { [sym]: { sym, name, price, changePct, analysis } }
    const [basket, setBasket] = useState({});
    const [loading, setLoading] = useState(true);
    const [news, setNews] = useState([]);
    const [newsLoading, setNewsLoading] = useState(true);
    const [newsStale, setNewsStale] = useState(false);
    const [basketFetchedAt, setBasketFetchedAt] = useState(null);
    const [basketError, setBasketError] = useState('');
    const [newsFetchedAt, setNewsFetchedAt] = useState(null);
    const [newsError, setNewsError] = useState('');
    const [expandedRows, setExpandedRows] = useState(() => new Set());

    const onToggle = useCallback((sym) => {
        setExpandedRows(prev => {
            const next = new Set(prev);
            if (next.has(sym)) next.delete(sym);
            else next.add(sym);
            return next;
        });
    }, []);

    // Small parallel batches keep quote hydration responsive and avoid overlapping refreshes.
    useEffect(() => {
        let cancelled = false, inFlight = false;
        const symbols = [...new Set([...TANKERS, ...REFINERS, ...OIL_ETFS].map(t => t.sym))];
        const loadBasket = async () => {
            if (inFlight) return;
            inFlight = true;
            await Promise.resolve();
            if (cancelled) return;
            setLoading(true);
            if (!electron) {
                setBasketError('Oil Watch quotes require the desktop app connection.');
                setLoading(false);
                inFlight = false;
                return;
            }
            let failures = 0, successes = 0;
            for (let index = 0; index < symbols.length; index += 5) {
                if (cancelled) return;
                const results = await Promise.all(symbols.slice(index, index + 5).map(async sym => {
                    try {
                        const json = await electron.ipcRenderer.invoke('fetch-yahoo-chart', sym, '1mo', '1d');
                        const result = json?.chart?.result?.[0];
                        const quote = result ? getYahooQuote(result, { range: '1mo' }) : null;
                        if (quote?.price == null) return [sym, null];
                        return [sym, { ...quote, sym, name: result.meta?.longName || result.meta?.shortName || sym,
                            analysis: quote.closes.length >= 15 ? analyzeStock(quote.closes, quote.price) : null, stale: false }];
                    } catch { return [sym, null]; }
                }));
                if (cancelled) return;
                failures += results.filter(([, quote]) => !quote).length;
                successes += results.filter(([, quote]) => quote).length;
                setBasket(previous => {
                    const next = { ...previous };
                    for (const [sym, row] of results) next[sym] = row || (previous[sym] ? { ...previous[sym], stale: true } : null);
                    return next;
                });
            }
            if (successes > 0) setBasketFetchedAt(new Date().toISOString());
            setBasketError(failures > 0 ? `${failures} quote${failures === 1 ? '' : 's'} unavailable. Retained prices are marked stale.` : '');
            setLoading(false);
            inFlight = false;
        };
        loadBasket();
        const timer = autoRefreshInterval > 0 ? setInterval(loadBasket, autoRefreshInterval * 60 * 1000) : null;
        return () => { cancelled = true; if (timer) clearInterval(timer); };
    }, [autoRefreshInterval]);

    useEffect(() => {
        let cancelled = false, inFlight = false;
        const loadNews = async () => {
            if (inFlight) return;
            inFlight = true;
            await Promise.resolve();
            if (cancelled) return;
            setNewsLoading(true);
            if (!electron) {
                setNewsError('News feed requires the desktop app connection.');
                setNewsLoading(false);
                inFlight = false;
                return;
            }
            try {
                const url = `https://news.google.com/rss/search?q=${encodeURIComponent(NEWS_QUERY)}&hl=en-US&gl=US&ceid=US:en`;
                const rss = await electron.ipcRenderer.invoke('fetch-url', url);
                const headlines = parseOilNews(rss);
                if (!cancelled) {
                    setNews(headlines);
                    setNewsFetchedAt(new Date().toISOString());
                    setNewsStale(false);
                    setNewsError('');
                }
            } catch (error) {
                if (!cancelled) { setNewsStale(true); setNewsError(error.message || 'News feed unavailable.'); }
            } finally {
                inFlight = false;
                if (!cancelled) setNewsLoading(false);
            }
        };
        loadNews();
        const timer = autoRefreshInterval > 0 ? setInterval(loadNews, autoRefreshInterval * 60 * 1000) : null;
        return () => { cancelled = true; if (timer) clearInterval(timer); };
    }, [autoRefreshInterval]);

    // Same global filter semantics as the other pages.
    const passesFilter = (row) => {
        if (globalFilter === 'All') return true;
        if (globalFilter === 'Bullish') return (row.changePct ?? 0) > 0;
        if (globalFilter === 'Bearish') return (row.changePct ?? 0) < 0;
        const rating = row.analysis ? getVerdict(row.analysis.score, row.analysis.isZombie).label : null;
        if (globalFilter === 'Sell/Strong Sell' || globalFilter === 'Sell') {
            return rating === 'Sell' || rating === 'Strong Sell';
        }
        return rating === globalFilter;
    };

    const boardRows = (defs) => defs
        .map(def => ({ ...def, ...(basket[def.sym] || { price: null, changePct: null, analysis: null }) }))
        .filter(passesFilter);

    return (
        <div className="oil-watch-page">
            <MarketPulse
                autoRefreshInterval={autoRefreshInterval}
                title="Energy Pulse"
                tickers={ENERGY_TICKERS}
            />

            <div className="flex-between" style={{ marginBottom: '1.5rem' }}>
                <div>
                    <h2 className="text-gradient flex-center" style={{ justifyContent: 'flex-start', gap: '0.5rem' }}>
                        <Droplet size={24} color="var(--primary)" />
                        Oil Watch — Tankers, Refiners &amp; Middle East Flow
                    </h2>
                    <p className="text-muted">
                        Tanker fleet, refiners, and energy ETFs with technical scores and sourced oil headlines.
                    </p>
                </div>
            </div>

            <div className="source-banner"><span>Yahoo Finance · Quote times and source delay shown per ticker</span><span>{basketFetchedAt ? `Fetched ${formatQuoteTime(basketFetchedAt)}` : 'No verified basket quotes loaded'}</span></div>
            {basketError && <p className="data-notice" role="status">{basketError}</p>}
            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {/* Boards column */}
                <div style={{ flex: '2 1 640px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                    <TickerBoard
                        title="Wet Freight — Tanker Fleet"
                        icon={<Ship size={18} />}
                        color="var(--primary)"
                        rows={boardRows(TANKERS)}
                        loading={loading}
                        expandedRows={expandedRows}
                        onToggle={onToggle}
                    />
                    <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                        <TickerBoard
                            title="Refiners"
                            icon={<Factory size={18} />}
                            color="var(--warning)"
                            rows={boardRows(REFINERS)}
                            loading={loading}
                            expandedRows={expandedRows}
                            onToggle={onToggle}
                            flexBasis="560px"
                        />
                        <TickerBoard
                            title="Energy ETFs"
                            icon={<Layers size={18} />}
                            color="var(--success)"
                            rows={boardRows(OIL_ETFS)}
                            loading={loading}
                            expandedRows={expandedRows}
                            onToggle={onToggle}
                            flexBasis="560px"
                        />
                    </div>
                </div>

                {/* News column */}
                <div className="glass-panel" style={{ flex: '1 1 340px', minWidth: 0, padding: '1.25rem', maxHeight: '900px', overflowY: 'auto' }}>
                    <h3 className="flex-center" style={{ justifyContent: 'flex-start', gap: '0.5rem', marginTop: 0, marginBottom: '0.75rem', color: 'var(--secondary)' }}>
                        <Newspaper size={18} />
                        Middle East Oil Intelligence
                        {newsLoading && <RefreshCw size={14} className="text-muted" style={{ animation: 'spin 1s linear infinite' }} />}
                    </h3>
                    <p className="text-muted" style={{ fontSize: '0.78rem', marginBottom: '1rem' }}>
                        Last-24h headlines on Middle East oil, the Strait of Hormuz, OPEC, tankers, and refineries.
                        Conflict and disruption keyword matches are flagged; these tags are not verified event assessments.
                    </p>
                    <p className="source-meta">Google News RSS · {newsFetchedAt ? `Fetched ${formatQuoteTime(newsFetchedAt)}` : 'No feed loaded'}</p>
                    {newsError && <p className="data-notice" role="status">{newsError}</p>}
                    {newsStale && news.length > 0 && (
                        <p style={{ fontSize: '0.72rem', color: 'var(--warning)', margin: '0 0 0.75rem 0' }}>
                            Feed refresh failed — showing the last loaded headlines.
                        </p>
                    )}
                    {!newsLoading && news.length === 0 ? (
                        <div className="text-muted" style={{ textAlign: 'center', padding: '1.5rem 0', fontSize: '0.85rem' }}>
                            {newsError ? 'News feed unavailable.' : 'No headlines available right now.'}
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            {news.map((item, idx) => (
                                <a
                                    key={idx}
                                    // Feed-controlled URLs: only http(s) links are clickable.
                                    href={/^https?:\/\//i.test(item.link) ? item.link : undefined}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                        display: 'block',
                                        padding: '0.75rem',
                                        borderRadius: '8px',
                                        textDecoration: 'none',
                                        background: item.highImpact ? 'rgba(217, 119, 6, 0.12)' : 'rgba(255,255,255,0.02)',
                                        border: item.highImpact ? '1px solid rgba(252, 211, 77, 0.4)' : '1px solid rgba(255,255,255,0.06)',
                                    }}
                                >
                                    <div className="flex-between" style={{ marginBottom: '0.3rem', gap: '0.5rem' }}>
                                        <span className="text-muted" style={{ fontSize: '0.72rem' }}>
                                            {formatQuoteTime(item.publishedAt)}{item.source ? ` · ${item.source}` : ''}
                                        </span>
                                        {item.highImpact && (
                                            <span className="flex-center" style={{
                                                gap: '0.25rem',
                                                fontSize: '0.62rem',
                                                fontWeight: 900,
                                                color: '#fde68a',
                                                background: 'rgba(217, 119, 6, 0.35)',
                                                padding: '0.1rem 0.45rem',
                                                borderRadius: '10px',
                                                whiteSpace: 'nowrap',
                                            }}>
                                                <AlertTriangle size={10} /> KEYWORD FLAG
                                            </span>
                                        )}
                                    </div>
                                    <div style={{ fontSize: '0.85rem', lineHeight: 1.45, color: item.highImpact ? '#fef3c7' : 'var(--text-main)' }}>
                                        {item.title}
                                    </div>
                                </a>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <style>{`
                @keyframes spin { 100% { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
};

export default OilWatch;

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Droplet, Ship, Factory, Layers, Newspaper, ChevronDown, RefreshCw, AlertTriangle } from 'lucide-react';
import MarketPulse from '../components/MarketPulse';
import { analyzeStock, getVerdict } from '../utils/scoring';
import { formatPrice, formatPct, formatQuoteTime } from '../utils/format';
import { getYahooQuote } from '../utils/marketData';
import { parseOilNews } from '../utils/oilNews';
import '../styles/pages/oil-watch.css';

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

// ─── Presentation helpers (tone classes; colours live in oil-watch.css) ──────
const BOARD_COLUMNS = [
    { label: 'Symbol', className: '' },
    { label: 'Price', className: 'numeric' },
    { label: 'Day Δ%', className: 'numeric' },
    { label: 'Off 1M close high', className: 'numeric' },
    { label: 'RSI', className: 'numeric' },
    { label: 'Trend', className: 'centered' },
    { label: 'Technical rating', className: 'centered' },
    { label: '', className: 'centered' },
];

const RATING_TONE = { 'Strong Buy': 'strong-buy', Buy: 'buy', Hold: 'hold', Sell: 'sell', 'Strong Sell': 'strong-sell' };

const signTone = (value) => value == null ? 'oil-flat' : value >= 0 ? 'oil-up' : 'oil-down';

// ─── One row of a ticker board ───────────────────────────────────────────────
const BoardRow = ({ row, expanded, onToggle }) => {
    const a = row.analysis;
    const verdict = a ? getVerdict(a.score, a.isZombie) : null;
    const ratingTone = verdict ? (a.isZombie ? 'muted' : RATING_TONE[verdict.label] || 'muted') : null;
    const rsiTone = a?.rsi == null ? 'oil-flat' : a.rsi <= 30 ? 'oil-up' : a.rsi >= 70 ? 'oil-down' : 'oil-flat';
    const trendTone = a?.trend === 'bullish' ? 'oil-up' : a?.trend === 'bearish' ? 'oil-down' : 'oil-flat';
    const trendGlyph = a?.trend === 'bullish' ? '▲' : a?.trend === 'bearish' ? '▼' : '—';
    const note = row.group || row.note || (row.name && row.name !== row.sym ? row.name : '');

    return (
        <>
            <tr className={`oil-row${expanded ? ' is-expanded' : ''}`}>
                <td>
                    <Link to={`/stock/${row.sym}`} className="oil-symbol">{row.sym}</Link>
                    <div className="oil-symbol-note" title={row.name}>{note}</div>
                    <div className="quote-meta" title={row.fetchedAt ? `Fetched ${formatQuoteTime(row.fetchedAt)}` : undefined}>Quote {formatQuoteTime(row.quotedAt)}</div>
                    <div className="quote-meta">{row.delayMinutes == null ? 'Delay not provided' : `Source delay: ${row.delayMinutes} min`}</div>
                </td>
                <td className="numeric oil-price">
                    {formatPrice(row.price)}
                    {row.stale && <div className="quote-meta oil-stale">Stale</div>}
                </td>
                <td className={`numeric ${signTone(row.changePct)}`}>{formatPct(row.changePct)}</td>
                <td className={`numeric ${a ? 'oil-down' : 'oil-flat'}`}>{a ? `-${a.dipPercentage.toFixed(1)}%` : '—'}</td>
                <td className={`numeric ${rsiTone}`}>{a?.rsi != null ? a.rsi.toFixed(0) : '—'}</td>
                <td className={`centered ${trendTone}`}>{trendGlyph}</td>
                <td className="centered">
                    {verdict
                        ? <span className={`oil-rating oil-rating--${ratingTone}`}>{verdict.label} ({a.score})</span>
                        : <span className="oil-flat">—</span>}
                </td>
                <td className="centered oil-expand-cell">
                    <button
                        type="button"
                        className="oil-expand"
                        onClick={() => onToggle(row.sym)}
                        title="Score breakdown"
                        aria-label={`Score breakdown for ${row.sym}`}
                        aria-expanded={expanded}
                    >
                        <ChevronDown size={14} />
                    </button>
                </td>
            </tr>
            {expanded && (
                <tr className="oil-row-detail">
                    <td colSpan={8}>
                        {a ? (
                            <div className="oil-factors">
                                {a.factors.map((f, i) => (
                                    <div key={i} className="oil-factor">
                                        <span className={`oil-factor-points oil-factor-points--${f.points > 0 ? 'up' : f.points < 0 ? 'down' : 'flat'}`}>
                                            {f.points > 0 ? `+${f.points}` : f.points}
                                        </span>
                                        <strong>{f.label}</strong>
                                        <span className="oil-factor-detail">{f.detail}</span>
                                    </div>
                                ))}
                                <span className="oil-factor-note">Score starts at 50; factors sum and clamp to 0–100.</span>
                            </div>
                        ) : (
                            <span className="oil-factor-detail">A technical score requires at least 15 valid daily price observations.</span>
                        )}
                    </td>
                </tr>
            )}
        </>
    );
};

// ─── A titled board of tickers ───────────────────────────────────────────────
const TickerBoard = ({ title, icon, tone, rows, loading, expandedRows, onToggle, wide = false }) => (
    <section className={`glass-panel oil-board oil-board--${tone}${wide ? ' oil-board--wide' : ''}`} aria-label={title} aria-busy={loading}>
        <div className="oil-board-head">
            <h3><span className="oil-board-icon">{icon}</span>{title}</h3>
            {loading && <RefreshCw size={14} className="oil-board-spinner is-spinning" aria-label="Refreshing quotes" />}
        </div>
        <div className="oil-table-scroll">
            <table className="oil-table">
                <thead>
                    <tr>
                        {BOARD_COLUMNS.map((column, i) => (
                            <th key={i} scope="col" className={column.className}>{column.label}</th>
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
                <div className="oil-board-empty">No tickers match the current global filter.</div>
            )}
        </div>
    </section>
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

            <div className="flex-between oil-heading">
                <div>
                    <h2 className="text-gradient">
                        <Droplet size={24} className="oil-title-icon" />
                        Oil Watch — Tankers, Refiners &amp; Middle East Flow
                    </h2>
                    <p className="text-muted">
                        Tanker fleet, refiners, and energy ETFs with technical scores and sourced oil headlines.
                    </p>
                </div>
            </div>

            <div className="source-banner"><span>Yahoo Finance · Quote times and source delay shown per ticker</span><span>{basketFetchedAt ? `Fetched ${formatQuoteTime(basketFetchedAt)}` : 'No verified basket quotes loaded'}</span></div>
            {basketError && <p className="data-notice" role="status">{basketError}</p>}
            <div className="oil-layout">
                {/* Boards column */}
                <div className="oil-boards">
                    <TickerBoard
                        title="Wet Freight — Tanker Fleet"
                        icon={<Ship size={18} />}
                        tone="primary"
                        rows={boardRows(TANKERS)}
                        loading={loading}
                        expandedRows={expandedRows}
                        onToggle={onToggle}
                    />
                    <div className="oil-boards-row">
                        <TickerBoard
                            title="Refiners"
                            icon={<Factory size={18} />}
                            tone="warning"
                            rows={boardRows(REFINERS)}
                            loading={loading}
                            expandedRows={expandedRows}
                            onToggle={onToggle}
                            wide
                        />
                        <TickerBoard
                            title="Energy ETFs"
                            icon={<Layers size={18} />}
                            tone="success"
                            rows={boardRows(OIL_ETFS)}
                            loading={loading}
                            expandedRows={expandedRows}
                            onToggle={onToggle}
                            wide
                        />
                    </div>
                </div>

                {/* News column */}
                <section className="glass-panel oil-news-panel oil-board--secondary" aria-label="Middle East Oil Intelligence" aria-busy={newsLoading}>
                    <div className="oil-board-head oil-news-head">
                        <h3><span className="oil-board-icon"><Newspaper size={18} /></span>Middle East Oil Intelligence</h3>
                        {newsLoading && <RefreshCw size={14} className="oil-board-spinner is-spinning" aria-label="Refreshing headlines" />}
                    </div>
                    <p className="oil-news-intro">
                        Last-24h headlines on Middle East oil, the Strait of Hormuz, OPEC, tankers, and refineries.
                        Conflict and disruption keyword matches are flagged; these tags are not verified event assessments.
                    </p>
                    <p className="source-meta">Google News RSS · {newsFetchedAt ? `Fetched ${formatQuoteTime(newsFetchedAt)}` : 'No feed loaded'}</p>
                    {newsError && <p className="data-notice" role="status">{newsError}</p>}
                    {newsStale && news.length > 0 && (
                        <p className="oil-news-stale" role="status">Feed refresh failed — showing the last loaded headlines.</p>
                    )}
                    {!newsLoading && news.length === 0 ? (
                        <div className="oil-news-empty">
                            {newsError ? 'News feed unavailable.' : 'No headlines available right now.'}
                        </div>
                    ) : (
                        <div className="oil-news-list">
                            {news.map((item) => (
                                <a
                                    key={item.link}
                                    // Feed-controlled URLs: only http(s) links are clickable.
                                    href={/^https?:\/\//i.test(item.link) ? item.link : undefined}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={`oil-news-item${item.highImpact ? ' oil-news-item--high' : ''}`}
                                >
                                    <div className="oil-news-meta">
                                        <span>{formatQuoteTime(item.publishedAt)}{item.source ? ` · ${item.source}` : ''}</span>
                                        {item.highImpact && (
                                            <span className="oil-badge-impact" title="Conflict or disruption keyword match — not a verified event assessment">
                                                <AlertTriangle size={10} aria-hidden="true" /> HIGH IMPACT
                                            </span>
                                        )}
                                    </div>
                                    <div className="oil-news-title">{item.title}</div>
                                </a>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
};

export default OilWatch;

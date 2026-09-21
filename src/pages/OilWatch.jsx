import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Droplet, Ship, Factory, Layers, Newspaper, ChevronDown, RefreshCw, AlertTriangle } from 'lucide-react';
import MarketPulse from '../components/MarketPulse';
import { analyzeStock, getVerdict } from '../utils/scoring';
import { formatPrice, formatPct } from '../utils/format';

const electron = typeof window !== 'undefined' && typeof window.require === 'function'
    ? window.require('electron')
    : null;

// ─── Energy complex for the pulse strip ──────────────────────────────────────
const ENERGY_TICKERS = [
    { sym: 'CL=F', label: 'WTI Crude' },
    { sym: 'BZ=F', label: 'Brent Crude' },
    { sym: 'RB=F', label: 'Gasoline' },
    { sym: 'NG=F', label: 'Nat Gas' },
    { sym: 'XLE', label: 'Energy Sector' },
];

const ENERGY_MOCKS = {
    'CL=F': { price: 78.42, changePct: 2.31, closes: [76.5, 76.8, 76.6, 77.2, 77.5, 77.9, 77.6, 78.1, 78.5, 78.42] },
    'BZ=F': { price: 82.15, changePct: 2.08, closes: [80.3, 80.6, 80.4, 81.0, 81.3, 81.6, 81.4, 81.9, 82.3, 82.15] },
    'RB=F': { price: 2.41, changePct: 1.45, closes: [2.37, 2.38, 2.37, 2.39, 2.40, 2.39, 2.40, 2.41, 2.42, 2.41] },
    'NG=F': { price: 2.87, changePct: -1.20, closes: [2.92, 2.91, 2.93, 2.90, 2.89, 2.90, 2.88, 2.87, 2.88, 2.87] },
    'XLE': { price: 91.30, changePct: 1.12, closes: [90.1, 90.4, 90.2, 90.7, 90.9, 90.6, 91.0, 91.3, 91.5, 91.3] },
};

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

// Terms that mark a headline as high-impact for oil flows out of the Middle East.
const HIGH_IMPACT_TERMS = [
    'hormuz', 'attack', 'strike', 'blockade', 'sanction', 'seiz', 'closure', 'closed',
    'fire', 'explosion', 'blast', 'drone', 'missile', 'war', 'escalat', 'disrupt', 'halt', 'embargo',
];

const NEWS_QUERY = '"Middle East" oil OR "Strait of Hormuz" OR OPEC OR "oil tanker" OR refinery when:24h';

const MOCK_NEWS = [
    { title: 'Mock: Tanker rates spike as insurers reprice Strait of Hormuz transits', link: 'https://news.google.com', source: 'Mock Wire', time: '09:10', highImpact: true },
    { title: 'Mock: OPEC+ signals output hold through next quarter', link: 'https://news.google.com', source: 'Mock Wire', time: '08:42', highImpact: false },
    { title: 'Mock: Gulf refinery restarts unit after maintenance', link: 'https://news.google.com', source: 'Mock Wire', time: '07:55', highImpact: false },
];

const isHighImpact = (title) => {
    const lower = (title || '').toLowerCase();
    return HIGH_IMPACT_TERMS.some(t => lower.includes(t));
};

// Deterministic-ish mock series so browser dev renders full boards.
const buildMockSeries = (seed) => {
    let x = seed;
    const rand = () => {
        x = (x * 1103515245 + 12345) % 2147483648;
        return x / 2147483648;
    };
    const series = [];
    let price = 20 + rand() * 120;
    for (let i = 0; i < 30; i++) {
        price = Math.max(1, price * (1 + (rand() - 0.51) * 0.05));
        series.push(Number(price.toFixed(2)));
    }
    return series;
};

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
                </td>
                <td style={{ padding: '0.7rem 0.4rem', textAlign: 'right', fontWeight: 600 }}>{formatPrice(row.price)}</td>
                <td style={{ padding: '0.7rem 0.4rem', textAlign: 'right', color: row.changePct == null ? 'var(--text-muted)' : row.changePct >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {formatPct(row.changePct)}
                </td>
                <td style={{ padding: '0.7rem 0.4rem', textAlign: 'right', color: 'var(--danger)' }}>
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
                            <span className="text-muted" style={{ fontSize: '0.8rem' }}>Score not hydrated yet.</span>
                        )}
                    </td>
                </tr>
            )}
        </>
    );
};

// ─── A titled board of tickers ───────────────────────────────────────────────
const TickerBoard = ({ title, icon, color, rows, loading, expandedRows, onToggle }) => (
    <div className="glass-panel" style={{ padding: '1.25rem', flex: '1 1 420px', minWidth: 0 }}>
        <h3 className="flex-center" style={{ justifyContent: 'flex-start', gap: '0.5rem', marginTop: 0, marginBottom: '0.75rem', color }}>
            {icon}
            {title}
            {loading && <RefreshCw size={14} className="text-muted" style={{ animation: 'spin 1s linear infinite' }} />}
        </h3>
        <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                        {['Symbol', 'Price', 'Day Δ%', 'Off 30d High', 'RSI', 'Trend', 'Rating', ''].map((h, i) => (
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
    const [expandedRows, setExpandedRows] = useState(() => new Set());

    const onToggle = useCallback((sym) => {
        setExpandedRows(prev => {
            const next = new Set(prev);
            if (next.has(sym)) next.delete(sym);
            else next.add(sym);
            return next;
        });
    }, []);

    // Fetch every basket symbol once (deduped), in small chunks like the dashboard hydrator.
    useEffect(() => {
        let cancelled = false;
        const allSymbols = [...new Set([...TANKERS, ...REFINERS, ...OIL_ETFS].map(t => t.sym))];

        const loadBasket = async () => {
            setLoading(true);

            if (!electron) {
                const entries = allSymbols.map((sym, i) => {
                    const closes = buildMockSeries(i + 7);
                    const price = closes[closes.length - 1];
                    const prev = closes[closes.length - 2];
                    return [sym, {
                        sym,
                        name: sym,
                        price,
                        changePct: ((price - prev) / prev) * 100,
                        analysis: analyzeStock(closes, price),
                    }];
                });
                if (!cancelled) {
                    setBasket(Object.fromEntries(entries));
                    setLoading(false);
                }
                return;
            }

            const chunkSize = 5;
            for (let i = 0; i < allSymbols.length; i += chunkSize) {
                if (cancelled) return;
                const chunk = allSymbols.slice(i, i + chunkSize);
                await Promise.all(chunk.map(async (sym) => {
                    try {
                        const json = await electron.ipcRenderer.invoke('fetch-yahoo-chart', sym, '1mo', '1d');
                        const result = json?.chart?.result?.[0];
                        if (!result) return;
                        const meta = result.meta || {};
                        const closes = (result.indicators?.quote?.[0]?.close || [])
                            .filter(c => c !== null && c !== undefined);
                        if (closes.length === 0) return;
                        const price = meta.regularMarketPrice ?? closes[closes.length - 1];
                        // Day change from the prior daily bar (chartPreviousClose on a
                        // 1mo request is the close from a month ago — see Dashboard).
                        const prevClose = closes.length >= 2 ? closes[closes.length - 2] : null;
                        const changePct = (price && prevClose) ? ((price - prevClose) / prevClose) * 100 : null;
                        const row = {
                            sym,
                            name: meta.longName ?? meta.shortName ?? sym,
                            price,
                            changePct,
                            analysis: analyzeStock(closes, price),
                        };
                        if (!cancelled) setBasket(prev => ({ ...prev, [sym]: row }));
                    } catch (err) {
                        console.error(`OilWatch: failed to fetch ${sym}`, err);
                    }
                }));
                await new Promise(r => setTimeout(r, 300));
            }
            if (!cancelled) setLoading(false);
        };

        loadBasket();

        if (autoRefreshInterval > 0) {
            const intervalId = setInterval(loadBasket, autoRefreshInterval * 60 * 1000);
            return () => { cancelled = true; clearInterval(intervalId); };
        }
        return () => { cancelled = true; };
    }, [autoRefreshInterval]);

    // Middle East oil news via Google News RSS (same approach as telemetry.js).
    useEffect(() => {
        let cancelled = false;

        const loadNews = async () => {
            setNewsLoading(true);

            if (!electron) {
                setTimeout(() => {
                    if (cancelled) return;
                    setNews(MOCK_NEWS);
                    setNewsLoading(false);
                }, 500);
                return;
            }

            try {
                const url = `https://news.google.com/rss/search?q=${encodeURIComponent(NEWS_QUERY)}&hl=en-US&gl=US&ceid=US:en`;
                const rssText = await electron.ipcRenderer.invoke('fetch-url', url);
                const xml = new DOMParser().parseFromString(rssText, 'text/xml');
                const items = xml.querySelectorAll('item');
                const parsed = [];
                for (let i = 0; i < Math.min(items.length, 15); i++) {
                    const item = items[i];
                    let title = item.querySelector('title')?.textContent || '';
                    const source = item.querySelector('source')?.textContent
                        || (title.lastIndexOf(' - ') > 0 ? title.slice(title.lastIndexOf(' - ') + 3) : '');
                    const dashIndex = title.lastIndexOf(' - ');
                    if (dashIndex > 0) title = title.slice(0, dashIndex);
                    const link = item.querySelector('link')?.textContent || '';
                    const pubDate = item.querySelector('pubDate')?.textContent;
                    const time = pubDate
                        ? new Date(pubDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                        : '';
                    parsed.push({ title, link, source, time, highImpact: isHighImpact(title) });
                }
                // High-impact headlines float to the top, otherwise keep feed order.
                parsed.sort((a, b) => Number(b.highImpact) - Number(a.highImpact));
                if (!cancelled) setNews(parsed);
            } catch (err) {
                console.error('OilWatch: news fetch failed', err);
                if (!cancelled) setNews([]);
            } finally {
                if (!cancelled) setNewsLoading(false);
            }
        };

        loadNews();

        if (autoRefreshInterval > 0) {
            const intervalId = setInterval(loadNews, autoRefreshInterval * 60 * 1000);
            return () => { cancelled = true; clearInterval(intervalId); };
        }
        return () => { cancelled = true; };
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
                mocks={ENERGY_MOCKS}
            />

            <div className="flex-between" style={{ marginBottom: '1.5rem' }}>
                <div>
                    <h2 className="text-gradient flex-center" style={{ justifyContent: 'flex-start', gap: '0.5rem' }}>
                        <Droplet size={24} color="var(--primary)" />
                        Oil Watch — Tankers, Refiners &amp; Middle East Flow
                    </h2>
                    <p className="text-muted">
                        Wet-freight tanker fleet, refiners, and energy ETFs scored by the shared recovery engine,
                        with a live Middle East oil intelligence feed.
                    </p>
                </div>
            </div>

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
                        />
                        <TickerBoard
                            title="Energy ETFs"
                            icon={<Layers size={18} />}
                            color="var(--success)"
                            rows={boardRows(OIL_ETFS)}
                            loading={loading}
                            expandedRows={expandedRows}
                            onToggle={onToggle}
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
                        High-impact events are flagged and float to the top.
                    </p>
                    {!newsLoading && news.length === 0 ? (
                        <div className="text-muted" style={{ textAlign: 'center', padding: '1.5rem 0', fontSize: '0.85rem' }}>
                            No headlines available right now.
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            {news.map((item, idx) => (
                                <a
                                    key={idx}
                                    href={item.link}
                                    target="_blank"
                                    rel="noreferrer"
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
                                            {item.time}{item.source ? ` · ${item.source}` : ''}
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
                                                <AlertTriangle size={10} /> HIGH IMPACT
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

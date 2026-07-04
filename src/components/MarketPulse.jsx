import { useState, useEffect } from 'react';
import { Radio } from 'lucide-react';
import { formatPrice, formatPct } from '../utils/format';

const electron = typeof window.require === 'function' ? window.require('electron') : null;

const TRACKED = [
    { sym: 'SPY', label: 'S&P 500' },
    { sym: 'QQQ', label: 'Nasdaq 100' },
    { sym: 'DIA', label: 'Dow 30' },
    { sym: 'IWM', label: 'Russell 2000' },
    { sym: '^VIX', label: 'VIX' }
];

// Plausible mock values so the strip still renders in a plain browser (vite dev).
const MOCK_QUOTES = {
    'SPY': { price: 512.30, changePct: 0.82, closes: [508.1, 508.9, 509.4, 508.8, 510.2, 511.0, 510.6, 511.8, 512.5, 512.3] },
    'QQQ': { price: 445.10, changePct: 1.14, closes: [440.2, 441.0, 440.5, 442.1, 443.0, 442.6, 443.9, 444.7, 445.4, 445.1] },
    'DIA': { price: 389.60, changePct: -0.24, closes: [390.9, 390.4, 390.7, 390.1, 389.8, 390.2, 389.5, 389.9, 389.4, 389.6] },
    'IWM': { price: 201.45, changePct: 0.37, closes: [200.6, 200.9, 200.4, 201.1, 200.8, 201.3, 201.0, 201.6, 201.2, 201.45] },
    '^VIX': { price: 14.82, changePct: -3.51, closes: [15.6, 15.4, 15.5, 15.2, 15.0, 15.1, 14.9, 14.95, 14.8, 14.82] }
};

// Manual SVG polyline sparkline (no recharts) — closes normalized into a 100x26 viewBox.
const Sparkline = ({ closes, color }) => {
    const width = 100;
    const height = 26;
    if (!closes || closes.length < 2) {
        return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" />;
    }
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    const pad = 2;
    const points = closes.map((v, i) => {
        const x = (i / (closes.length - 1)) * width;
        const y = pad + (1 - (v - min) / span) * (height - pad * 2);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
    return (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
    );
};

const MarketPulse = ({ autoRefreshInterval = 0 }) => {
    // quotes: { [sym]: { price, changePct, closes } | null } — null renders as '—'.
    const [quotes, setQuotes] = useState({});
    const [updatedAt, setUpdatedAt] = useState(null);

    useEffect(() => {
        const fetchQuotes = async () => {
            if (!electron) {
                // Browser dev (no IPC): fall back to mock data so the strip still renders.
                setQuotes(MOCK_QUOTES);
                setUpdatedAt(new Date());
                return;
            }
            const results = await Promise.all(TRACKED.map(async ({ sym }) => {
                try {
                    const json = await electron.ipcRenderer.invoke('fetch-yahoo-chart', sym, '1d', '5m');
                    const result = json?.chart?.result?.[0];
                    if (!result) return [sym, null];
                    const meta = result.meta || {};
                    const price = meta.regularMarketPrice;
                    const prevClose = meta.chartPreviousClose ?? meta.previousClose;
                    if (price == null || prevClose == null || !prevClose) return [sym, null];
                    const changePct = (price / prevClose - 1) * 100;
                    const rawCloses = result.indicators?.quote?.[0]?.close || [];
                    const closes = rawCloses.filter(c => c !== null && c !== undefined);
                    return [sym, { price, changePct, closes }];
                } catch (err) {
                    console.error(`MarketPulse: failed to fetch ${sym}:`, err);
                    return [sym, null];
                }
            }));
            setQuotes(Object.fromEntries(results));
            setUpdatedAt(new Date());
        };

        fetchQuotes();

        if (autoRefreshInterval > 0) {
            const intervalId = setInterval(fetchQuotes, autoRefreshInterval * 60 * 1000);
            return () => clearInterval(intervalId);
        }
    }, [autoRefreshInterval]);

    return (
        <div style={{ marginBottom: '1.5rem' }}>
            <div className="flex-between" style={{ marginBottom: '0.5rem' }}>
                <span className="text-muted flex-center" style={{ gap: '0.4rem', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    <Radio size={14} />
                    Market Pulse
                </span>
                <span className="text-muted" style={{ fontSize: '0.75rem' }}>
                    {updatedAt ? `updated ${updatedAt.toLocaleTimeString('en-US', { hour12: false })}` : 'updating…'}
                </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
                {TRACKED.map(({ sym, label }) => {
                    const q = quotes[sym];
                    const up = q ? q.changePct >= 0 : true;
                    const changeColor = up ? 'var(--success)' : 'var(--danger)';
                    return (
                        <div key={sym} className="glass-panel" style={{ padding: '0.75rem 1rem', flex: 1, minWidth: '150px' }}>
                            <div className="flex-between" style={{ marginBottom: '0.25rem' }}>
                                <span className="text-muted" style={{ fontSize: '0.75rem' }}>{label}</span>
                                <span className="text-muted" style={{ fontSize: '0.7rem', fontWeight: 'bold' }}>{sym}</span>
                            </div>
                            <div className="flex-between" style={{ gap: '0.5rem', marginBottom: '0.35rem' }}>
                                <span style={{ fontWeight: 'bold', fontSize: '1.05rem', color: 'var(--text-main)' }}>
                                    {q ? formatPrice(q.price) : '—'}
                                </span>
                                <span style={{
                                    fontSize: '0.75rem',
                                    fontWeight: '600',
                                    color: changeColor,
                                    background: q ? (up ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)') : 'transparent',
                                    padding: '0.1rem 0.4rem',
                                    borderRadius: '6px'
                                }}>
                                    {q ? formatPct(q.changePct) : '—'}
                                </span>
                            </div>
                            <Sparkline closes={q ? q.closes : null} color={changeColor} />
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default MarketPulse;

import { useState, useEffect, memo } from 'react';
import { Radio, AlertTriangle } from 'lucide-react';
import { formatPrice, formatPct, formatQuoteTime } from '../utils/format';
import { getYahooQuote } from '../utils/marketData';

const electron = typeof window.require === 'function' ? window.require('electron') : null;
const TRACKED = [
    { sym: 'SPY', label: 'S&P 500 ETF' },
    { sym: 'QQQ', label: 'Nasdaq 100 ETF' },
    { sym: 'DIA', label: 'Dow 30 ETF' },
    { sym: 'IWM', label: 'Russell 2000 ETF' },
    { sym: '^VIX', label: 'Volatility index', unit: 'points' },
];

const Sparkline = memo(({ closes, color }) => {
    const width = 120, height = 26, pad = 2;
    if (!closes || closes.length < 2) return <div className="pulse-sparkline-empty" aria-hidden="true" />;
    const min = Math.min(...closes), span = Math.max(...closes) - min || 1;
    const points = closes.map((value, index) => `${(pad + index / (closes.length - 1) * (width - pad * 2)).toFixed(1)},${(pad + (1 - (value - min) / span) * (height - pad * 2)).toFixed(1)}`).join(' ');
    return <svg className="pulse-sparkline" viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>;
});

const MarketPulse = ({ autoRefreshInterval = 0, title = 'Market Pulse', tickers = TRACKED }) => {
    const [quotes, setQuotes] = useState({});
    const [fetchedAt, setFetchedAt] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false, inFlight = false;
        const fetchQuotes = async () => {
            if (inFlight) return;
            inFlight = true;
            await Promise.resolve();
            if (cancelled) return;
            setLoading(true);
            if (!electron) {
                setError('Market quotes require the desktop app connection.');
                setLoading(false);
                inFlight = false;
                return;
            }
            const results = await Promise.all(tickers.map(async ({ sym }) => {
                try {
                    const json = await electron.ipcRenderer.invoke('fetch-yahoo-chart', sym, '1d', '5m');
                    const result = json?.chart?.result?.[0];
                    const quote = result ? getYahooQuote(result, { range: '1d' }) : null;
                    return [sym, quote?.price != null ? { ...quote, stale: false } : null];
                } catch { return [sym, null]; }
            }));
            inFlight = false;
            if (cancelled) return;
            const successes = results.filter(([, quote]) => quote != null).length;
            setQuotes(previous => Object.fromEntries(results.map(([sym, quote]) => [sym, quote || (previous[sym] ? { ...previous[sym], stale: true } : null)])));
            if (successes > 0) setFetchedAt(new Date().toISOString());
            setError(successes < tickers.length ? `${tickers.length - successes} quote${tickers.length - successes === 1 ? '' : 's'} unavailable. Retained prices are marked stale.` : '');
            setLoading(false);
        };
        fetchQuotes();
        const timer = autoRefreshInterval > 0 ? setInterval(fetchQuotes, autoRefreshInterval * 60 * 1000) : null;
        return () => { cancelled = true; if (timer) clearInterval(timer); };
    }, [autoRefreshInterval, tickers]);

    return (
        <section className="market-pulse" aria-label={title}>
            <div className="pulse-heading">
                <span className="section-kicker"><Radio size={14} /> {title}</span>
                <span className="source-meta">Yahoo Finance · {loading ? 'Fetching…' : fetchedAt ? `Fetched ${formatQuoteTime(fetchedAt)}` : 'No quotes loaded'}</span>
            </div>
            {error && <p className="data-notice data-status" role="status"><AlertTriangle size={13} />{error}</p>}
            <div className="pulse-grid">
                {tickers.map(({ sym, label, unit }) => {
                    const quote = quotes[sym];
                    const changeColor = quote?.changePct == null ? 'var(--text-muted)' : quote.changePct >= 0 ? 'var(--success)' : 'var(--danger)';
                    const price = quote?.price == null ? '—' : unit === 'points' ? `${quote.price.toFixed(2)}` : quote.currency && quote.currency !== 'USD' ? `${quote.price.toFixed(2)} ${quote.currency}` : formatPrice(quote.price);
                    return (
                        <article key={sym} className={`pulse-card glass-panel${quote?.stale ? ' data-stale' : ''}`}>
                            <div className="pulse-card-label"><span>{label}</span><span>{sym}</span></div>
                            <div className="pulse-values"><span className="pulse-price">{price}</span><span className="pulse-change" style={{ color: changeColor }}>{formatPct(quote?.changePct)}</span></div>
                            <Sparkline closes={quote?.closes} color={changeColor} />
                            <div className="quote-meta" title={quote ? `Quote: ${formatQuoteTime(quote.quotedAt)} · Fetched: ${formatQuoteTime(quote.fetchedAt)}` : 'No verified quote available'}>
                                {unit && <span>{unit} · </span>}
                                {quote?.stale ? 'Stale · ' : ''}{quote ? `Quote ${formatQuoteTime(quote.quotedAt)}` : loading ? 'Fetching quote…' : 'Unavailable'}
                            </div>
                            {quote && <div className="quote-meta">{quote.delayMinutes == null ? 'Delay not provided by source' : `Source delay: ${quote.delayMinutes} min`}</div>}
                        </article>
                    );
                })}
            </div>
        </section>
    );
};
export default MarketPulse;

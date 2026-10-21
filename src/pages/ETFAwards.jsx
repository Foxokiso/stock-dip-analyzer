import { useState, useEffect } from 'react';
import { Trophy, TrendingUp, DollarSign, Percent, ExternalLink, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { parseFinvizScreener } from '../utils/finviz';
import { formatPrice, formatPct, formatCompact, formatQuoteTime } from '../utils/format';
import '../styles/pages/etf-discovery.css';

const CATEGORIES = [
    { key: 'performance', title: 'One month leaders', field: 'perfMonth', metric: '1 month return', view: '141', order: '-perf4w', icon: TrendingUp },
    { key: 'dividend', title: 'Dividend yield leaders', field: 'dividendYield', metric: 'Dividend yield', view: '161', order: '-dividendyield', icon: DollarSign },
    { key: 'capitalGain', title: 'One year leaders', field: 'perfYear', metric: '1 year return', view: '141', order: '-perf52w', icon: Percent },
];
const initialLists = Object.fromEntries(CATEGORIES.map(category => [category.key, { rows: [], fetchedAt: null, error: '', stale: false }]));

const ETFAwards = ({ autoRefreshInterval = 0, globalFilter = 'All' }) => {
    const [lists, setLists] = useState(initialLists);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false, inFlight = false;
        const fetchEtfs = async () => {
            if (inFlight) return;
            inFlight = true;
            await Promise.resolve();
            if (cancelled) return;
            setLoading(true);
            if (typeof window.require !== 'function') {
                setLists(previous => Object.fromEntries(CATEGORIES.map(({ key }) => [key, { ...previous[key], error: 'ETF quotes require the desktop app connection.' }])));
                setLoading(false);
                inFlight = false;
                return;
            }
            const electron = window.require('electron');
            // The three rankings are independent pages: fetch them together and
            // show each one the moment it lands.
            await Promise.all(CATEGORIES.map(async (category) => {
                if (cancelled) return;
                try {
                    const url = `https://finviz.com/screener.ashx?v=${category.view}&f=ind_exchangetradedfund&o=${category.order}`;
                    const html = await electron.ipcRenderer.invoke('fetch-url', url);
                    const fetchedAt = new Date().toISOString();
                    const rows = parseFinvizScreener(html, { view: category.view, fetchedAt }).slice(0, 10);
                    if (!cancelled) setLists(previous => ({ ...previous, [category.key]: { rows, fetchedAt, error: '', stale: false } }));
                } catch (error) {
                    if (!cancelled) setLists(previous => ({ ...previous, [category.key]: { ...previous[category.key], stale: previous[category.key].rows.length > 0, error: error.message || 'Finviz ETF data is unavailable.' } }));
                }
            }));
            inFlight = false;
            if (!cancelled) setLoading(false);
        };
        fetchEtfs();
        const timer = autoRefreshInterval > 0 ? setInterval(fetchEtfs, autoRefreshInterval * 60 * 1000) : null;
        return () => { cancelled = true; if (timer) clearInterval(timer); };
    }, [autoRefreshInterval]);

    const hasRatingFilter = !['All', 'Bullish', 'Bearish'].includes(globalFilter);
    return (
        <div className="etf-awards-page">
            <div className="page-heading flex-between">
                <div><p className="eyebrow">Fund research</p><h2><Trophy size={24} /> ETF leaders</h2><p className="text-muted">Finviz rankings with the corresponding return or dividend yield displayed.</p></div>
                <a href="https://etfdb.com/" target="_blank" rel="noopener noreferrer" className="btn btn-outline"><ExternalLink size={16} /> ETF Database</a>
            </div>
            <div className="source-banner"><span>Finviz · US equities delayed 1 minute · Quote timestamp not supplied</span>{loading && <span className="etf-fetch-status" role="status"><RefreshCw size={13} className="spin" /> Fetching rankings…</span>}</div>
            {hasRatingFilter && <p className="data-notice">ETF rankings do not carry recovery ratings. Select All Ratings, Bullish, or Bearish to view these lists.</p>}
            <div className="etf-leaders-grid">
                {CATEGORIES.map(category => {
                    const { key, title, field, metric, icon: Icon } = category;
                    const list = lists[key];
                    const rows = hasRatingFilter ? [] : list.rows.filter(etf => globalFilter === 'All' || (globalFilter === 'Bullish' ? etf.change > 0 : etf.change < 0));
                    return (
                        <section key={key} className={`glass-panel etf-leader-panel${list.stale ? ' data-stale' : ''}`}>
                            <h3><Icon size={18} />{title}</h3>
                            <p className="source-meta">{list.fetchedAt ? `Fetched ${formatQuoteTime(list.fetchedAt)}` : 'No verified data loaded'}{list.stale ? ' · Stale' : ''}</p>
                            {list.error && <p className="data-notice" role="status">{list.error}{list.stale ? ' Showing the last successful list.' : ''}</p>}
                            {rows.length === 0 && <div className="desk-empty">{loading && !list.fetchedAt ? 'Fetching rankings…' : list.error && !list.fetchedAt ? 'Rankings unavailable.' : 'No funds match the current filter.'}</div>}
                            {rows.map((etf, index) => {
                                const rank = list.rows.indexOf(etf) + 1 || index + 1;
                                const tone = etf[field] == null ? 'text-muted' : etf[field] >= 0 ? 'text-success' : 'text-danger';
                                return (
                                    <div key={etf.symbol} className="etf-leader-row">
                                        <div className="etf-leader-symbol"><span className={`etf-leader-rank${rank <= 3 ? ' is-top' : ''}`}>{rank}</span><div className="etf-leader-ident"><Link to={`/stock/${etf.symbol}`}>{etf.symbol}</Link>{etf.name !== etf.symbol && <p className="etf-leader-name" title={etf.name}>{etf.name}</p>}<span className="quote-meta">Price {formatPrice(etf.price)} · Day {formatPct(etf.change)}</span></div></div>
                                        <div className="etf-leader-metric"><strong className={`etf-leader-value ${tone}`}>{field === 'dividendYield' && etf[field] != null ? `${etf[field].toFixed(2)}%` : formatPct(etf[field])}</strong><span className="quote-meta">{metric}</span><span className="quote-meta">Vol {formatCompact(etf.volume)}</span></div>
                                    </div>
                                );
                            })}
                        </section>
                    );
                })}
            </div>
        </div>
    );
};
export default ETFAwards;

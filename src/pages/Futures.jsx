import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ArrowUpRight as ExternalLink, ChartNoAxesCombined, Clock3, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { fetchFinvizFutures, FUTURES_DELAY_MINUTES, FUTURES_GROUPS, FUTURES_SOURCE_URL, FUTURES_TIMEFRAMES } from '../services/futures';
import { getInvoke } from '../utils/bridge.js';
import { formatPct } from '../utils/format';
import { useSettings } from '../state/settingsContext.js';
import '../styles/pages/futures.css';

const OVERVIEW = ['ES', 'NQ', 'CL', 'GC'];
const OVERVIEW_NAMES = { ES: 'S&P 500', NQ: 'Nasdaq 100', CL: 'Crude Oil WTI', GC: 'Gold' };
const DEFAULT_GROUP = 'all';
const DEFAULT_TIMEFRAME = 'i5';
// How the chart caption describes the sample series Finviz returns for a timeframe.
const SAMPLE_KIND = { i5: 'intraday', h: 'intraday', d: 'daily', w: 'weekly', m: 'monthly', NO: 'quotes only' };
const STATUS_LABEL = { delayed: 'Delayed', cached: 'Cached', unavailable: 'Unavailable' };

const nativeNumber = (value) => Number.isFinite(value)
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(value)
    : '—';
const retrievalTime = (value) => value
    ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'Not retrieved';
// Only the three source states the service emits; anything else reads as unavailable.
const statusOf = (quote) => (quote?.status === 'delayed' || quote?.status === 'cached') ? quote.status : 'unavailable';
// Direction drives every up/down colour (text, sparkline, chart) through a class, never an inline colour.
const directionOf = (value) => value == null ? 'flat' : value >= 0 ? 'up' : 'down';

function StatusChip({ quote, title }) {
    const status = statusOf(quote);
    return <span className={`quote-status ${status}`} title={title}>{STATUS_LABEL[status]}</span>;
}

function SourceChart({ quote, large = false }) {
    const samples = (quote?.sparkline || []).filter(Number.isFinite);
    if (samples.length < 2) return <div className={large ? 'chart-empty' : 'spark-empty'}>{large ? 'Finviz has no chart samples for this instrument.' : '—'}</div>;
    const width = large ? 780 : 140;
    const height = large ? 218 : 38;
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const span = max - min || 1;
    const points = samples.map((v, i) => `${i / (samples.length - 1) * width},${height - 8 - (v - min) / span * (height - 16)}`).join(' ');
    const tone = `is-${directionOf(quote.changePct)}`;
    return (
        <svg className={`${large ? 'futures-chart' : 'futures-spark'} ${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${quote.name}: ${samples.length} Finviz price samples`}>
            {large && [0.25, 0.5, 0.75].map((position) => <line key={position} className="futures-chart-grid" x1="0" x2={width} y1={height * position} y2={height * position} strokeDasharray="4 6" />)}
            {large && <polygon className="futures-chart-area" points={`0,${height} ${points} ${width},${height}`} />}
            <polyline className="futures-chart-line" points={points} fill="none" strokeWidth={large ? 2 : 1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
    );
}

function Change({ value }) {
    const tone = directionOf(value);
    return <span className={`futures-change is-${tone}`}>{tone === 'up' && <ArrowUpRight size={14} />}{tone === 'down' && <ArrowDownRight size={14} />}{formatPct(value)}</span>;
}

function Futures({ autoRefreshInterval = 0 }) {
    const { settings } = useSettings();
    const futuresSettings = settings.futures || {};
    const timeframe = FUTURES_TIMEFRAMES.some((item) => item.id === futuresSettings.timeframe) ? futuresSettings.timeframe : DEFAULT_TIMEFRAME;
    const timeframeLabel = FUTURES_TIMEFRAMES.find((item) => item.id === timeframe)?.label || timeframe;
    const showDelayNotice = futuresSettings.showDelayNotice !== false;
    const [snapshot, setSnapshot] = useState(null);
    const [loading, setLoading] = useState(true);
    const [group, setGroup] = useState(() => FUTURES_GROUPS.some((item) => item.id === futuresSettings.defaultGroup) ? futuresSettings.defaultGroup : DEFAULT_GROUP);
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState('ES');
    const snapshotRef = useRef(null);
    const runRef = useRef(0);
    const pendingRef = useRef(false);

    const refresh = useCallback(async () => {
        if (pendingRef.current) return;
        pendingRef.current = true;
        const run = ++runRef.current;
        setLoading(true);
        try {
            const bridge = getInvoke();
            const ipc = bridge ? { invoke: bridge } : null;
            const next = await fetchFinvizFutures(ipc, { timeframe, previous: snapshotRef.current });
            if (run !== runRef.current) return;
            snapshotRef.current = next;
            setSnapshot(next);
        } finally {
            if (run === runRef.current) {
                pendingRef.current = false;
                setLoading(false);
            }
        }
    }, [timeframe]);

    const cancelRefresh = useCallback(() => {
        ++runRef.current;
        pendingRef.current = false;
    }, []);

    useEffect(() => {
        refresh();
        const interval = autoRefreshInterval > 0 ? setInterval(() => {
            if (document.visibilityState === 'visible') refresh();
        }, autoRefreshInterval * 60_000) : null;
        return () => {
            cancelRefresh();
            if (interval) clearInterval(interval);
        };
    }, [autoRefreshInterval, refresh, cancelRefresh]);

    const quotes = useMemo(() => snapshot?.quotes || [], [snapshot]);
    const filtered = useMemo(() => quotes.filter((q) =>
        (group === DEFAULT_GROUP || q.group === group) && `${q.symbol} ${q.name}`.toLowerCase().includes(query.trim().toLowerCase())
    ), [quotes, group, query]);
    const focused = quotes.find((q) => q.symbol === selected) || filtered[0];
    const available = quotes.filter((q) => Number.isFinite(q.price) && q.status !== 'unavailable');
    const advancing = available.filter((q) => q.changePct > 0).length;
    const declining = available.filter((q) => q.changePct < 0).length;
    const cached = snapshot?.status === 'cached' || quotes.some((q) => q.status === 'cached');

    return (
        <div className="futures-page">
            <div className="desk-heading">
                <div>
                    <div className="eyebrow"><span className="eyebrow-line" /> GLOBAL MARKETS / FUTURES</div>
                    <h1>See the market <span className="text-muted">before the open.</span></h1>
                    <p className="text-muted">One desk for equity indices, energy, metals, rates and currencies.</p>
                </div>
                <button className="btn btn-outline" onClick={refresh} disabled={loading}><RefreshCw size={15} className={loading ? 'is-spinning' : ''} />{loading ? 'Retrieving' : 'Refresh quotes'}</button>
            </div>

            {/* The delay disclosure always stays in the banner; the setting only toggles the longer explanation below it. */}
            <div className={`source-banner ${cached ? 'source-banner-cached' : ''} ${loading ? 'is-loading' : ''}`} role="status">
                <div className="source-banner-main"><ShieldCheck size={17} /><strong>Finviz reference data</strong><span className="delay-chip"><Clock3 size={12} /> Delayed · allow {FUTURES_DELAY_MINUTES} min</span></div>
                <div className="source-banner-time">Last retrieved: {retrievalTime(snapshot?.fetchedAt)}</div>
            </div>
            {showDelayNotice && <p className="source-explanation">Finviz reports a 15–20 minute source delay. Quote timestamps and contract expiry are not supplied by this feed. Retrieval time does not establish quote freshness.</p>}

            {snapshot?.error && <div className="data-notice" role="status"><strong>{cached ? 'Refresh incomplete · previous quotes retained' : available.length ? 'Some source data is unavailable' : 'Quotes unavailable'}</strong><span>{snapshot.error}</span>{cached && <span>Cached rows retain their original retrieval time.</span>}</div>}

            <div className="futures-overview">
                {OVERVIEW.map((symbol) => {
                    const quote = quotes.find((q) => q.symbol === symbol);
                    return <button key={symbol} className={`overview-card ${selected === symbol ? 'selected' : ''}`} onClick={() => setSelected(symbol)} aria-pressed={selected === symbol}>
                        <div className="overview-label"><span>{quote?.name || OVERVIEW_NAMES[symbol]}</span><span className="ticker-tag">{symbol}</span></div>
                        <div className="overview-price">{nativeNumber(quote?.price)}<Change value={quote?.changePct} /></div>
                        <SourceChart quote={quote} />
                        <div className="overview-foot"><span>Finviz quoted units</span><StatusChip quote={quote} /></div>
                    </button>;
                })}
            </div>

            <div className="futures-workspace">
                <section className="glass-panel futures-board" aria-labelledby="contracts-title">
                    <div className="board-heading"><div><div className="eyebrow">THE MARKET AT A GLANCE</div><h2 id="contracts-title">Futures board</h2></div><span className="board-count">{available.length} available <span>of {quotes.length}</span></span></div>
                    <div className="futures-toolbar"><div className="category-filter" aria-label="Filter futures category"><button onClick={() => setGroup(DEFAULT_GROUP)} aria-pressed={group === DEFAULT_GROUP}>All markets</button>{FUTURES_GROUPS.map((item) => <button key={item.id} onClick={() => setGroup(item.id)} aria-pressed={group === item.id}>{item.label}</button>)}</div><label className="desk-search"><Search size={15} /><input aria-label="Search futures" placeholder="Find a market" value={query} onChange={(e) => setQuery(e.target.value)} /></label></div>
                    <div className="futures-table-scroll"><table className="futures-table"><thead><tr><th>Instrument</th><th>Last</th><th>Change %</th><th>Source samples</th><th>Data status</th></tr></thead><tbody>
                        {filtered.map((quote) => <tr key={quote.symbol} className={focused?.symbol === quote.symbol ? 'selected-row' : ''}><td><button className="instrument-button" onClick={() => setSelected(quote.symbol)} aria-pressed={focused?.symbol === quote.symbol}><span className="instrument-symbol">{quote.symbol}</span><span className="instrument-name">{quote.name}</span></button></td><td className="numeric">{nativeNumber(quote.price)}</td><td className="numeric"><Change value={quote.changePct} /></td><td><SourceChart quote={quote} /></td><td><StatusChip quote={quote} title={`Retrieved ${retrievalTime(quote.fetchedAt)}. Quote time unknown.`} /></td></tr>)}
                    </tbody></table></div>
                    {!filtered.length && <div className="desk-empty"><ChartNoAxesCombined size={32} /><h3>{loading ? 'Retrieving Finviz quotes…' : quotes.length ? 'No markets match this search' : 'Market data is unavailable'}</h3><p>{quotes.length ? 'Choose a different category or search term.' : 'Run the desktop app to retrieve market data through its source connection.'}</p><a href="https://finviz.com/futures" target="_blank" rel="noopener noreferrer">Open the Finviz futures reference <ExternalLink size={14} /></a></div>}
                    <div className="board-footer"><span><span className="direction-dot up" />{advancing} advancing <span className="direction-dot down" />{declining} declining{cached ? ' · includes cached quotes' : ''}</span><span>Prices in each instrument’s native quote units</span></div>
                </section>

                <aside className="glass-panel futures-detail" aria-label="Selected futures instrument">
                    <div className="eyebrow">INSTRUMENT FOCUS</div>
                    <div className="focus-title"><h2>{focused?.name || 'Select a market'}</h2><span className="ticker-tag">{focused?.symbol || '—'}</span></div>
                    <div className="focus-price">{nativeNumber(focused?.price)}</div><Change value={focused?.changePct} />
                    <div className="focus-chart-wrap"><SourceChart quote={focused} large /></div>
                    <div className="chart-caption"><span>Finviz source samples · {SAMPLE_KIND[timeframe] || 'intraday'}</span><StatusChip quote={focused} /></div>
                    <dl className="quote-facts"><div><dt>Previous close</dt><dd>{nativeNumber(focused?.prevClose)}</dd></div><div><dt>Session high</dt><dd>{nativeNumber(focused?.high)}</dd></div><div><dt>Session low</dt><dd>{nativeNumber(focused?.low)}</dd></div><div><dt>Absolute change · native units</dt><dd>{nativeNumber(focused?.change)}</dd></div><div><dt>Source quote time</dt><dd>Not supplied</dd></div><div><dt>Contract expiry</dt><dd>Not supplied</dd></div><div><dt>Retrieved</dt><dd>{retrievalTime(focused?.fetchedAt)}</dd></div></dl>
                    <a className="btn btn-outline source-link" href={FUTURES_SOURCE_URL} target="_blank" rel="noopener noreferrer">Verify on Finviz <ExternalLink size={14} /></a>
                    <p className="focus-note">Reference instrument symbols. Match the contract and expiry in your broker before comparing prices.</p>
                </aside>
            </div>
            <div className="desk-bottom"><span>FINVIZ / MARKET REFERENCE</span><span>{autoRefreshInterval > 0 ? `Refresh every ${autoRefreshInterval} min while visible` : 'Manual refresh'} · {timeframeLabel} series · source delay applies</span></div>
        </div>
    );
}

export default Futures;

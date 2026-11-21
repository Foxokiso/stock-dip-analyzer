import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ClipboardCopy, RefreshCw, Search, Trash2 } from 'lucide-react';
import { getInvoke } from '../utils/bridge.js';
import { fetchOptionsChain, finvizOptionsUrl, isOptionSymbol } from '../utils/finvizOptions.js';
import { BROKERS, MAX_LEGS, analyzeOrder, expiryLabel, legContracts, money, orderProblems, price, suggestedSide, ticketFields, ticketText } from '../utils/optionsStrategy.js';
import { getVerdict } from '../utils/scoring.js';
import { formatQuoteTime } from '../utils/format.js';
import { findScannedStock } from '../state/scanStore.js';
import { useVisibleInterval } from '../utils/useVisibleInterval.js';
import '../styles/pages/options.css';

// Strikes shown on each side of the underlying until "All strikes" is chosen: a long
// chain has hundreds of rows, and an old machine should not lay them all out at once.
const STRIKES_EACH_SIDE = 10;
const CHECK_STATES = [['', 'Not checked'], ['match', 'Matches'], ['differs', 'Differs'], ['missing', 'Not filled']];
// The broker last chosen, kept for the session so the desk reopens on it.
let lastBroker = 'robinhood';

const dash = '—';
const num = (value, digits = 2) => (value === null || value === undefined ? dash : value.toFixed(digits));
const whole = (value) => (value === null || value === undefined ? dash : value.toLocaleString('en-US'));
const pct = (value) => (value === null || value === undefined ? dash : `${(value * 100).toFixed(1)}%`);
const contractName = (symbol, { expiry, strike, type }) => `${symbol} ${expiryLabel(expiry)} ${strike} ${type}`;

function ChainSide({ symbol, item, inOrder, onPick, disabled }) {
    if (!item) return <td colSpan={7} className="opt-none">{dash}</td>;
    const name = contractName(symbol, item);
    return (
        <>
            <td className="numeric"><button type="button" className="opt-quote opt-quote--sell" disabled={disabled} onClick={() => onPick(item, 'sell')} aria-label={`Sell ${name}, bid ${num(item.bid)}`} title="Add a sell leg">{num(item.bid)}</button></td>
            <td className="numeric"><button type="button" className="opt-quote opt-quote--buy" disabled={disabled} onClick={() => onPick(item, 'buy')} aria-label={`Buy ${name}, ask ${num(item.ask)}`} title="Add a buy leg">{num(item.ask)}</button></td>
            <td className="numeric">{num(item.width)}</td>
            <td className="numeric">{whole(item.volume)}</td>
            <td className="numeric">{whole(item.openInterest)}</td>
            <td className="numeric">{pct(item.iv)}</td>
            <td className={`numeric${inOrder ? ' opt-in-order' : ''}`}>{num(item.delta, 3)}</td>
        </>
    );
}

function PayoffChart({ analysis, underlying }) {
    const points = analysis.payoff;
    if (!points) return <div className="opt-chart-empty">{analysis.notes[0] || 'Add a leg to see the payoff at expiration.'}</div>;
    const width = 560;
    const height = 200;
    const pad = 14;
    const xs = points.map(point => point.price);
    const ys = points.map(point => point.pnl);
    const [x0, x1] = [xs[0], xs[xs.length - 1]];
    const yMin = Math.min(0, ...ys);
    const yMax = Math.max(0, ...ys);
    const span = yMax - yMin || 1;
    const x = (value) => pad + (value - x0) / (x1 - x0 || 1) * (width - 2 * pad);
    const y = (value) => pad + (yMax - value) / span * (height - 2 * pad);
    const line = points.map(point => `${x(point.price).toFixed(1)},${y(point.pnl).toFixed(1)}`).join(' ');
    const spot = underlying > x0 && underlying < x1 ? underlying : null;
    return (
        <figure className="opt-chart">
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Profit or loss at expiration from ${money(x0)} to ${money(x1)} per share of the underlying`}>
                <line className="opt-chart-zero" x1={pad} x2={width - pad} y1={y(0)} y2={y(0)} />
                {spot && <line className="opt-chart-spot" x1={x(spot)} x2={x(spot)} y1={pad} y2={height - pad} />}
                <polyline className="opt-chart-line" points={line} fill="none" vectorEffect="non-scaling-stroke" />
                {analysis.breakevens.map(value => <circle key={value} className="opt-chart-even" cx={x(value)} cy={y(0)} r="4" />)}
            </svg>
            <figcaption>
                <span>{money(x0)}</span>
                <span>Profit or loss at expiration, before fees{spot ? ` · dashed line: underlying ${num(spot)}` : ''}</span>
                <span>{money(x1)}</span>
            </figcaption>
        </figure>
    );
}

const extreme = (value) => (value === null ? 'Not defined' : value === Infinity ? 'Unlimited' : money(value));

// A new ticker is a new draft: the desk is keyed by its symbol, so every piece of
// draft state starts over without an effect resetting it.
export default function OptionsStrategy(props) {
    const { symbol: routeSymbol } = useParams();
    const symbol = isOptionSymbol(routeSymbol) ? routeSymbol.toUpperCase() : null;
    return <OptionsDesk key={symbol ?? ''} symbol={symbol} {...props} />;
}

function OptionsDesk({ symbol, autoRefreshInterval = 0 }) {
    const navigate = useNavigate();
    const location = useLocation();

    // The score comes with the link from the scanner or the stock page; a direct visit
    // looks the ticker up in the scans still in memory. Nothing is scored here.
    const carried = useMemo(() => {
        const state = location.state;
        if (state && state.symbol === symbol && typeof state.score === 'number') return { score: state.score, isZombie: Boolean(state.isZombie) };
        const scanned = symbol ? findScannedStock(symbol) : null;
        return scanned && typeof scanned.recoveryProbability === 'number' ? { score: scanned.recoveryProbability, isZombie: Boolean(scanned.isZombie) } : null;
    }, [location.state, symbol]);
    const verdict = carried ? getVerdict(carried.score, carried.isZombie) : null;

    const [lookup, setLookup] = useState(symbol ?? '');
    const [expiry, setExpiry] = useState(null);
    const [chain, setChain] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(Boolean(symbol));
    const [allStrikes, setAllStrikes] = useState(false);
    const [legs, setLegs] = useState([]);
    const [quantity, setQuantity] = useState(1);
    const [orderType, setOrderType] = useState('limit');
    const [limitText, setLimitText] = useState('');
    const [side, setSide] = useState(null); // null: follows the legs until chosen
    const [tif, setTif] = useState('day');
    const [broker, setBroker] = useState(lastBroker);
    const [copied, setCopied] = useState(null);
    const [checks, setChecks] = useState({});
    const runRef = useRef(0);
    const legKey = useRef(0);

    // Promise callbacks, not an async body: state changes only when Finviz has answered.
    const load = useCallback((forSymbol, forExpiry) => {
        if (!forSymbol) return;
        const run = ++runRef.current;
        const current = () => run === runRef.current;
        fetchOptionsChain(getInvoke(), forSymbol, forExpiry).then((next) => {
            if (!current()) return;
            setChain(next);
            setError('');
            // Legs on the expiration just retrieved take its fresh quotes. The limit,
            // quantity and every other term the user set are left exactly as they are.
            const fresh = new Map(next.strikes.flatMap(row => [row.call, row.put]).filter(Boolean).map(item => [item.id, item]));
            setLegs(legsNow => legsNow.map(leg => (fresh.has(leg.contract.id) ? { ...leg, contract: fresh.get(leg.contract.id), quotedAt: next.fetchedAt } : leg)));
        }, (failure) => {
            if (current()) setError(String(failure?.message ?? failure));
        }).finally(() => {
            if (current()) setLoading(false);
        });
    }, []);

    // The first load starts with `loading` already true; later ones say so here.
    const reload = (forSymbol, forExpiry) => { setLoading(true); load(forSymbol, forExpiry); };
    const cancelLoad = useCallback(() => { ++runRef.current; }, []);
    useEffect(() => {
        load(symbol, null);
        return cancelLoad;
    }, [symbol, load, cancelLoad]);

    useVisibleInterval(() => reload(symbol, expiry), autoRefreshInterval, { resetKey: `${symbol}|${expiry}` });

    const chooseExpiry = (value) => { setExpiry(value); reload(symbol, value); };
    const pick = (item, action) => {
        setCopied(null);
        setLegs(current => {
            const existing = current.find(leg => leg.contract.id === item.id);
            if (existing) return current.map(leg => (leg === existing ? { ...leg, action } : leg));
            if (current.length >= MAX_LEGS) return current;
            return [...current, { key: ++legKey.current, contract: item, action, effect: 'open', ratio: 1, quotedAt: chain?.fetchedAt ?? null }];
        });
    };
    const editLeg = (key, changes) => { setCopied(null); setLegs(current => current.map(leg => (leg.key === key ? { ...leg, ...changes } : leg))); };
    const removeLeg = (key) => { setCopied(null); setLegs(current => current.filter(leg => leg.key !== key)); };

    const limit = /^\d*\.?\d+$/.test(limitText.trim()) ? Number(limitText) : null;
    const priceSide = side ?? suggestedSide(legs);
    const order = useMemo(() => ({ symbol: symbol ?? '', legs, quantity, orderType, limit, priceSide, tif }), [symbol, legs, quantity, orderType, limit, priceSide, tif]);
    const analysis = useMemo(() => analyzeOrder(order, chain?.underlying ?? null), [order, chain]);
    const problems = useMemo(() => orderProblems(order), [order]);
    const ready = Boolean(symbol) && problems.length === 0;
    const ticket = ready ? ticketText(order, broker, analysis) : '';
    const fields = ready ? ticketFields(order, broker) : [];

    const rows = useMemo(() => {
        const strikes = chain?.strikes ?? [];
        if (allStrikes || !chain?.underlying || strikes.length <= 2 * STRIKES_EACH_SIDE) return strikes;
        const firstAbove = strikes.findIndex(row => row.strike >= chain.underlying);
        const centre = firstAbove < 0 ? strikes.length : firstAbove;
        // Strikes already in the order stay visible.
        const chosen = new Set(legs.map(leg => leg.contract.strike));
        return strikes.filter((row, index) => (index >= centre - STRIKES_EACH_SIDE && index < centre + STRIKES_EACH_SIDE) || chosen.has(row.strike));
    }, [chain, allStrikes, legs]);
    const inOrder = new Set(legs.map(leg => leg.contract.id));

    const copyTicket = async () => {
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
            await navigator.clipboard.writeText(ticket);
            setCopied('ok');
        } catch {
            setCopied('failed');
        }
    };
    const useMid = () => {
        if (analysis.market.mid === null || analysis.market.mid === 0) return;
        setLimitText(price(Math.abs(analysis.market.mid)));
        setSide(analysis.market.mid > 0 ? 'debit' : 'credit');
        setCopied(null);
    };
    const chooseBroker = (value) => { lastBroker = value; setBroker(value); setCopied(null); setChecks({}); };
    const setCheck = (key, changes) => setChecks(current => ({ ...current, [key]: { ...current[key], ...changes } }));
    const mismatches = fields.filter(field => ['differs', 'missing'].includes(checks[field.key]?.state));
    const checkedAll = fields.length > 0 && fields.every(field => checks[field.key]?.state);
    const copyReport = async () => {
        const lines = [`TRANSFER CHECK · ${BROKERS[broker].ticket} · ${new Date().toISOString()}`, `Order: ${analysis.strategy}, ${symbol}`];
        for (const field of fields) {
            const check = checks[field.key] ?? {};
            const state = CHECK_STATES.find(([id]) => id === (check.state ?? ''))[1];
            lines.push(`${field.label}: expected "${field.value}" · ${state}${check.shown ? ` · broker showed "${check.shown}"` : ''}`);
        }
        try { await navigator.clipboard.writeText(lines.join('\n')); setCopied('report'); } catch { setCopied('failed'); }
    };

    const submitLookup = (event) => {
        event.preventDefault();
        const next = lookup.trim().toUpperCase();
        if (isOptionSymbol(next)) navigate(`/options/${next}`);
    };
    const stale = Boolean(error && chain);

    return (
        <div className="options-page">
            <div className="desk-heading">
                <div>
                    <div className="eyebrow"><span className="eyebrow-line" aria-hidden="true" /> OPTIONS / STRATEGY TO TICKET</div>
                    <h1 tabIndex={-1}><span className="visually-hidden">Options strategy: </span>Build the trade. <span className="text-muted">Copy the ticket.</span></h1>
                    <p className="text-muted">Pick contracts from the chain, see what you risk, then paste the order into a blank broker ticket. No brokerage account is linked.</p>
                </div>
                <form className="opt-lookup" onSubmit={submitLookup} role="search">
                    <label className="desk-search"><Search size={15} aria-hidden="true" /><input aria-label="Ticker symbol" placeholder="Ticker, e.g. AAPL" value={lookup} onChange={(event) => setLookup(event.target.value)} maxLength={10} /></label>
                    <button className="btn btn-outline" type="submit">Open chain</button>
                </form>
            </div>

            {!symbol ? (
                <div className="desk-empty" role="status"><h3>Choose a ticker</h3><p>Enter a symbol above, or open this desk from a row on the <Link to="/">Overview</Link> to carry its score over.</p></div>
            ) : (
                <>
                    <div className="opt-context">
                        <Link className="ticker-tag" to={`/stock/${symbol}`}>{symbol}</Link>
                        <span>Underlying {chain?.underlying ? num(chain.underlying) : dash}{chain?.underlyingAt ? ` · Finviz quote ${formatQuoteTime(chain.underlyingAt)}` : ''}</span>
                        <span className={`opt-score${verdict ? '' : ' is-empty'}`}>{verdict ? `Technical score ${carried.score} · ${verdict.label}` : 'Technical score not carried over · open from the Overview to bring it'}</span>
                        <span>Retrieved {chain ? formatQuoteTime(chain.fetchedAt) : dash}</span>
                        <button className="btn btn-outline opt-refresh" type="button" onClick={() => reload(symbol, expiry)} disabled={loading}><RefreshCw size={14} className={loading ? 'is-spinning' : ''} aria-hidden="true" />{loading ? 'Retrieving' : 'Refresh quotes'}</button>
                    </div>
                    {error && <div className="data-notice" role="status"><strong>{stale ? 'Refresh failed · earlier quotes kept' : 'Options chain unavailable'}</strong><span>{error}</span>{stale && <span>The chain below was retrieved {formatQuoteTime(chain.fetchedAt)}.</span>}</div>}

                    <section className="glass-panel opt-chain" aria-labelledby="opt-chain-title">
                        <div className="opt-panel-head">
                            <h2 id="opt-chain-title">Options chain</h2>
                            <label>Expiration <select value={chain?.expiry ?? ''} onChange={(event) => chooseExpiry(event.target.value)} disabled={!chain}>
                                {(chain?.expiries ?? []).map(item => <option key={item} value={item}>{expiryLabel(item)}</option>)}
                            </select></label>
                            <label className="opt-check"><input type="checkbox" checked={allStrikes} onChange={(event) => setAllStrikes(event.target.checked)} /> All strikes</label>
                            <span className="opt-hint">Click a bid to sell, an ask to buy. Finviz quotes, delayed; times are each contract’s last trade.</span>
                        </div>
                        {chain ? (
                            <div className="opt-chain-scroll">
                                <table className="opt-chain-table">
                                    <thead>
                                        <tr><th colSpan={7} className="opt-side">Calls</th><th className="opt-strike">Strike</th><th colSpan={7} className="opt-side">Puts</th></tr>
                                        <tr>{['c', 'p'].map(sideKey => [sideKey === 'p' && <th key="strike" className="opt-strike" aria-hidden="true" />, ...['Bid', 'Ask', 'Width', 'Volume', 'Open int', 'IV', 'Delta'].map(label => <th key={sideKey + label} className="numeric">{label}</th>)])}</tr>
                                    </thead>
                                    <tbody>
                                        {rows.map(row => (
                                            <tr key={row.strike} className={chain.underlying && row.strike < chain.underlying ? 'opt-below' : ''}>
                                                <ChainSide symbol={symbol} item={row.call} inOrder={row.call && inOrder.has(row.call.id)} onPick={pick} disabled={legs.length >= MAX_LEGS && !(row.call && inOrder.has(row.call.id))} />
                                                <th scope="row" className="opt-strike">{row.strike}</th>
                                                <ChainSide symbol={symbol} item={row.put} inOrder={row.put && inOrder.has(row.put.id)} onPick={pick} disabled={legs.length >= MAX_LEGS && !(row.put && inOrder.has(row.put.id))} />
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : <div className="desk-empty" role="status"><h3>{loading ? 'Retrieving the Finviz options chain…' : 'No chain to show'}</h3>{!loading && <p>Nothing is shown in its place. <a href={finvizOptionsUrl(symbol)} target="_blank" rel="noopener noreferrer">Open the chain on Finviz</a></p>}</div>}
                    </section>

                    <div className="opt-workspace">
                        <section className="glass-panel opt-ticket" aria-labelledby="opt-ticket-title">
                            <div className="opt-panel-head"><h2 id="opt-ticket-title">Draft ticket</h2><span className="opt-strategy">{analysis.strategy}</span></div>
                            {legs.length === 0 ? <p className="opt-empty">No legs yet. Choose a contract in the chain above.</p> : (
                                <div className="opt-legs-scroll">
                                    <table className="opt-legs">
                                        <thead><tr><th>Contract</th><th>Action</th><th>Open/close</th><th>Ratio</th><th className="numeric">Contracts</th><th className="numeric">Bid / ask</th><th className="numeric">IV</th><th className="numeric">Δ / Γ / Θ / Vega</th><th>Last trade (ET)</th><th><span className="visually-hidden">Remove</span></th></tr></thead>
                                        <tbody>
                                            {legs.map((leg, index) => {
                                                const item = leg.contract;
                                                const name = contractName(symbol, item);
                                                const alternatives = chain?.expiry === item.expiry ? chain.strikes.map(row => row[item.type]).filter(Boolean) : [item];
                                                return (
                                                    <tr key={leg.key}>
                                                        <td>
                                                            <div className="opt-leg-name">{expiryLabel(item.expiry)} {item.type === 'call' ? 'Call' : 'Put'}</div>
                                                            <select aria-label={`Leg ${index + 1} strike`} value={item.id} onChange={(event) => editLeg(leg.key, { contract: alternatives.find(option => option.id === event.target.value), quotedAt: chain?.fetchedAt ?? leg.quotedAt })}>
                                                                {alternatives.map(option => <option key={option.id} value={option.id} disabled={option.id !== item.id && inOrder.has(option.id)}>{option.strike}</option>)}
                                                            </select>
                                                        </td>
                                                        <td><select aria-label={`Leg ${index + 1} action`} value={leg.action} onChange={(event) => editLeg(leg.key, { action: event.target.value })}><option value="buy">Buy</option><option value="sell">Sell</option></select></td>
                                                        <td><select aria-label={`Leg ${index + 1} open or close`} value={leg.effect} onChange={(event) => editLeg(leg.key, { effect: event.target.value })}><option value="open">To open</option><option value="close">To close</option></select></td>
                                                        <td><input aria-label={`Leg ${index + 1} ratio`} type="number" min="1" max="99" step="1" value={leg.ratio} onChange={(event) => editLeg(leg.key, { ratio: Number(event.target.value) })} /></td>
                                                        <td className="numeric opt-strong">{Number.isInteger(quantity) && Number.isInteger(leg.ratio) ? legContracts(leg, quantity) : dash}</td>
                                                        <td className="numeric">{num(item.bid)} / {num(item.ask)}</td>
                                                        <td className="numeric">{pct(item.iv)}</td>
                                                        <td className="numeric">{num(item.delta, 3)} / {num(item.gamma, 4)} / {num(item.theta, 3)} / {num(item.vega, 3)}</td>
                                                        <td>{item.lastTradeAt ?? 'Not supplied'}{chain?.expiry !== item.expiry && <div className="opt-leg-stale">Quote retrieved {formatQuoteTime(leg.quotedAt)}; open {expiryLabel(item.expiry)} to refresh it</div>}</td>
                                                        <td><button type="button" className="opt-remove" onClick={() => removeLeg(leg.key)} aria-label={`Remove ${name}`}><Trash2 size={14} aria-hidden="true" /></button></td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            <div className="opt-terms">
                                <label>{legs.length > 1 ? 'Strategy quantity' : 'Contracts'}<input type="number" min="1" max="9999" step="1" value={quantity} onChange={(event) => { setQuantity(Number(event.target.value)); setCopied(null); }} /></label>
                                <label>Order type<select value={orderType} onChange={(event) => { setOrderType(event.target.value); setCopied(null); }}><option value="limit">Limit</option><option value="market">Market</option></select></label>
                                {orderType === 'limit' && <>
                                    <label>Limit price<input inputMode="decimal" placeholder="0.00" value={limitText} onChange={(event) => { setLimitText(event.target.value); setCopied(null); }} aria-describedby="opt-market" /></label>
                                    <label>Net<select value={priceSide} onChange={(event) => { setSide(event.target.value); setCopied(null); }}><option value="debit">Debit (you pay)</option><option value="credit">Credit (you receive)</option></select></label>
                                </>}
                                <label>Time in force<select value={tif} onChange={(event) => { setTif(event.target.value); setCopied(null); }}><option value="day">Day</option><option value="gtc">Good till canceled</option></select></label>
                            </div>
                            <p className="opt-market" id="opt-market">
                                Market now: {analysis.market.mid === null ? 'no usable quote' : `mid ${price(Math.abs(analysis.market.mid))} ${analysis.market.mid >= 0 ? 'debit' : 'credit'} · natural ${price(Math.abs(analysis.market.natural))} ${analysis.market.natural >= 0 ? 'debit' : 'credit'}`}.
                                {' '}Your limit stays as typed when quotes refresh.
                                {orderType === 'limit' && analysis.market.mid !== null && analysis.market.mid !== 0 && <button type="button" className="opt-link" onClick={useMid}>Use the mid</button>}
                            </p>

                            <div className="opt-copy">
                                <label>Broker<select value={broker} onChange={(event) => chooseBroker(event.target.value)}>{Object.values(BROKERS).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                                <button type="button" className="btn btn-primary opt-copy-button" onClick={copyTicket} disabled={!ready}><ClipboardCopy size={16} aria-hidden="true" />Copy Order Ticket</button>
                                <span className="opt-copy-status" role="status">
                                    {copied === 'ok' && `Copied. Switch to a blank ${BROKERS[broker].ticket} and paste once.`}
                                    {copied === 'report' && 'Transfer check copied.'}
                                    {copied === 'failed' && 'Copy failed. Select the ticket text below and copy it by hand.'}
                                    {!copied && !ready && problems[0]}
                                </span>
                            </div>
                            <label className="opt-preview-label" htmlFor="opt-preview">Ticket preview · {BROKERS[broker].ticket}</label>
                            <textarea id="opt-preview" className="opt-preview" readOnly rows={Math.max(6, legs.length + 10)} value={ticket || 'The ticket appears here once the order is complete.'} />

                            <details className="opt-verify">
                                <summary>Check the pasted ticket{mismatches.length ? ` · ${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'}` : checkedAll ? ' · all fields match' : ''}</summary>
                                <p>After pasting, compare the broker’s ticket with each line and record what it shows. Stop at the broker’s review screen.</p>
                                {fields.length === 0 ? <p className="opt-empty">Complete the order first.</p> : (
<div className="opt-legs-scroll"><table className="opt-verify-table">
                                        <thead><tr><th>Field</th><th>Expected</th><th>Broker ticket</th><th>What it showed</th></tr></thead>
                                        <tbody>
                                            {fields.map(field => {
                                                const check = checks[field.key] ?? {};
                                                return (
                                                    <tr key={field.key} className={check.state ? `is-${check.state}` : ''}>
                                                        <th scope="row">{field.label}</th>
                                                        <td>{field.value}</td>
                                                        <td><select aria-label={`${field.label}: result`} value={check.state ?? ''} onChange={(event) => setCheck(field.key, { state: event.target.value })}>{CHECK_STATES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></td>
                                                        <td><input aria-label={`${field.label}: what the broker showed`} value={check.shown ?? ''} onChange={(event) => setCheck(field.key, { shown: event.target.value })} disabled={!['differs', 'missing'].includes(check.state)} /></td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table></div>
                                )}
                                {mismatches.length > 0 && <ul className="opt-mismatches">{mismatches.map(field => <li key={field.key}><strong>{field.label}</strong>: expected {field.value}; {checks[field.key].state === 'missing' ? 'the ticket left it empty' : `the ticket showed ${checks[field.key].shown || 'a different value'}`}.</li>)}</ul>}
                                <button type="button" className="btn btn-outline" onClick={copyReport} disabled={fields.length === 0}>Copy transfer check</button>
                            </details>
                        </section>

                        <aside className="glass-panel opt-risk" aria-labelledby="opt-risk-title">
                            <div className="opt-panel-head"><h2 id="opt-risk-title">What you risk</h2></div>
                            <dl className="opt-figures">
                                <div className="opt-figure opt-figure--total"><dt>Total {analysis.side ?? 'debit or credit'} before fees</dt><dd>{analysis.total === null ? dash : money(analysis.total)}{analysis.estimated && <small> estimate</small>}</dd></div>
                                <div className="opt-figure"><dt>Maximum loss</dt><dd className="is-down">{extreme(analysis.maxLoss)}</dd></div>
                                <div className="opt-figure"><dt>Maximum gain</dt><dd className="is-up">{extreme(analysis.maxGain)}</dd></div>
                                <div className="opt-figure"><dt>Breakeven{analysis.breakevens?.length === 1 ? '' : 's'} at expiration</dt><dd>{analysis.breakevens === null ? 'Not defined' : analysis.breakevens.length ? analysis.breakevens.map(value => num(value)).join(' · ') : 'None'}</dd></div>
                                {analysis.strikeWidth !== null && <div className="opt-figure"><dt>Strike width</dt><dd>{num(analysis.strikeWidth)}</dd></div>}
                            </dl>
                            <PayoffChart analysis={analysis} underlying={chain?.underlying ?? null} />
                            {analysis.notes.length > 0 && <ul className="opt-notes">{analysis.notes.map(note => <li key={note}>{note}</li>)}</ul>}
                            <p className="opt-fineprint">Figures are arithmetic on the legs and your limit: 100 shares per contract, held to expiration, before fees and early assignment. They are not advice or a forecast.</p>
                        </aside>
                    </div>
                </>
            )}
            <div className="desk-bottom"><span>FINVIZ / OPTIONS CHAIN</span><span>{autoRefreshInterval > 0 ? `Refresh every ${autoRefreshInterval} min while visible` : 'Manual refresh'} · account, sign-in and submission stay with the broker</span></div>
        </div>
    );
}

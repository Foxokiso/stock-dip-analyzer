// The Options Strategy desk's arithmetic and its order ticket. Everything here is a
// pure function of the draft order, so the analysis and the ticket preview are always
// computed from the same values and cannot disagree. No model, no network.
//
// A leg: { contract: { expiry, type, strike, bid, ask, mid }, action: 'buy'|'sell',
//          effect: 'open'|'close', ratio: 1.. }
// An order: { symbol, legs, quantity, orderType: 'limit'|'market', limit: number|null,
//             priceSide: 'debit'|'credit', tif: 'day'|'gtc' }
// Prices are per share; one standard contract covers 100 shares.

export const CONTRACT_SIZE = 100;
export const MAX_LEGS = 4;
export const BROKERS = {
    robinhood: { id: 'robinhood', name: 'Robinhood', ticket: 'Robinhood Legend options ticket' },
    fidelity: { id: 'fidelity', name: 'Fidelity', ticket: 'Fidelity Trader+ Web options ticket' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const cents = (value) => Math.round(value * 100) / 100;
const isCount = (value) => Number.isInteger(value) && value >= 1;
const sign = (leg) => (leg.action === 'buy' ? 1 : -1);
const trimmed = (number) => String(Number(number.toFixed(3)));

export const money = (value) => `$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const price = (value) => value.toFixed(2);
/** "Dec 18 2026" from "2026-12-18". */
export const expiryLabel = (expiry) => {
    const [year, month, day] = expiry.split('-').map(Number);
    return `${MONTHS[month - 1]} ${day} ${year}`;
};
/** The OCC option symbol without root padding: AAPL261218C00350000. */
// The OCC root has no punctuation: the Berkshire B contract is BRKB, not BRK-B or BRK.B.
const root = (symbol) => symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const occSymbol = (symbol, { expiry, type, strike }) =>
    `${root(symbol)}${expiry.slice(2).replaceAll('-', '')}${type === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
/** Fidelity's spelling of the same contract: -AAPL261218C350. */
export const fidelitySymbol = (symbol, { expiry, type, strike }) =>
    `-${root(symbol)}${expiry.slice(2).replaceAll('-', '')}${type === 'call' ? 'C' : 'P'}${trimmed(strike)}`;

export const legContracts = (leg, quantity) => leg.ratio * quantity;

/**
 * What the market asks for one strategy unit, per share: positive is a debit.
 * `mid` uses each leg's midpoint, `natural` crosses every spread (buy at the ask, sell
 * at the bid). Either is null when a leg has no usable quote.
 */
export function marketNet(legs) {
    let mid = 0;
    let natural = 0;
    for (const leg of legs) {
        const { bid, ask, mid: legMid } = leg.contract;
        mid = mid === null || legMid === null || legMid === undefined ? null : mid + sign(leg) * leg.ratio * legMid;
        const cross = leg.action === 'buy' ? ask : bid;
        natural = natural === null || cross === null || cross === undefined ? null : natural + sign(leg) * leg.ratio * cross;
    }
    return legs.length ? { mid: mid === null ? null : cents(mid), natural: natural === null ? null : cents(natural) } : { mid: null, natural: null };
}

/** Debit when the legs cost money at the midpoint (or, without quotes, when more is bought than sold). */
export function suggestedSide(legs) {
    const { mid } = marketNet(legs);
    if (mid !== null && mid !== 0) return mid > 0 ? 'debit' : 'credit';
    return legs.reduce((sum, leg) => sum + sign(leg) * leg.ratio, 0) >= 0 ? 'debit' : 'credit';
}

export function strategyName(legs) {
    if (legs.length === 0) return 'No legs';
    const [a, b] = legs;
    const word = (leg) => (leg.contract.type === 'call' ? 'call' : 'put');
    if (legs.length === 1) return `${a.action === 'buy' ? 'Long' : 'Short'} ${word(a)}`;
    if (legs.length === 2 && a.ratio === b.ratio) {
        const sameExpiry = a.contract.expiry === b.contract.expiry;
        const sameType = a.contract.type === b.contract.type;
        const sameStrike = a.contract.strike === b.contract.strike;
        if (a.action !== b.action && sameType && sameExpiry && !sameStrike) return `Vertical ${word(a)} spread`;
        if (a.action !== b.action && sameType && !sameExpiry) return `${sameStrike ? 'Calendar' : 'Diagonal'} ${word(a)} spread`;
        if (a.action === b.action && !sameType && sameExpiry) return `${a.action === 'buy' ? 'Long' : 'Short'} ${sameStrike ? 'straddle' : 'strangle'}`;
    }
    return `Custom ${legs.length}-leg strategy`;
}

/** Problems that stop a ticket from being copied; empty when the order is complete. */
export function orderProblems(order) {
    const problems = [];
    const { legs, quantity, orderType, limit } = order;
    if (legs.length === 0) problems.push('Add at least one leg from the options chain.');
    if (legs.length > MAX_LEGS) problems.push(`A single order holds at most ${MAX_LEGS} legs.`);
    if (!isCount(quantity)) problems.push('Quantity must be a whole number of 1 or more.');
    if (legs.some(leg => !isCount(leg.ratio))) problems.push('Each leg ratio must be a whole number of 1 or more.');
    if (new Set(legs.map(leg => leg.contract.id)).size !== legs.length) problems.push('The same contract appears in two legs.');
    if (orderType === 'limit' && !(typeof limit === 'number' && Number.isFinite(limit) && limit > 0)) problems.push('Enter a limit price above 0.');
    if (orderType === 'market' && legs.length > 1) problems.push('Multi-leg orders need a limit price; brokers do not take them at market.');
    return problems;
}

// Value of one strategy unit at expiration, per share, with the underlying at `spot`.
const unitValue = (legs, spot) => legs.reduce((sum, leg) => {
    const { type, strike } = leg.contract;
    const intrinsic = type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
    return sum + sign(leg) * leg.ratio * intrinsic;
}, 0);

/**
 * Cost, payoff at expiration, breakevens and the extremes of the draft order.
 * The entry price is the chosen limit (a market order uses the midpoint, as an
 * estimate). Figures that cannot be defined are null with the reason in `notes`:
 * no entry price, or legs that expire on different days.
 */
export function analyzeOrder(order, underlying = null) {
    const { legs, quantity, orderType, limit, priceSide } = order;
    const market = marketNet(legs);
    const notes = [];
    const empty = { strategy: strategyName(legs), market, entry: null, estimated: false, total: null, side: null, payoff: null, breakevens: null, maxGain: null, maxLoss: null, strikeWidth: null, notes };
    if (legs.length === 0 || !isCount(quantity) || legs.some(leg => !isCount(leg.ratio))) return empty;

    let entry = null; // per share, positive = debit
    let estimated = false;
    if (orderType === 'limit') {
        if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) entry = priceSide === 'credit' ? -limit : limit;
        else notes.push('Enter a limit price to see cost and risk.');
    } else if (market.mid !== null) {
        entry = market.mid;
        estimated = true;
        notes.push('Market order: cost and risk are estimated at the midpoint; the fill can differ.');
    } else {
        notes.push('No usable quote for an estimate; a market order has no stated price.');
    }
    const strikes = [...new Set(legs.map(leg => leg.contract.strike))].sort((a, b) => a - b);
    const result = { ...empty, entry, estimated, strikeWidth: strikes.length === 2 ? cents(strikes[1] - strikes[0]) : null };
    if (entry === null) return result;

    const scale = CONTRACT_SIZE * quantity;
    result.total = cents(Math.abs(entry) * scale);
    result.side = entry >= 0 ? 'debit' : 'credit';
    if (legs.some(leg => leg.effect === 'close')) notes.push('Closing legs: risk figures describe this order alone, not the position it closes.');
    if (new Set(legs.map(leg => leg.contract.expiry)).size > 1) {
        notes.push('Legs expire on different days, so payoff at expiration, breakevens and maximum gain or loss are not defined.');
        return result;
    }

    const pnl = (spot) => cents((unitValue(legs, spot) - entry) * scale);
    const breakpoints = [0, ...strikes];
    const values = breakpoints.map(pnl);
    // Above the highest strike only calls move: dollars per $1 of underlying.
    const tailSlope = legs.reduce((sum, leg) => sum + (leg.contract.type === 'call' ? sign(leg) * leg.ratio : 0), 0) * scale;
    const lastStrike = strikes[strikes.length - 1];
    const lastValue = values[values.length - 1];

    const breakevens = [];
    for (let i = 0; i < breakpoints.length; i++) {
        if (values[i] === 0) { breakevens.push(breakpoints[i]); continue; }
        if (i + 1 < breakpoints.length && values[i] * values[i + 1] < 0) {
            breakevens.push(breakpoints[i] + (breakpoints[i + 1] - breakpoints[i]) * (0 - values[i]) / (values[i + 1] - values[i]));
        }
    }
    if (tailSlope !== 0 && lastValue * tailSlope < 0) breakevens.push(lastStrike - lastValue / tailSlope);
    result.breakevens = [...new Set(breakevens.map(cents))].filter(value => value > 0).sort((a, b) => a - b);
    result.maxGain = tailSlope > 0 ? Infinity : Math.max(0, ...values);
    result.maxLoss = tailSlope < 0 ? Infinity : Math.max(0, -Math.min(...values));

    // Chart: from below the lowest point of interest to above the highest, with a
    // vertex at every strike and breakeven so the drawn line is exact.
    const anchors = [...strikes, ...result.breakevens, ...(underlying > 0 ? [underlying] : [])];
    const low = Math.max(0, Math.min(...anchors) * 0.85);
    const high = Math.max(...anchors) * 1.15;
    const xs = [...new Set([low, ...strikes, ...result.breakevens, high])].filter(x => x >= low && x <= high).sort((a, b) => a - b);
    result.payoff = xs.map(x => ({ price: x, pnl: pnl(x) }));
    return result;
}

const ACTION_WORDS = {
    robinhood: { buy: { open: 'Buy to open', close: 'Buy to close' }, sell: { open: 'Sell to open', close: 'Sell to close' } },
    fidelity: { buy: { open: 'Buy to Open', close: 'Buy to Close' }, sell: { open: 'Sell to Open', close: 'Sell to Close' } },
};
const TIF_WORDS = {
    robinhood: { day: 'Good for day', gtc: 'Good till canceled' },
    fidelity: { day: 'Day', gtc: 'Good \'til Canceled (GTC)' },
};

/** The order's terms in the chosen broker's vocabulary, one entry per ticket field. */
export function ticketFields(order, brokerId) {
    const broker = BROKERS[brokerId] ?? BROKERS.robinhood;
    const { symbol, legs, quantity, orderType, limit, priceSide, tif } = order;
    const multi = legs.length > 1;
    const fields = [{ key: 'underlying', label: 'Underlying', value: symbol.toUpperCase() }];
    legs.forEach((leg, index) => {
        const { expiry, type, strike } = leg.contract;
        const n = index + 1;
        fields.push(
            { key: `leg${n}.action`, label: `Leg ${n} action`, value: ACTION_WORDS[broker.id][leg.action][leg.effect] },
            { key: `leg${n}.quantity`, label: `Leg ${n} contracts`, value: String(legContracts(leg, quantity)) },
            { key: `leg${n}.expiration`, label: `Leg ${n} expiration`, value: expiryLabel(expiry) },
            { key: `leg${n}.strike`, label: `Leg ${n} strike`, value: trimmed(strike) },
            { key: `leg${n}.type`, label: `Leg ${n} call or put`, value: type === 'call' ? 'Call' : 'Put' },
        );
    });
    if (multi) {
        fields.push({ key: 'ratio', label: 'Leg ratio', value: legs.map(leg => leg.ratio).join(' : ') });
        fields.push({ key: 'quantity', label: 'Strategy quantity', value: String(quantity) });
        fields.push({ key: 'single', label: 'One order', value: `All ${legs.length} legs in one multi-leg order` });
    }
    if (orderType === 'limit') {
        const sideWord = priceSide === 'credit' ? 'Net credit' : 'Net debit';
        fields.push({ key: 'orderType', label: 'Order type', value: multi ? `${sideWord} limit` : 'Limit' });
        fields.push({ key: 'limit', label: 'Limit price', value: price(limit) });
    } else {
        fields.push({ key: 'orderType', label: 'Order type', value: 'Market' });
    }
    fields.push({ key: 'tif', label: 'Time in force', value: TIF_WORDS[broker.id][tif] ?? TIF_WORDS[broker.id].day });
    return fields;
}

/**
 * The text Copy Order Ticket puts on the clipboard: every leg and order term in the
 * broker's words, then one machine-readable line (DDS-TICKET/1 …) holding the same
 * order, for any tool that reads the clipboard rather than a person.
 */
export function ticketText(order, brokerId, analysis) {
    const broker = BROKERS[brokerId] ?? BROKERS.robinhood;
    const { symbol, legs, quantity, orderType, limit, priceSide, tif } = order;
    const upper = symbol.toUpperCase();
    const words = ACTION_WORDS[broker.id];
    const lines = [
        `ORDER TICKET · ${broker.ticket} · review before placing`,
        `Underlying: ${upper}`,
        `Strategy: ${analysis.strategy} · ${legs.length > 1 ? `${quantity} × (${legs.map(leg => leg.ratio).join(':')}) · one multi-leg order` : 'single leg'}`,
    ];
    legs.forEach((leg, index) => {
        const { expiry, type, strike } = leg.contract;
        const code = broker.id === 'fidelity' ? fidelitySymbol(upper, leg.contract) : occSymbol(upper, leg.contract);
        lines.push(`Leg ${index + 1}: ${words[leg.action][leg.effect]} ${legContracts(leg, quantity)} ${upper} ${expiryLabel(expiry)} ${trimmed(strike)} ${type === 'call' ? 'Call' : 'Put'} [${code}]`);
    });
    if (orderType === 'limit') {
        const sideWord = priceSide === 'credit' ? 'Net credit' : 'Net debit';
        lines.push(`Order type: ${legs.length > 1 ? `${sideWord} limit` : 'Limit'}`);
        lines.push(`Limit price: ${price(limit)}`);
    } else {
        lines.push('Order type: Market');
    }
    lines.push(`Time in force: ${TIF_WORDS[broker.id][tif] ?? TIF_WORDS[broker.id].day}`);
    if (analysis.total !== null) lines.push(`Total ${analysis.side} before fees: ${money(analysis.total)}${analysis.estimated ? ' (estimate at the midpoint)' : ''}`);
    lines.push('Account, sign-in and submission: in the broker.');
    lines.push(`DDS-TICKET/1 ${JSON.stringify({
        broker: broker.id,
        underlying: upper,
        quantity,
        orderType,
        limit: orderType === 'limit' ? Number(price(limit)) : null,
        priceSide: orderType === 'limit' ? priceSide : null,
        tif,
        legs: legs.map(leg => ({
            action: leg.action,
            effect: leg.effect,
            ratio: leg.ratio,
            contracts: legContracts(leg, quantity),
            type: leg.contract.type,
            strike: leg.contract.strike,
            expiration: leg.contract.expiry,
            occ: occSymbol(upper, leg.contract),
        })),
    })}`);
    return lines.join('\n');
}

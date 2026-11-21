// The options chain Finviz embeds in its stock page (the "Options" tab): one JSON
// document in <script id="route-init-data">, holding the expirations Finviz lists and
// every contract of one expiration with its bid, ask, volume, open interest, implied
// volatility, Greeks and last-trade time. finviz.com is already an allowed host, so
// the chain needs no new desktop channel.

const EXPIRY = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL = /^[A-Za-z][A-Za-z0-9.-]{0,9}$/;

export const isOptionSymbol = (symbol) => typeof symbol === 'string' && SYMBOL.test(symbol);

/** The stock page's options tab; with an expiration, that expiration's chain. */
export function finvizOptionsUrl(symbol, expiry) {
    if (!isOptionSymbol(symbol)) throw new Error('Enter a ticker symbol such as AAPL.');
    // Finviz spells a share class with a hyphen (BRK-B); its page for BRK.B is a 404.
    const base = `https://finviz.com/stock?t=${encodeURIComponent(symbol.toUpperCase().replaceAll('.', '-'))}&ty=oc`;
    return expiry && EXPIRY.test(expiry) ? `${base}&e=${expiry}` : base;
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const positive = (value) => (finite(value) !== null && value > 0 ? value : null);
const nonNegative = (value) => (finite(value) !== null && value >= 0 ? value : null);

// exDate is YYMMDD as a number (261218).
const expiryOf = (exDate) => {
    const digits = String(exDate ?? '');
    if (!/^\d{6}$/.test(digits)) return null;
    return `20${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
};

// Finviz prints a contract's last-trade time without a zone ("2026-11-13T15:59:43").
// Its stock pages use US Eastern time, so the text is kept as printed and labelled ET;
// it is never converted, because a guessed offset would be a made-up instant.
const tradeTime = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? value.slice(0, 16).replace('T', ' ') : null);

function contract(record) {
    const strike = positive(record?.strike);
    const expiry = expiryOf(record?.exDate);
    const type = record?.type === 'call' || record?.type === 'put' ? record.type : null;
    if (!strike || !expiry || !type) return null;
    const bid = nonNegative(record.bidPrice);
    const ask = positive(record.askPrice);
    // A crossed or one-sided market has no usable midpoint or width.
    const twoSided = bid !== null && ask !== null && ask >= bid;
    return {
        id: `${expiry}|${type}|${strike}`,
        expiry, type, strike, bid, ask,
        mid: twoSided ? (bid + ask) / 2 : null,
        width: twoSided ? ask - bid : null,
        last: positive(record.lastClose),
        volume: nonNegative(record.lastVolume),
        openInterest: nonNegative(record.openInterest),
        iv: positive(record.iv),
        delta: finite(record.delta),
        gamma: finite(record.gamma),
        theta: finite(record.theta),
        vega: finite(record.vega),
        lastTradeAt: tradeTime(record.lastTime),
    };
}

// Linear in the page's size: the id is found as plain text, then the tag around it is
// checked by position. A pattern such as /<script[^>]*id=…/ would rescan to the end of
// the page from every unclosed <script, which froze the Futures desk once.
function initData(html) {
    const text = String(html ?? '');
    for (let from = 0; ;) {
        const id = text.indexOf('route-init-data', from);
        if (id < 0) return null;
        from = id + 1;
        const tagStart = text.lastIndexOf('<', id);
        const tagEnd = text.indexOf('>', id);
        if (tagStart < 0 || tagEnd < 0 || !/^<script\b/i.test(text.slice(tagStart, tagStart + 8))) continue;
        if (!/\bid\s*=\s*(["'])route-init-data\1/i.test(text.slice(tagStart, tagEnd))) continue;
        const bodyEnd = text.indexOf('</script', tagEnd);
        if (bodyEnd < 0) return null;
        try { return JSON.parse(text.slice(tagEnd + 1, bodyEnd)); } catch { return null; }
    }
}

/**
 * The chain of one expiration from a Finviz stock page.
 * Unknown values stay null; a page without a chain throws.
 * @returns {{ symbol: string, expiries: string[], expiry: string, underlying: number|null,
 *   underlyingAt: string|null, strikes: { strike: number, call: object|null, put: object|null }[] }}
 */
export function parseFinvizOptionsPage(html) {
    const data = initData(html);
    if (!data || !Array.isArray(data.options) || typeof data.ticker !== 'string') {
        throw new Error('Finviz options chain unavailable: response blocked, no listed options, or page schema changed.');
    }
    const expiries = (Array.isArray(data.expiries) ? data.expiries : []).filter(item => typeof item === 'string' && EXPIRY.test(item));
    const expiry = EXPIRY.test(data.currentExpiry ?? '') ? data.currentExpiry : null;
    const byStrike = new Map();
    for (const record of data.options) {
        const item = contract(record);
        if (!item || (expiry && item.expiry !== expiry)) continue;
        const row = byStrike.get(item.strike) ?? { strike: item.strike, call: null, put: null };
        row[item.type] = item;
        byStrike.set(item.strike, row);
    }
    if (!expiry || byStrike.size === 0) throw new Error('Finviz lists no option contracts for this expiration.');
    const quotedAt = positive(data.lastTime);
    return {
        symbol: data.ticker.toUpperCase(),
        expiries,
        expiry,
        underlying: positive(data.lastClose),
        underlyingAt: quotedAt ? new Date(quotedAt * 1000).toISOString() : null,
        strikes: [...byStrike.values()].sort((a, b) => a.strike - b.strike),
    };
}

/** Fetches and parses one expiration's chain through the desktop bridge (null outside the desktop app). */
export async function fetchOptionsChain(invoke, symbol, expiry) {
    if (!invoke) throw new Error('The options chain requires the desktop app connection. No sample quotes are shown.');
    const html = await invoke('fetch-url', finvizOptionsUrl(symbol, expiry));
    return { ...parseFinvizOptionsPage(html), fetchedAt: new Date().toISOString() };
}

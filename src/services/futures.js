export const FUTURES_SOURCE_URL = 'https://finviz.com/futures.ashx';
export const FUTURES_API_URL = 'https://finviz.com/api/futures_all';

// Finviz's current FAQ still specifies 20 minutes, although the page footer
// specifies 15. Use the conservative disclosure; neither is a freshness SLA.
export const FUTURES_DELAY_MINUTES = 20;

export const FUTURES_TIMEFRAMES = [
    { id: 'i5', label: '5 minute' },
    { id: 'h', label: 'Hourly' },
    { id: 'd', label: 'Daily' },
    { id: 'w', label: 'Weekly' },
    { id: 'm', label: 'Monthly' },
    { id: 'NO', label: 'Quotes only' },
];

// Finviz roots are reference instruments, not a confirmed delivery contract.
// Additional roots present in the API belong beside their respective groups.
export const FUTURES_GROUPS = [
    { id: 'indices', label: 'Indices', symbols: ['ES', 'NQ', 'YM', 'ER2', 'NKD', 'EX', 'DY', 'VX'] },
    { id: 'rates', label: 'Rates', symbols: ['ZQ', 'SR3', 'ZT', 'ZF', 'ZN', 'TN', 'ZB', 'UB'] },
    { id: 'energy', label: 'Energy', symbols: ['CL', 'QA', 'NG', 'RB', 'G', 'HO', 'NCF', 'UX', 'ZK'] },
    { id: 'metals', label: 'Metals', symbols: ['GC', 'SI', 'PL', 'PA', 'HG', 'ALI', 'TIO', 'HRC'] },
    { id: 'grains', label: 'Grains', symbols: ['ZS', 'ZM', 'ZL', 'ZC', 'ZW', 'ZR', 'RS', 'ZO'] },
    { id: 'softs', label: 'Softs & Meats', symbols: ['KC', 'CC', 'SB', 'CT', 'LB', 'LC', 'FC', 'LH', 'JO'] },
    { id: 'currencies', label: 'Currencies', symbols: ['DX', '6E', '6J', '6B', '6C', '6S', '6A', 'BTC', '6N'] },
];

const GROUP_BY_SYMBOL = new Map(FUTURES_GROUPS.flatMap(group => group.symbols.map(symbol => [symbol, group.id])));
const BOND_SYMBOLS = new Set(['ZT', 'ZF', 'ZN', 'TN', 'ZB', 'UB']);
const SYMBOL_PATTERN = /^[A-Z0-9]{1,8}$/;
const numeric = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (now) => new Date(typeof now === 'function' ? now() : (now ?? Date.now())).toISOString();
const messageOf = (error) => error instanceof Error ? error.message : String(error);

const readPayload = (input) => {
    if (typeof input !== 'string') return { data: input, fromPage: false };
    const text = input.trim();
    if (!text.startsWith('<')) return { data: JSON.parse(text), fromPage: false };

    // Never evaluate page JavaScript. Only the explicitly typed JSON payload
    // is accepted, with attributes permitted in either order and quote style.
    for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        const attributes = match[1];
        if (/(?:^|\s)id\s*=\s*(["'])futures-init-data\1/i.test(attributes)
            && /(?:^|\s)type\s*=\s*(["'])application\/json\1/i.test(attributes)) {
            return { data: JSON.parse(match[2]), fromPage: true };
        }
    }
    throw new Error('Finviz response does not contain futures quote JSON.');
};

const sourceQuote = (symbol, data, fetchedAt, sourceUrl) => {
    const record = isRecord(data) ? data : {};
    const identityMatches = record.ticker === symbol;
    const last = numeric(record.last);
    const changePct = numeric(record.change);
    const available = identityMatches && last !== null && changePct !== null;
    const sparkline = available && Array.isArray(record.sparkline) && record.sparkline.every(value => numeric(value) !== null)
        ? [...record.sparkline] : [];
    const chartLabels = {};
    if (sparkline.length > 0 && isRecord(record.sparklineDateChanges)) {
        for (const [index, label] of Object.entries(record.sparklineDateChanges)) {
            if (/^\d+$/.test(index) && Number(index) < sparkline.length && typeof label === 'string') {
                chartLabels[index] = label.slice(0, 40);
            }
        }
    }
    return {
        symbol,
        name: typeof record.label === 'string' && record.label.trim() ? record.label.trim().slice(0, 100) : symbol,
        group: GROUP_BY_SYMBOL.get(symbol) ?? 'other',
        status: available ? 'delayed' : 'unavailable',
        price: available ? last : null,
        changePct: available ? changePct : null,
        // Despite Finviz's field name, this is change in the instrument's
        // native price units: index points, bond points, cents, dollars, etc.
        change: available ? numeric(record.changeUsd) : null,
        prevClose: available ? numeric(record.prevClose) : null,
        high: available ? numeric(record.high) : null,
        low: available ? numeric(record.low) : null,
        sparkline,
        chartLabels,
        unit: BOND_SYMBOLS.has(symbol) ? 'points' : 'native quote',
        quotedAt: null,
        contract: null,
        fetchedAt: available ? fetchedAt : null,
        sourceUrl,
    };
};

/** Parse actual API JSON or the futures page's JSON script without executing it. */
export const parseFinvizFutures = (input, options = {}) => {
    const { data, fromPage } = readPayload(input);
    if (!isRecord(data)) throw new Error('Finviz futures quote payload must be a record.');
    const fetchedAt = timestamp(options.fetchedAt);
    const timeframe = options.timeframe ?? 'i5';
    const sourceUrl = options.sourceUrl ?? (fromPage ? FUTURES_SOURCE_URL : `${FUTURES_API_URL}?timeframe=${timeframe}`);
    const quotes = Object.entries(data)
        .filter(([symbol]) => SYMBOL_PATTERN.test(symbol))
        .map(([symbol, quote]) => sourceQuote(symbol, quote, fetchedAt, sourceUrl));
    if (!quotes.some(quote => quote.status === 'delayed')) {
        throw new Error('Finviz response contains no usable futures quotes.');
    }
    const partial = quotes.some(quote => quote.status === 'unavailable');
    return {
        source: 'Finviz', sourceUrl, timeframe,
        status: 'delayed', cached: false, partial,
        fetchedAt, attemptedAt: fetchedAt, quotedAt: null,
        delayMinutes: FUTURES_DELAY_MINUTES,
        quotes,
        error: partial ? 'Some Finviz quotes are unavailable.' : null,
    };
};

const unavailableSnapshot = (timeframe, attemptedAt, error) => ({
    source: 'Finviz', sourceUrl: FUTURES_SOURCE_URL, timeframe,
    status: 'unavailable', cached: false, partial: false,
    fetchedAt: null, attemptedAt, quotedAt: null,
    delayMinutes: FUTURES_DELAY_MINUTES, quotes: [], error,
});

const compatiblePrevious = (previous, timeframe) => previous?.source === 'Finviz'
    && previous.timeframe === timeframe && Array.isArray(previous.quotes);

const mergePrevious = (snapshot, previous) => {
    if (!compatiblePrevious(previous, snapshot.timeframe)) return snapshot;
    const quotes = new Map(snapshot.quotes.map(quote => [quote.symbol, quote]));
    for (const old of previous.quotes) {
        const current = quotes.get(old.symbol);
        if ((!current || current.status === 'unavailable') && old.status !== 'unavailable'
            && numeric(old.price) !== null && numeric(old.changePct) !== null) {
            quotes.set(old.symbol, { ...old, status: 'cached' });
        }
    }
    const merged = [...quotes.values()];
    const cached = merged.some(quote => quote.status === 'cached');
    const partial = merged.some(quote => quote.status !== 'delayed');
    return {
        ...snapshot,
        quotes: merged,
        cached,
        partial,
        error: partial ? 'Some quotes could not be refreshed. Cached rows retain their last successful retrieval time.' : snapshot.error,
    };
};

const failedSnapshot = (previous, timeframe, attemptedAt, error) => {
    if (!compatiblePrevious(previous, timeframe)) return unavailableSnapshot(timeframe, attemptedAt, error);
    const quotes = previous.quotes.map(quote => quote.status === 'unavailable' ? quote : { ...quote, status: 'cached' });
    if (!quotes.some(quote => quote.status === 'cached')) return unavailableSnapshot(timeframe, attemptedAt, error);
    return { ...previous, status: 'cached', cached: true, attemptedAt, error, quotes };
};

/** Fetch through Electron; browser previews explicitly show unavailable data. */
export const fetchFinvizFutures = async (ipcRenderer, options = {}) => {
    const timeframe = options.timeframe ?? 'i5';
    const attemptedAt = timestamp(options.now);
    const previous = options.previous;
    if (!FUTURES_TIMEFRAMES.some(item => item.id === timeframe)) {
        return unavailableSnapshot(timeframe, attemptedAt, 'Unsupported Finviz futures timeframe.');
    }
    if (typeof ipcRenderer?.invoke !== 'function') {
        return failedSnapshot(previous, timeframe, attemptedAt, 'Futures data requires the Electron desktop app.');
    }

    const apiUrl = `${FUTURES_API_URL}?timeframe=${timeframe}`;
    let apiError;
    try {
        const input = await ipcRenderer.invoke('fetch-url', apiUrl);
        const snapshot = parseFinvizFutures(input, { fetchedAt: timestamp(options.now), timeframe, sourceUrl: apiUrl });
        return { ...mergePrevious(snapshot, previous), attemptedAt };
    } catch (error) {
        apiError = messageOf(error);
    }

    try {
        const input = await ipcRenderer.invoke('fetch-url', FUTURES_SOURCE_URL);
        const snapshot = parseFinvizFutures(input, { fetchedAt: timestamp(options.now), timeframe, sourceUrl: FUTURES_SOURCE_URL });
        // The generic page does not identify its chart interval. Keep its
        // quotes, but never label those samples as the requested interval.
        const quotesOnly = {
            ...snapshot,
            quotes: snapshot.quotes.map(quote => ({ ...quote, sparkline: [], chartLabels: {} })),
        };
        const merged = mergePrevious(quotesOnly, previous);
        return {
            ...merged, attemptedAt,
            error: [merged.error, `Chart endpoint unavailable (${apiError}); showing Finviz page quotes without unverified chart samples.`].filter(Boolean).join(' '),
        };
    } catch (error) {
        return failedSnapshot(previous, timeframe, attemptedAt, `Finviz refresh failed: ${apiError}; ${messageOf(error)}`);
    }
};

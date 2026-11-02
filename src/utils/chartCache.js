// Yahoo chart responses reused for Settings → Data → chart cache seconds.
// Every entry keeps the time the response was actually retrieved, so a quote
// served from memory still shows its original retrieval time on screen; nothing
// is ever re-stamped. A zero TTL disables completed-response reuse but identical
// concurrent requests still share their in-flight provider request.
const MAX_ENTRIES = 1500;
const entries = new Map(); // "symbol|range|interval" -> { json, fetchedAt, at }
const inFlight = new Map(); // "symbol|range|interval" -> pending provider request

const keyOf = (symbol, range, interval) => `${symbol}|${range}|${interval}`;

/**
 * @param {(channel: string, ...args: any[]) => Promise<any>} invoke  ipcRenderer.invoke
 * @returns {Promise<{ json: any, fetchedAt: string, cached: boolean }>}
 */
export async function fetchYahooChart(invoke, symbol, { range = '1mo', interval = '1d', ttlSeconds = 0, now = Date.now } = {}) {
    const key = keyOf(symbol, range, interval);
    const hit = entries.get(key);
    if (hit && ttlSeconds > 0 && now() - hit.at <= ttlSeconds * 1000) {
        return { json: hit.json, fetchedAt: hit.fetchedAt, cached: true };
    }
    const pending = inFlight.get(key);
    if (pending) return pending;

    const request = Promise.resolve()
        .then(() => invoke('fetch-yahoo-chart', symbol, range, interval))
        .then((json) => {
            const at = now();
            const fetchedAt = new Date(at).toISOString();
            // Always remembered, so raising the TTL later can reuse what is already here.
            entries.delete(key);
            entries.set(key, { json, fetchedAt, at });
            while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
            return { json, fetchedAt, cached: false };
        });
    inFlight.set(key, request);
    try {
        return await request;
    } finally {
        if (inFlight.get(key) === request) inFlight.delete(key);
    }
}

export const chartCacheSize = () => entries.size;
export const clearChartCache = () => entries.clear();

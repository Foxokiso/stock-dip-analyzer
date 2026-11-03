// Yahoo chart responses reused for Settings → Data → chart cache seconds.
// Every entry keeps the time the response was actually retrieved, so a quote
// served from memory still shows its original retrieval time on screen; nothing
// is ever re-stamped. With TTL 0 each new request hits the provider; overlapping
// requests in the same scope share their in-flight provider call.
const MAX_ENTRIES = 1500;
const entries = new Map(); // "symbol|range|interval" -> { json, fetchedAt, at }
const inFlight = new Map(); // request scope -> key -> promise

const keyOf = (symbol, range, interval) => `${symbol}|${range}|${interval}`;

/**
 * @param {(channel: string, ...args: any[]) => Promise<any>} invoke  ipcRenderer.invoke
 * @param {{ range?: string, interval?: string, ttlSeconds?: number, now?: () => number, requestScope?: unknown }} [options]
 * @returns {Promise<{ json: any, fetchedAt: string, cached: boolean }>}
 */
export async function fetchYahooChart(invoke, symbol, { range = '1mo', interval = '1d', ttlSeconds = 0, now = Date.now, requestScope = invoke } = {}) {
    const key = keyOf(symbol, range, interval);
    const hit = entries.get(key);
    if (hit && ttlSeconds > 0 && now() - hit.at <= ttlSeconds * 1000) {
        return { json: hit.json, fetchedAt: hit.fetchedAt, cached: true };
    }
    let requests = inFlight.get(requestScope);
    if (requests?.has(key)) return requests.get(key);
    if (!requests) {
        requests = new Map();
        inFlight.set(requestScope, requests);
    }

    let pending;
    pending = Promise.resolve()
        .then(() => invoke('fetch-yahoo-chart', symbol, range, interval))
        .then((json) => {
            const at = now();
            const result = { json, fetchedAt: new Date(at).toISOString(), cached: false };
            if (inFlight.get(requestScope) === requests && requests.get(key) === pending) {
                // Always remembered, so raising the TTL later can reuse what is already here.
                entries.delete(key);
                entries.set(key, { json, fetchedAt: result.fetchedAt, at });
                while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
            }
            return result;
        })
        .finally(() => {
            if (requests.get(key) === pending) requests.delete(key);
            if (requests.size === 0 && inFlight.get(requestScope) === requests) inFlight.delete(requestScope);
        });
    requests.set(key, pending);
    return pending;
}

export const chartCacheSize = () => entries.size;
export const clearChartCache = () => {
    entries.clear();
    inFlight.clear();
};

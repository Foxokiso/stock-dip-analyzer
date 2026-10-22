// Yahoo chart responses reused for Settings → Data → chart cache seconds.
// Every entry keeps the time the response was actually retrieved, so a quote
// served from memory still shows its original retrieval time on screen; nothing
// is ever re-stamped. With a TTL of 0 (the default) every call hits the provider.
const MAX_ENTRIES = 1500;
const entries = new Map(); // "symbol|range|interval" -> { json, fetchedAt, at }

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
    const json = await invoke('fetch-yahoo-chart', symbol, range, interval);
    const at = now();
    // Always remembered, so raising the TTL later can reuse what is already here.
    entries.delete(key);
    entries.set(key, { json, fetchedAt: new Date(at).toISOString(), at });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
    return { json, fetchedAt: new Date(at).toISOString(), cached: false };
}

export const chartCacheSize = () => entries.size;
export const clearChartCache = () => entries.clear();

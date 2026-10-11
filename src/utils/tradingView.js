export function createTradingViewLoader({
    window: browserWindow = globalThis.window,
    document: browserDocument = globalThis.document,
    timeoutMs = 12000,
} = {}) {
    let pending = null;
    return () => {
        if (pending) return pending;
        if (typeof browserWindow?.TradingView?.widget === 'function') {
            pending = Promise.resolve(browserWindow.TradingView);
            return pending;
        }
        if (!browserDocument?.head) return Promise.reject(new Error('TradingView chart is unavailable in this environment.'));

        const script = browserDocument.createElement('script');
        script.src = 'https://s3.tradingview.com/tv.js';
        script.async = true;
        let resolveLoad, rejectLoad, timer, settled = false;
        const request = new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; });
        pending = request;
        const clearHandlers = () => { clearTimeout(timer); script.onload = null; script.onerror = null; };
        const fail = error => {
            if (settled) return;
            settled = true;
            clearHandlers();
            script.remove();
            if (pending === request) pending = null;
            rejectLoad(error);
        };
        script.onload = () => {
            if (settled) return;
            if (typeof browserWindow?.TradingView?.widget !== 'function') {
                fail(new Error('TradingView did not initialize. Retry the chart.'));
                return;
            }
            settled = true;
            clearHandlers();
            resolveLoad(browserWindow.TradingView);
        };
        script.onerror = () => fail(new Error('TradingView chart is unavailable. Check the network connection and retry.'));
        timer = setTimeout(() => fail(new Error('TradingView chart loading timed out. Retry the chart.')), timeoutMs);
        try { browserDocument.head.appendChild(script); } catch { fail(new Error('TradingView chart script could not load. Retry the chart.')); }
        return request;
    };
}

let sharedLoader;
export function loadTradingView() {
    sharedLoader ||= createTradingViewLoader();
    return sharedLoader();
}

// The app owns the displayed symbol. Superseded loads must never inject a
// widget into a reused chart container or report errors for its current stock.
export function mountTradingViewWidget(container, options, {
    load = loadTradingView, onReady = () => {}, onError = () => {},
} = {}) {
    let cancelled = false, widget;
    container.replaceChildren();
    load().then(TradingView => {
        if (cancelled) return;
        widget = new TradingView.widget({ ...options, allow_symbol_change: false });
        onReady();
    }).catch(error => { if (!cancelled) onError(error); });
    return () => {
        cancelled = true;
        try { widget?.remove?.(); } catch { /* A failed remote widget cannot block local cleanup. */ }
        container.replaceChildren();
    };
}

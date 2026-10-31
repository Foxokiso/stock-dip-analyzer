// TradingView's chart runs in a sandboxed iframe on TradingView's own origin.
// Its loader script (tv.js) is never added to this document: TradingView
// redeploys it, so it cannot be pinned, and anything it ran here would share
// the page with the desktop bridge. The iframe URL tv.js would build is
// reproduced below instead.
export const TRADINGVIEW_ORIGIN = 'https://s.tradingview.com';

// Finviz and Yahoo write share classes with a hyphen (BRK-B). TradingView reads
// '-' as a spread and would chart BRK minus B, so it gets its own dot notation.
// An exchange prefix, if present, is kept.
export const toTradingViewSymbol = (symbol) => (typeof symbol === 'string'
    ? symbol.trim().replace(/^((?:[A-Z]+:)?[A-Z]{1,5})-([A-Z])$/i, '$1.$2')
    : '');

// Anything still holding an operator would chart an expression, not a security.
const SPREAD_OPERATOR = /[-+*/]/;

// TradingView draws its toolbars in a light or a dark theme. Pages pass the app
// theme; every app theme is dark (index.css declares color-scheme: dark), and
// TradingView's own names are honoured as given.
export const toTradingViewTheme = (theme) => (theme === 'light' ? 'light' : 'dark');

/**
 * The URL tv.js's generateUrl builds for TradingView's advanced chart, for the
 * options the app uses and with the keys in tv.js's order. The embedding page
 * is reported the way tv.js reports the packaged file:// app, so the app's own
 * URL never reaches TradingView. Symbol changes are never allowed.
 */
export function buildTradingViewEmbedUrl({
    symbol, frameElementId, interval, timezone, theme, style, locale, hide_side_toolbar,
    save_image = true, backgroundColor, gridColor, overrides = {}, studies_overrides = {},
    enabled_features = [], disabled_features = [],
}) {
    const url = new URL('/widgetembed/', TRADINGVIEW_ORIGIN);
    url.searchParams.append('hideideas', '1');
    url.searchParams.append('overrides', JSON.stringify(overrides));
    url.searchParams.append('enabled_features', JSON.stringify(enabled_features));
    url.searchParams.append('disabled_features', JSON.stringify(disabled_features));
    if (locale) url.searchParams.append('locale', locale);
    const hash = { symbol, frameElementId, interval };
    const put = (key, value) => {
        if (value == null || value === '') return;
        hash[key] = typeof value === 'object' ? JSON.stringify(value) : value;
    };
    const flag = (key, value, otherwise) => put(key, value === undefined ? undefined : value ? '1' : otherwise);
    flag('hide_side_toolbar', hide_side_toolbar, '0');
    flag('allow_symbol_change', false, '0');
    flag('save_image', save_image, '0');
    put('backgroundColor', backgroundColor);
    put('gridColor', gridColor);
    put('studies', []);
    put('theme', theme);
    put('style', style);
    put('timezone', timezone);
    put('studies_overrides', studies_overrides);
    put('utm_medium', 'widget');
    put('utm_campaign', 'chart');
    put('utm_term', symbol);
    put('page-uri', '__NHTTP__');
    return `${url}#${encodeURIComponent(JSON.stringify(hash))}`;
}

// TradingView paints its chart on a canvas inside its own iframe, so the brief's
// chart roles cannot reach it through CSS. They are read from the live cascade
// at mount time (never typed by hand) and handed over as plain colour strings.
const CHART_ROLES = {
    background: '--bg-card', grid: '--line', text: '--text-muted',
    series: '--secondary', up: '--success', down: '--danger',
};

const cssColor = ([r, g, b, a]) => a === 255
    ? `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
    : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;

// Resolves each role token to an sRGB string through a 1x1 canvas. Returns null
// when anything cannot be resolved so the widget simply keeps its own defaults.
function resolveChartPalette(container) {
    const doc = container?.ownerDocument;
    const view = doc?.defaultView;
    if (!view?.getComputedStyle || typeof doc.createElement !== 'function') return null;
    const canvas = doc.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext?.('2d', { willReadFrequently: true });
    if (!context) return null;
    // Never rendered: it only carries the role tokens to getComputedStyle.
    const probe = doc.createElement('span');
    probe.hidden = true;
    container.appendChild(probe);
    try {
        const palette = {};
        for (const [role, token] of Object.entries(CHART_ROLES)) {
            probe.style.color = `var(${token})`;
            const color = view.getComputedStyle(probe).color;
            context.fillStyle = 'transparent';
            const unset = context.fillStyle;
            context.fillStyle = color;
            if (!color || context.fillStyle === unset) return null;
            context.clearRect(0, 0, 1, 1);
            context.fillRect(0, 0, 1, 1);
            const pixel = context.getImageData(0, 0, 1, 1).data;
            if (pixel[3] === 0) return null;
            palette[role] = cssColor(pixel);
        }
        return palette;
    } catch {
        return null;
    } finally {
        probe.remove();
    }
}

// Candles keep the up/down semantics; the line and area styles take the
// --secondary stroke; grid, scales and ground follow --line / --text-muted / --bg-card.
const chartPaletteOptions = (palette) => palette ? {
    backgroundColor: palette.background,
    gridColor: palette.grid,
    overrides: {
        'paneProperties.background': palette.background,
        'paneProperties.backgroundType': 'solid',
        'paneProperties.vertGridProperties.color': palette.grid,
        'paneProperties.horzGridProperties.color': palette.grid,
        'scalesProperties.textColor': palette.text,
        'scalesProperties.lineColor': palette.grid,
        'mainSeriesProperties.candleStyle.upColor': palette.up,
        'mainSeriesProperties.candleStyle.downColor': palette.down,
        'mainSeriesProperties.candleStyle.borderUpColor': palette.up,
        'mainSeriesProperties.candleStyle.borderDownColor': palette.down,
        'mainSeriesProperties.candleStyle.wickUpColor': palette.up,
        'mainSeriesProperties.candleStyle.wickDownColor': palette.down,
        'mainSeriesProperties.lineStyle.color': palette.series,
        'mainSeriesProperties.areaStyle.linecolor': palette.series,
    },
} : {};

// tv.js's ids have this shape; the frame echoes it back as client_id.
const createFrameElementId = () => `tradingview_${(0x100000 * (1 + Math.random()) | 0).toString(16).slice(1)}`;

// TradingView posts plain objects and JSON strings.
const readMessage = (data) => {
    if (typeof data !== 'string') return data;
    try { return JSON.parse(data); } catch { return null; }
};

// The app owns the displayed symbol. A disposed mount must never put a chart
// into a reused container or report errors for the stock shown now. Mounting
// waits one task: the settings provider applies the theme class in its own
// effect, after the page's, and the palette must be read from that cascade.
export function mountTradingViewWidget(container, options, {
    onReady = () => {}, onError = () => {}, timeoutMs = 20000,
} = {}) {
    const view = container.ownerDocument?.defaultView;
    const frameElementId = createFrameElementId();
    let frame, readyTimer;
    // A cross-origin frame fires `load` even when its page failed (offline,
    // DNS), so readiness comes from TradingView's handshake instead. As tv.js
    // does, the frame is asked for widgetReady and answers once the chart is
    // up. It is asked when it announces itself (tv-widget-load), well before
    // its load event, which waits for every ad and font, and again on load.
    const requestReady = () => frame?.contentWindow?.postMessage(JSON.stringify({
        id: 0, type: 'get', name: 'widgetReady', client_id: frameElementId, data: {}, provider: 'TradingView',
    }), TRADINGVIEW_ORIGIN);
    // Only TradingView's origin is heard, and only about this frame.
    const onMessage = (event) => {
        if (event.origin !== TRADINGVIEW_ORIGIN) return;
        const message = readMessage(event.data);
        if (message?.name === 'tv-widget-load' && message.frameElementId === frameElementId) requestReady();
        if (message?.provider !== 'TradingView' || message.type !== 'on' || message.name !== 'widgetReady'
            || message.client_id !== frameElementId) return;
        view.removeEventListener('message', onMessage);
        frame.removeEventListener('load', requestReady);
        clearTimeout(readyTimer);
        frame.style.opacity = '';
        frame.inert = false;
        onReady();
    };
    container.replaceChildren();
    const mountTimer = setTimeout(() => {
        const symbol = toTradingViewSymbol(options.symbol);
        if (!symbol || SPREAD_OPERATOR.test(symbol)) {
            onError(new Error(`TradingView has no chart for ${options.symbol || 'this symbol'}.`));
            return;
        }
        frame = container.ownerDocument.createElement('iframe');
        // Scripts on TradingView's own origin (its storage and data connection)
        // only: no popups, so ads cannot open windows, and no top navigation,
        // downloads or forms. Links inside the chart therefore do nothing.
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        frame.referrerPolicy = 'no-referrer';
        // The ready timeout starts now, so the frame must not wait to be scrolled to.
        frame.loading = 'eager';
        frame.title = `TradingView chart for ${options.symbol}`;
        // Transparent until TradingView answers, so the container keeps its
        // placeholder while loading and a failed load never shows a blank error
        // page. Opacity, not visibility: Chromium throttles hidden cross-origin
        // frames, which could keep the chart from ever getting ready. Inert until
        // then as well, so Tab never stops on (and assistive technology never
        // reads) a frame nobody can see.
        frame.style.cssText = 'display: block; width: 100%; height: 100%; border: 0; opacity: 0;';
        frame.inert = true;
        frame.src = buildTradingViewEmbedUrl({
            ...chartPaletteOptions(resolveChartPalette(container)),
            ...options,
            symbol,
            frameElementId,
            theme: toTradingViewTheme(options.theme),
            // The sandbox blocks downloads and popups, so the snapshot menu could only fail.
            save_image: false,
        });
        frame.addEventListener('load', requestReady);
        view?.addEventListener('message', onMessage);
        container.appendChild(frame);
        // A late answer still calls onReady, which clears the notice again.
        readyTimer = setTimeout(() => onError(new Error('TradingView chart did not load. Check the network connection and retry the chart.')), timeoutMs);
    }, 0);
    return () => {
        clearTimeout(mountTimer);
        clearTimeout(readyTimer);
        view?.removeEventListener('message', onMessage);
        container.replaceChildren();
    };
}

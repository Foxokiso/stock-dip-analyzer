import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import {
    TRADINGVIEW_ORIGIN, buildTradingViewEmbedUrl, mountTradingViewWidget, toTradingViewSymbol, toTradingViewTheme,
} from '../src/utils/tradingView.js';
import { CONTENT_SECURITY_POLICY } from '../vite.config.js';

const environment = () => {
    const document = new DOMParser().parseFromString('<html><head></head><body><div id="chart"></div></body></html>', 'text/html');
    return { document, view: document.defaultView, container: document.getElementById('chart') };
};

// The options TradingView reads from the JSON after '#'.
const hashOf = (src) => JSON.parse(decodeURIComponent(new URL(src).hash.slice(1)));

const postMessageEvent = (view, origin, data) => {
    const event = new view.Event('message');
    Object.defineProperties(event, { origin: { value: origin }, data: { value: data } });
    view.dispatchEvent(event);
};

const readyReply = (frameElementId, fields = {}) => JSON.stringify({
    id: 0, type: 'on', name: 'widgetReady', client_id: frameElementId, provider: 'TradingView', ...fields,
});

// Mounts, runs the deferred mount (timers must be mocked) and records what the
// frame is sent, since linkedom frames have no window of their own.
function mount(t, options, callbacks) {
    const env = environment();
    const dispose = mountTradingViewWidget(env.container, options, callbacks);
    t.mock.timers.tick(0);
    const frame = env.container.querySelector('iframe');
    const posted = [];
    if (frame) Object.defineProperty(frame, 'contentWindow', {
        value: { postMessage: (data, targetOrigin) => posted.push({ data: JSON.parse(data), targetOrigin }) },
    });
    return { ...env, dispose, frame, posted };
}

test('the production CSP runs no remote script and frames only the TradingView embed host', () => {
    const directives = Object.fromEntries(CONTENT_SECURITY_POLICY.split('; ').map(directive => {
        const [name, ...sources] = directive.split(' ');
        return [name, sources];
    }));
    assert.deepEqual(directives, {
        'default-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'"], 'font-src': ["'self'"], 'media-src': ["'self'"], 'connect-src': ["'self'"],
        'frame-src': [TRADINGVIEW_ORIGIN], 'worker-src': ["'self'"],
        'object-src': ["'none'"], 'base-uri': ["'none'"], 'form-action': ["'none'"],
    });
});

test('class shares take TradingView dot notation and other symbols are kept', () => {
    assert.equal(toTradingViewSymbol('BRK-B'), 'BRK.B');
    assert.equal(toTradingViewSymbol('BF-B'), 'BF.B');
    assert.equal(toTradingViewSymbol('HEI-A'), 'HEI.A');
    assert.equal(toTradingViewSymbol('NYSE:BRK-B'), 'NYSE:BRK.B');
    for (const symbol of ['SPY', 'AAPL', 'BRK.B', 'NASDAQ:AAPL', 'ABC-WS']) assert.equal(toTradingViewSymbol(symbol), symbol);
    assert.equal(toTradingViewSymbol(undefined), '');
});

test('the embed URL is the one tv.js builds for the stock page options', () => {
    const url = buildTradingViewEmbedUrl({
        symbol: 'AAPL', frameElementId: 'tradingview_0a1b2', interval: 'D', timezone: 'America/New_York',
        theme: 'dark', style: '1', locale: 'en', hide_side_toolbar: false,
    });
    // tv.js (build of 2026-10-30) generated this on a file:// page for the same
    // options plus allow_symbol_change: false, as the app always passed them.
    assert.equal(url, 'https://s.tradingview.com/widgetembed/?hideideas=1&overrides=%7B%7D&enabled_features=%5B%5D&disabled_features=%5B%5D&locale=en#%7B%22symbol%22%3A%22AAPL%22%2C%22frameElementId%22%3A%22tradingview_0a1b2%22%2C%22interval%22%3A%22D%22%2C%22hide_side_toolbar%22%3A%220%22%2C%22allow_symbol_change%22%3A%220%22%2C%22save_image%22%3A%221%22%2C%22studies%22%3A%22%5B%5D%22%2C%22theme%22%3A%22dark%22%2C%22style%22%3A%221%22%2C%22timezone%22%3A%22America%2FNew_York%22%2C%22studies_overrides%22%3A%22%7B%7D%22%2C%22utm_medium%22%3A%22widget%22%2C%22utm_campaign%22%3A%22chart%22%2C%22utm_term%22%3A%22AAPL%22%2C%22page-uri%22%3A%22__NHTTP__%22%7D');
});

test('a symbol is encoded into the fragment and cannot reach the query or other options', () => {
    const symbol = 'X","allow_symbol_change":"1"}#&locale=fr';
    const url = new URL(buildTradingViewEmbedUrl({ symbol, frameElementId: 'tradingview_00000', locale: 'en' }));
    assert.equal(url.origin, TRADINGVIEW_ORIGIN);
    assert.equal(url.pathname, '/widgetembed/');
    assert.deepEqual([...url.searchParams.keys()], ['hideideas', 'overrides', 'enabled_features', 'disabled_features', 'locale']);
    assert.equal(url.searchParams.get('locale'), 'en');
    const hash = hashOf(url.href);
    assert.equal(hash.symbol, symbol);
    assert.equal(hash.utm_term, symbol);
    assert.equal(hash.allow_symbol_change, '0');
});

test('symbol changes stay off whatever the options ask for', (t) => {
    assert.equal(hashOf(buildTradingViewEmbedUrl({ symbol: 'SPY', frameElementId: 'tradingview_00000', allow_symbol_change: true })).allow_symbol_change, '0');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { frame } = mount(t, { symbol: 'SPY', allow_symbol_change: true });
    assert.equal(hashOf(frame.src).allow_symbol_change, '0');
});

test('app themes are dark to TradingView and its own theme names pass through', (t) => {
    for (const theme of ['theme-pierce27', 'theme-majestic', 'theme-anime', 'theme-seizure', 'dark', undefined]) {
        assert.equal(toTradingViewTheme(theme), 'dark');
    }
    assert.equal(toTradingViewTheme('light'), 'light');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(hashOf(mount(t, { symbol: 'SPY', theme: 'theme-anime' }).frame.src).theme, 'dark');
    assert.equal(hashOf(mount(t, { symbol: 'SPY', theme: 'light' }).frame.src).theme, 'light');
});

test('the chart is a sandboxed TradingView frame and no script reaches the document', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { document, container, frame } = mount(t, {
        symbol: 'BRK-B', interval: 'D', timezone: 'America/New_York', theme: 'theme-pierce27', style: '1', locale: 'en',
    });
    assert.equal(container.children.length, 1);
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-same-origin');
    assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(frame.getAttribute('loading'), 'eager');
    assert.equal(frame.getAttribute('title'), 'TradingView chart for BRK-B');
    const src = new URL(frame.src);
    assert.equal(`${src.origin}${src.pathname}`, `${TRADINGVIEW_ORIGIN}/widgetembed/`);
    // Without a resolvable palette TradingView keeps its own colours.
    assert.equal(src.searchParams.get('overrides'), '{}');
    const hash = hashOf(frame.src);
    assert.equal(hash.symbol, 'BRK.B');
    assert.equal(hash.utm_term, 'BRK.B');
    assert.equal(hash.theme, 'dark');
    assert.equal(hash.save_image, '0');
    assert.equal(hash['page-uri'], '__NHTTP__');
    assert.match(hash.frameElementId, /^tradingview_[0-9a-f]{5}$/);
    assert.equal(document.querySelectorAll('script').length, 0);
});

test('readiness is accepted only from TradingView and only for this frame', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const events = [];
    const { view, frame, posted } = mount(t, { symbol: 'AAPL' }, {
        onReady: () => events.push('ready'), onError: error => events.push(error.message),
    });
    const id = hashOf(frame.src).frameElementId;
    // The frame announces itself before its load event and is asked at once.
    postMessageEvent(view, 'https://example.com', { name: 'tv-widget-load', frameElementId: id });
    postMessageEvent(view, TRADINGVIEW_ORIGIN, { name: 'tv-widget-load', frameElementId: 'tradingview_fffff' });
    assert.deepEqual(posted, []);
    postMessageEvent(view, TRADINGVIEW_ORIGIN, { name: 'tv-widget-load', frameElementId: id });
    assert.deepEqual(posted, [{
        targetOrigin: TRADINGVIEW_ORIGIN,
        data: { id: 0, type: 'get', name: 'widgetReady', client_id: id, data: {}, provider: 'TradingView' },
    }]);
    for (const [origin, data] of [
        ['https://www.tradingview.com', readyReply(id)],
        ['null', readyReply(id)],
        [TRADINGVIEW_ORIGIN, readyReply('tradingview_fffff')],
        [TRADINGVIEW_ORIGIN, readyReply(id, { provider: 'Other' })],
        [TRADINGVIEW_ORIGIN, readyReply(id, { type: 'post' })],
        [TRADINGVIEW_ORIGIN, '{"provider":'],
    ]) postMessageEvent(view, origin, data);
    assert.deepEqual(events, []);
    assert.equal(frame.style.opacity, '0');
    postMessageEvent(view, TRADINGVIEW_ORIGIN, readyReply(id));
    postMessageEvent(view, TRADINGVIEW_ORIGIN, readyReply(id));
    t.mock.timers.tick(60_000);
    assert.deepEqual(events, ['ready']);
    assert.equal(frame.style.opacity, '');
});

test('the frame stays out of the focus order until TradingView answers', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { view, frame } = mount(t, { symbol: 'AAPL' });
    // Tab must not stop on, and assistive technology must not read, a frame nobody can see.
    assert.equal(frame.style.opacity, '0');
    assert.equal(frame.inert, true);
    postMessageEvent(view, TRADINGVIEW_ORIGIN, readyReply(hashOf(frame.src).frameElementId));
    assert.equal(frame.style.opacity, '');
    assert.equal(frame.inert, false);
});

test('the frame is also asked on its load event, as tv.js does', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { view, frame, posted } = mount(t, { symbol: 'AAPL' });
    frame.dispatchEvent(new view.Event('load'));
    assert.equal(posted.length, 1);
    assert.equal(posted[0].targetOrigin, TRADINGVIEW_ORIGIN);
    assert.equal(posted[0].data.client_id, hashOf(frame.src).frameElementId);
});

test('a frame that never answers reports an error, and a late answer clears it', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const events = [];
    const { view, frame } = mount(t, { symbol: 'AAPL' }, {
        onReady: () => events.push('ready'), onError: error => events.push(error.message),
    });
    // An offline error page still fires load.
    frame.dispatchEvent(new view.Event('load'));
    t.mock.timers.tick(19_999);
    assert.deepEqual(events, []);
    t.mock.timers.tick(1);
    assert.equal(events.length, 1);
    assert.match(events[0], /did not load.*retry/i);
    // A failed frame stays transparent over the container's placeholder, and out of the focus order.
    assert.equal(frame.style.opacity, '0');
    assert.equal(frame.inert, true);
    postMessageEvent(view, TRADINGVIEW_ORIGIN, readyReply(hashOf(frame.src).frameElementId));
    assert.equal(events.at(-1), 'ready');
    assert.equal(frame.style.opacity, '');
    assert.equal(frame.inert, false);
});

test('symbols TradingView would read as a spread report the chart as unavailable', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const symbol of ['ABC-WS', 'BRK-B-X', 'A+B', 'A/B', '', undefined]) {
        const errors = [];
        const { container } = mount(t, { symbol }, { onError: error => errors.push(error.message) });
        assert.equal(container.querySelector('iframe'), null);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /^TradingView has no chart for /);
    }
});

test('canceling a delayed AAPL mount cannot draw into the active MSFT chart', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { container } = environment();
    const errors = [];
    const disposeOld = mountTradingViewWidget(container, { symbol: 'AAPL' }, { onError: error => errors.push(`AAPL:${error.message}`) });
    disposeOld();
    const disposeCurrent = mountTradingViewWidget(container, { symbol: 'MSFT' }, { onError: error => errors.push(`MSFT:${error.message}`) });
    t.mock.timers.tick(0);
    assert.equal(container.querySelectorAll('iframe').length, 1);
    assert.equal(hashOf(container.querySelector('iframe').src).symbol, 'MSFT');
    t.mock.timers.tick(20_000);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^MSFT:/);
    disposeCurrent();
    assert.equal(container.children.length, 0);
});

test('a disposed chart is removed and its later answers are ignored', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const events = [];
    const { view, frame, container, dispose } = mount(t, { symbol: 'AAPL' }, {
        onReady: () => events.push('ready'), onError: () => events.push('error'),
    });
    dispose();
    assert.equal(container.children.length, 0);
    postMessageEvent(view, TRADINGVIEW_ORIGIN, readyReply(hashOf(frame.src).frameElementId));
    t.mock.timers.tick(60_000);
    assert.deepEqual(events, []);
});

test('the chart takes its palette from the cascade of the page that mounts it', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { document, view, container } = environment();
    const tokens = {
        '--bg-card': 'rgb(23, 29, 36)', '--line': 'rgb(42, 51, 61)', '--text-muted': 'rgb(150, 161, 173)',
        '--secondary': 'rgb(166, 182, 204)', '--success': 'rgb(72, 240, 84)', '--danger': 'rgba(255, 0, 64, 0.5)',
    };
    const pixels = {
        'rgb(23, 29, 36)': [23, 29, 36, 255], 'rgb(42, 51, 61)': [42, 51, 61, 255], 'rgb(150, 161, 173)': [150, 161, 173, 255],
        'rgb(166, 182, 204)': [166, 182, 204, 255], 'rgb(72, 240, 84)': [72, 240, 84, 255], 'rgba(255, 0, 64, 0.5)': [255, 0, 64, 128],
    };
    // The browser resolves var() and paints the colour; this stands in for both.
    view.getComputedStyle = element => ({ color: tokens[element.style.color.slice(4, -1)] });
    const createElement = document.createElement.bind(document);
    document.createElement = name => name !== 'canvas' ? createElement(name) : {
        getContext: () => {
            let fill = 'rgba(0, 0, 0, 0)';
            return {
                get fillStyle() { return fill; },
                set fillStyle(value) { fill = value === 'transparent' ? 'rgba(0, 0, 0, 0)' : value; },
                clearRect() {}, fillRect() {}, getImageData: () => ({ data: pixels[fill] }),
            };
        },
    };
    mountTradingViewWidget(container, { symbol: 'AAPL', theme: 'theme-majestic' });
    t.mock.timers.tick(0);
    assert.equal(container.children.length, 1);
    const frame = container.querySelector('iframe');
    const hash = hashOf(frame.src);
    assert.equal(hash.backgroundColor, '#171d24');
    assert.equal(hash.gridColor, '#2a333d');
    const overrides = JSON.parse(new URL(frame.src).searchParams.get('overrides'));
    assert.equal(overrides['paneProperties.background'], '#171d24');
    assert.equal(overrides['scalesProperties.textColor'], '#96a1ad');
    assert.equal(overrides['mainSeriesProperties.lineStyle.color'], '#a6b6cc');
    assert.equal(overrides['mainSeriesProperties.candleStyle.upColor'], '#48f054');
    assert.equal(overrides['mainSeriesProperties.candleStyle.downColor'], 'rgba(255, 0, 64, 0.50)');
});

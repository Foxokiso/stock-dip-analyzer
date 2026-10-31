const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const { STATUS_CODES } = require('http');
const isDev = !app.isPackaged;

// The renderer may only ask the main process for these providers, over HTTPS
// on the default port. Anything else (local network, plain HTTP, other sites)
// is refused before a request is even shared, and every redirect hop is held
// to the same rule, so a compromised page cannot turn 'fetch-url' into a proxy
// that carries the app's browser headers and cookies.
const FETCH_HOSTS = new Map([['finviz.com', 'Finviz'], ['www.finviz.com', 'Finviz'], ['news.google.com', 'Google News']]);
function allowedFetchUrl(url) {
    let parsed;
    try { parsed = new URL(String(url)); } catch { return null; }
    // host includes a non-default port, so https://finviz.com:8443/ is refused.
    if (parsed.protocol !== 'https:' || !FETCH_HOSTS.has(parsed.host)) return null;
    return parsed.href;
}

// Per-host cookie jar, in memory only. Cookies are filed under the host that
// set them (each redirect hop under its own) and merged by name, so a Google
// News response can never clobber the Finviz session, and no cookie is ever
// replayed cross-origin. Max-Age<=0 or an Expires in the past deletes one.
const cookieJar = new Map(); // hostname -> Map(name -> value)
const hostOf = (url) => {
    try { return new URL(url).hostname; } catch { return null; }
};
function storeCookies(host, response) {
    const setCookies = response.headers?.getSetCookie?.() || [];
    if (!host || setCookies.length === 0) return;
    const cookies = cookieJar.get(host) || new Map();
    for (const line of setCookies) {
        const [pair, ...rest] = line.split(';');
        const split = pair.indexOf('=');
        const name = split > 0 ? pair.slice(0, split).trim() : '';
        if (!name) continue;
        const attributes = new Map(rest.map(item => {
            const [key, ...value] = item.split('=');
            return [key.trim().toLowerCase(), value.join('=').trim()];
        }));
        // Max-Age wins over Expires; an unparsable value counts as absent.
        const maxAge = Number.parseInt(attributes.get('max-age'), 10);
        const expired = Number.isNaN(maxAge) ? Date.parse(attributes.get('expires')) <= Date.now() : maxAge <= 0;
        if (expired) cookies.delete(name);
        else cookies.set(name, pair.slice(split + 1).trim());
    }
    if (cookies.size > 0) cookieJar.set(host, cookies);
    else cookieJar.delete(host);
}
const cookieHeader = (host) => [...(cookieJar.get(host) || [])].map(([name, value]) => `${name}=${value}`).join('; ');

// Electron hands the renderer nothing but an error's message, so messages say
// who answered and how. Failures a retry would only repeat (a refused
// redirect, a redirect loop, an oversized body, a page that is not chart
// data) are marked permanent.
const permanent = (message) => Object.assign(new Error(message), { permanent: true });
const refusedRedirect = (next) => permanent(`Refused redirect to ${next ? `${next.protocol}//${next.host}` : 'an invalid address'}.`);
function httpError(provider, response, detail) {
    const reason = response.statusText || STATUS_CODES[response.status];
    const error = new Error(`${provider} returned HTTP ${response.status}${reason ? ` ${reason}` : ''}${detail ? `: ${detail}` : ''}`);
    error.status = response.status;
    return error;
}
// Node's fetch reports network failures (DNS, refused or reset connections,
// TLS) as "fetch failed", or "terminated" mid-body, with the reason in err.cause.
const networkError = (provider, err) => (err.cause && !err.status
    ? Object.assign(new Error(`Could not reach ${provider} (${err.cause.code || err.cause.message})`), { network: true })
    : err);

// Redirects are followed here rather than by fetch, so each hop passes the
// same allowlist as the request itself and its cookies land under its host.
const MAX_REDIRECTS = 5;
async function fetchProvider(url, { signal, headers }) {
    let current = url;
    for (let redirects = 0; ; redirects++) {
        const host = hostOf(current);
        const cookies = cookieHeader(host);
        const response = await fetch(current, {
            signal,
            cache: 'no-store',
            headers: cookies ? { ...headers, Cookie: cookies } : headers,
            redirect: 'manual',
        });
        storeCookies(host, response);
        const location = response.status >= 300 && response.status < 400 ? response.headers?.get?.('location') : null;
        if (!location) return response;
        void response.body?.cancel().catch(() => {});
        if (redirects === MAX_REDIRECTS) throw permanent(`${FETCH_HOSTS.get(hostOf(url))} redirected more than ${MAX_REDIRECTS} times.`);
        let next = null;
        try { next = new URL(location, current); } catch { /* refused below */ }
        if (!next || !allowedFetchUrl(next.href)) throw refusedRedirect(next);
        current = next.href;
    }
}

// Bodies are read as a stream and dropped past the cap, so a misbehaving
// provider cannot make the main process buffer an unbounded response.
const MAX_BODY_BYTES = 15 * 1024 * 1024;
async function readText(response, provider, limit = MAX_BODY_BYTES) {
    const tooLarge = () => permanent(`The response from ${provider} is larger than ${limit / 1024 / 1024} MB.`);
    if (Number(response.headers?.get?.('content-length')) > limit) {
        void response.body?.cancel().catch(() => {});
        throw tooLarge();
    }
    if (!response.body?.getReader) return response.text();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let size = 0;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        size += chunk.value.byteLength;
        if (size > limit) {
            void reader.cancel().catch(() => {});
            throw tooLarge();
        }
        text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
}

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
};

// One deadline per request (retries, session seeding, backoff and body included).
// Settings → Data → request timeout updates it through 'configure-network'.
let requestTimeoutMs = 12000;
ipcMain.handle('configure-network', (event, options = {}) => {
    const seconds = Number(options?.requestTimeoutSeconds);
    if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 600) requestTimeoutMs = Math.round(seconds * 1000);
    return { requestTimeoutMs };
});

// Runs a request under that deadline. Running out reads as a timeout, however
// deep inside the request (a retry pause, a body read) the abort landed.
async function withDeadline(request) {
    const timeoutMs = requestTimeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
        return await request(signal);
    } catch (err) {
        if (!signal.aborted) throw err;
        throw Object.assign(new Error(`Request timed out after ${timeoutMs / 1000} s`), { name: 'TimeoutError' });
    }
}

// Share only work that is still in progress. Once a response (including its
// body) settles, the next refresh always goes back to the provider.
const pendingRequests = new Map();
function shareRequest(key, request) {
    if (pendingRequests.has(key)) return pendingRequests.get(key);
    const pending = Promise.resolve().then(request);
    pendingRequests.set(key, pending);
    const forget = () => pendingRequests.delete(key);
    pending.then(forget, forget);
    return pending;
}

function retryDelay(ms, signal) {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
        }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
}

ipcMain.handle('fetch-url', (event, requested) => {
    const url = allowedFetchUrl(requested);
    if (!url) {
        const error = new Error(`Refused request: only HTTPS requests to ${[...FETCH_HOSTS.keys()].join(', ')} are allowed.`);
        error.status = 400;
        return Promise.reject(error);
    }
    // A single deadline covers retries, session seeding, backoff and body
    // consumption. A failing source must not hold up the interface for 40s+.
    return shareRequest(`url:${url}`, () => withDeadline(async (signal) => {
    const maxRetries = 2;
    const host = hostOf(url);
    const provider = FETCH_HOSTS.get(host);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            signal.throwIfAborted();
            const headers = { ...BROWSER_HEADERS };
            if (host === 'finviz.com' && attempt > 0) {
                headers['Referer'] = 'https://finviz.com/screener/stocks';
            }

            const response = await fetchProvider(url, { signal, headers });

            if (!response.ok) {
                // Discard error bodies so retries don't retain unused streams.
                void response.body?.cancel().catch(() => {});
                throw httpError(provider, response);
            }
            return await readText(response, provider);
        } catch (failure) {
            if (signal.aborted) throw signal.reason;
            const err = networkError(provider, failure);
            const retryable = !err.permanent && (!err.status || err.status === 403 || err.status === 408 || err.status >= 500);
            if (attempt === maxRetries || !retryable) {
                console.error('Fetch error:', err);
                throw err;
            }
            await retryDelay(err.status === 403 ? 1500 + Math.random() * 1000 : 1000, signal);
            // On a Finviz challenge, establish a session before trying again.
            if (err.status === 403 && host === 'finviz.com' && !cookieJar.has(host)) {
                try {
                    const seedResp = await fetchProvider('https://finviz.com/', { signal, headers: BROWSER_HEADERS });
                    void seedResp.body?.cancel().catch(() => {});
                } catch {
                    signal.throwIfAborted(); // Other seed failures are best effort.
                }
            }
        }
    }
    }));
});

// fetch-yahoo-chart builds its own URL, so it checks its inputs first: a ticker
// spelled the way Yahoo spells it (AAPL, BRK-B, ^VIX, CL=F, EURUSD=X, BTC-USD,
// 7203.T) and the ranges and intervals Yahoo lists as valid. range/interval are
// optional so existing fetch-yahoo-chart(symbol) callers keep working.
const YAHOO_SYMBOL = /^\^?[A-Za-z0-9][A-Za-z0-9.=-]{0,19}$/;
const YAHOO_RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const YAHOO_INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '4h', '1d', '5d', '1wk', '1mo', '3mo']);

// Yahoo explains a refusal in its JSON body ({ chart: { error: { description } } },
// e.g. "No data found, symbol may be delisted"); at most 64 KB of it is read.
async function yahooRefusal(response) {
    try {
        const description = JSON.parse(await readText(response, 'Yahoo Finance', 64 * 1024))?.chart?.error?.description;
        return typeof description === 'string' ? description.trim().slice(0, 200) : '';
    } catch {
        return '';
    }
}

ipcMain.handle('fetch-yahoo-chart', (event, symbol, range = '1mo', interval = '1d') => {
    const refuse = (what, value) => Promise.reject(new Error(`Refused chart request: ${JSON.stringify(String(value).slice(0, 24))} is not a valid ${what}.`));
    if (typeof symbol !== 'string' || !YAHOO_SYMBOL.test(symbol)) return refuse('ticker symbol', symbol);
    if (!YAHOO_RANGES.has(range)) return refuse('chart range', range);
    if (!YAHOO_INTERVALS.has(interval)) return refuse('chart interval', interval);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
    return shareRequest(`yahoo:${url}`, () => withDeadline(async (signal) => {
        const maxRetries = 2;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                signal.throwIfAborted();
                const response = await fetch(url, {
                    signal,
                    cache: 'no-store',
                    headers: {
                        ...BROWSER_HEADERS,
                        'Referer': 'https://finance.yahoo.com/',
                    },
                    // Yahoo answers the chart URL itself. A redirect (a consent
                    // page, another host) is refused, never followed, like an
                    // off-list hop on fetch-url.
                    redirect: 'manual',
                });
                const location = response.status >= 300 && response.status < 400 ? response.headers?.get?.('location') : null;
                if (location) {
                    void response.body?.cancel().catch(() => {});
                    let next = null;
                    try { next = new URL(location, url); } catch { /* refused below */ }
                    throw refusedRedirect(next);
                }
                if (!response.ok) throw httpError('Yahoo Finance', response, await yahooRefusal(response));
                const body = await readText(response, 'Yahoo Finance');
                try {
                    return JSON.parse(body);
                } catch {
                    // A consent or captcha page answers 200 with HTML.
                    throw permanent('Yahoo Finance did not return chart data.');
                }
            } catch (failure) {
                if (signal.aborted) throw failure;
                const err = networkError('Yahoo Finance', failure);
                // Only server errors and network failures are worth another
                // try; a 4xx answer (unknown symbol, rate limit), a page that
                // is not chart data or an oversized body would only repeat.
                if (attempt === maxRetries || !(err.status >= 500 || err.network)) {
                    console.error('Yahoo Fetch error:', err);
                    throw err;
                }
                await retryDelay(1000, signal);
            }
        }
    }));
});

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        title: 'Dip Analyzer PRO',
        // Pierce/27 ink (--ink in src/styles/tokens.css) so the window never
        // flashes white before the renderer paints its own background.
        backgroundColor: '#0b0a10',
        webPreferences: {
            // The renderer is sandboxed and isolated; preload.cjs exposes the
            // three provider channels and nothing else. It runs only the app's
            // own scripts but embeds third-party pages (TradingView's chart in
            // a sandboxed iframe, the research sites in webviews), so it must
            // never hold Node or Electron APIs.
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webviewTag: true  // Required for internal embedded site viewers
        }
    });

    if (isDev) {
        mainWindow.loadURL(DEV_URL);
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

const DEV_URL = 'http://127.0.0.1:5174';
// The app window may only show the app itself; its webviews may only show HTTPS sites.
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const isAppUrl = (url) => {
    try {
        const parsed = new URL(url);
        if (isDev && parsed.origin === DEV_URL) return true;
        // A file URL with a host names another machine (a UNC share on Windows),
        // never the app, even when its path matches.
        if (parsed.protocol !== 'file:' || parsed.host !== '') return false;
        const filePath = path.normalize(decodeURIComponent(parsed.pathname.replace(/^\/([A-Za-z]:)/, '$1')));
        return samePath(filePath, path.normalize(path.join(__dirname, 'dist', 'index.html')));
    } catch { return false; }
};
const isHttps = (url) => { try { return new URL(url).protocol === 'https:'; } catch { return false; } };

// The research sites behind RESOURCE_TABS in src/pages/StockDetails.jsx; keep
// the two lists in step. An embedded viewer may only start on one of them.
const RESEARCH_HOSTS = new Set(['finviz.com', 'www.chartmill.com', 'stockcharts.com', 'digital.fidelity.com', 'finance.yahoo.com']);
const isResearchUrl = (url) => {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && RESEARCH_HOSTS.has(parsed.host);
    } catch { return false; }
};

// Electron does not tell the window-open handler whether a user gesture caused
// the request, and ad scripts in the research sites may call window.open at
// any time. So a guest may launch the browser only within a second of the
// user clicking, typing or tapping in that guest, once per gesture.
const GESTURE_INPUTS = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'gestureTap']);
const GESTURE_WINDOW_MS = 1000;

// The research viewers share one in-memory session of their own, so cookies
// those sites set (a Fidelity login included) never reach the app's profile on
// disk and are gone when the app quits. Downloads keep Electron's save dialog,
// so the user confirms every file a research site offers.
const RESEARCH_PARTITION = 'research';

// Use Electron's default accelerated rendering for chart and interface compositing.

app.on('web-contents-created', (event, contents) => {
    const isGuest = contents.getType() === 'webview';
    let gestureAt = -Infinity;
    if (isGuest) {
        contents.on('input-event', (_event, input) => {
            if (GESTURE_INPUTS.has(input.type)) gestureAt = Date.now();
        });
    }

    // Window-open policy: no chromeless in-app popups. The app's own links
    // (news, StockFetcher, ETF Database) open in the system browser, http(s)
    // only. A guest's target=_blank links do too, over HTTPS and only right
    // after a gesture in that guest; anything else is dropped silently.
    contents.setWindowOpenHandler(({ url }) => {
        if (isGuest) {
            const fromGesture = Date.now() - gestureAt <= GESTURE_WINDOW_MS;
            gestureAt = -Infinity;
            if (fromGesture && isHttps(url)) shell.openExternal(url).catch(() => {});
        } else if (/^https?:\/\//i.test(url)) {
            shell.openExternal(url).catch(() => {});
        }
        return { action: 'deny' };
    });

    // Navigation lock: the app window never leaves the app; embedded site
    // viewers stay on HTTPS. Server redirects never raise will-navigate, so
    // they get the same check. Subframe redirects (the TradingView chart, a
    // guest's own frames) are left to the CSP and mixed-content blocking.
    const lockNavigation = (navigation) => {
        if (navigation.isMainFrame === false) return;
        const allowed = isGuest ? isHttps(navigation.url) : isAppUrl(navigation.url);
        if (!allowed) navigation.preventDefault();
    };
    contents.on('will-navigate', lockNavigation);
    contents.on('will-redirect', lockNavigation);

    // Every <webview> is created without Node, isolated and sandboxed, with no
    // preload of its own, and may only start on one of the research sites.
    // Its media needs a click or key press there before it plays with sound:
    // Electron's default autoplay policy lets an ad play sound unprompted.
    contents.on('will-attach-webview', (attach, webPreferences, params) => {
        delete webPreferences.preload;
        delete webPreferences.preloadURL;
        webPreferences.nodeIntegration = false;
        webPreferences.nodeIntegrationInSubFrames = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.webSecurity = true;
        webPreferences.allowRunningInsecureContent = false;
        webPreferences.autoplayPolicy = 'user-gesture-required';
        // Whatever partition the page asked for, guests get the research session.
        webPreferences.partition = RESEARCH_PARTITION;
        if (!isResearchUrl(params.src)) attach.preventDefault();
    });
});

// The one permission granted anywhere: the app's own page may write sanitized
// text to the clipboard (Settings → Backup → Copy). Its subframes (the
// TradingView chart) and every guest stay denied.
const isAppClipboardWrite = (contents, permission, details) => permission === 'clipboard-sanitized-write'
    && mainWindow != null && contents === mainWindow.webContents
    && details?.isMainFrame === true && isAppUrl(details.requestingUrl);

app.whenReady().then(() => {
    // No page in this app, including embedded third-party sites, gets camera,
    // microphone, location, notifications or any other permission beyond the
    // clipboard write above. Handlers belong to a session, so the research
    // viewers' session gets them too.
    for (const ses of [session.defaultSession, session.fromPartition(RESEARCH_PARTITION)]) {
        ses.setPermissionRequestHandler((contents, permission, callback, details) => callback(isAppClipboardWrite(contents, permission, details)));
        ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => isAppClipboardWrite(contents, permission, details));
    }
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

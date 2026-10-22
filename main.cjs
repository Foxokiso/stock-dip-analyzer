const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const isDev = !app.isPackaged;

// The renderer may only ask the main process for these providers, over HTTPS.
// Anything else (local network, plain HTTP, other sites) is refused before a
// request is even shared, so a compromised page cannot turn 'fetch-url' into
// a proxy that carries the app's browser headers and cookies.
const FETCH_HOSTS = new Set(['finviz.com', 'www.finviz.com', 'news.google.com']);
function allowedFetchUrl(url) {
    let parsed;
    try { parsed = new URL(String(url)); } catch { return null; }
    if (parsed.protocol !== 'https:' || !FETCH_HOSTS.has(parsed.hostname)) return null;
    return parsed.href;
}

// Per-host cookie jar. Cookies are only attached to (and captured from) the
// host that set them, so a Google News response can never clobber the Finviz
// session, and no cookie is ever replayed cross-origin.
const cookieJar = new Map(); // hostname -> "k=v; k2=v2"
const hostOf = (url) => {
    try { return new URL(url).hostname; } catch { return null; }
};

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
        const error = new Error(`Refused request: only HTTPS requests to ${[...FETCH_HOSTS].join(', ')} are allowed.`);
        error.status = 400;
        return Promise.reject(error);
    }
    return shareRequest(`url:${url}`, async () => {
    const maxRetries = 2;
    const host = hostOf(url);
    // A single deadline covers retries, session seeding, backoff and body
    // consumption. A failing source must not hold up the interface for 40s+.
    const signal = AbortSignal.timeout(requestTimeoutMs);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            signal.throwIfAborted();
            const headers = { ...BROWSER_HEADERS };
            const hostCookies = host ? cookieJar.get(host) : null;
            if (hostCookies) {
                headers['Cookie'] = hostCookies;
            }
            if (host === 'finviz.com' && attempt > 0) {
                headers['Referer'] = 'https://finviz.com/screener.ashx';
            }

            const response = await fetch(url, {
                signal,
                cache: 'no-store',
                headers,
                redirect: 'follow',
            });

            // Capture set-cookie headers for this host's session persistence
            const setCookies = response.headers.getSetCookie?.() || [];
            if (setCookies.length > 0 && host) {
                cookieJar.set(host, setCookies.map(c => c.split(';')[0]).join('; '));
            }

            if (!response.ok) {
                // Discard error bodies so retries don't retain unused streams.
                void response.body?.cancel().catch(() => {});
                const error = new Error(`HTTP error! status: ${response.status}`);
                error.status = response.status;
                throw error;
            }
            return await response.text();
        } catch (err) {
            if (signal.aborted) throw signal.reason;
            const retryable = !err.status || err.status === 403 || err.status === 408 || err.status >= 500;
            if (attempt === maxRetries || !retryable) {
                console.error('Fetch error:', err);
                throw err;
            }
            await retryDelay(err.status === 403 ? 1500 + Math.random() * 1000 : 1000, signal);
            // On a Finviz challenge, establish a session before trying again.
            if (err.status === 403 && host === 'finviz.com' && !cookieJar.get(host)) {
                try {
                    const seedResp = await fetch('https://finviz.com/', {
                        signal, cache: 'no-store', headers: BROWSER_HEADERS, redirect: 'follow',
                    });
                    const seedCookies = seedResp.headers.getSetCookie?.() || [];
                    if (seedCookies.length > 0) {
                        cookieJar.set(host, seedCookies.map(c => c.split(';')[0]).join('; '));
                    }
                    void seedResp.body?.cancel().catch(() => {});
                } catch (_) {
                    signal.throwIfAborted(); // Other seed failures are best effort.
                }
            }
        }
    }
    });
});

// range/interval are optional so existing fetch-yahoo-chart(symbol) callers keep working.
// Valid ranges: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, max. Intervals: 1m..1d, 1wk, 1mo.
ipcMain.handle('fetch-yahoo-chart', (event, symbol, range = '1mo', interval = '1d') => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
    return shareRequest(`yahoo:${url}`, async () => {
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(requestTimeoutMs),
                cache: 'no-store',
                headers: {
                    ...BROWSER_HEADERS,
                    'Referer': 'https://finance.yahoo.com/',
                }
            });
            if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return await response.json();
        } catch (err) {
            console.error('Yahoo Fetch error:', err);
            throw err;
        }
    });
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
            // three provider channels and nothing else. It loads a remote
            // charting script and embeds third-party sites, so it must never
            // hold Node or Electron APIs.
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
        if (parsed.protocol !== 'file:') return false;
        const filePath = path.normalize(decodeURIComponent(parsed.pathname.replace(/^\/([A-Za-z]:)/, '$1')));
        return samePath(filePath, path.normalize(path.join(__dirname, 'dist', 'index.html')));
    } catch { return false; }
};
const isHttps = (url) => { try { return new URL(url).protocol === 'https:'; } catch { return false; } };

// Use Electron's default accelerated rendering for chart and interface compositing.

app.on('web-contents-created', (event, contents) => {
    // Window-open policy: no chromeless in-app popups. Any window.open /
    // target=_blank from the app or its webviews (news links, resource tabs)
    // opens in the system browser instead — and only for http(s) URLs.
    contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    // Navigation lock: the app window never leaves the app; embedded site
    // viewers stay on HTTPS.
    contents.on('will-navigate', (navigation, url) => {
        const allowed = contents.getType() === 'webview' ? isHttps(url) : isAppUrl(url);
        if (!allowed) navigation.preventDefault();
    });

    // Every <webview> is created without Node, isolated and sandboxed, with no
    // preload of its own, and may only start on an HTTPS page.
    contents.on('will-attach-webview', (attach, webPreferences, params) => {
        delete webPreferences.preload;
        delete webPreferences.preloadURL;
        webPreferences.nodeIntegration = false;
        webPreferences.nodeIntegrationInSubFrames = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.webSecurity = true;
        webPreferences.allowRunningInsecureContent = false;
        if (!isHttps(params.src)) attach.preventDefault();
    });
});

app.whenReady().then(() => {
    // No page in this app, including embedded third-party sites, gets camera,
    // microphone, location, notifications or any other permission.
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
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

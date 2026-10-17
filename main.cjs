const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const isDev = !app.isPackaged;

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

ipcMain.handle('fetch-url', (event, url) => shareRequest(`url:${url}`, async () => {
    const maxRetries = 2;
    const host = hostOf(url);
    // A single deadline covers retries, session seeding, backoff and body
    // consumption. A failing source must not hold up the interface for 40s+.
    const signal = AbortSignal.timeout(12000);
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
}));

// range/interval are optional so existing fetch-yahoo-chart(symbol) callers keep working.
// Valid ranges: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, max. Intervals: 1m..1d, 1wk, 1mo.
ipcMain.handle('fetch-yahoo-chart', (event, symbol, range = '1mo', interval = '1d') => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
    return shareRequest(`yahoo:${url}`, async () => {
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(12000),
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
            nodeIntegration: true,
            contextIsolation: false,
            webviewTag: true  // Required for internal embedded site viewers
        }
    });

    if (isDev) {
        mainWindow.loadURL('http://127.0.0.1:5174');
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Use Electron's default accelerated rendering for chart and interface compositing.

// Window-open policy: no chromeless in-app popups. Any window.open /
// target=_blank from the app or its webviews (news links, resource tabs)
// opens in the system browser instead — and only for http(s) URLs.
app.on('web-contents-created', (event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });
});

app.whenReady().then(() => {
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

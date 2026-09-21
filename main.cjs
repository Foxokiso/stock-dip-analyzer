const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const isDev = !app.isPackaged;

// Network requests that hang would otherwise stall a whole hydration chunk.
const FETCH_TIMEOUT_MS = 15000;

// Performance settings persisted in userData (read synchronously at startup
// because hardware acceleration must be decided before the app is ready).
const perfSettingsPath = () => path.join(app.getPath('userData'), 'perf-settings.json');
const readPerfSettings = () => {
    try { return JSON.parse(fs.readFileSync(perfSettingsPath(), 'utf8')); } catch { return {}; }
};
const perfSettings = readPerfSettings();

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

ipcMain.handle('fetch-url', async (event, url) => {
    const maxRetries = 2;
    const host = hostOf(url);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const headers = { ...BROWSER_HEADERS };
            const hostCookies = host ? cookieJar.get(host) : null;
            if (hostCookies) {
                headers['Cookie'] = hostCookies;
            }
            if (url.includes('finviz.com') && attempt > 0) {
                headers['Referer'] = 'https://finviz.com/screener.ashx';
            }

            const response = await fetch(url, {
                cache: 'no-store',
                headers,
                redirect: 'follow',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });

            // Capture set-cookie headers for this host's session persistence
            const setCookies = response.headers.getSetCookie?.() || [];
            if (setCookies.length > 0 && host) {
                cookieJar.set(host, setCookies.map(c => c.split(';')[0]).join('; '));
            }

            if (response.status === 403 && attempt < maxRetries) {
                console.warn(`Fetch attempt ${attempt + 1} got 403, retrying after delay...`);
                await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
                // On retry, first hit the homepage to establish a session
                if (host === 'finviz.com' && !cookieJar.get(host)) {
                    try {
                        const seedResp = await fetch('https://finviz.com/', { headers: BROWSER_HEADERS, redirect: 'follow' });
                        const seedCookies = seedResp.headers.getSetCookie?.() || [];
                        if (seedCookies.length > 0) {
                            cookieJar.set(host, seedCookies.map(c => c.split(';')[0]).join('; '));
                        }
                    } catch (_) { /* best effort */ }
                }
                continue;
            }

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.text();
        } catch (err) {
            if (attempt === maxRetries) {
                console.error('Fetch error:', err);
                throw err;
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    }
});

// range/interval are optional so existing fetch-yahoo-chart(symbol) callers keep working.
// Valid ranges: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, max. Intervals: 1m..1d, 1wk, 1mo.
// Short-lived chart cache with in-flight de-duplication. Navigating
// Dashboard -> Stock Details, flipping sectors back and forth, or several
// panels asking for the same symbol no longer re-hit Yahoo within the TTL.
const CHART_CACHE_TTL_MS = 45 * 1000;
const CHART_CACHE_MAX = 600;
const chartCache = new Map();    // key -> { at, data }
const chartInFlight = new Map(); // key -> Promise<data>

const fetchYahooChart = async (symbol, range, interval) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
    const response = await fetch(url, {
        cache: 'no-store',
        headers: {
            ...BROWSER_HEADERS,
            'Referer': 'https://finance.yahoo.com/',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
};

ipcMain.handle('fetch-yahoo-chart', async (event, symbol, range = '1mo', interval = '1d') => {
    const key = `${symbol}|${range}|${interval}`;
    const hit = chartCache.get(key);
    if (hit && Date.now() - hit.at < CHART_CACHE_TTL_MS) return hit.data;
    if (chartInFlight.has(key)) return chartInFlight.get(key);

    const pending = fetchYahooChart(symbol, range, interval)
        .then(data => {
            chartCache.set(key, { at: Date.now(), data });
            if (chartCache.size > CHART_CACHE_MAX) {
                chartCache.delete(chartCache.keys().next().value); // evict oldest insert
            }
            return data;
        })
        .catch(err => {
            console.error('Yahoo Fetch error:', err);
            throw err;
        })
        .finally(() => chartInFlight.delete(key));
    chartInFlight.set(key, pending);
    return pending;
});

// ─── Performance settings (hardware acceleration opt-in) ─────────────────────
ipcMain.handle('get-perf-settings', () => ({
    hardwareAcceleration: !!perfSettings.hardwareAcceleration,
}));

ipcMain.handle('set-perf-settings', (event, next) => {
    const merged = { ...readPerfSettings(), ...(next || {}) };
    fs.mkdirSync(path.dirname(perfSettingsPath()), { recursive: true });
    fs.writeFileSync(perfSettingsPath(), JSON.stringify(merged, null, 2));
    return merged;
});

ipcMain.handle('relaunch-app', () => {
    app.relaunch();
    app.exit(0);
});

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
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

// Software rendering is the safe default (it was forced on in an earlier
// release). GPU acceleration is opt-in from Settings -> Performance: with it
// on, the glass-panel backdrop blurs and animations render on the GPU
// instead of the CPU, which is the single biggest smoothness win available.
if (!perfSettings.hardwareAcceleration) {
    app.disableHardwareAcceleration();
}

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

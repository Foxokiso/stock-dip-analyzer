const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const isDev = !app.isPackaged;

// Persistent cookie jar for Finviz session persistence across requests
let finvizCookies = '';

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
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const headers = { ...BROWSER_HEADERS };
            if (finvizCookies) {
                headers['Cookie'] = finvizCookies;
            }
            if (url.includes('finviz.com') && attempt > 0) {
                headers['Referer'] = 'https://finviz.com/screener.ashx';
            }

            const response = await fetch(url, {
                cache: 'no-store',
                headers,
                redirect: 'follow',
            });

            // Capture set-cookie headers for session persistence
            const setCookies = response.headers.getSetCookie?.() || [];
            if (setCookies.length > 0) {
                finvizCookies = setCookies.map(c => c.split(';')[0]).join('; ');
            }

            if (response.status === 403 && attempt < maxRetries) {
                console.warn(`Fetch attempt ${attempt + 1} got 403, retrying after delay...`);
                await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
                // On retry, first hit the homepage to establish a session
                if (!finvizCookies) {
                    try {
                        const seedResp = await fetch('https://finviz.com/', { headers: BROWSER_HEADERS, redirect: 'follow' });
                        const seedCookies = seedResp.headers.getSetCookie?.() || [];
                        if (seedCookies.length > 0) {
                            finvizCookies = seedCookies.map(c => c.split(';')[0]).join('; ');
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

ipcMain.handle('fetch-yahoo-chart', async (event, symbol) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`;
    try {
        const response = await fetch(url, {
            cache: 'no-store',
            headers: {
                ...BROWSER_HEADERS,
                'Referer': 'https://finance.yahoo.com/',
            }
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
    } catch (err) {
        console.error('Yahoo Fetch error:', err);
        throw err;
    }
});

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
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

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// Allow uncapped frame rates if supported, helping reach 120fps on high-refresh monitors
app.commandLine.appendSwitch('disable-frame-rate-limit');

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

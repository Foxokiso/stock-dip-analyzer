import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setImmediate } from 'node:timers';
import { pathToFileURL } from 'node:url';
import { appDir, fakeContents, loadMain, manualClock, navigation } from './helpers/mainProcess.js';

const appIndex = pathToFileURL(path.join(appDir, 'dist', 'index.html')).href;

// The research viewers' start pages, read from RESOURCE_TABS so the host list
// in main.cjs cannot drift from the tabs the stock page actually offers. A tab
// builds its URL inline or names a helper (local, or imported from a module).
const pagesDir = new URL('../src/pages/', import.meta.url);
const stockDetails = readFileSync(new URL('StockDetails.jsx', pagesDir), 'utf8');
const tabsAt = stockDetails.indexOf('const RESOURCE_TABS');
const webviewTabs = stockDetails.slice(tabsAt, stockDetails.indexOf('];', tabsAt)).split('\n').filter(line => line.includes("type: 'webview'"));
const urlTemplate = source => /`(https:[^`]+)`/.exec(source)?.[1];
function helperTemplate(name) {
  const from = new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '([^']+)'`).exec(stockDetails)?.[1];
  const source = from ? readFileSync(new URL(from, pagesDir), 'utf8') : stockDetails;
  const at = source.search(new RegExp(`(?:const|function) ${name}\\b`));
  return at < 0 ? undefined : urlTemplate(source.slice(at));
}
const researchUrls = webviewTabs.map(tab => (urlTemplate(tab) ?? helperTemplate(/url: (\w+)/.exec(tab)?.[1]))?.replace(/\$\{[^}]+\}/g, 'BRK-B'));

// Loads main.cjs and lets the app become ready, which creates the window.
function start(options) {
  const main = loadMain(undefined, manualClock(Date.UTC(2026, 9, 31)), options);
  main.ready();
  assert.equal(main.windows.length, 1, 'the app window is created once the app is ready');
  return { ...main, appContents: main.windows[0].webContents };
}

// A <webview> guest, announced the way Electron announces every webContents.
function attachGuest(main) {
  const contents = fakeContents('webview');
  main.emitApp('web-contents-created', {}, contents);
  return contents;
}

// Asks a webContents to open a URL in a new window; returns the handler's answer.
const windowOpen = (contents, url) => contents.windowOpenHandler({ url, frameName: '', features: '', disposition: 'foreground-tab' }).action;

// Attaches a <webview> to the app window; reports whether it was allowed and
// the webPreferences main.cjs left for the guest.
function attachWebview(appContents, src, webPreferences = {}) {
  const event = navigation(src);
  appContents.emit('will-attach-webview', event, webPreferences, { src });
  return { attached: !event.defaultPrevented, webPreferences };
}

// Emits a navigation event the way Electron 45 does (event first, then the
// deprecated positional URL) and reports whether it was let through.
function navigates(contents, url, eventName = 'will-navigate', details) {
  const event = navigation(url, details);
  contents.emit(eventName, event, url);
  return !event.defaultPrevented;
}

test('the app window is sandboxed, isolated, without Node, and shows the built app', () => {
  const { windows } = start();
  const { webPreferences } = windows[0].options;
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.preload, path.join(appDir, 'preload.cjs'));
  assert.equal(windows[0].loaded, path.join(appDir, 'dist', 'index.html'));
  assert.equal(start({ packaged: false }).windows[0].loaded, 'http://127.0.0.1:5174');
});

test('the window is re-created on activate only when none is open, and the app quits except on macOS', () => {
  const main = start();
  main.emitApp('activate');
  assert.equal(main.windows.length, 1);
  main.windows[0].close();
  main.emitApp('activate');
  assert.equal(main.windows.length, 2);

  main.emitApp('window-all-closed');
  assert.equal(main.electron.app.quitCalls, 1);
  const mac = start({ platform: 'darwin' });
  mac.emitApp('window-all-closed');
  assert.equal(mac.electron.app.quitCalls, undefined);
});

test('the app window opens only http(s) links, in the system browser, and never a window of its own', () => {
  const { appContents, opened } = start();
  const open = url => windowOpen(appContents, url);
  for (const url of ['https://news.example.com/story', 'http://www.stockfetcher.com/']) {
    assert.equal(open(url), 'deny');
  }
  assert.deepEqual(opened, ['https://news.example.com/story', 'http://www.stockfetcher.com/']);
  for (const url of ['file:///C:/Windows/System32/calc.exe', 'smb://attacker.example/share', 'javascript:alert(1)', 'ms-msdt:/id PCWDiagnostic', 'mailto:a@example.com']) {
    assert.equal(open(url), 'deny');
  }
  assert.equal(opened.length, 2, 'other schemes never reach shell.openExternal');
});

test('a refused browser launch from the app window is ignored rather than left unhandled', async () => {
  const main = start();
  main.electron.shell.openExternal = async () => { throw new Error('No application is registered for this link'); };
  const unhandled = [];
  const record = reason => unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    assert.equal(windowOpen(main.appContents, 'https://news.example.com/story'), 'deny');
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', record);
  }
  assert.deepEqual(unhandled, []);
});

test('a guest opens HTTPS links in the browser only right after a click, key press or tap in it, once per gesture', async () => {
  const main = start();
  const guest = attachGuest(main);
  const other = attachGuest(main);
  const input = (contents, type) => contents.emit('input-event', {}, { type });
  const link = 'https://finance.yahoo.com/news/story.html';

  assert.equal(windowOpen(guest, link), 'deny');
  assert.deepEqual(main.opened, [], 'a scripted popup without any gesture opens nothing');

  input(guest, 'mouseDown');
  await main.clock.advance(150);
  assert.equal(windowOpen(guest, link), 'deny');
  assert.deepEqual(main.opened, [link], 'a click opens the link');
  assert.equal(windowOpen(guest, 'https://ads.example/popup'), 'deny');
  assert.deepEqual(main.opened, [link], 'one gesture allows one launch');

  input(guest, 'keyDown');
  assert.equal(windowOpen(guest, 'http://ads.example/popup'), 'deny');
  assert.equal(windowOpen(guest, 'https://ads.example/popup'), 'deny');
  assert.deepEqual(main.opened, [link], 'plain HTTP is refused and still uses up the gesture');

  input(guest, 'rawKeyDown');
  await main.clock.advance(1001);
  windowOpen(guest, link);
  assert.equal(main.opened.length, 1, 'a gesture older than a second has expired');

  for (const type of ['mouseMove', 'mouseUp', 'mouseWheel', 'mouseEnter', 'gestureScrollBegin', 'keyUp']) input(guest, type);
  windowOpen(guest, link);
  assert.equal(main.opened.length, 1, 'hovering, scrolling and releasing are not gestures');

  input(other, 'mouseDown');
  windowOpen(guest, link);
  assert.equal(main.opened.length, 1, 'a click in another guest does not count');
  windowOpen(other, link);
  assert.equal(main.opened.length, 2);

  input(guest, 'gestureTap');
  windowOpen(guest, link);
  assert.equal(main.opened.length, 3, 'a tap counts like a click');
});

test('the app window may only navigate to the app itself', () => {
  const { appContents } = start();
  assert.ok(navigates(appContents, `${appIndex}#/settings`), 'the app (with a route) is allowed');
  assert.ok(navigates(appContents, appIndex.replace('file://', 'file://localhost')), 'file://localhost is this machine');
  for (const url of [
    'https://evil.example/',
    'http://127.0.0.1:5174/',                                   // the dev server, in a packaged app
    'file:///etc/passwd',
    pathToFileURL(path.join(appDir, 'dist', 'other.html')).href,
    appIndex.replace('file://', 'file://attacker.example'),     // same path on another machine
    'not a url',
  ]) {
    assert.equal(navigates(appContents, url), false, url);
  }

  const dev = start({ packaged: false });
  assert.ok(navigates(dev.appContents, 'http://127.0.0.1:5174/#/futures'));
  assert.equal(navigates(dev.appContents, 'https://evil.example/'), false);
});

test('on Windows the app loads from its install folder, and its page matches regardless of case but never on another host or drive', () => {
  const installDir = 'C:\\Users\\Ana\\AppData\\Local\\Programs\\DDS response\\resources\\app.asar';
  const main = start({ platform: 'win32', dirname: installDir });
  const { appContents } = main;
  assert.equal(main.windows[0].options.webPreferences.preload, `${installDir}\\preload.cjs`);
  assert.equal(main.windows[0].loaded, `${installDir}\\dist\\index.html`);
  const index = 'file:///C:/Users/Ana/AppData/Local/Programs/DDS%20response/resources/app.asar/dist/index.html';
  assert.ok(navigates(appContents, `${index}#/oil`));
  assert.ok(navigates(appContents, index.toLowerCase()));
  assert.equal(navigates(appContents, index.replace('file:///C:', 'file:///D:')), false);
  assert.equal(navigates(appContents, index.replace('file:///', 'file://fileserver.example/')), false);
  let granted;
  main.electron.session.defaultSession.requestHandler(appContents, 'clipboard-sanitized-write', value => { granted = value; }, { isMainFrame: true, requestingUrl: `${index}#/settings` });
  assert.equal(granted, true, 'Settings → Backup → Copy works from the installed app');
});

test('guests may only navigate over HTTPS', () => {
  const main = start();
  const guest = attachGuest(main);
  assert.ok(navigates(guest, 'https://finance.yahoo.com/quote/AAPL/news'));
  for (const url of ['http://finance.yahoo.com/', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.equal(navigates(guest, url), false, url);
  }
});

test('every webview is attached without Node or a preload, isolated, sandboxed and only to an HTTPS page', () => {
  const { appContents } = start();
  const { attached, webPreferences } = attachWebview(appContents, 'https://finviz.com/quote.ashx?t=AAPL&p=d', {
    preload: '/tmp/evil.js', preloadURL: 'file:///tmp/evil.js', nodeIntegration: true, nodeIntegrationInSubFrames: true,
    contextIsolation: false, sandbox: false, webSecurity: false, allowRunningInsecureContent: true,
  });
  assert.ok(attached);
  assert.equal('preload' in webPreferences, false);
  assert.equal('preloadURL' in webPreferences, false);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.nodeIntegrationInSubFrames, false);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.webSecurity, true);
  assert.equal(webPreferences.allowRunningInsecureContent, false);
  for (const src of ['http://finviz.com/quote.ashx?t=AAPL', 'file:///etc/passwd', '']) {
    assert.equal(attachWebview(appContents, src).attached, false, src);
  }
});

test('webviews may only start on the research sites the stock page offers', () => {
  const { appContents } = start();
  assert.ok(researchUrls.length >= 5, 'RESOURCE_TABS lists the research start pages');
  assert.ok(researchUrls.every(Boolean), `every research tab's start page is found: ${webviewTabs.join(' / ')}`);
  for (const url of researchUrls) assert.ok(attachWebview(appContents, url).attached, url);
  for (const src of [
    'https://evil.example/',
    'https://finviz.com.evil.example/quote.ashx',
    'https://finviz.com:8443/quote.ashx?t=AAPL',
    'https://login.fidelity.com/',
    'https://chartmill.com/stock/quote/AAPL',
  ]) {
    assert.equal(attachWebview(appContents, src).attached, false, src);
  }
});

test('research webviews need a user gesture before media plays with sound, whatever autoplay policy the page asked for', () => {
  const { appContents } = start();
  // Electron's default, 'no-user-gesture-required', lets an ad in a research page play sound unprompted.
  for (const autoplayPolicy of [undefined, 'no-user-gesture-required', 'document-user-activation-required']) {
    const { attached, webPreferences } = attachWebview(appContents, researchUrls[0], autoplayPolicy === undefined ? {} : { autoplayPolicy });
    assert.ok(attached);
    assert.equal(webPreferences.autoplayPolicy, 'user-gesture-required', String(autoplayPolicy));
  }
});

test('webviews always run in the in-memory research session, whatever partition the page asked for', () => {
  const { appContents } = start();
  for (const partition of [undefined, 'persist:finviz', 'persist:research', '']) {
    const { webPreferences } = attachWebview(appContents, researchUrls[0], partition === undefined ? {} : { partition });
    assert.equal(webPreferences.partition, 'research', String(partition));
  }
});

test('server redirects are held to the same locks as navigations', () => {
  const main = start();
  const guest = attachGuest(main);
  assert.ok(navigates(guest, 'https://finance.yahoo.com/quote/AAPL', 'will-redirect'));
  assert.equal(navigates(guest, 'http://landing.example/', 'will-redirect'), false, 'HTTPS to HTTP downgrade');
  assert.equal(navigates(main.appContents, 'https://evil.example/', 'will-redirect'), false);
  assert.ok(navigates(main.appContents, `${appIndex}#/`, 'will-redirect'));
  // The TradingView chart is a subframe of the app window; its redirects are
  // not navigations of the app.
  assert.ok(navigates(main.appContents, 'https://s.tradingview.com/widgetembed/', 'will-redirect', { isMainFrame: false }));
});

test('the navigation locks read the URL from the event, not the deprecated positional argument', () => {
  const main = start();
  const guest = attachGuest(main);
  for (const eventName of ['will-navigate', 'will-redirect']) {
    const downgrade = navigation('http://landing.example/');
    guest.emit(eventName, downgrade, 'https://finance.yahoo.com/');
    assert.equal(downgrade.defaultPrevented, true, eventName);
    const secure = navigation('https://finance.yahoo.com/');
    guest.emit(eventName, secure, 'http://landing.example/');
    assert.equal(secure.defaultPrevented, false, eventName);
  }
});

test('the research session gets the same deny-all permission handlers as the default session', () => {
  const main = start();
  const research = main.partitions.get('research');
  assert.ok(research, 'the research session is configured once the app is ready');
  assert.deepEqual([...main.partitions.keys()], ['research'], 'and it is in memory, never a persist: partition');
  const guest = attachGuest(main);
  const details = { isMainFrame: true, requestingUrl: 'https://finance.yahoo.com/quote/AAPL' };
  for (const permission of ['geolocation', 'media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']) {
    let granted;
    research.requestHandler(guest, permission, value => { granted = value; }, details);
    assert.equal(granted, false, permission);
    assert.equal(research.checkHandler(guest, permission, 'https://finance.yahoo.com', details), false, permission);
  }
});

test("the app's own page may write to the clipboard; its subframes, guests and everything else may not", () => {
  const main = start();
  const { requestHandler, checkHandler } = main.electron.session.defaultSession;
  const page = { isMainFrame: true, requestingUrl: `${appIndex}#/settings` };
  const decide = (contents, details, permission = 'clipboard-sanitized-write') => {
    let granted;
    requestHandler(contents, permission, value => { granted = value; }, details);
    const checked = checkHandler(contents, permission, details?.requestingUrl ? new URL(details.requestingUrl).origin : '', details);
    assert.equal(checked, granted, 'the check and request handlers agree');
    return granted;
  };
  assert.equal(decide(main.appContents, page), true, 'Settings → Backup → Copy');
  assert.equal(decide(main.appContents, { isMainFrame: false, requestingUrl: 'https://s.tradingview.com/widgetembed/' }), false, 'the TradingView frame');
  assert.equal(decide(main.appContents, { isMainFrame: false, requestingUrl: `${appIndex}#/settings` }), false, 'a subframe, even one showing the app page');
  assert.equal(decide(main.appContents, { isMainFrame: true, requestingUrl: 'https://evil.example/' }), false, 'not the app page');
  assert.equal(decide(main.appContents, undefined), false, 'no details');
  assert.equal(decide(main.appContents, page, 'clipboard-read'), false, 'reading stays denied');
  assert.equal(decide(attachGuest(main), { isMainFrame: true, requestingUrl: 'https://finance.yahoo.com/' }), false, 'a guest');
  assert.equal(checkHandler(null, 'clipboard-sanitized-write', 'file://', page), false, 'no webContents');
  main.windows[0].close();
  assert.equal(decide(main.appContents, page), false, 'a closed window');

  const dev = start({ packaged: false });
  const devPage = { isMainFrame: true, requestingUrl: 'http://127.0.0.1:5174/#/settings' };
  let granted;
  dev.electron.session.defaultSession.requestHandler(dev.appContents, 'clipboard-sanitized-write', value => { granted = value; }, devPage);
  assert.equal(granted, true, 'the dev server page is the app in development');
});

test('the default session denies every permission other than the app page writing to the clipboard', () => {
  const { electron, appContents } = start();
  const { requestHandler, checkHandler } = electron.session.defaultSession;
  const details = { isMainFrame: true, requestingUrl: `${appIndex}#/settings` };
  for (const permission of ['geolocation', 'media', 'notifications', 'clipboard-read', 'fullscreen', 'openExternal', 'unknown']) {
    let granted;
    requestHandler(appContents, permission, value => { granted = value; }, details);
    assert.equal(granted, false, permission);
    assert.equal(checkHandler(appContents, permission, 'file://', details), false, permission);
  }
});

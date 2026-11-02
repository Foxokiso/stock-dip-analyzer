// Runs main.cjs and preload.cjs in a VM against a fake Electron, so their IPC
// handlers and their window, navigation, webview and permission policies can
// be driven directly. Scripts get their real filename so coverage sees them.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { setImmediate } from 'node:timers';

const mainPath = fileURLToPath(new URL('../../main.cjs', import.meta.url));
const preloadPath = fileURLToPath(new URL('../../preload.cjs', import.meta.url));
const mainSource = readFileSync(mainPath, 'utf8');
const preloadSource = readFileSync(preloadPath, 'utf8');

export const appDir = path.dirname(mainPath);
// Lets every pending promise job run, as the event loop does before its next
// timer: an immediate fires only once the microtask queue is empty. So the
// manual clock fires its next timer only once a request has gone as far as it
// can without one.
export const flush = () => new Promise(resolve => setImmediate(resolve));

export function manualClock(start = 0) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  const setTimer = (fn, delay) => {
    const id = nextId++;
    timers.set(id, { at: now + delay, fn });
    return id;
  };
  return {
    now: () => now,
    setTimeout: setTimer,
    clearTimeout: id => timers.delete(id),
    timeout: ms => {
      const controller = new AbortController();
      setTimer(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), ms);
      return controller.signal;
    },
    async advance(ms) {
      const target = now + ms;
      await flush();
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

// A webContents of the given type ('window' or 'webview') that records its
// window-open handler and lets a test emit the events main.cjs listens to.
export function fakeContents(type) {
  const listeners = new Map();
  return {
    windowOpenHandler: null,
    getType: () => type,
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; },
    // Code main.cjs runs in the page (the application menu's Go items).
    executed: [],
    executeJavaScript(code) { this.executed.push(code); return Promise.resolve(); },
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) || []), listener]);
      return this;
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) || []) listener(...args);
    },
    openDevTools() {},
  };
}

// Electron 45 navigation events carry the URL on the event object itself.
export const navigation = (url, details = {}) => ({
  url,
  isMainFrame: true,
  isSameDocument: false,
  ...details,
  defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; },
});

/**
 * @param {Function} fetch  the global fetch main.cjs sees
 * @param {{ packaged?: boolean, platform?: string, dirname?: string }} options
 *   By default main.cjs runs from this checkout as it would on this machine:
 *   with Node's own path module, and as Windows on a Windows host (CI runs the
 *   suite there), so tests can build their expectations with node:path and
 *   pathToFileURL. Other hosts run it as Linux; macOS is simulated on request.
 *   platform 'win32' with a Windows dirname simulates a Windows install on any
 *   host, with Node's Windows path module.
 */
export function loadMain(fetch = async () => { throw new Error('Unexpected request'); }, clock = manualClock(), options = {}) {
  const { packaged = true, platform = process.platform === 'win32' ? 'win32' : 'linux', dirname = appDir } = options;
  const handlers = new Map();
  const appListeners = new Map();
  const readyCallbacks = [];
  const windows = [];
  const opened = [];
  const partitions = new Map();
  const emitApp = (name, ...args) => {
    for (const listener of appListeners.get(name) || []) listener(...args);
  };
  const fakeSession = () => ({
    requestHandler: null,
    checkHandler: null,
    setPermissionRequestHandler(handler) { this.requestHandler = handler; },
    setPermissionCheckHandler(handler) { this.checkHandler = handler; },
  });
  class BrowserWindow {
    static getAllWindows() { return windows.filter(win => !win.closed); }
    constructor(options) {
      this.options = options;
      this.listeners = new Map();
      this.webContents = fakeContents('window');
      windows.push(this);
      // Like Electron, announce the window's contents before anything loads.
      emitApp('web-contents-created', {}, this.webContents);
    }
    loadURL(url) { this.loaded = url; }
    loadFile(file) { this.loaded = file; }
    on(name, listener) { this.listeners.set(name, listener); }
    close() {
      this.closed = true;
      this.listeners.get('closed')?.();
    }
  }
  const electron = {
    app: {
      isPackaged: packaged,
      on: (name, listener) => appListeners.set(name, [...(appListeners.get(name) || []), listener]),
      whenReady: () => ({ then: callback => { readyCallbacks.push(callback); } }),
      quit() { electron.app.quitCalls = (electron.app.quitCalls || 0) + 1; },
      getVersion: () => '9.9.9',
      setAboutPanelOptions(options) { electron.app.aboutPanelOptions = options; },
    },
    // buildFromTemplate keeps the template, so tests read the menu main.cjs set.
    Menu: {
      buildFromTemplate: template => ({ template }),
      setApplicationMenu(menu) { electron.Menu.applicationMenu = menu; },
    },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow,
    shell: { openExternal: async url => { opened.push(url); } },
    session: {
      defaultSession: fakeSession(),
      fromPartition: name => {
        if (!partitions.has(name)) partitions.set(name, fakeSession());
        return partitions.get(name);
      },
    },
  };
  class ClockDate extends Date {
    static now() { return clock.now(); }
  }
  runInNewContext(mainSource, {
    require: name => {
      if (name === 'electron') return electron;
      // The path module has to agree with __dirname: the host's own for this
      // checkout (path.posix would mangle a Windows runner's D:\a\... path).
      if (name === 'path') return platform === 'win32' ? path.win32 : path;
      if (name === 'http') return http;
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { platform },
    __dirname: dirname,
    fetch, URL, TextDecoder,
    Date: ClockDate,
    AbortSignal: { timeout: clock.timeout },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    console: { warn() {}, error() {} },
  }, { filename: mainPath });
  return {
    invoke: (name, ...args) => handlers.get(name)({}, ...args),
    clock,
    electron,
    windows,
    opened,
    partitions,
    emitApp,
    // Runs the app.whenReady() callbacks, as Electron does once it is ready.
    ready: () => { for (const callback of readyCallbacks) callback(); },
  };
}

// Runs preload.cjs against a fake contextBridge and ipcRenderer. Returns what
// it exposed to the page and every call that reached ipcRenderer.invoke.
export function loadPreload(reply = async (channel, ...args) => ({ channel, args })) {
  const exposed = new Map();
  const calls = [];
  runInNewContext(preloadSource, {
    require: name => {
      if (name !== 'electron') throw new Error(`Unexpected dependency: ${name}`);
      return {
        contextBridge: { exposeInMainWorld: (key, api) => exposed.set(key, api) },
        ipcRenderer: {
          invoke: (channel, ...args) => {
            calls.push([channel, ...args]);
            return reply(channel, ...args);
          },
        },
      };
    },
  }, { filename: preloadPath });
  return { exposed, calls };
}

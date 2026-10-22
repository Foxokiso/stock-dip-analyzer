import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';

const mainSource = readFileSync(new URL('../main.cjs', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const response = (value, status = 200, cookies = []) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { getSetCookie: () => cookies },
  text: async () => value,
  json: async () => value,
});

function manualClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const setTimer = (fn, delay) => {
    const id = nextId++;
    timers.set(id, { at: now + delay, fn });
    return id;
  };
  return {
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

function loadMain(fetch, clock = manualClock()) {
  const handlers = new Map();
  const electron = {
    app: { isPackaged: true, on() {}, whenReady: () => ({ then() {} }) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: class {},
    shell: {},
  };
  runInNewContext(mainSource, {
    require: name => {
      if (name === 'electron') return electron;
      if (name === 'path') return path;
      throw new Error(`Unexpected dependency: ${name}`);
    },
    fetch, URL,
    AbortSignal: { timeout: clock.timeout },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    console: { warn() {}, error() {} },
  });
  return { invoke: (name, ...args) => handlers.get(name)({}, ...args), clock };
}

const waitForAbort = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

for (const [channel, args, bodyMethod] of [
  ['fetch-url', ['https://finviz.com/api/futures_all?timeframe=i5'], 'text'],
  ['fetch-yahoo-chart', ['AAPL'], 'json'],
]) {
  test(`${channel} shares concurrent body reads, then fetches a fresh response`, async () => {
    const body = deferred();
    let calls = 0;
    const { invoke } = loadMain(async () => {
      calls++;
      return calls === 1 ? { ...response('first'), [bodyMethod]: () => body.promise } : response('fresh');
    });
    const first = invoke(channel, ...args);
    const duplicate = invoke(channel, ...args);
    await flush();
    assert.equal(calls, 1);
    body.resolve('first');
    assert.deepEqual(await Promise.all([first, duplicate]), ['first', 'first']);
    assert.equal(await invoke(channel, ...args), 'fresh');
    assert.equal(calls, 2, 'settled results must not become a quote cache');
  });

  test(`${channel} evicts failed requests so a later refresh can recover`, async () => {
    const pending = deferred();
    let calls = 0;
    const { invoke } = loadMain(async () => {
      calls++;
      return calls === 1 ? pending.promise : response('recovered');
    });
    const first = assert.rejects(invoke(channel, ...args), /404/);
    const duplicate = assert.rejects(invoke(channel, ...args), /404/);
    await flush();
    assert.equal(calls, 1);
    pending.resolve(response('', 404));
    await Promise.all([first, duplicate]);
    assert.equal(await invoke(channel, ...args), 'recovered');
    assert.equal(calls, 2);
  });
}

test('configure-network changes the single request deadline and ignores out-of-range values', async () => {
  const { invoke, clock } = loadMain((url, { signal }) => waitForAbort(signal));
  // Results come from another VM realm, so compare fields rather than object identity.
  const deadline = async (options) => (await invoke('configure-network', options)).requestTimeoutMs;
  assert.equal(await deadline({ requestTimeoutSeconds: 3 }), 3000);
  const pending = assert.rejects(invoke('fetch-url', 'https://finviz.com/screener.ashx?v=111'), /timed out/i);
  await clock.advance(2999);
  await clock.advance(1);
  await pending;
  assert.equal(await deadline({ requestTimeoutSeconds: 0 }), 3000);
  assert.equal(await deadline({ requestTimeoutSeconds: 'soon' }), 3000);
  assert.equal(await deadline(undefined), 3000);
});

test('Yahoo coalesces default arguments but keeps symbol, range and interval distinct', async () => {
  const pending = deferred();
  const urls = [];
  const { invoke } = loadMain(async url => { urls.push(url); return pending.promise; });
  const requests = [
    invoke('fetch-yahoo-chart', 'AAPL'),
    invoke('fetch-yahoo-chart', 'AAPL', '1mo', '1d'),
    invoke('fetch-yahoo-chart', 'MSFT', '1mo', '1d'),
    invoke('fetch-yahoo-chart', 'AAPL', '1y', '1d'),
    invoke('fetch-yahoo-chart', 'AAPL', '1mo', '1h'),
  ];
  await flush();
  assert.equal(new Set(urls).size, 4);
  assert.equal(urls.length, 4);
  pending.resolve(response({ chart: 'quotes' }));
  await Promise.all(requests);
});

for (const status of [400, 401, 404, 429]) {
  test(`HTTP ${status} fails immediately without retrying`, async () => {
    let calls = 0;
    const { invoke, clock } = loadMain(async () => { calls++; return response('', status); });
    const result = assert.rejects(invoke('fetch-url', 'https://finviz.com/missing'), new RegExp(String(status)));
    await clock.advance(12000);
    await result;
    assert.equal(calls, 1);
  });
}

test('transient server failures retry within the original request deadline', async () => {
  const signals = [];
  const { invoke, clock } = loadMain(async (url, options) => {
    signals.push(options.signal);
    return response(signals.length === 1 ? '' : 'recovered', signals.length === 1 ? 503 : 200);
  });
  const result = invoke('fetch-url', 'https://example.com/quotes');
  await clock.advance(1000);
  assert.equal(await result, 'recovered');
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
});

test('Finviz session seeding and retry share the same deadline and cookie jar', async () => {
  const requests = [];
  const { invoke, clock } = loadMain(async (url, options) => {
    requests.push({ url, ...options });
    if (requests.length === 1) return response('', 403);
    if (url === 'https://finviz.com/') return response('', 200, ['session=finviz; Path=/']);
    return response('quotes');
  });
  const result = invoke('fetch-url', 'https://finviz.com/screener.ashx');
  await clock.advance(1500);
  assert.equal(await result, 'quotes');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].headers.Cookie, 'session=finviz');
  assert.ok(requests.every(request => request.signal === requests[0].signal));
});

test('the total deadline interrupts a slow cookie seed at 12 seconds', async () => {
  const clock = manualClock();
  const requests = [];
  const { invoke } = loadMain(async (url, options) => {
    requests.push({ url, signal: options.signal });
    if (requests.length === 1) {
      await new Promise(resolve => clock.setTimeout(resolve, 7000));
      return response('', 403);
    }
    return waitForAbort(options.signal);
  }, clock);
  const result = assert.rejects(invoke('fetch-url', 'https://finviz.com/screener.ashx'), { name: 'TimeoutError' });
  await clock.advance(12000);
  await result;
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal, requests[1].signal);
  assert.equal(requests[1].signal.aborted, true);
});

test('the total deadline includes response body reading and prevents another retry', async () => {
  let calls = 0;
  const { invoke, clock } = loadMain(async (url, options) => {
    calls++;
    return { ...response(''), text: () => waitForAbort(options.signal) };
  });
  const result = assert.rejects(invoke('fetch-url', 'https://example.com/quotes'), { name: 'TimeoutError' });
  await clock.advance(12000);
  await result;
  assert.equal(calls, 1);
});

test('the total deadline interrupts retry backoff before it can seed another session', async () => {
  const clock = manualClock();
  let calls = 0;
  const { invoke } = loadMain(async () => {
    calls++;
    await new Promise(resolve => clock.setTimeout(resolve, 11500));
    return response('', 403);
  }, clock);
  const result = assert.rejects(invoke('fetch-url', 'https://finviz.com/screener.ashx'), { name: 'TimeoutError' });
  await clock.advance(12000);
  await result;
  assert.equal(calls, 1);
});

test('cookies remain isolated between Finviz and news requests', async () => {
  const requests = [];
  const { invoke } = loadMain(async (url, options) => {
    requests.push({ url, ...options });
    const host = new URL(url).hostname;
    return response('quotes', 200, [`session=${host}; Path=/`]);
  });
  for (let i = 0; i < 2; i++) {
    await invoke('fetch-url', 'https://finviz.com/screener.ashx');
    await invoke('fetch-url', 'https://news.google.com/rss');
  }
  assert.equal(requests[0].headers.Cookie, undefined);
  assert.equal(requests[1].headers.Cookie, undefined);
  assert.equal(requests[2].headers.Cookie, 'session=finviz.com');
  assert.equal(requests[3].headers.Cookie, 'session=news.google.com');
});

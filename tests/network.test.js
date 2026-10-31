import test from 'node:test';
import assert from 'node:assert/strict';
import { flush, loadMain, manualClock } from './helpers/mainProcess.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
// main.cjs reads every body as text (JSON for Yahoo), so a stub serves its
// value as text, encoding anything but a string as JSON.
const response = (value, status = 200, cookies = []) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { getSetCookie: () => cookies },
  text: async () => (typeof value === 'string' ? value : JSON.stringify(value)),
});

// A 3xx answer as Node's fetch reports it with redirect: 'manual'.
const redirect = (location, status = 302, cookies = []) => ({
  ok: false,
  status,
  headers: { getSetCookie: () => cookies, get: name => (name.toLowerCase() === 'location' ? location : null) },
  body: { cancel: async () => {} },
  text: async () => '',
});
// A 200 whose body arrives as a stream of chunks; records how much was pulled
// and whether the reader gave up.
const streamed = (chunks, headers = {}) => {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      if (state.pulled === chunks.length) controller.close();
      else controller.enqueue(chunks[state.pulled++]);
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 }); // pull only when read, so 'pulled' counts reads
  return {
    state,
    response: {
      ok: true,
      status: 200,
      headers: { getSetCookie: () => [], get: name => headers[name.toLowerCase()] ?? null },
      body,
      text: async () => { throw new Error('the body must be read as a capped stream'); },
    },
  };
};
const realNow = Date.UTC(2026, 9, 31, 12);

const waitForAbort = signal => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

// Expects a request to fail while the clock runs to the deadline, so a retry
// that should not happen shows up as an extra call (or a timeout) instead of
// leaving the test waiting on a retry pause.
async function rejectsByDeadline(clock, request, expected) {
  const failed = assert.rejects(request, expected);
  await clock.advance(12000);
  await failed;
}

// fetch-url resolves with the body text; fetch-yahoo-chart parses it as JSON.
for (const [channel, args, encode] of [
  ['fetch-url', ['https://finviz.com/api/futures_all?timeframe=i5'], String],
  ['fetch-yahoo-chart', ['AAPL'], JSON.stringify],
]) {
  test(`${channel} shares concurrent body reads, then fetches a fresh response`, async () => {
    const body = deferred();
    let calls = 0;
    const { invoke } = loadMain(async () => {
      calls++;
      return calls === 1 ? { ...response(''), text: () => body.promise } : response(encode('fresh'));
    });
    const first = invoke(channel, ...args);
    const duplicate = invoke(channel, ...args);
    await flush();
    assert.equal(calls, 1);
    body.resolve(encode('first'));
    assert.deepEqual(await Promise.all([first, duplicate]), ['first', 'first']);
    assert.equal(await invoke(channel, ...args), 'fresh');
    assert.equal(calls, 2, 'settled results must not become a quote cache');
  });

  // The clock runs to the deadline, so a retried 404 would show up as an
  // extra call instead of leaving the test waiting on a retry pause.
  test(`${channel} evicts failed requests so a later refresh can recover`, async () => {
    const pending = deferred();
    let calls = 0;
    const { invoke, clock } = loadMain(async () => {
      calls++;
      return calls === 1 ? pending.promise : response(encode('recovered'));
    });
    const first = assert.rejects(invoke(channel, ...args), /404/);
    const duplicate = assert.rejects(invoke(channel, ...args), /404/);
    await flush();
    assert.equal(calls, 1);
    pending.resolve(response('', 404));
    await clock.advance(12000);
    await Promise.all([first, duplicate]);
    assert.equal(calls, 1, 'a 404 is not retried');
    assert.equal(await invoke(channel, ...args), 'recovered');
    assert.equal(calls, 2);
  });
}

test('fetch-url refuses anything but HTTPS requests to the known providers', async () => {
  let calls = 0;
  const { invoke } = loadMain(async () => { calls++; return response('ok'); });
  for (const url of [
    'http://finviz.com/screener.ashx?v=111',          // plain HTTP
    'http://ip-api.com/json/',                         // a host the app no longer uses
    'https://evil.example/collect',                    // any other site
    'https://finviz.com.evil.example/',                // suffix trick
    'https://127.0.0.1:5174/',                         // local network
    'https://finviz.com:8443/screener.ashx',           // a listed host on another port
    'file:///C:/Windows/win.ini',
    'not a url',
    undefined,
  ]) {
    await assert.rejects(invoke('fetch-url', url), { message: 'Refused request: only HTTPS requests to finviz.com, www.finviz.com, news.google.com are allowed.' });
  }
  assert.equal(calls, 0, 'refused requests never reach the network');
  assert.equal(await invoke('fetch-url', 'https://news.google.com/rss?hl=en-US'), 'ok');
  assert.equal(await invoke('fetch-url', 'https://www.finviz.com/futures'), 'ok');
  assert.equal(calls, 2);
});

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
  const result = invoke('fetch-url', 'https://finviz.com/quotes');
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
  assert.equal(requests[2].headers.Referer, 'https://finviz.com/screener/stocks', 'the canonical screener URL');
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
  const result = assert.rejects(invoke('fetch-url', 'https://finviz.com/quotes'), { name: 'TimeoutError' });
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

test('fetch-url follows allowlisted redirects itself and re-checks every hop', async () => {
  const requests = [];
  const { invoke } = loadMain(async (url, options) => {
    requests.push({ url, ...options });
    if (url === 'https://finviz.com/screener.ashx?v=111') return redirect('/screener?v=111', 301);
    if (url === 'https://finviz.com/screener?v=111') return redirect('https://finviz.com/screener/stocks?v=111');
    return response('grid');
  });
  assert.equal(await invoke('fetch-url', 'https://finviz.com/screener.ashx?v=111'), 'grid');
  assert.deepEqual(requests.map(request => request.url), [
    'https://finviz.com/screener.ashx?v=111',
    'https://finviz.com/screener?v=111',
    'https://finviz.com/screener/stocks?v=111',
  ]);
  assert.ok(requests.every(request => request.redirect === 'manual' && request.signal === requests[0].signal));
});

test('fetch-url refuses a redirect off the allowlist without requesting it or retrying', async () => {
  for (const [location, target] of [
    ['http://192.168.1.1/admin', 'http://192.168.1.1'],          // local network, plain HTTP
    ['http://finviz.com/screener', 'http://finviz.com'],         // HTTPS downgrade
    ['https://finviz.com:8443/screener', 'https://finviz.com:8443'],
    ['https://evil.example/collect', 'https://evil.example'],
    ['//finviz.com.evil.example/', 'https://finviz.com.evil.example'],
    ['file:///etc/passwd', 'file://'],
    ['https://[::1', 'an invalid address'],
  ]) {
    const requested = [];
    const { invoke, clock } = loadMain(async url => { requested.push(url); return redirect(location); });
    const refused = assert.rejects(invoke('fetch-url', 'https://finviz.com/screener.ashx'), error => {
      assert.equal(error.message, `Refused redirect to ${target}.`);
      return true;
    });
    await clock.advance(12000);
    await refused;
    assert.deepEqual(requested, ['https://finviz.com/screener.ashx'], location);
  }
});

test('fetch-url follows at most five redirects', async () => {
  const chain = hops => async url => {
    const hop = Number(new URL(url).searchParams.get('hop') || 0);
    return hop < hops ? redirect(`/loop?hop=${hop + 1}`) : response(`after ${hop}`);
  };
  assert.equal(await loadMain(chain(5)).invoke('fetch-url', 'https://finviz.com/loop'), 'after 5');
  let calls = 0;
  const { invoke, clock } = loadMain(async (url, options) => { calls++; return chain(6)(url, options); });
  await rejectsByDeadline(clock, invoke('fetch-url', 'https://finviz.com/loop'), { message: 'Finviz redirected more than 5 times.' });
  assert.equal(calls, 6, 'the sixth redirect is not followed, and a loop is not retried');
});

test('each redirect hop files its cookies under its own host', async () => {
  const requests = [];
  const { invoke } = loadMain(async (url, options) => {
    requests.push({ url, cookie: options.headers.Cookie });
    if (url === 'https://www.finviz.com/futures') return redirect('https://finviz.com/futures', 301, ['www_only=1; Path=/']);
    if (url === 'https://finviz.com/futures') return redirect('/futures/all', 302, ['cf_clearance=SECRET; Path=/; Secure']);
    return response('quotes', 200, ['session=S1; Path=/; HttpOnly']);
  });
  assert.equal(await invoke('fetch-url', 'https://www.finviz.com/futures'), 'quotes');
  await invoke('fetch-url', 'https://finviz.com/quotes');
  await invoke('fetch-url', 'https://www.finviz.com/quotes');
  await invoke('fetch-url', 'https://news.google.com/rss');
  assert.deepEqual(requests.map(request => request.cookie), [
    undefined, undefined, 'cf_clearance=SECRET',                 // the redirect's own cookie is kept
    'cf_clearance=SECRET; session=S1',                           // finviz.com: never www_only
    'www_only=1',                                                // www.finviz.com: only its own
    undefined,                                                   // news.google.com: nothing from Finviz
  ]);
});

test('cookies merge by name, and Max-Age<=0 or a past Expires deletes them', async () => {
  const answers = [
    ['session=S1; Path=/', 'cf_clearance=C1; Max-Age=3600'],
    ['screenerUrl=x; Expires=Fri, 31 Oct 2031 00:00:00 GMT'],
    ['session=S2; Path=/'],
    ['session=; Max-Age=0', 'screenerUrl=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
    ['cf_clearance=C2; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
    ['cf_clearance=gone; Max-Age=-1', 'not a cookie', '=nameless'],
    [],
  ];
  const cookies = [];
  const { invoke } = loadMain(async (url, options) => {
    cookies.push(options.headers.Cookie);
    return response('ok', 200, answers[cookies.length - 1]);
  }, manualClock(realNow));
  for (let i = 0; i < answers.length; i++) await invoke('fetch-url', `https://finviz.com/page${i}`);
  assert.deepEqual(cookies, [
    undefined,
    'session=S1; cf_clearance=C1',
    'session=S1; cf_clearance=C1; screenerUrl=x',
    'session=S2; cf_clearance=C1; screenerUrl=x',              // replaced in place, nothing else lost
    'cf_clearance=C1',                                         // a logout is a deletion, not 'session='
    'cf_clearance=C2',                                         // Max-Age wins over Expires
    undefined,                                                 // malformed lines are ignored
  ]);
});

test('responses without Set-Cookie support or headers are tolerated', async () => {
  const { invoke } = loadMain(async (url) => (url.endsWith('/a')
    ? { ok: true, status: 200, headers: {}, text: async () => 'a' }
    : { ok: true, status: 200, text: async () => 'b' }));
  assert.equal(await invoke('fetch-url', 'https://finviz.com/a'), 'a');
  assert.equal(await invoke('fetch-url', 'https://finviz.com/b'), 'b');
});

test('provider bodies are read as a stream and stop past 15 MB', async () => {
  const megabyte = new Uint8Array(1024 * 1024).fill(0x20);
  const grid = streamed([new TextEncoder().encode('<html>'), new TextEncoder().encode('grid</html>')]);
  const small = loadMain(async () => grid.response);
  const text = small.invoke('fetch-url', 'https://finviz.com/a');
  await small.clock.advance(12000);
  assert.equal(await text, '<html>grid</html>');

  const huge = streamed(Array(64).fill(megabyte));
  let calls = 0;
  const { invoke, clock } = loadMain(async () => { calls++; return huge.response; });
  await rejectsByDeadline(clock, invoke('fetch-url', 'https://finviz.com/b'), { message: 'The response from Finviz is larger than 15 MB.' });
  assert.ok(huge.state.cancelled, 'the reader gives up instead of buffering the rest');
  assert.equal(huge.state.pulled, 16, 'reading stops at the first megabyte past the cap');
  assert.equal(calls, 1, 'an oversized body is not fetched again');

  const declared = streamed([megabyte], { 'content-length': String(16 * 1024 * 1024) });
  const early = loadMain(async () => declared.response);
  await rejectsByDeadline(early.clock, early.invoke('fetch-url', 'https://finviz.com/c'), /larger than 15 MB/);
  assert.equal(declared.state.pulled, 0, 'a declared oversized body is never read');
  assert.ok(declared.state.cancelled);

  const chart = streamed(Array(64).fill(megabyte));
  let charts = 0;
  const yahoo = loadMain(async () => { charts++; return chart.response; });
  await rejectsByDeadline(yahoo.clock, yahoo.invoke('fetch-yahoo-chart', 'AAPL'), { message: 'The response from Yahoo Finance is larger than 15 MB.' });
  assert.equal(chart.state.pulled, 16, "Yahoo's chart body goes through the same cap");
  assert.equal(charts, 1);
});

// Node's fetch reports network failures as "fetch failed" with the reason in
// err.cause.
const unreachable = code => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error(`connect ${code}`), { code }),
});

test('provider errors say who answered and how', async () => {
  const answers = {
    'https://finviz.com/a': { ...response('', 429), statusText: 'Too Many Requests' },
    'https://finviz.com/b': response('', 404),                       // no reason phrase (HTTP/2)
    'https://news.google.com/rss': { ...response('', 401), statusText: 'Unauthorized' },
  };
  let calls = 0;
  const { invoke, clock } = loadMain(async url => { calls++; return answers[url]; });
  await rejectsByDeadline(clock, invoke('fetch-url', 'https://finviz.com/a'), { message: 'Finviz returned HTTP 429 Too Many Requests' });
  await rejectsByDeadline(clock, invoke('fetch-url', 'https://finviz.com/b'), { message: 'Finviz returned HTTP 404 Not Found' });
  await rejectsByDeadline(clock, invoke('fetch-url', 'https://news.google.com/rss'), { message: 'Google News returned HTTP 401 Unauthorized' });
  assert.equal(calls, 3, 'none of them is retried');
});

test('network failures name their cause, and timeouts say how long was waited', async () => {
  const offline = loadMain(async () => { throw unreachable('ENOTFOUND'); });
  const failed = assert.rejects(offline.invoke('fetch-url', 'https://finviz.com/quotes'), { message: 'Could not reach Finviz (ENOTFOUND)' });
  await offline.clock.advance(2000);
  await failed;

  const slow = loadMain((url, { signal }) => waitForAbort(signal));
  const timedOut = assert.rejects(slow.invoke('fetch-url', 'https://finviz.com/quotes'), { name: 'TimeoutError', message: 'Request timed out after 12 s' });
  await slow.clock.advance(12000);
  await timedOut;
  await slow.invoke('configure-network', { requestTimeoutSeconds: 2.5 });
  const yahoo = assert.rejects(slow.invoke('fetch-yahoo-chart', 'AAPL'), { name: 'TimeoutError', message: 'Request timed out after 2.5 s' });
  await slow.clock.advance(2500);
  await yahoo;
});

test("Yahoo's own explanation of a refusal reaches the message, read from a capped body", async () => {
  const delisted = JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } });
  const huge = streamed(Array(64).fill(new Uint8Array(1024 * 1024).fill(0x20)));
  let calls = 0;
  const { invoke, clock } = loadMain(async url => {
    calls++;
    if (url.includes('/ZZZZ?')) return { ...response(delisted, 404), statusText: 'Not Found' };
    return { ...huge.response, ok: false, status: 400 };
  });
  await rejectsByDeadline(clock, invoke('fetch-yahoo-chart', 'ZZZZ'), { message: 'Yahoo Finance returned HTTP 404 Not Found: No data found, symbol may be delisted' });
  await rejectsByDeadline(clock, invoke('fetch-yahoo-chart', 'HUGE'), { message: 'Yahoo Finance returned HTTP 400 Bad Request' });
  assert.equal(huge.state.pulled, 1, 'an oversized error body is cut off at the first chunk');
  assert.ok(huge.state.cancelled);
  assert.equal(calls, 2, 'a 4xx answer is never retried');
});

test('Yahoo retries server errors and network failures within the deadline, never 4xx', async () => {
  const signals = [];
  const flaky = loadMain(async (url, options) => {
    signals.push(options.signal);
    if (signals.length === 1) return response('', 503);
    if (signals.length === 2) throw unreachable('ECONNRESET');
    return response({ chart: { result: [] } });
  });
  const result = flaky.invoke('fetch-yahoo-chart', 'AAPL');
  await flaky.clock.advance(2000);
  assert.deepEqual(Object.keys(await result), ['chart']);
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal === signals[0]), 'one deadline for every attempt');

  const down = loadMain(async () => { throw unreachable('ECONNREFUSED'); });
  const refused = assert.rejects(down.invoke('fetch-yahoo-chart', 'AAPL'), { message: 'Could not reach Yahoo Finance (ECONNREFUSED)' });
  await down.clock.advance(2000);
  await refused;

  // A connection dropped while the body is read is a network failure too.
  let reads = 0;
  const dropped = loadMain(async () => ({
    ...response(''),
    text: async () => {
      if (++reads > 1) return JSON.stringify({ chart: { result: [] } });
      throw Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    },
  }));
  const resumed = dropped.invoke('fetch-yahoo-chart', 'AAPL');
  await dropped.clock.advance(1000);
  assert.deepEqual(Object.keys(await resumed), ['chart']);
  assert.equal(reads, 2);

  for (const status of [400, 401, 404, 429]) {
    let calls = 0;
    const { invoke, clock } = loadMain(async () => { calls++; return response('', status); });
    const failed = assert.rejects(invoke('fetch-yahoo-chart', 'AAPL'), new RegExp(`HTTP ${status}`));
    await clock.advance(12000);
    await failed;
    assert.equal(calls, 1, `HTTP ${status}`);
  }
});

test('Yahoo answering with a page that is not chart data fails at once, in words', async () => {
  let calls = 0;
  const { invoke, clock } = loadMain(async () => {
    calls++;
    return response('<!DOCTYPE html><html><body>Before you continue to Yahoo</body></html>');
  });
  await rejectsByDeadline(clock, invoke('fetch-yahoo-chart', 'AAPL'), { message: 'Yahoo Finance did not return chart data.' });
  assert.equal(calls, 1, 'a consent page would only come back');
});

test('Yahoo refuses a redirect instead of following it, and does not retry', async () => {
  for (const [location, target] of [
    ['https://guce.yahoo.com/consent?brandType=eu', 'https://guce.yahoo.com'],   // a consent page
    ['http://192.168.1.1/admin', 'http://192.168.1.1'],                         // local network, plain HTTP
    ['https://query2.finance.yahoo.com/v8/finance/chart/AAPL', 'https://query2.finance.yahoo.com'],
    ['https://[::1', 'an invalid address'],
  ]) {
    const requests = [];
    const { invoke, clock } = loadMain(async (url, options) => { requests.push([url, options.redirect]); return redirect(location); });
    await rejectsByDeadline(clock, invoke('fetch-yahoo-chart', 'AAPL'), { message: `Refused redirect to ${target}.` });
    assert.deepEqual(requests, [['https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=1d', 'manual']], location);
  }
});

test('Yahoo chart requests accept every symbol, range and interval the app sends', async () => {
  const urls = [];
  const { invoke } = loadMain(async url => { urls.push(url); return response({ chart: { result: [] } }); });
  // MarketPulse, OilWatch, the scan and the stock page (tickers from Finviz).
  for (const symbol of ['AAPL', 'BRK-B', 'BF-B', '^VIX', '^GSPC', 'CL=F', 'BZ=F', 'EURUSD=X', 'BTC-USD', '7203.T', 'SHOP.TO', '0700.HK', 'aapl']) {
    await invoke('fetch-yahoo-chart', symbol);
  }
  for (const [range, interval] of [['1d', '5m'], ['1mo', '1d'], ['3mo', '1d'], ['6mo', '1d'], ['1y', '1d'], [undefined, undefined]]) {
    await invoke('fetch-yahoo-chart', 'SPY', range, interval);
  }
  assert.equal(urls.length, 19);
  assert.equal(urls[3], 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=1mo&interval=1d');
  assert.equal(urls.at(-1), 'https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1mo&interval=1d');
});

test('Yahoo chart requests refuse a malformed symbol, range or interval before any request exists', async () => {
  let calls = 0;
  const { invoke } = loadMain(async () => { calls++; return response({}); });
  for (const symbol of ['', '.', '..', '../../v7/finance/quote', 'AAPL/x', 'AAPL?modules=x', 'AAPL&range=max', 'AAPL ', ' AAPL', '^', '-AAPL', 'A'.repeat(1_000_000), null, undefined, 42, {}]) {
    await assert.rejects(invoke('fetch-yahoo-chart', symbol), /^Error: Refused chart request: .* is not a valid ticker symbol\.$/, String(symbol).slice(0, 20));
  }
  for (const range of ['1mo&crumb=x', '2mo', 'MAX', '', null, 1]) {
    await assert.rejects(invoke('fetch-yahoo-chart', 'AAPL', range, '1d'), /is not a valid chart range/, String(range));
  }
  for (const interval of ['7m', '1d ', 'daily', null]) {
    await assert.rejects(invoke('fetch-yahoo-chart', 'AAPL', '1mo', interval), /is not a valid chart interval/, String(interval));
  }
  assert.equal(calls, 0, 'refused requests never reach the network');
  await assert.rejects(invoke('fetch-yahoo-chart', 'A'.repeat(1_000_000)), error => error.message.length < 100);
});

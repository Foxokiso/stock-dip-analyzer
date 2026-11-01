import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPreload } from './helpers/mainProcess.js';

test('the preload exposes exactly one function to the page: window.dipAnalyzer.invoke', () => {
  const { exposed } = loadPreload();
  assert.deepEqual([...exposed.keys()], ['dipAnalyzer']);
  assert.deepEqual(Object.keys(exposed.get('dipAnalyzer')), ['invoke']);
  assert.equal(typeof exposed.get('dipAnalyzer').invoke, 'function');
});

test('only the three provider channels reach the main process, with their arguments', async () => {
  const { exposed, calls } = loadPreload();
  const { invoke } = exposed.get('dipAnalyzer');
  const forwarded = await invoke('fetch-yahoo-chart', 'AAPL', '1mo', '1d');
  assert.equal(forwarded.channel, 'fetch-yahoo-chart');
  await invoke('fetch-url', 'https://finviz.com/screener.ashx?v=111');
  await invoke('configure-network', { requestTimeoutSeconds: 20 });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(([channel]) => channel), ['fetch-yahoo-chart', 'fetch-url', 'configure-network']);
  assert.deepEqual(calls[0].slice(1), ['AAPL', '1mo', '1d']);

  for (const channel of ['open-external', 'fetch-url ', 'FETCH-URL', '__proto__', 'constructor', 'hasOwnProperty', '', undefined, 42]) {
    await assert.rejects(invoke(channel, 'https://evil.example/'), /Unknown desktop channel/, String(channel));
  }
  assert.equal(calls.length, 3, 'refused channels never reach ipcRenderer');
});

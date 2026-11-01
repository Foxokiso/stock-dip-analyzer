import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { configureNetwork } from '../src/state/network.js';
import { SETTINGS_KEY, SETTINGS_VERSION, loadSettings } from '../src/state/settingsSchema.js';

// What the settings layer tells the desktop process: main.jsx sends the saved
// request timeout before the first render, SettingsProvider every change after.

const recorder = (reply = () => Promise.resolve({ requestTimeoutMs: 0 })) => {
  const calls = [];
  return { calls, invoke: (channel, ...args) => { calls.push([channel, ...args]); return reply(); } };
};

test('configureNetwork issues configure-network before it returns', () => {
  const { calls, invoke } = recorder();
  configureNetwork(45, invoke);
  // Synchronous on purpose: main.jsx renders the desks right after this call,
  // and the main process handles one renderer's messages in order.
  assert.deepEqual(calls, [['configure-network', { requestTimeoutSeconds: 45 }]]);
});

test('the startup call carries the saved timeout, not the built-in 12 s', () => {
  const storage = {
    getItem: (key) => (key === SETTINGS_KEY ? JSON.stringify({ version: SETTINGS_VERSION, data: { requestTimeoutSeconds: 60 } }) : null),
  };
  const { calls, invoke } = recorder();
  configureNetwork(loadSettings(storage).data.requestTimeoutSeconds, invoke);
  assert.deepEqual(calls, [['configure-network', { requestTimeoutSeconds: 60 }]]);
});

test('configureNetwork never stops startup: no bridge, a refusal or a throwing bridge', async () => {
  const unhandled = [];
  const collect = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', collect);
  try {
    assert.doesNotThrow(() => configureNetwork(30)); // no window: a browser preview has no bridge
    assert.doesNotThrow(() => configureNetwork(30, null));
    assert.doesNotThrow(() => configureNetwork(30, () => Promise.reject(new Error('refused'))));
    assert.doesNotThrow(() => configureNetwork(30, () => { throw new Error('bridge broke'); }));
    assert.doesNotThrow(() => configureNetwork(30, () => undefined));
    await new Promise(resolve => setTimeout(resolve, 10));
  } finally {
    process.off('unhandledRejection', collect);
  }
  assert.deepEqual(unhandled, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocalNewsHeadlines } from '../src/utils/telemetry.js';

test('unavailable news cannot turn into invented headlines', async () => {
    globalThis.window = {};
    const originalError = console.error;
    console.error = () => {};
    try {
        assert.deepEqual(await getLocalNewsHeadlines(), []);
    } finally {
        console.error = originalError;
        delete globalThis.window;
    }
});

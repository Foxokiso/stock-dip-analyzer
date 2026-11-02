import test from 'node:test';
import assert from 'node:assert/strict';
import { DEV_URL, PREVIEW_URL, runVerify, summary, verifySteps } from '../scripts/verify.mjs';

// npm run verify: which checks run, in what order, and that a step's server is
// always stopped. Commands and servers are stand-ins; nothing is spawned.

const quiet = () => {};
const clock = () => { let t = 0; return () => (t += 100); };

function fakeIo({ failOn = null, throwOn = null, serverFails = null } = {}) {
    const calls = [];
    return {
        calls,
        io: {
            log: quiet,
            now: clock(),
            run: async (command, env) => {
                calls.push(['run', command.join(' '), env?.UI_BASE_URL ?? null]);
                if (throwOn && command.join(' ').includes(throwOn)) throw new Error(`cannot run ${throwOn}`);
                return failOn && command.join(' ').includes(failOn) ? 1 : 0;
            },
            startServer: async ({ url }) => {
                calls.push(['start', url]);
                if (serverFails === url) throw new Error(`something already answers on ${url}`);
                return { stop: async () => { calls.push(['stop', url]); } };
            },
        },
    };
}

test('the full run is the CI Linux job: tests, lint, build, then test:ui on the dev server and on the production build', () => {
    const steps = verifySteps({ node: 'node', cwd: '/repo' });
    assert.deepEqual(steps.map(step => step.command.join(' ')), [
        'npm test',
        'npm run lint -- --max-warnings 0',
        'npm run build:renderer',
        'npm run test:ui',
        'npm run test:ui',
    ]);
    const [dev, preview] = steps.slice(3);
    assert.equal(dev.server.url, `${DEV_URL}/`);
    assert.equal(dev.env.UI_BASE_URL, DEV_URL);
    assert.deepEqual(dev.server.command.slice(2), ['--host', '127.0.0.1', '--port', '5174', '--strictPort']);
    assert.equal(preview.server.url, `${PREVIEW_URL}/`);
    assert.equal(preview.env.UI_BASE_URL, PREVIEW_URL);
    assert.deepEqual(preview.server.command.slice(2), ['preview', '--host', '127.0.0.1', '--port', '4174', '--strictPort']);
    for (const { server } of [dev, preview]) {
        assert.equal(server.command[0], 'node');
        assert.match(server.command[1].replaceAll('\\', '/'), /\/repo\/node_modules\/vite\/bin\/vite\.js$/);
    }
});

test('--quick runs the tests, lint and build only, with no server', () => {
    const steps = verifySteps({ quick: true });
    assert.deepEqual(steps.map(step => step.name), ['unit tests', 'lint', 'renderer build']);
    assert.ok(steps.every(step => !step.server));
});

test('every step runs, in order, and each server is stopped after its step', async () => {
    const { calls, io } = fakeIo();
    const results = await runVerify(verifySteps({ node: 'node', cwd: '/repo' }), io);
    assert.ok(results.every(result => result.ok));
    assert.equal(results.length, 5);
    assert.deepEqual(calls, [
        ['run', 'npm test', null],
        ['run', 'npm run lint -- --max-warnings 0', null],
        ['run', 'npm run build:renderer', null],
        ['start', `${DEV_URL}/`], ['run', 'npm run test:ui', DEV_URL], ['stop', `${DEV_URL}/`],
        ['start', `${PREVIEW_URL}/`], ['run', 'npm run test:ui', PREVIEW_URL], ['stop', `${PREVIEW_URL}/`],
    ]);
    assert.match(summary(results, 5), /verify: all checks passed$/);
});

test('the run stops at the first failing step', async () => {
    const { calls, io } = fakeIo({ failOn: 'lint' });
    const results = await runVerify(verifySteps({ node: 'node', cwd: '/repo' }), io);
    assert.deepEqual(results.map(result => [result.name, result.ok]), [['unit tests', true], ['lint', false]]);
    assert.equal(results[1].error, 'npm run lint -- --max-warnings 0 exited with code 1');
    assert.equal(calls.length, 2);
    assert.match(summary(results, 5), /FAIL {2}lint \(0\.1 s\): npm run lint -- --max-warnings 0 exited with code 1\nverify failed at: lint$/);
});

test('a failing browser step still stops its server, and the production-build step never starts', async () => {
    const { calls, io } = fakeIo({ failOn: 'test:ui' });
    const results = await runVerify(verifySteps({ node: 'node', cwd: '/repo' }), io);
    assert.equal(results.at(-1).ok, false);
    assert.deepEqual(calls.slice(-3), [['start', `${DEV_URL}/`], ['run', 'npm run test:ui', DEV_URL], ['stop', `${DEV_URL}/`]]);
});

test('a command that cannot run fails its step and its server is stopped', async () => {
    const { calls, io } = fakeIo({ throwOn: 'test:ui' });
    const results = await runVerify(verifySteps({ node: 'node', cwd: '/repo' }), io);
    assert.equal(results.at(-1).error, 'cannot run test:ui');
    assert.deepEqual(calls.at(-1), ['stop', `${DEV_URL}/`]);
});

test('a server that cannot start (port taken) fails its step before its command runs', async () => {
    const { calls, io } = fakeIo({ serverFails: `${DEV_URL}/` });
    const results = await runVerify(verifySteps({ node: 'node', cwd: '/repo' }), io);
    assert.equal(results.at(-1).ok, false);
    assert.equal(results.at(-1).error, `something already answers on ${DEV_URL}/`);
    assert.deepEqual(calls.at(-1), ['start', `${DEV_URL}/`]);
    assert.ok(!calls.some(([kind, what]) => kind === 'run' && what === 'npm run test:ui'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { launch } from '../scripts/start.mjs';

// npm start: the launcher that runs Vite and Electron and stops them together.
// Stand-ins replace both: node itself, as a server answering 200 and as an app.

const freePort = () => new Promise((resolve, reject) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
    }).on('error', reject);
});
// Each stand-in stops by itself after `life` ms, so a failing test cannot leave it behind for
// long; that is longer than a test may take, so a process left running fails its test.
const serverCommand = (port, life = 30000) => [process.execPath, '-e',
    `require('node:http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1'); setTimeout(() => process.exit(), ${life});`];
const appStandIn = (script) => ({ command: process.execPath, args: ['-e', script] });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const answers = (url) => fetch(url).then(() => true, () => false);
const quiet = () => {};
// A regression that leaves a process running would otherwise hang the run.
const limit = { timeout: 15000 };

async function devServer() {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    return { url, command: serverCommand(port) };
}

test('closing the app (exit code 0) stops the dev server and ends the run with code 0', limit, async () => {
    const server = await devServer();
    const run = launch({ devServer: server, app: appStandIn('setTimeout(() => process.exit(0), 300)'), log: quiet });
    const { server: vite } = await run.started;
    assert.equal(await run.done, 0);
    assert.equal(alive(vite.pid), false, 'the dev server is still running');
    assert.equal(await answers(server.url), false, 'the dev server still answers');
});

test('stop() — a signal, or the starting process exiting — stops the app and the dev server, with code 0', limit, async () => {
    const server = await devServer();
    const run = launch({ devServer: server, app: appStandIn('setTimeout(() => {}, 30000)'), log: quiet });
    const { server: vite, app } = await run.started;
    assert.equal(await answers(server.url), true);
    run.stop('test');
    assert.equal(await run.done, 0);
    assert.equal(alive(app.pid), false, 'the app is still running');
    assert.equal(alive(vite.pid), false, 'the dev server is still running');
    assert.equal(await answers(server.url), false, 'the dev server still answers');
});

test('stop() before the dev server answers still stops it once it has started, and never starts the app', limit, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'start-'));
    const marker = path.join(dir, 'app-started');
    try {
        const server = await devServer();
        // A long grace period, so only an explicit stop, not the kill after it, can end the server in time.
        const run = launch({ devServer: server, app: appStandIn(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`), grace: 20000, log: quiet });
        const startedAt = performance.now();
        run.stop('test');
        assert.equal(await run.started, null);
        assert.equal(await run.done, 0);
        assert.ok(performance.now() - startedAt < 5000, 'the dev server was not stopped once it had started');
        assert.equal(await answers(server.url), false, 'the dev server still answers');
        assert.equal(existsSync(marker), false, 'the app was started');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('an app stopped by a signal the launcher did not send (Ctrl+C reaches it first) is a stop, not a failure', limit, async () => {
    const server = await devServer();
    const messages = [];
    const run = launch({ devServer: server, app: appStandIn('setTimeout(() => {}, 30000)'), log: m => messages.push(m) });
    const { app } = await run.started;
    app.kill('SIGINT');
    assert.equal(await run.done, 0);
    assert.equal(await answers(server.url), false, 'the dev server still answers');
    assert.deepEqual(messages, []);
});

test('the app failing (exit code 3) stops the dev server and passes its code on', limit, async () => {
    const server = await devServer();
    const messages = [];
    const run = launch({ devServer: server, app: appStandIn('process.exit(3)'), log: m => messages.push(m) });
    assert.equal(await run.done, 3);
    assert.equal(await answers(server.url), false, 'the dev server still answers');
    assert.deepEqual(messages, ['the app exited (exit code 3)']);
});

test('the dev server failing stops the app, with code 1', limit, async () => {
    const port = await freePort();
    const messages = [];
    const run = launch({
        devServer: { url: `http://127.0.0.1:${port}/`, command: serverCommand(port) },
        app: appStandIn('setTimeout(() => {}, 30000)'), log: m => messages.push(m),
    });
    const { server: vite, app } = await run.started;
    vite.kill('SIGKILL'); // a crash, not a stop request
    assert.equal(await run.done, 1);
    assert.equal(alive(app.pid), false, 'the app is still running');
    assert.match(messages[0], /^the dev server exited \(SIGKILL\); stopping the app$/);
});

test('a dev server that cannot start never starts the app; the run ends with code 1 and its reason', limit, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'start-'));
    const marker = path.join(dir, 'app-started');
    try {
        const port = await freePort();
        const messages = [];
        const run = launch({
            devServer: { url: `http://127.0.0.1:${port}/`, command: [process.execPath, '-e', "console.error('Error: Port 5174 is already in use'); process.exit(1)"] },
            app: appStandIn(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`), log: m => messages.push(m),
        });
        assert.equal(await run.done, 1);
        assert.equal(existsSync(marker), false, 'the app was started');
        assert.deepEqual(messages, ['the dev server did not start: the dev server exited (exit code 1) before it answered: Error: Port 5174 is already in use']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('an app command that cannot run stops the dev server, with code 1', limit, async () => {
    const server = await devServer();
    const messages = [];
    const run = launch({ devServer: server, app: { command: path.join(tmpdir(), 'no-such-electron-binary') }, log: m => messages.push(m) });
    assert.equal(await run.done, 1);
    assert.equal(await answers(server.url), false, 'the dev server still answers');
    assert.match(messages[0], /^the app did not start: spawn .*no-such-electron-binary ENOENT$/);
});

test('a process that ignores the stop request is killed after the grace period', limit, async () => {
    const server = await devServer();
    const run = launch({ devServer: server, app: appStandIn("process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"), grace: 300, log: quiet });
    const { app } = await run.started;
    // Give the stand-in time to install its handler before asking it to stop.
    await new Promise(resolve => setTimeout(resolve, 300));
    const startedAt = performance.now();
    run.stop('test');
    assert.equal(await run.done, 0);
    assert.equal(alive(app.pid), false, 'the app is still running');
    assert.ok(performance.now() - startedAt < 5000, 'the run waited for the stand-in to stop by itself');
});

test('the launcher stops everything when the process that started it exits (npm passing SIGTERM to its shell only)', limit, async () => {
    // parent → launcher (watchParent + launch with stand-ins). The parent exits on its own, as
    // npm's shell does after SIGTERM, without signalling the launcher; the launcher must notice.
    const dir = mkdtempSync(path.join(tmpdir(), 'start-'));
    const report = path.join(dir, 'pids.json');
    try {
        const port = await freePort();
        const url = `http://127.0.0.1:${port}/`;
        const startUrl = new URL('../scripts/start.mjs', import.meta.url).href;
        const launcher = `
            const { launch, watchParent } = await import(${JSON.stringify(startUrl)});
            const run = launch({ devServer: { url: ${JSON.stringify(url)}, command: ${JSON.stringify(serverCommand(port))} },
                app: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] }, log: () => {} });
            // Watching starts at once, as in the real launcher: the parent may exit as soon as the report exists.
            watchParent(() => run.stop('parent gone'), 100);
            const { server, app } = await run.started;
            require('node:fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify({ launcher: process.pid, server: server.pid, app: app.pid }));
            process.exitCode = await run.done;`;
        const parent = `
            const child = require('node:child_process').spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n${launcher}`)}], { stdio: 'ignore' });
            const fs = require('node:fs');
            const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(report)})) { clearInterval(wait); process.exit(0); } }, 50);`;
        const parentProcess = spawn(process.execPath, ['-e', parent], { stdio: 'ignore' });
        await new Promise(resolve => parentProcess.once('exit', resolve));
        const pids = JSON.parse(readFileSync(report, 'utf8'));
        let left = [];
        for (let i = 0; i < 100; i++) {
            left = Object.entries(pids).filter(([, pid]) => alive(pid)).map(([name]) => name);
            if (left.length === 0) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.deepEqual(left, [], `still running after the parent exited: ${left.join(', ')}`);
        assert.equal(await answers(url), false, 'the dev server still answers');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('npm start runs the launcher, with no shell or concurrently between npm and Vite or Electron', limit, () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts.start, 'node scripts/start.mjs');
    assert.equal(pkg.devDependencies.concurrently, undefined);
    const source = readFileSync(new URL('../scripts/start.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /shell:/);
    assert.match(source, /'--host', '127\.0\.0\.1', '--port', '5174', '--strictPort'/);
    assert.match(source, /NODE_ENV: 'development'/);
});

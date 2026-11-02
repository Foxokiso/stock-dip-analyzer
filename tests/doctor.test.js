import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import path from 'node:path';
import { checkBrowser, checkDependencies, checkDisplay, checkElectron, checkNode, checkPort, checkSandbox, report } from '../scripts/doctor.mjs';

// npm run doctor: every check is driven with stand-in probes, except the port check,
// which listens on real ports.

const cwd = '/repo';
const restriction = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
const noFile = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
const files = (map) => (file) => { if (file in map) return map[file]; return noFile(); };

test('Node.js 22.12 or later passes; older fails with the fix', () => {
    assert.equal(checkNode('22.12.0').status, 'ok');
    assert.equal(checkNode('24.3.0').status, 'ok');
    assert.equal(checkNode('23.0.0').status, 'ok');
    for (const version of ['22.11.9', '20.19.0', '18.20.4']) {
        const result = checkNode(version);
        assert.equal(result.status, 'fail', version);
        assert.match(result.fix, /22\.12 or later/);
    }
});

test('dependencies: missing packages are named, with npm ci as the fix', () => {
    assert.equal(checkDependencies({ cwd, exists: () => true }).status, 'ok');
    const result = checkDependencies({ cwd, exists: file => !file.includes(`${path.sep}electron${path.sep}`) });
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /electron missing/);
    assert.match(result.fix, /npm ci/);
});

test('Electron: present when the executable path.txt names exists; otherwise a note that npm start downloads it', () => {
    const dist = path.join(cwd, 'node_modules', 'electron', 'dist');
    const read = files({ [path.join(cwd, 'node_modules', 'electron', 'path.txt')]: 'electron' });
    assert.equal(checkElectron({ cwd, read, exists: file => file === path.join(dist, 'electron') }).status, 'ok');
    // Before the first download there is no path.txt; the platform's name is used.
    assert.equal(checkElectron({ cwd, read: noFile, platform: 'win32', exists: file => file === path.join(dist, 'electron.exe') }).status, 'ok');
    const missing = checkElectron({ cwd, read: noFile, platform: 'linux', exists: () => false });
    assert.equal(missing.status, 'note');
    assert.match(missing.detail, /first `npm start` downloads it/);
});

test('sandbox: not checked outside Linux; root fails', () => {
    assert.equal(checkSandbox({ platform: 'win32', cwd }), null);
    assert.equal(checkSandbox({ platform: 'darwin', cwd }), null);
    const root = checkSandbox({ platform: 'linux', uid: 0, cwd, read: noFile, stat: noFile, listProfiles: () => [] });
    assert.equal(root.status, 'fail');
    assert.match(root.detail, /running as root/);
});

test('sandbox: fine where user namespaces are not restricted (file absent or 0)', () => {
    for (const read of [noFile, files({ [restriction]: '0\n' })]) {
        assert.equal(checkSandbox({ platform: 'linux', uid: 1000, cwd, read, stat: noFile, listProfiles: () => [] }).status, 'ok');
    }
});

test('sandbox on Ubuntu 23.10+: a chrome-sandbox that is not setuid root fails, with the chown/chmod fix', () => {
    const read = files({ [restriction]: '1\n' });
    const result = checkSandbox({ platform: 'linux', uid: 1000, cwd, read, stat: () => ({ uid: 1000, mode: 0o100755 }), listProfiles: () => [] });
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /The SUID sandbox helper binary was found, but is not configured correctly/);
    assert.match(result.fix, /sudo chown root:root node_modules\/electron\/dist\/chrome-sandbox && sudo chmod 4755 node_modules\/electron\/dist\/chrome-sandbox/);
    // Owned by root but not setuid is not enough either.
    assert.equal(checkSandbox({ platform: 'linux', uid: 1000, cwd, read, stat: () => ({ uid: 0, mode: 0o100755 }), listProfiles: () => [] }).status, 'fail');
});

test('sandbox on Ubuntu 23.10+: a setuid-root chrome-sandbox, or an AppArmor profile for the binary, passes', () => {
    const read = files({ [restriction]: '1\n' });
    assert.equal(checkSandbox({ platform: 'linux', uid: 1000, cwd, read, stat: () => ({ uid: 0, mode: 0o104755 }), listProfiles: () => [] }).status, 'ok');
    const binary = path.join(cwd, 'node_modules', 'electron', 'dist', 'electron');
    const withProfile = files({ [restriction]: '1\n', '/etc/apparmor.d/electron-dev': `profile electron-dev ${binary} flags=(unconfined) { userns, }` });
    assert.equal(checkSandbox({ platform: 'linux', uid: 1000, cwd, read: withProfile, stat: () => ({ uid: 1000, mode: 0o100755 }), listProfiles: () => ['electron-dev', 'abstractions'] }).status, 'ok');
});

test('sandbox on Ubuntu 23.10+ before Electron is downloaded: a note with the fix to apply afterwards', () => {
    const result = checkSandbox({ platform: 'linux', uid: 1000, cwd, read: files({ [restriction]: '1' }), stat: noFile, listProfiles: () => [] });
    assert.equal(result.status, 'note');
    assert.match(result.detail, /after the first `npm start` downloads Electron/);
    assert.match(result.fix, /chmod 4755/);
});

test('ports: a port something listens on fails with how to find it; a free one passes', async () => {
    const holder = createServer();
    await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
    const { port } = holder.address();
    try {
        const taken = await checkPort(port, '`npm start`');
        assert.equal(taken.status, 'fail');
        assert.match(taken.fix, new RegExp(`lsof -i :${port}`));
    } finally {
        await new Promise(resolve => holder.close(resolve));
    }
    assert.equal((await checkPort(port, '`npm start`')).status, 'ok');
});

test('display: Linux without DISPLAY or WAYLAND_DISPLAY gets a note about xvfb-run; other systems are not checked', () => {
    assert.equal(checkDisplay({ platform: 'linux', env: { DISPLAY: ':0' } }).status, 'ok');
    assert.equal(checkDisplay({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }).status, 'ok');
    const none = checkDisplay({ platform: 'linux', env: {} });
    assert.equal(none.status, 'note');
    assert.match(none.fix, /xvfb-run -a/);
    assert.equal(checkDisplay({ platform: 'win32', env: {} }), null);
});

test('browser: a Chromium that does not start is a note with the install command', async () => {
    // Like Playwright's browser type, launch() needs its object as `this`.
    const browserType = { browser: { close: async () => {} }, async launch() { return this.browser; } };
    assert.equal((await checkBrowser({ loadChromium: async () => browserType })).status, 'ok');
    const missing = await checkBrowser({ loadChromium: async () => ({ async launch() { throw new Error("browserType.launch: Executable doesn't exist at /x\nmore"); } }) });
    assert.equal(missing.status, 'note');
    assert.match(missing.detail, /Executable doesn't exist at \/x\)/);
    assert.match(missing.fix, /npx playwright install chromium/);
});

test('report: one line per check, fixes under failures and notes, and the count of problems', () => {
    const text = report([
        { status: 'ok', name: 'Node.js', detail: '24.3.0' },
        null,
        { status: 'note', name: 'Display', detail: 'none', fix: 'use xvfb-run -a' },
        { status: 'fail', name: 'Port 5174', detail: 'in use', fix: 'stop it' },
    ]);
    assert.equal(text, [
        'ok    Node.js: 24.3.0',
        'note  Display: none',
        '      Fix: use xvfb-run -a',
        'FAIL  Port 5174: in use',
        '      Fix: stop it',
        'doctor: 1 problem to fix first',
    ].join('\n'));
    assert.match(report([{ status: 'ok', name: 'Node.js', detail: '24' }]), /doctor: nothing blocks npm start or npm run verify$/);
});

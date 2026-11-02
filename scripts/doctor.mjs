// `npm run doctor`: checks this machine for what stops `npm start`, `npm run verify`
// and `npm run test:live`, before any of them runs, and prints the fix for each
// problem. It changes nothing. Exit code 1 when a check fails.
//
// The checks are plain functions that take their probes (file reads, the platform,
// the user id, the environment) as arguments, so tests can drive every case.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Linux-only paths, so POSIX separators whatever the host (the tests also run on Windows).
const SANDBOX_HELPER = path.posix.join('node_modules', 'electron', 'dist', 'chrome-sandbox');
const USERNS_RESTRICTION = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
// The executable inside node_modules/electron/dist/, as electron's install.js names it.
const ELECTRON_EXECUTABLE = { win32: 'electron.exe', darwin: 'Electron.app/Contents/MacOS/Electron', mas: 'Electron.app/Contents/MacOS/Electron' };

const ok = (name, detail) => ({ status: 'ok', name, detail });
const note = (name, detail, fix) => ({ status: 'note', name, detail, fix });
const fail = (name, detail, fix) => ({ status: 'fail', name, detail, fix });
const readOrNull = (read, file) => { try { return read(file); } catch { return null; } };

/** Node.js 22.12 or later: Vite 7 and the test runner need it. */
export function checkNode(version = process.versions.node) {
    const [major, minor] = version.split('.').map(Number);
    return major > 22 || (major === 22 && minor >= 12)
        ? ok('Node.js', `${version} (22.12 or later needed)`)
        : fail('Node.js', `${version} is too old: Vite 7 and the tests need 22.12 or later`,
            'Install Node.js 22.12 or later; with nvm, `nvm install` in this folder reads .nvmrc');
}

/** The locked dependencies are installed. */
export function checkDependencies({ exists = existsSync, cwd = root } = {}) {
    const missing = ['vite', 'electron', 'playwright'].filter(name => !exists(path.join(cwd, 'node_modules', name, 'package.json')));
    return missing.length === 0
        ? ok('Dependencies', 'installed')
        : fail('Dependencies', `not installed (${missing.join(', ')} missing from node_modules)`, 'Run `npm ci` in this folder');
}

/** The Electron binary, which the first `npm start` downloads. */
export function checkElectron({ exists = existsSync, read = file => readFileSync(file, 'utf8'), platform = process.platform, cwd = root } = {}) {
    const dir = path.join(cwd, 'node_modules', 'electron');
    const executable = readOrNull(read, path.join(dir, 'path.txt'))?.trim() || ELECTRON_EXECUTABLE[platform] || 'electron';
    return exists(path.join(dir, 'dist', executable))
        ? ok('Electron', 'binary downloaded')
        : note('Electron', 'binary not downloaded yet: the first `npm start` downloads it, which needs the network');
}

/**
 * Chromium's sandbox, which Electron keeps on (never pass --no-sandbox). On Linux it
 * refuses to start as root, and where the kernel lets only processes with an AppArmor
 * profile use unprivileged user namespaces (Ubuntu 23.10 and later), the downloaded
 * Electron has neither a profile nor a setuid-root chrome-sandbox, so `npm start`
 * stops with "The SUID sandbox helper binary was found, but is not configured correctly".
 * Returns null where the check does not apply (not Linux).
 */
export function checkSandbox({
    platform = process.platform, uid = process.getuid?.(), cwd = root,
    read = file => readFileSync(file, 'utf8'), stat = statSync, listProfiles = () => readdirSync('/etc/apparmor.d'),
} = {}) {
    if (platform !== 'linux') return null;
    const name = 'Electron sandbox';
    if (uid === 0) {
        return fail(name, 'running as root: Chromium will not start with its sandbox on, so `npm start` would fail',
            'Run npm as your normal user, not as root or with sudo');
    }
    if (readOrNull(read, USERNS_RESTRICTION)?.trim() !== '1') return ok(name, 'user namespaces are available to Electron');
    const helper = path.posix.join(cwd, SANDBOX_HELPER);
    const fix = `Run once (again after every \`npm ci\`): sudo chown root:root ${SANDBOX_HELPER} && sudo chmod 4755 ${SANDBOX_HELPER}`
        + ' (or install the .deb, which sets this up for the installed app)';
    let info;
    try {
        info = stat(helper);
    } catch {
        return note(name, 'this system blocks unprivileged user namespaces (Ubuntu 23.10 or later); after the first `npm start` downloads Electron, it will need a setuid-root chrome-sandbox', fix);
    }
    if (info.uid === 0 && (info.mode & 0o4755) === 0o4755) return ok(name, 'chrome-sandbox is setuid root, which this system needs');
    // An AppArmor profile for the dev binary, as the .deb installs for /opt/DDS response, also works.
    const binary = path.posix.join(cwd, 'node_modules', 'electron', 'dist', 'electron');
    const profiled = (readOrNull(listProfiles, null) ?? []).some(file => readOrNull(read, path.posix.join('/etc/apparmor.d', file))?.includes(binary));
    if (profiled) return ok(name, 'an AppArmor profile in /etc/apparmor.d allows the Electron in node_modules');
    return fail(name, 'this system blocks unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1) and '
        + `${SANDBOX_HELPER} is not setuid root, so \`npm start\` will stop with "The SUID sandbox helper binary was found, but is not configured correctly"`, fix);
}

/** Whether a TCP port on 127.0.0.1 is free, by trying to listen on it. */
export function checkPort(port, users, { host = '127.0.0.1' } = {}) {
    const name = `Port ${port}`;
    return new Promise(resolve => {
        const probe = createServer();
        probe.once('error', error => resolve(error.code === 'EADDRINUSE'
            ? fail(name, `in use, so ${users} cannot start`, `Stop what holds it: \`lsof -i :${port}\` (Linux, macOS) or \`netstat -ano | findstr ${port}\` (Windows) shows it`)
            : note(name, `could not be checked (${error.code})`)));
        probe.listen(port, host, () => probe.close(() => resolve(ok(name, `free (${users})`))));
    });
}

/** A display, which Electron needs on Linux. Returns null where the check does not apply. */
export function checkDisplay({ platform = process.platform, env = process.env } = {}) {
    if (platform !== 'linux') return null;
    const display = env.WAYLAND_DISPLAY || env.DISPLAY;
    return display
        ? ok('Display', display)
        : note('Display', 'none: `npm start` and `npm run test:live` need one', 'On a machine without a screen, put `xvfb-run -a` in front of them');
}

/** Playwright's Chromium, which the browser regressions in `npm run verify` drive. */
export async function checkBrowser({ loadChromium = async () => (await import('playwright')).chromium } = {}) {
    const name = 'Playwright Chromium';
    try {
        // launch() is a method: called detached from its browser type it has no `this`.
        const chromium = await loadChromium();
        await (await chromium.launch()).close();
        return ok(name, 'starts');
    } catch (error) {
        return note(name, `does not start (${error.message.split('\n')[0]}), so \`npm run verify\` can run only with --quick`,
            'Run `npx playwright install chromium` (`--with-deps` on a fresh Linux box)');
    }
}

/** The report: one line per check, its fix under it, and the outcome. */
export function report(results) {
    const label = { ok: 'ok  ', note: 'note', fail: 'FAIL' };
    const lines = [];
    for (const result of results.filter(Boolean)) {
        lines.push(`${label[result.status]}  ${result.name}: ${result.detail}`);
        if (result.fix && result.status !== 'ok') lines.push(`      Fix: ${result.fix}`);
    }
    const failures = results.filter(result => result?.status === 'fail').length;
    lines.push(failures === 0 ? 'doctor: nothing blocks npm start or npm run verify'
        : `doctor: ${failures} problem${failures === 1 ? '' : 's'} to fix first`);
    return lines.join('\n');
}

async function main() {
    const results = [
        checkNode(),
        checkDependencies(),
        checkElectron(),
        checkSandbox(),
        await checkPort(5174, '`npm start`, `npm run dev`, `npm run verify` and `npm run test:live`'),
        await checkPort(4174, '`npm run verify`'),
        checkDisplay(),
        await checkBrowser(),
    ];
    console.log(report(results));
    process.exitCode = results.some(result => result?.status === 'fail') ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

// `npm run verify`: what CI's Linux job checks, in one command, from the
// repository root: the unit tests, lint (warnings fail too), the production
// renderer build, then the browser regressions against the Vite dev server and
// against `vite preview` of that build. It starts each server itself, stops it
// when its step ends (also when the step fails or the run is interrupted), and
// stops at the first failure. `npm run verify -- --quick` runs the first three
// only, which need no browser.
//
// The browser regressions need Playwright's Chromium (`npx playwright install
// chromium`), and both servers need their ports free: 5174 (an `npm run dev` or
// `npm start` holds it) and 4174.
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { startDevServer } from './live-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEV_URL = 'http://127.0.0.1:5174';
export const PREVIEW_URL = 'http://127.0.0.1:4174';

/**
 * The checks, in order. A step with `server` runs its command while that server answers.
 * @param {{ quick?: boolean, node?: string, cwd?: string }} options
 * @returns {{ name: string, command: string[], env?: Record<string, string>, server?: { url: string, command: string[] } }[]}
 */
export function verifySteps({ quick = false, node = process.execPath, cwd = root } = {}) {
    const vite = path.join(cwd, 'node_modules', 'vite', 'bin', 'vite.js');
    const steps = [
        { name: 'unit tests', command: ['npm', 'test'] },
        { name: 'lint', command: ['npm', 'run', 'lint', '--', '--max-warnings', '0'] },
        { name: 'renderer build', command: ['npm', 'run', 'build:renderer'] },
    ];
    if (quick) return steps;
    return [...steps,
        { name: 'browser regressions on the dev server', command: ['npm', 'run', 'test:ui'], env: { UI_BASE_URL: DEV_URL },
            server: { url: `${DEV_URL}/`, command: [node, vite, '--host', '127.0.0.1', '--port', '5174', '--strictPort'] } },
        // Only the production build carries the Content Security Policy.
        { name: 'browser regressions on the production build', command: ['npm', 'run', 'test:ui'], env: { UI_BASE_URL: PREVIEW_URL },
            server: { url: `${PREVIEW_URL}/`, command: [node, vite, 'preview', '--host', '127.0.0.1', '--port', '4174', '--strictPort'] } },
    ];
}

/**
 * Runs the steps in order and stops at the first failure. A step's server is stopped
 * when the step ends, whatever its outcome.
 * @param {ReturnType<typeof verifySteps>} steps
 * @param {{ run: (command: string[], env?: Record<string, string>) => Promise<number>,
 *           startServer: (server: { url: string, command: string[] }) => Promise<{ stop: () => Promise<void> }>,
 *           log?: (message: string) => void, now?: () => number }} io
 * @returns {Promise<{ name: string, ok: boolean, ms: number, error?: string }[]>}
 */
export async function runVerify(steps, { run, startServer, log = message => console.error(message), now = Date.now }) {
    const results = [];
    for (const step of steps) {
        log(`\nverify: ${step.name}`);
        const started = now();
        let server = null;
        let result;
        try {
            if (step.server) server = await startServer(step.server);
            const code = await run(step.command, step.env);
            result = code === 0 ? { ok: true } : { ok: false, error: `${step.command.join(' ')} exited with code ${code}` };
        } catch (error) {
            result = { ok: false, error: error.message };
        } finally {
            if (server) await server.stop();
        }
        results.push({ name: step.name, ms: now() - started, ...result });
        if (!result.ok) break;
    }
    return results;
}

/** One line per step that ran, then the outcome. */
export function summary(results, total) {
    const lines = results.map(({ name, ok, ms, error }) =>
        `${ok ? 'ok  ' : 'FAIL'}  ${name} (${(ms / 1000).toFixed(1)} s)${error ? `: ${error}` : ''}`);
    const failed = results.find(result => !result.ok);
    lines.push(failed ? `verify failed at: ${failed.name}`
        : results.length === total ? 'verify: all checks passed' : 'verify: stopped before every check ran');
    return lines.join('\n');
}

// Waits for a process to exit; whatever has not exited `grace` ms after SIGTERM is killed.
const stopProcess = (child, grace = 5000) => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const kill = setTimeout(() => child.kill('SIGKILL'), grace);
    child.once('exit', () => { clearTimeout(kill); resolve(); });
    child.kill('SIGTERM');
});

async function main() {
    const quick = process.argv.includes('--quick');
    const steps = verifySteps({ quick });
    if (!quick) {
        // Launch it once, as the browser regressions will: a missing browser fails here in
        // a second, with the fix, instead of after the tests and the build.
        const { chromium } = await import('playwright');
        try {
            await (await chromium.launch()).close();
        } catch (error) {
            console.error(`verify: the browser regressions cannot run, because Playwright's Chromium does not start:\n${error.message.split('\n')[0]}\n`
                + 'Install it with `npx playwright install chromium` (on Linux CI: `npx playwright install --with-deps chromium`),\n'
                + 'or run `npm run verify -- --quick` for the tests, lint and build only.');
            process.exitCode = 1;
            return;
        }
    }
    let current = null;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.once(signal, async () => {
            if (current) await stopProcess(current);
            process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[signal]);
        });
    }
    // npm is a .cmd script on Windows, which Node runs only through a shell; the
    // steps' arguments are plain words, so the joined command needs no quoting.
    const run = (command, env) => new Promise(resolve => {
        const options = { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } };
        const child = process.platform === 'win32'
            ? spawn(command.join(' '), { ...options, shell: true })
            : spawn(command[0], command.slice(1), options);
        child.once('error', error => { console.error(`verify: ${command[0]}: ${error.message}`); resolve(1); });
        child.once('exit', (code, signal) => resolve(signal ? 1 : code));
    });
    const startServer = async ({ url, command }) => {
        current = await startDevServer({ url, command, cwd: root });
        const server = current;
        return { stop: async () => { await stopProcess(server); current = null; } };
    };
    const results = await runVerify(steps, { run, startServer });
    console.error(`\n${summary(results, steps.length)}`);
    process.exitCode = results.length === steps.length && results.every(result => result.ok) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

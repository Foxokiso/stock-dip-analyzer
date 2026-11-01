// `npm start`: runs the renderer dev server, then Electron once it answers, and
// stops both together. Node starts each of them itself, with no shell in between.
//
// npm runs a script through a shell (sh -c, or cmd.exe on Windows). Sent SIGTERM,
// as an editor's Stop button or `kill` does, npm passes it to that shell only, and
// the shell exits without passing it on. Under the previous `concurrently` command
// that left concurrently, Vite and Electron running, with Vite still holding
// 127.0.0.1:5174. So this launcher stops both on SIGINT, SIGTERM or SIGHUP, and also
// when the process that started it has exited, the only sign it gets in npm's case.
//
// Closing the app window ends the run and stops Vite. If either one exits on its
// own, the other is stopped too. Arguments after `npm start --` go to Electron.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { startDevServer } from './live-checks.mjs';

/**
 * Starts the dev server, then the app once the server answers. Resolves `done`
 * with the exit code once everything it started has exited:
 * - the app exiting stops the server, with the app's exit code (0 when its window was closed);
 * - the server failing to start, or exiting with an error, stops the app, with code 1;
 * - stop() stops both, with code 0.
 * A process that exits with code 0, or after a stop signal, was stopped rather than
 * failed: Ctrl+C in a terminal reaches Vite and Electron directly too, and either
 * may exit before this process has handled its own copy of the signal.
 * Whatever does not exit within `grace` ms of being asked is killed.
 * @param {{ devServer: { url: string, command: string[], cwd?: string, attempts?: number, interval?: number },
 *           app: { command: string, args?: string[], cwd?: string, env?: NodeJS.ProcessEnv },
 *           grace?: number, log?: (message: string) => void }} options
 * @returns {{ done: Promise<number>, started: Promise<{ server: import('node:child_process').ChildProcess, app: import('node:child_process').ChildProcess } | null>, stop: (reason: string) => void }}
 */
const STOP_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP']);
const stopped = (exitCode, signal) => exitCode === 0 || STOP_SIGNALS.has(signal);
const how = (exitCode, signal) => signal ?? `exit code ${exitCode}`;

export function launch({ devServer, app, grace = 5000, log = message => console.error(`npm start: ${message}`) }) {
  const running = new Set();
  let stopping = false;
  let starting = true;
  let code = 0;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const settle = () => { if (stopping && !starting && running.size === 0) finish(code); };
  const stopAll = () => {
    for (const child of running) child.kill('SIGTERM');
    setTimeout(() => { for (const child of running) child.kill('SIGKILL'); }, grace).unref();
  };
  const end = (reason, exitCode) => {
    if (stopping) return;
    stopping = true;
    code = exitCode;
    if (reason) log(reason);
    stopAll();
    settle();
  };
  const track = (child, onExit) => {
    running.add(child);
    child.once('exit', (exitCode, signal) => {
      running.delete(child);
      onExit(exitCode, signal);
      settle();
    });
  };

  const started = (async () => {
    let server;
    try {
      server = await startDevServer({ ...devServer, echo: true });
    } catch (error) {
      starting = false;
      end(stopping ? null : `the dev server did not start: ${error.message}`, 1);
      settle();
      return null;
    }
    track(server, (exitCode, signal) => end(stopped(exitCode, signal)
      ? 'the dev server stopped; stopping the app'
      : `the dev server exited (${how(exitCode, signal)}); stopping the app`, stopped(exitCode, signal) ? 0 : 1));
    if (stopping) { starting = false; stopAll(); return null; }
    const child = spawn(app.command, app.args ?? [], { cwd: app.cwd, env: app.env ?? process.env, stdio: 'inherit' });
    // A command that cannot be run emits 'error' and never 'exit'.
    child.once('error', error => {
      running.delete(child);
      end(`the app did not start: ${error.message}`, 1);
      settle();
    });
    track(child, (exitCode, signal) => end(stopped(exitCode, signal) ? null : `the app exited (${how(exitCode, signal)})`,
      stopped(exitCode, signal) ? 0 : exitCode ?? 1));
    starting = false;
    settle();
    return { server, app: child };
  })();

  return { done, started, stop: reason => end(reason, 0) };
}

/**
 * Calls onGone once the process that started this one has exited: on Linux and
 * macOS this process is then re-parented, and on Windows the old parent ID no
 * longer answers. Checks every `interval` ms; the timer does not keep Node alive.
 * @param {() => void} onGone
 * @returns {NodeJS.Timeout}
 */
export function watchParent(onGone, interval = 1000) {
  const parent = process.ppid;
  const gone = () => {
    if (process.ppid !== parent) return true;
    try { process.kill(parent, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  };
  const timer = setInterval(() => { if (gone()) { clearInterval(timer); onGone(); } }, interval);
  timer.unref();
  return timer;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Resolving the electron package downloads its binary on first use (see README).
  const electron = createRequire(import.meta.url)('electron');
  const run = launch({
    devServer: {
      url: 'http://127.0.0.1:5174/', cwd: root,
      command: [process.execPath, path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5174', '--strictPort'],
    },
    app: { command: electron, args: ['.', ...process.argv.slice(2)], cwd: root, env: { ...process.env, NODE_ENV: 'development' } },
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => run.stop(`${signal} received; stopping Vite and Electron`));
  watchParent(() => run.stop('the process that started npm start has exited; stopping Vite and Electron'));
  process.exitCode = await run.done;
}

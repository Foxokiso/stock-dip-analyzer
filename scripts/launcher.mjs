// What `npm start` (scripts/start.mjs) does, as functions the tests can drive with
// stand-ins for Vite and Electron: start the dev server, then the app once the
// server answers, and stop both together.
//
// npm runs a script through a shell (sh -c, or cmd.exe on Windows). Sent SIGTERM,
// as an editor's Stop button or `kill` does, npm passes it to that shell only, and
// the shell exits without passing it on. Under the previous `concurrently` command
// that left concurrently, Vite and Electron running, with Vite still holding
// 127.0.0.1:5174. So start.mjs starts both itself, with no shell in between, stops
// them on SIGINT, SIGTERM or SIGHUP, and also stops them when the process that
// started it has exited, the only sign it gets in npm's case (watchParent).
import { spawn } from 'node:child_process';
import process from 'node:process';
import { startDevServer } from './live-checks.mjs';

const STOP_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP']);
// Exit codes of a process that was asked to stop: 128 + SIGHUP, SIGINT or SIGTERM
// (Vite exits 143 on SIGTERM), and Windows' STATUS_CONTROL_C_EXIT, which Vite and
// Electron end with when Ctrl+C reaches them through the console.
const STOP_EXIT_CODES = new Set([129, 130, 143, 0xC000013A]);

/**
 * Whether a process that exited this way was stopped (or quit) rather than failed.
 * Ctrl+C in a terminal reaches Vite and Electron directly too, and either may exit
 * before the launcher has handled its own copy of the signal.
 * @param {number | null} exitCode
 * @param {NodeJS.Signals | null} signal
 */
export const stoppedExit = (exitCode, signal) => exitCode === 0 || STOP_EXIT_CODES.has(exitCode) || STOP_SIGNALS.has(signal);
const how = (exitCode, signal) => signal ?? `exit code ${exitCode}`;

/**
 * Starts the dev server, then the app once the server answers. Resolves `done`
 * with the exit code once everything it started has exited:
 * - the app quitting stops the server, with code 0; the app failing stops it with the app's code;
 * - the server failing to start, or failing later, stops the app, with code 1;
 * - stop() stops both, with code 0, also while the server is still starting.
 * Whatever does not exit within `grace` ms of being asked is killed.
 * @param {{ devServer: { url: string, command: string[], cwd?: string, attempts?: number, interval?: number, echo?: boolean },
 *           app: { command: string, args?: string[], cwd?: string, env?: NodeJS.ProcessEnv },
 *           grace?: number, log?: (message: string) => void }} options  devServer.echo (default true): show the server's output
 * @returns {{ done: Promise<number>, started: Promise<{ server: import('node:child_process').ChildProcess, app: import('node:child_process').ChildProcess } | null>, stop: (reason: string) => void }}
 */
export function launch({ devServer, app, grace = 5000, log = message => console.error(`npm start: ${message}`) }) {
  const running = new Set();
  const cancel = new AbortController();
  let stopping = false;
  let starting = true;
  let code = 0;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const settle = () => { if (stopping && !starting && running.size === 0) finish(code); };
  const stopAll = () => {
    cancel.abort();
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
  // Also handles a child that exited before it was tracked: its 'exit' has been emitted already.
  const track = (child, onExit) => {
    running.add(child);
    const exited = (exitCode, signal) => {
      running.delete(child);
      onExit(exitCode, signal);
      settle();
    };
    if (child.exitCode !== null || child.signalCode !== null) queueMicrotask(() => exited(child.exitCode, child.signalCode));
    else child.once('exit', exited);
  };

  const started = (async () => {
    let server;
    try {
      server = await startDevServer({ echo: true, ...devServer, signal: cancel.signal, grace });
    } catch (error) {
      starting = false;
      end(`the dev server did not start: ${error.message}`, 1);
      settle();
      return null;
    }
    track(server, (exitCode, signal) => end(stoppedExit(exitCode, signal)
      ? 'the dev server stopped; stopping the app'
      : `the dev server exited (${how(exitCode, signal)}); stopping the app`, stoppedExit(exitCode, signal) ? 0 : 1));
    if (stopping) { starting = false; stopAll(); return null; }
    let child;
    try {
      child = spawn(app.command, app.args ?? [], { cwd: app.cwd, env: app.env ?? process.env, stdio: 'inherit' });
    } catch (error) {
      // Some failures throw here rather than emitting 'error': an invalid argument, or
      // EFTYPE on Windows for an executable of the wrong architecture.
      starting = false;
      end(`the app did not start: ${error.message}`, 1);
      return null;
    }
    // A command that cannot be run (ENOENT) emits 'error' and never 'exit'.
    child.once('error', error => {
      running.delete(child);
      end(`the app did not start: ${error.message}`, 1);
      settle();
    });
    track(child, (exitCode, signal) => end(stoppedExit(exitCode, signal) ? null : `the app exited (${how(exitCode, signal)})`,
      stoppedExit(exitCode, signal) ? 0 : exitCode ?? 1));
    starting = false;
    settle();
    return { server, app: child };
  })().catch(error => {
    // Not expected; whatever it is, stop what was started rather than leave it running.
    starting = false;
    end(`npm start failed: ${error.message}`, 1);
    settle();
    return null;
  });

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

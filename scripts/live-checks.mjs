// What scripts/verify-live-electron.mjs fails on, as a pure function of its
// report so it can be tested without Electron. Security and app checks always
// fail the run. Live-data checks (rows, scores, values per route) fail it too,
// unless dataOptional turns them into warnings for a run during a provider
// outage, when only the security checks are wanted. Errors whose stack points
// at a third-party script (TradingView's chart) are warnings; errors with no
// source count as the app's. Provider redirects the main process refused are
// warnings too. It also starts the dev server the script measures
// (startDevServer), so how that start fails can be tested without Electron too.
import { spawn } from 'node:child_process';

const SANDBOX = 'allow-scripts allow-same-origin';
// A request the main process refuses is an app bug, not provider noise: the app
// asked for an invalid chart symbol, range or interval, or a host off the
// allowlist. Desks log some to the console; the main process logs every handler
// rejection. (The harness's own refused-host probe is never collected: the
// main-process log filter leaves out its "Refused request" wording.)
const REFUSED_REQUEST = /Refused (chart )?request/;
// A refused redirect is the provider's answer to a request the app was allowed
// to make: Yahoo sending its chart URL to a consent or captcha page, or a
// Finviz or Google News hop off the allowlist. The desks report it like any
// provider failure, so it is noise; a desk it leaves without data still fails
// the live-data checks.
const REFUSED_REDIRECT = /Refused redirect/;

/**
 * The script an uncaught page error came from: the URL of the first stack frame
 * that names one, or '' when none does.
 * @param {string} [stack]
 */
export function errorSource(stack) {
  for (const line of String(stack ?? '').split('\n')) {
    const url = /^\s*at .*?((?:https?|file):\/\/[^\s()]+?):\d+:\d+\)?$/.exec(line)?.[1];
    if (url) return url;
  }
  return '';
}

/**
 * @param {object} report  the report verify-live-electron writes to artifacts/live/report.json
 * @param {{ packaged?: boolean, dataOptional?: boolean }} [options]  packaged: a built app (ELECTRON_EXE), which carries the CSP
 * @returns {{ failures: string[], warnings: string[] }}
 */
export function liveFailures(report, { packaged = false, dataOptional = false } = {}) {
  const failures = [];
  const data = [];
  const noise = []; // third-party page errors and refused provider redirects: reported, never failures
  const fail = (condition, message) => { if (condition) failures.push(message); };
  const missingData = (condition, message) => { if (condition) data.push(message); };

  fail(report.fatal, `fatal: ${report.fatal}`);

  const isolation = report.isolation;
  if (!isolation || isolation.error) {
    failures.push(`isolation: the probe did not complete${isolation?.error ? ` (${isolation.error})` : ''}`);
  } else {
    fail(isolation.nodeRequire !== 'undefined', `isolation: window.require is ${isolation.nodeRequire} in the renderer`);
    fail(isolation.process !== 'undefined', `isolation: window.process is ${isolation.process} in the renderer`);
    fail(isolation.bridge !== 'function', `isolation: window.dipAnalyzer.invoke is ${isolation.bridge}`);
    fail(JSON.stringify(isolation.bridgeKeys) !== '["invoke"]', `isolation: the bridge exposes ${JSON.stringify(isolation.bridgeKeys)}, not only invoke`);
    fail(!/Unknown desktop channel/.test(isolation.unknownChannel ?? ''), `isolation: an unknown channel answered "${isolation.unknownChannel}"`);
    fail(!/Refused request/.test(isolation.refusedHost ?? ''), `isolation: a request to a host off the allowlist answered "${isolation.refusedHost}"`);
    fail(packaged && !isolation.csp, 'isolation: the packaged renderer has no Content Security Policy');
    fail(isolation.tradingViewSandbox !== SANDBOX, `isolation: the TradingView iframe is sandboxed as "${isolation.tradingViewSandbox}", not "${SANDBOX}"`);
    const guests = Array.isArray(isolation.guests) ? isolation.guests : [];
    fail(guests.length === 0, 'isolation: no research viewer was attached, so no guest was probed');
    for (const guest of guests) {
      fail(guest.node !== false, `isolation: the research viewer at ${guest.url} reaches Node (${guest.node})`);
      fail(guest.research !== true, `isolation: the research viewer at ${guest.url} is not in the hardened research session: will-attach-webview did not run`);
    }
  }

  fail(report.clipboard !== 'Copied to the clipboard.', `clipboard: Settings → Backup → Copy reported "${report.clipboard ?? 'nothing'}"`);
  fail(report.cspViolations?.length > 0, `csp: ${report.cspViolations?.length} kind(s) of violation, first ${report.cspViolations?.[0]?.key}`);
  fail(report.cspError, `csp: the violations could not be read (${report.cspError})`);
  // An error from the app's own scripts fails the run, and so does one whose
  // source is unknown; one from a third-party frame (TradingView's chart) is
  // only reported.
  const fromApp = ({ source }) => !source || source.startsWith('file:') || !report.baseUrl || source.startsWith(report.baseUrl);
  const pageErrors = report.pageErrors || [];
  const appErrors = pageErrors.filter(fromApp);
  fail(appErrors.length > 0, `page errors: ${appErrors.length}, first ${appErrors[0]?.message} (${appErrors[0]?.source || 'no source'})`);
  for (const { message, source } of pageErrors.filter(error => !fromApp(error))) noise.push(`page error in ${source}: ${message}`);
  const logged = [...(report.consoleErrors || []), ...(report.mainProcessErrors || [])];
  const refused = logged.filter(line => REFUSED_REQUEST.test(line));
  fail(refused.length > 0, `refused requests: ${refused.length}, first ${refused[0]}`);
  const redirects = logged.filter(line => REFUSED_REDIRECT.test(line));
  if (redirects.length > 0) noise.push(`refused redirects: ${redirects.length}, first ${redirects[0]}`);

  const overview = report.overview || {};
  missingData(overview.firstRow == null, 'overview: no live screener row appeared');
  missingData(!(overview.rows > 0), 'overview: the scan listed no rows');
  missingData(!(overview.scored > 0), 'overview: no row was scored');
  missingData(overview.complete === false, 'overview: the scan was still running after 120 s');
  for (const route of report.routes || []) {
    const where = `${route.name} (${route.pass})`;
    missingData(route.ms?.data == null && route.ms?.playwrightData == null, `${where}: no live data appeared`);
    for (const [key, at] of Object.entries(route.extraMs || {})) missingData(at == null, `${where}: ${key} never appeared`);
  }
  const returnVisit = report.returnVisit || {};
  missingData(returnVisit.firstRow == null && returnVisit.playwrightRow == null, 'return visit: no Overview row on returning');
  missingData(!(returnVisit.rows > 0), 'return visit: the Overview showed no rows');

  return dataOptional ? { failures, warnings: [...noise, ...data] } : { failures: [...failures, ...data], warnings: noise };
}

/**
 * Starts the renderer dev server for a live run and resolves with its process
 * once it answers. The command runs with no npx or shell in between, so killing
 * the process stops the server itself. Whatever already answers at the URL is
 * refused rather than measured, as it may serve another checkout. A server that
 * exits before it answers fails the start at once, with its own reason, and one
 * that never answers is killed: a failed start leaves nothing running.
 * @param {{ url: string, command: string[], cwd?: string, attempts?: number, interval?: number }} options  command: the executable, then its arguments; attempts: polls of the URL, interval ms apart
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
export async function startDevServer({ url, command, cwd, attempts = 60, interval = 500 }) {
  const answers = () => fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  if (await answers()) throw new Error(`something already answers on ${url} (npm run dev, or a server an earlier run left behind); stop it and run again`);
  const [executable, ...args] = command;
  const server = spawn(executable, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
  let exited = null;
  let stderr = '';
  server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 400); });
  server.once('error', error => { exited ??= error.message; });
  // 'close', not 'exit': only then has everything it wrote to stderr been read.
  server.once('close', (code, signal) => { exited ??= signal ?? `exit code ${code}`; });
  for (let i = 0; i < attempts && exited === null; i++) {
    if ((await answers())?.ok && exited === null) return server;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  if (exited !== null) throw new Error(`the dev server exited (${exited}) before it answered: ${stderr.trim() || 'no output'}`);
  // Not asked to stop: a server that never answered may not handle that either.
  server.kill('SIGKILL');
  throw new Error('dev server did not start');
}

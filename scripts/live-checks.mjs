// What scripts/verify-live-electron.mjs fails on, as a pure function of its
// report so it can be tested without Electron. Security and app checks always
// fail the run. Live-data checks (rows, scores, values per route) fail it too,
// unless dataOptional turns them into warnings for a run during a provider
// outage, when only the security checks are wanted. Errors whose stack points
// at a third-party script (TradingView's chart) are warnings; errors with no
// source count as the app's.

const SANDBOX = 'allow-scripts allow-same-origin';
// A request the main process refuses is an app bug, not provider noise: an
// invalid chart symbol, a host off the allowlist, a redirect off it. Desks log
// some to the console; the main process logs every handler rejection. (The
// harness's own refused-host probe is never collected: the main-process log
// filter leaves out its "Refused request" wording.)
const REFUSED = /Refused (chart request|request|redirect)/;

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
  const thirdParty = [];
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
  for (const { message, source } of pageErrors.filter(error => !fromApp(error))) thirdParty.push(`page error in ${source}: ${message}`);
  const refused = [...(report.consoleErrors || []), ...(report.mainProcessErrors || [])].filter(line => REFUSED.test(line));
  fail(refused.length > 0, `refused requests: ${refused.length}, first ${refused[0]}`);

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

  return dataOptional ? { failures, warnings: [...thirdParty, ...data] } : { failures: [...failures, ...data], warnings: thirdParty };
}

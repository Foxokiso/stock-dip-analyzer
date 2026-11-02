---
trigger: glob
globs: "**/main.cjs, **/preload.cjs, **/vite.config.js, **/src/utils/bridge.js, **/src/utils/inertHtml.js, **/src/utils/tradingView.js, **/tests/mainPolicy.test.js, **/tests/preload.test.js"
description: "Security rules for the Electron main process, the preload bridge, the Content Security Policy and third-party HTML."
---

# Security surface

The app shows third-party content (TradingView's chart in a sandboxed iframe; Finviz, Chartmill, StockCharts, Fidelity and Yahoo Finance pages in research viewers), so the desktop shell is locked down. These must keep holding:

- **Renderer.** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`. The page sees only `window.dipAnalyzer.invoke`, limited to the channels in `CHANNELS` in `preload.cjs`; any other channel is rejected.
- **Network.** `fetch-url` accepts only HTTPS URLs on the hosts in `FETCH_HOSTS` (`main.cjs`), and redirects are checked against the same rule; `fetch-yahoo-chart` builds its own Yahoo URL from a validated symbol, range and interval. Everything else is refused in the main process before a request exists.
- **Navigation and viewers.** The app window cannot navigate away from the app. Research `<webview>`s attach only to HTTPS pages on `RESEARCH_HOSTS`, without Node or a preload, in the in-memory `research` session; a popup opens in the system browser only right after a user gesture.
- **Permissions.** Every permission request is denied, except a clipboard write from the app's own page (Backup → Copy).
- **Content Security Policy.** Production builds get the policy that `vite.config.js` injects: scripts from the app only, frames only from TradingView's host, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`.
- **Provider HTML.** It is made inert (`src/utils/inertHtml.js` strips inline event handlers) before it is parsed.

When you change this code:

1. Never add a channel, a host, a permission or a CSP source, enable Node in any web content, turn off the sandbox, or allow `unsafe-eval` unless the user asked for exactly that change. If a feature seems to need one, stop and ask.
2. Add or update tests: `tests/mainPolicy.test.js` (window, navigation, webview, permission and network policies, run against a stand-in Electron), `tests/preload.test.js`, `tests/bridge.test.js`, `tests/inertHtml.test.js`, `tests/tradingView.test.js`.
3. Run `npm run verify`. The production-build pass of the browser regressions fails on any CSP violation. For a change only Electron shows, also run `npm run test:live`, and against a packaged build (`ELECTRON_EXE`) when the CSP or the packaged app is involved.
4. Keep the *Security* section of `README.md` accurate.

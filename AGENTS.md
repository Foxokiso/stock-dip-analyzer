# AGENTS.md

Instructions for coding agents (Google Antigravity, Codex, Cursor, Claude Code and others) working in this repository. Step-by-step procedures are skills in `.agents/skills/` (run the app, verify a change, repair Finviz parsing, build the Linux packages, cut a release); rules for specific areas load from `.agents/rules/` when you touch those files.

## What this is

Stock Dip Analyzer Pro, installed as **DDS response**: an Electron 45 desktop app with a React 19 + Vite 7 renderer. Finviz supplies the stock screeners and futures, Yahoo Finance's chart endpoint the price history and technical scores, Google News RSS the Oil Watch headlines. A C++20 core in `native/` mirrors several JavaScript modules and is checked against them by parity suites. People run it from an installer (`.deb`, AppImage or Windows NSIS, attached to each GitHub Release) or from source with `npm start`.

## Commands

Run every command from the repository root, the folder that holds `package.json`. Node.js 22.12 or later (CI uses 24).

| Task | Command | Notes |
|---|---|---|
| Install dependencies | `npm ci` | Uses the lockfile exactly. Use `npm install <pkg>` only to change dependencies. |
| Run the app | `npm start` | Not `npx start`, which looks for an unrelated package. It keeps running until the app quits: start it in the background or a separate terminal and do not wait for it to exit. Ctrl+C or quitting the app stops Vite and Electron together. |
| Layout preview in a browser | `npm run dev`, then open http://127.0.0.1:5174 | Long-running too. Shows layouts and "unavailable" notices only: market data needs the desktop bridge, which exists only in Electron. |
| **Check a change like CI does** | `npm run verify` | Unit tests, lint (warnings fail), renderer build, then the browser regressions against a dev server and a production preview that it starts and stops itself. About 2–3 minutes. `npm run verify -- --quick` skips the browser part. |
| Unit tests | `npm test` | Node's test runner. No Electron, browser or network. |
| Lint | `npm run lint` | Must be clean. |
| Renderer build | `npm run build:renderer` | Writes `dist/`, the renderer the packaged app loads. |
| Live Finviz check | `npm run test:finviz` | Real requests to Finviz, about 10 s. Run it when a desk shows no rows. |
| Live app check | `npm run test:live` | Drives the real Electron app with live data. Needs a display (`xvfb-run -a npm run test:live` on a headless Linux box). |
| Linux packages | `npm run build:renderer && npx electron-builder --linux deb AppImage --x64 --publish never -c.directories.output=release` | See the `build-linux-package` skill. |

## Repository map

- `main.cjs`: Electron main process. Window, navigation lock, permission policy, the network channels (`fetch-url` limited to `FETCH_HOSTS`, `fetch-yahoo-chart`, `configure-network`) and the research `<webview>` policy (`RESEARCH_HOSTS`, the in-memory `research` session).
- `preload.cjs`: the only bridge. `window.dipAnalyzer.invoke(channel, ...args)` for the channels in `CHANNELS`.
- `src/pages/`: the desks. `Dashboard.jsx` (Overview), `Futures.jsx`, `ETFAwards.jsx` (ETF rankings), `OilWatch.jsx`, `Discovery.jsx`, `StockDetails.jsx`, `Settings.jsx`, `NotFound.jsx`.
- `src/utils/`: parsing and logic. `finviz.js` (screener grid), `finvizQuote.js` (quote page), `marketData.js` (Yahoo charts, quote times, alert eligibility), `scoring.js` (recovery score, Simple RSI, verdicts), `format.js`, `oilNews.js`, `alertGates.js`, `bridge.js`, `inertHtml.js`, `chartCache.js`, `pool.js`, `useVisibleInterval.js`, `tradingView.js`.
- `src/services/futures.js`: the Finviz futures API. `src/state/`: settings (`settingsSchema.js` validates every stored and imported value), the scan store, network settings. `src/styles/tokens.css`: the Pierce/27 design tokens; pages use role tokens only.
- `native/`: the C++ core and its parity drivers (`native/README.md`).
- `scripts/`: the `npm start` launcher (`start.mjs`, `launcher.mjs`), `verify.mjs`, the browser and live checks (`verify-*.mjs`, `live-checks.mjs`, `ui-harness.mjs`).
- `tests/`: unit tests (`*.test.js`); `tests/helpers/mainProcess.js` runs `main.cjs` and `preload.cjs` against a stand-in Electron; `tests/fixtures/` holds recorded provider responses, with their provenance in its README.
- `.github/workflows/`: `ci.yml` (Linux checks), `windows-installer.yml`, `linux-packages.yml`, `native-core.yml`, `release.yml`.
- `README.md` and `CHANGELOG.md`: the user-facing record. Keep them true.

## Rules that must hold

1. **Data integrity.** Runtime views never show synthetic, mock or placeholder market data. A value that is unknown or invalid stays "unavailable", never 0 and never a Hold rating. Retrieval time and the source's quote time are separate fields; one never stands in for the other. A failed refresh keeps earlier values only with a stale or cached notice. Recorded fixtures are for tests only.
2. **Security posture.** Keep `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`, the one-function bridge, the host allowlists, the navigation lock, the denied permissions and the Content Security Policy in `vite.config.js`. Do not widen any of them unless the user asks for exactly that.
3. **Native parity.** `src/utils/scoring.js`, `format.js`, `marketData.js`, `oilNews.js`, `src/services/futures.js` and `src/styles/tokens.css` are mirrored in `native/`. A behaviour change in one needs the matching C++ change and passing parity suites.
4. **Tests and checks.** Every change comes with tests that would fail without it, and `npm run verify` passes before you commit. Never skip, weaken or delete a test to get a green run.
5. **Record changes.** Describe user-visible changes in `CHANGELOG.md` under `## Unreleased` (add that heading above the newest version if it is missing), in the existing style: what changed, why, and in which files. Update `README.md` when a command, a requirement or a desk's behaviour changes.
6. **Dependencies.** Change them with npm, never by editing `package-lock.json`. electron-builder is pinned exactly; bump it only with a Windows packaging check.

## Environment pitfalls

- **Ubuntu 23.10 and later (24.04):** `npm start` can stop with "The SUID sandbox helper binary was found, but is not configured correctly". Run `sudo chown root:root node_modules/electron/dist/chrome-sandbox` and `sudo chmod 4755 node_modules/electron/dist/chrome-sandbox` (again after every fresh `npm ci`), or use the installed `.deb`. Never work around it with `--no-sandbox`.
- Chromium will not run as root with its sandbox on: run Electron as a normal user.
- Port 5174 is strict. If something already answers there (an earlier `npm run dev` or `npm start`), `npm start`, `npm run verify` and `npm run test:live` refuse to start and say so: stop that process. `npm run verify` also needs port 4174.
- The first `npm start` downloads the Electron binary (network needed); `npm ci` does not.
- The browser regressions need Playwright's Chromium: `npx playwright install chromium` (`--with-deps` on a fresh Linux box).
- `build_exe.bat` is for Windows only.

## Git, pull requests and releases

- Branch from `master` and open a pull request; pull requests are squash-merged. CI must be green: the Linux checks, the Windows installer, the Linux packages, and the native parity suites when native or mirrored code changes.
- Workflow actions are pinned to full commit SHAs with a version comment; keep it that way (`.agents/rules/github-workflows.md`).
- A release is a version bump plus a pushed `v*` tag; the release workflow builds and publishes everything (the `cut-release` skill). Never create a release in GitHub's web interface: the workflow's publish step would then fail.
- Dependabot opens weekly update pull requests. Run `npm run verify` and start the app before merging a major-version bump.

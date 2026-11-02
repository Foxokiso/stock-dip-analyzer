---
name: verify-changes
description: Check a code change the way CI does before committing or opening a pull request, rerun a single failing check, and pick the extra live checks a change needs. Use after editing code and before any commit, pull request or merge.
---

# Verify a change

1. **While editing**, run the fast checks. One test file runs on its own:

```bash
npm test
node --test tests/scoring.test.js
npm run lint
```

2. **Before committing**, run what CI's Linux job runs, from the repository root:

```bash
npm run verify
```

It runs the unit tests, lint (warnings fail too), the production renderer build, then the browser regressions against a dev server on port 5174 and against `vite preview` of the build on port 4174. It starts and stops both servers itself, stops at the first failure and ends with one line per check. It takes about 2–3 minutes. The browser part needs Playwright's Chromium (`npx playwright install chromium`, with `--with-deps` on a fresh Linux box) and both ports free. `npm run verify -- --quick` runs the tests, lint and build only.

3. **If a check fails**, rerun only that one while you fix it:

| Failing check | Rerun it with |
|---|---|
| unit tests | `npm test` |
| lint | `npm run lint -- --max-warnings 0` |
| renderer build | `npm run build:renderer` |
| browser regressions on the dev server | `npm run dev` in one terminal, then `npm run test:ui` in another |
| browser regressions on the production build | `npm run build:renderer`, then `npm run preview -- --host 127.0.0.1 --port 4174 --strictPort` in one terminal and `UI_BASE_URL=http://127.0.0.1:4174 npm run test:ui` in another |

The browser regressions write screenshots to `artifacts/` (ignored by git); look at them after a visual change.

4. **Add the checks your change needs:**

| You changed | Also run |
|---|---|
| Finviz parsing or URLs (`src/utils/finviz.js`, `src/utils/finvizQuote.js`, `src/services/futures.js`, the desks that build screener URLs) | `npm run test:finviz` |
| `main.cjs`, `preload.cjs`, the CSP, or anything only Electron shows | `npm run test:live` (needs a display; `xvfb-run -a` on headless Linux) |
| A module mirrored in `native/`, or `src/styles/tokens.css` | The parity suites (`.agents/rules/native-parity.md`) |
| Packaging (`package.json` `build`, the workflows) | The `build-linux-package` skill |

5. **Record it.** Describe user-visible changes in `CHANGELOG.md` under `## Unreleased`, and update `README.md` when a command or a desk's behaviour changed.

6. **Report what you ran.** List each check and its result, and say which checks you did not run and why. Never skip, weaken or delete a test to get a green run.

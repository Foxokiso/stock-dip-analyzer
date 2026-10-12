# Windows installer validation for draft PR #6

## Scope and automation

`.github/workflows/windows-installer.yml` runs on pull requests, including drafts,
and supports manual dispatch once available to GitHub. It uses Windows Server
2022 and Node 24, installs the lockfile with npm lifecycle scripts enabled, runs
the 52 native regression tests, ESLint, the production renderer build, and the
existing Playwright UI/alert checks. It then builds x64 NSIS with
`--publish never` and signing discovery disabled. No release or deployment is
created; the installer is retained only as a seven-day Actions validation artifact.

Packaging output is explicitly separated into `release/`, outside the renderer's
`dist/`. The job requires the exact versioned
`stock-dip-analyzer-<version>-x64-setup.exe`, checks size and MZ headers for both
installer and unpacked application executable, checks `resources/app.asar`, and
records the installer's SHA256. Missing outputs fail the job. Actions are pinned
to commit SHAs, checkout does not persist credentials, and token permissions are
read-only. No draft-status skip prevents this PR from being checked.

## NSIS review and correction

The old `customInit` located legacy uninstallers by guessed directory names,
executed them without checking exit status, and unconditionally used `RMDir /r`
on their installation folders. A failed uninstall could therefore still delete
files. It also lacked a silent-mode guard around its interactive MessageBox,
and path existence alone did not establish executable identity. These are
confirmed from the source; destructive behavior was not executed.

The custom migration code has been removed. The referenced include remains as
comments so the standard electron-builder NSIS lifecycle handles upgrades using
the stable `com.stockdipanalyzer.app` identity. A legacy installation with a
different identity is not automatically migrated: its owner should remove it
through Windows Settings. No guessed legacy directory is recursively erased by
custom code. Real upgrade behavior still requires Windows testing.

The current package uses version `0.0.0`, a default Electron icon, and lacks
author/description metadata. The build reports those metadata warnings; they do
not establish packaging failure. Validation artifacts are unsigned: signing,
SmartScreen reputation, release versioning and distribution are outside this
draft validation change.

## Results actually observed locally

Linux workspace, Node 24.19.0, npm 11.9.0, locked Electron 40.9.3 and
electron-builder 26.8.1:

- `npm ci --ignore-scripts=false --no-audit --no-fund`: passed; Electron binary installed.
- `npm test`: 52 passed, zero failed/skipped.
- `npm run lint`: passed.
- `npm run build:renderer`: passed.
- actionlint 1.7.11 on the new workflow: passed.
- `git diff --check`: passed.
- Source checks confirmed the original unsafe instructions and that the replacement
  include contains no executable migration instructions.
- Windows cross-build with the same target/name options (output redirected to
  ignored `artifacts/windows-package/`): produced the unpacked Windows application
  and app.asar. Archive inspection confirmed `main.cjs`, `dist/index.html` and
  `package.json`. Build then failed because Wine is unavailable during Windows
  executable resource processing. **No Windows installer was produced locally.**
- Playwright Chromium installation failed after repeated invalid/truncated ZIP
  responses. `npm run test:ui` then failed because its browser executable was
  absent, before browser assertions ran. **Browser checks were not reverified.**

The Windows Actions job and its PowerShell artifact checks have not been executed
in this Linux workspace. Consult the PR's current check run for runner results;
workflow syntax validation alone is not a successful Windows build.

## Remaining target-platform checks

Even a green packaging job proves artifact production, not installer behavior.
On a disposable Windows account/VM, still verify clean install and application
launch, same-appId upgrade, coexistence/removal of different-appId legacy installs,
silent installation, paths with spaces, Start Menu shortcuts, and uninstall.
Preserve user files and settings during those tests. No installer has been
executed here. PR #6 must remain draft; do not merge, tag, publish or deploy.

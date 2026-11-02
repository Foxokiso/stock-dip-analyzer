---
trigger: glob
globs: "**/.github/workflows/*.yml, **/.github/dependabot.yml"
description: "Conventions for the GitHub Actions workflows: pinned actions, read-only tokens, how a release is published."
---

# GitHub Actions workflows

- **Pin actions to full commit SHAs**, with the version in a comment, as every workflow already does:
  `uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`.
  Look up the commit of a tag with `git ls-remote --tags https://github.com/<owner>/<action>`.
- **Read-only by default.** Each workflow starts with `permissions: contents: read`. Only the `publish` job in `release.yml` has `contents: write`, and it runs no npm and no build tool.
- **Expressions reach scripts through `env:` only.** Never splice `${{ ... }}` into the text of a `run:` script.
- **No secrets in pull-request jobs.** The signing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`) appear only in the environment of the release workflow's Windows build step.
- **What runs where.** `ci.yml` (Linux tests, lint, build, browser regressions) and `linux-packages.yml` (builds the `.deb` and the AppImage, installs the `.deb` on Ubuntu 24.04 and opens the installed app) run on every pull request and push to `master`; `windows-installer.yml` builds and inspects the NSIS installer; `native-core.yml` runs the C++ parity suites when native or mirrored code changes.
- **Releases.** `release.yml` runs when a `v*` tag is pushed: the tag must match `package.json`'s version, `ci.yml` and `native-core.yml` must pass on the tagged commit, then the Windows and Linux builds hand their files to `publish`, which writes `SHA256SUMS.txt` and creates the GitHub Release. A release created in the web interface makes `publish` fail.
- **Keep checks meaningful.** The installed-app check in `linux-packages.yml` waits for the window title React sets (`Overview — Dip Analyzer PRO`), not `index.html`'s static title, which would pass even if the app never mounted.
- When a workflow changes, update the CI paragraph in `README.md` (*Verify and build*).

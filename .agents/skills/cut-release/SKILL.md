---
name: cut-release
description: Publish a new version as a GitHub Release carrying the Windows installer, the .deb, the AppImage and their SHA-256 sums. Use when the user asks to release, publish or ship a version.
---

# Cut a release

A release is public. Get the user's go-ahead before step 5.

1. **Choose the version.** Fixes only: raise the patch number (2.2.0 → 2.2.1). New features: raise the minor number (2.2.0 → 2.3.0).

2. **Set it** in `package.json` and `package-lock.json` together, without a commit or a tag:

```bash
npm version 2.3.0 --no-git-tag-version
```

3. **Write it down.**
   - In `CHANGELOG.md`, rename `## Unreleased` to `## 2.3.0 (YYYY-MM-DD)`.
   - In `README.md`, add a `## Release Notes v2.3.0` section above the previous one, with a short summary and the checks run.

4. **Verify and merge.** Run `npm run verify` and open a pull request titled `Release 2.3.0`. Once every check is green and the user agrees, squash-merge it.

5. **Tag the merged commit and push the tag.** This starts the release:

```bash
git fetch origin master
git tag -a v2.3.0 -m "Stock Dip Analyzer 2.3.0" origin/master
git push origin v2.3.0
```

   Without git, or where tags cannot be pushed: **Actions → Release → Run workflow**, branch `master`, version `2.3.0`. The workflow checks the version against `package.json` and its publish job creates the `v2.3.0` tag on the commit it built.

6. **Watch the "Release" workflow** in the repository's Actions tab. It checks that the tag matches `package.json`, runs CI and the native parity suites on the tagged commit, builds the Windows installer and the Linux packages, then publishes. The release must carry four files:
   - `stock-dip-analyzer-x64-setup.exe` (no version in its name: the README links to `releases/latest/download/stock-dip-analyzer-x64-setup.exe`)
   - `stock-dip-analyzer-2.3.0-amd64.deb`
   - `stock-dip-analyzer-2.3.0-x86_64.AppImage`
   - `SHA256SUMS.txt`

7. **If the workflow fails before publishing,** nothing was published. Fix the problem on `master` through a pull request, then move the tag to the fixed commit:

```bash
git push origin :refs/tags/v2.3.0
git tag -d v2.3.0
git fetch origin master
git tag -a v2.3.0 -m "Stock Dip Analyzer 2.3.0" origin/master
git push origin v2.3.0
```

Never create the release in GitHub's web interface: the workflow's publish step would then fail because the release already exists.

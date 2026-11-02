---
name: build-linux-package
description: Build the Linux .deb and AppImage locally, inspect and install the .deb, and check the installed app with live data. Use when changing packaging, before a release, or when someone needs an installable Linux build without waiting for a GitHub Release.
---

# Build and check the Linux packages

1. **Build** from the repository root. The first build downloads Electron and electron-builder's packaging tools; a build takes 2–3 minutes:

```bash
npm ci
npm run build:renderer
npx electron-builder --linux deb AppImage --x64 --publish never -c.directories.output=release
```

It writes `release/stock-dip-analyzer-<version>-amd64.deb` and `release/stock-dip-analyzer-<version>-x86_64.AppImage`, with the version from `package.json`.

2. **Inspect the .deb:**

```bash
dpkg-deb --info release/stock-dip-analyzer-*-amd64.deb
dpkg-deb --contents release/stock-dip-analyzer-*-amd64.deb | grep -E 'chrome-sandbox|apparmor-profile|app\.asar|\.desktop'
```

3. **Install it** as a user would. It installs to `/opt/DDS response/`, puts `stock-dip-analyzer` on the `PATH` and adds **DDS response** to the app menu; on Ubuntu 24.04 its post-install script also installs the AppArmor profile (`/etc/apparmor.d/stock-dip-analyzer`) that Chromium's sandbox needs:

```bash
sudo apt install ./release/stock-dip-analyzer-*-amd64.deb
```

4. **Check the installed app with live data.** Run this as a normal user with a display (`xvfb-run -a` in front on a headless box). It should end with `all live checks passed` and writes its report and screenshots to `artifacts/live/`:

```bash
ELECTRON_EXE="/opt/DDS response/stock-dip-analyzer" npm run test:live
```

5. **Remove it** when you are done testing:

```bash
sudo apt remove stock-dip-analyzer
```

The AppImage needs FUSE 2 (`libfuse2t64` on Ubuntu 24.04, `libfuse2` on 22.04), or start it with `--appimage-extract-and-run`. Where user namespaces are blocked, as on Ubuntu 24.04, it starts without Chromium's sandbox, so the `.deb` is the package to use there.

CI does steps 1 to 3 on every pull request (`.github/workflows/linux-packages.yml`) and then requires the installed app to open its window.

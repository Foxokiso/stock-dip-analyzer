---
name: run-app
description: Start Stock Dip Analyzer (DDS response) from source with npm start, stop it, and fix common start-up errors (npx start, old Node.js, port 5174 in use, the Ubuntu 24.04 sandbox error, a broken Electron download). Use to run or open the app.
---

# Run the app from source

1. **Work from the repository root**, the folder that holds `package.json`, and check Node.js (22.12 or later):

```bash
node --version
```

2. **Install the dependencies** the first time, and again whenever `package-lock.json` changes:

```bash
npm ci
```

3. **Start the app.** `npm start` keeps running until the app quits, so start it in the background or a separate terminal and do not wait for it to finish:

```bash
npm start
```

It is up when Vite prints `Local: http://127.0.0.1:5174/` and the **DDS response** window opens on the Overview desk. The first run prints `Downloading Electron binary...` and needs the network.

4. **Stop it** by quitting the app window or pressing Ctrl+C in its terminal; either stops Vite and Electron together.

If the `.deb` is installed, the installed app starts with `stock-dip-analyzer` (or **DDS response** in the app menu); its settings are kept apart from those of `npm start`.

## When it does not start

| What you see | Why | Fix |
|---|---|---|
| `npm error could not determine executable to run` | `npx start` was run, or the terminal is not in the repository root | `cd` to the repository root and run `npm start` |
| `something already answers on http://127.0.0.1:5174/` | An earlier `npm run dev` or `npm start` still holds the port | Stop that process: find it with `lsof -i :5174` (Linux, macOS) or `netstat -ano \| findstr 5174` (Windows) |
| `The SUID sandbox helper binary was found, but is not configured correctly` | Ubuntu 23.10 or later blocks the user namespaces Chromium's sandbox uses | Run the two commands below once (again after every fresh `npm ci`), or install the `.deb` |
| `Running as root without --no-sandbox is not supported` | Electron was started as root | Start it as a normal user. Never add `--no-sandbox` |
| `Electron failed to install correctly` | The binary download was interrupted | `rm -rf node_modules/electron`, then `npm ci` and `npm start` again |
| Syntax errors or an "unsupported engine" warning | Node.js is older than 22.12 | Install Node.js 22.12 or later |

The Ubuntu sandbox fix:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

`npm run dev` alone serves the renderer at http://127.0.0.1:5174 for a layout check in a browser. It shows no market data, because the desktop bridge exists only in Electron.

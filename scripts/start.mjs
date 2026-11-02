// `npm start`: runs the renderer dev server, then Electron once it answers, and
// stops both together (see launcher.mjs for why npm's own shell cannot be relied on).
// Ctrl+C, closing the terminal, SIGTERM to npm start, or the process that started
// it exiting stops both; quitting the app stops Vite; either one exiting on its own
// stops the other. Arguments after `npm start --` go to Electron.
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { launch, watchParent } from './launcher.mjs';
import { checkSandbox } from './doctor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Resolving the electron package downloads its binary on first use (see README).
const electron = createRequire(import.meta.url)('electron');
// Chromium's own message for an unusable sandbox is a cryptic FATAL line; say what is wrong and
// how to fix it first (the same check as `npm run doctor`), then start anyway: if the check is
// wrong about this machine, nothing is lost.
const sandbox = checkSandbox({ cwd: root });
if (sandbox?.status === 'fail') console.error(`npm start: ${sandbox.detail}.\nnpm start: Fix: ${sandbox.fix}`);
const run = launch({
  devServer: {
    url: 'http://127.0.0.1:5174/', cwd: root,
    // --clearScreen false: Vite would otherwise clear npm's output, and the download notice above.
    command: [process.execPath, path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5174', '--strictPort', '--clearScreen', 'false'],
  },
  app: { command: electron, args: ['.', ...process.argv.slice(2)], cwd: root, env: { ...process.env, NODE_ENV: 'development' } },
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => run.stop(`${signal} received; stopping Vite and Electron`));
watchParent(() => run.stop('the process that started npm start has exited; stopping Vite and Electron'));
process.exitCode = await run.done;

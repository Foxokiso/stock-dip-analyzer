import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { ESLint } from 'eslint';

// npm run lint is the only check on main-process code the tests never run. A
// script that no files pattern matches is still parsed, with no rules at all,
// so a clean run would say nothing about it.
const eslint = new ESLint({ cwd: fileURLToPath(new URL('..', import.meta.url)) });
const lint = async (filePath, code) => (await eslint.lintText(code, { filePath }))[0].messages.map(({ ruleId, message }) => `${ruleId}: ${message}`);

test('every kind of script gets the recommended rules, and only the renderer the React ones', async () => {
    const recommended = Object.keys(js.configs.recommended.rules);
    for (const file of ['main.cjs', 'preload.cjs', 'scripts/verify-ui.mjs', 'scripts/live-checks.mjs', 'tests/scoring.test.js', 'vite.config.js', 'src/utils/scoring.js', 'src/App.jsx']) {
        const { rules } = await eslint.calculateConfigForFile(file);
        // A rule turned off is still listed, as [0]: only an error counts.
        assert.deepEqual(recommended.filter(rule => rules[rule]?.[0] !== 2), [], file);
        assert.equal('react-hooks/rules-of-hooks' in rules, file.startsWith('src/'), file);
    }
});

test('each kind of script knows the globals of the place it runs, and no others', async () => {
    assert.deepEqual(await lint('main.cjs', "const { app } = require('electron');\napp.on('ready', () => isHtps(__dirname, document));\n"),
        ["no-undef: 'isHtps' is not defined.", "no-undef: 'document' is not defined."]);
    // The sandboxed preload runs in the page, with none of Node's globals.
    assert.deepEqual(await lint('preload.cjs', "const { contextBridge } = require('electron');\ncontextBridge.exposeInMainWorld('x', { at: () => [location.href, process.platform, __dirname, Buffer] });\n"),
        ["no-undef: '__dirname' is not defined.", "no-undef: 'Buffer' is not defined."]);
    assert.deepEqual(await lint('scripts/verify-native-format.mjs', 'console.log(process.argv, __dirname, document);\n'), ["no-undef: '__dirname' is not defined.", "no-undef: 'document' is not defined."]);
    // A Playwright script's page callbacks run in the browser.
    assert.deepEqual(await lint('scripts/verify-ui.mjs', 'console.log(process.argv, document.title);\n'), []);
    assert.deepEqual(await lint('tests/scoring.test.js', 'console.log(process.argv, window, __dirname);\n'), ["no-undef: 'window' is not defined.", "no-undef: '__dirname' is not defined."]);
    assert.deepEqual(await lint('src/utils/scoring.js', 'export const read = () => [document.title, process.env];\n'), ["no-undef: 'process' is not defined."]);
});

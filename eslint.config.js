import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'release', 'artifacts']),
  // Every script gets the recommended rules: the renderer, the Electron main
  // process and preload, the tests and the verification scripts.
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest' },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // The renderer runs in the browser and is the only React code.
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // main.cjs is CommonJS on Electron's Node.
  {
    files: ['**/*.cjs'],
    ignores: ['preload.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  // preload.cjs is sandboxed: it runs in the page's isolated world, where
  // Electron 45 adds only require (for electron), a reduced process and global.
  // __dirname, Buffer and setImmediate would throw there.
  {
    files: ['preload.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.browser, process: 'readonly' } },
  },
  // Tests, scripts and tool configs are ES modules on Node, where require and
  // __dirname do not exist.
  {
    files: ['tests/**/*.js', 'scripts/**/*.mjs', '*.config.js'],
    languageOptions: { globals: globals.nodeBuiltin },
  },
  // The Playwright scripts' page callbacks run in the browser.
  {
    files: [
      'scripts/screenshot-routes.mjs',
      'scripts/ui-harness.mjs',
      'scripts/verify-alerts.mjs',
      'scripts/verify-live-electron.mjs',
      'scripts/verify-ui.mjs',
    ],
    languageOptions: { globals: globals.browser },
  },
])

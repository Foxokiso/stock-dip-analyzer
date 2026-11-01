import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Content Security Policy for the packaged renderer. Only the app's own files
// run as scripts, and images, fonts and workers come only from the app. The
// one frame is TradingView's chart, a sandboxed iframe on its embed host
// (src/utils/tradingView.js), which loads and connects on its own. Inline
// styles are allowed for provider markup only: documents DOMParser builds
// from Finviz pages fall under this policy, and every style attribute in them
// would be reported. React and Recharts style through the CSSOM, which the
// policy does not govern. Embedded site viewers (<webview>) are separate
// guests and are governed by main.cjs, not by this policy.
// The dev server is exempt: Vite's HMR client and React Fast Refresh need
// inline scripts.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "frame-src https://s.tradingview.com",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const contentSecurityPolicy = () => ({
  name: 'dip-analyzer-csp',
  apply: 'build',
  transformIndexHtml: () => [{
    tag: 'meta',
    attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
    injectTo: 'head-prepend',
  }],
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  base: './',
})

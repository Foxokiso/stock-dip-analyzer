import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Content Security Policy for the packaged renderer. Only the app's own files
// run as scripts, plus TradingView's widget loader; its chart lives in an
// iframe on TradingView's hosts. Inline styles are allowed because React and
// the chart library set style attributes. Embedded site viewers (<webview>)
// are separate guests and are governed by main.cjs, not by this policy.
// The dev server is exempt: Vite's HMR client and React Fast Refresh need
// inline scripts.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://s3.tradingview.com https://www.tradingview.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self' https://*.tradingview.com wss://*.tradingview.com",
  "frame-src https://*.tradingview.com https://*.tradingview-widget.com",
  "worker-src 'self' blob:",
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

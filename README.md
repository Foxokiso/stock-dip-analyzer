# Stock Dip Analyzer Pro

Welcome to the Stock Dip Analyzer! This application connects real-time financial market data with a fully transparent, factor-by-factor recovery scoring engine to highlight highly oversold "dip" opportunities across all market sectors — complete with live market context, data-dense sortable dashboards, and deep multi-range stock detail views.

## Release Notes v1.2.0

This release is all about making the app more informative: richer data, transparent scoring, and market context on every screen.

* **Transparent Recovery Score:**
  * Every score now comes with a per-factor breakdown visible everywhere (dashboard, stock details), so you can see exactly which signals earned or lost points.
  * All views share a single scoring engine (`src/utils/scoring.js`) — no more subtly divergent numbers between pages.
  * New RSI and momentum factors feed the score alongside the existing dip-depth and trend signals.
* **Market Pulse Strip:**
  * A new market-context strip at the top of the Dashboard tracks SPY, QQQ, DIA, IWM, and the VIX with live prices, signed day-change badges, and intraday sparklines.
* **Data-Dense Sortable Dashboard:**
  * Columns for day change, off-30-day-high, volume, relative volume, and market cap.
  * 52-week range bar, RSI readout, trend indicator, and per-row sparklines.
  * Summary stat tiles up top for an at-a-glance read of the whole scan.
* **Deeper Stock Details:**
  * Switchable 1M / 3M / 6M / 1Y chart ranges with SMA20 plus peak and support overlays.
  * Finviz key-statistics panel, a 52-week position bar, and 10 news items with source attribution.
* **Reliability:**
  * The photonics basket was moved off the crumb-gated Yahoo v7 quote API onto the chart API, eliminating a whole class of intermittent fetch failures.

## Release Notes v1.1.0

This major update introduces critical intelligence features, severe-drop alerts, and massive performance optimizations for heavy visual modes.

* **Live Alert History & Amber Alerts:**
  * Replaced the transient alert toasts with a fully persistent "Alert History" side-drawer.
  * Introduced "Amber Alerts" for catastrophic breakdown events (>15% drop). 
  * History actively preserves critical Amber Alerts across sessions while automatically purging old minor alerts to keep memory tight.
* **Ambient Web Audio Sirens:**
  * Integrated the Web Audio API to procedurally generate a dynamic, dissonant 4-tone siren when an Amber Alert strikes. The tones morph unpredictably, providing a jarring, unignorable hardware-level warning.
* **1000% Accurate Data Pipeline:**
  * Rewrote the dip calculation algorithm to utilize live, down-to-the-second pricing from Finviz rather than delayed daily-close charts from Yahoo Finance. Every math operation is now anchored in real-time truth.
  * Injected strict `cache: 'no-store'` commands into the Desktop IPC to guarantee the app never falls back to stale caching.
* **Buttery Smooth UI Merging (No Flashing):**
  * Patched the auto-refresh cycle in `Dashboard.jsx`. New data now seamlessly merges into the existing UI State, fully preventing the visual "flashing" or wiping of scores when scanning the market.
* **Seizure Mode Optimizations (120fps):**
  * Deleted CPU-bottlenecked wildcard animations triggering layout thrashing across thousands of DOM nodes.
  * Rebuilt the visual distress system using a single, unified GPU-accelerated overlay (`mix-blend-mode` & `radial-gradients`) that guarantees ultra-smooth 60-120fps performance.
  * Added a subtle, creeping sub-bass continuous audio drone to Seizure mode to vastly improve the atmosphere without blowing out speakers.
* **Darker Anime Theme:**
  * Deepened the `theme-anime` aesthetic to a highly saturated, low-light neon vibe (`#1a0f14`), massively improving text legibility and aesthetic contrast.

## Installation
Extract the provided archive, install the application via the `.exe`, and run the app from your Desktop/Start Menu. No additional configuration is required.

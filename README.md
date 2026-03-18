# Stock Dip Analyzer Pro

Welcome to the Stock Dip Analyzer! This application connects real-time financial market data with an advanced algorithmic recovery scoring system to highlight highly oversold "dip" opportunities across all market sectors.

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

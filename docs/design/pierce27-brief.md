# Pierce/27 — design brief for Stock Dip Analyzer v2

This brief governs every surface in the app. Layout stays what it is; the *style* changes.

## The look in one paragraph

Black-ink ground, electric light cutting through it. Think of the colour energy of a
hacker-convention badge: hot magenta against acid green, cyan against red — true
complements placed so they pierce rather than blend. Surfaces are silky: hairline borders,
a 2 % sheen at the top of every panel, soft 27 px glows at low alpha, and motion that
settles with a long ease-out tail. Nothing is harsh or chunky; the contrast comes from
colour, not from heavy borders or thick type.

## The 27 system (do not invent colours)

All tokens are in `src/styles/tokens.css`. Use them; never hard-code hex values in pages.

- **Hue grid** — H(k) = 27·k mod 360 in OKLCH. 27·20 ≡ 180, so hue k and hue k+20 are
  exact complements. Pairs in use:
  - primary `--primary` magenta (324°) ↔ `--primary-x` green (144°)
  - secondary `--secondary` cyan (189°) ↔ `--secondary-x` red (9°)
  - tertiary `--tertiary` violet (270°) ↔ `--tertiary-x` yellow (90°)
  - accent `--accent` amber (54°) ↔ `--accent-x` blue (234°)
- **Multiplication** — tints are `--primary-73`, `--primary-46`, `--primary-27`
  (lightness and chroma multiplied by 0.73 / 0.46 / 0.27). Washes are
  `--wash-p-27 / -14 / -07` etc. (alpha at 27 %, 14 %, 7 %). Overlays that must darken
  use `mix-blend-mode: multiply`. If you need a new shade, derive it with
  `oklch(from var(--token) calc(l * 0.73) calc(c * 0.73) h)` — never pick it by eye.
- **Timing** — `--t-fast` 270 ms, `--t-slow` 540 ms, `--t-pulse` 2.7 s, easing
  `--ease-silk`. Live indicators breathe with `animation: pierce-pulse var(--t-pulse) ease-in-out infinite`.
- **Geometry** — `--radius` 9 px, `--radius-sm` 6 px, `--radius-lg` 13 px; gaps
  `--gap` 27 px, `--gap-sm` 13 px, `--gap-xs` 7 px.
- **Type** — `--font-heading` / `--font-body` (Inter → Segoe UI → system),
  `--font-mono` for prices and tables (tabular numerals). No new web-font imports: the
  app must look right offline and the UI checks abort font requests.

## Semantics

- Up / bullish / success → `--success` (green). Down / bearish / danger → `--danger` (red).
  Caution / delayed / cached → `--warning` (amber). Informational → `--info` (cyan).
  An unchanged value (0.00 %, `-0` included) is flat: muted, with no arrow.
- Ratings take their tone from the verdict label on every desk: Strong Buy and Buy →
  `--success`, Hold → `--warning`, Sell and Strong Sell → `--danger`. `getVerdict`
  returns the label only, and no rating has a grey override.
- Primary actions use `--primary` on `--ink` text. Selected rows use `--wash-p-14` with a
  2 px inset `--primary` edge. Hover is `--bg-card-hover` plus a hairline shift to
  `--line-strong`; no transforms on table rows (they created compositor layers before).
- Text on dark: `--text-main` body, `--text-muted` labels, `--text-faint` captions.
  `--text-faint` is the one text role not derived by multiplication: `--text-muted` × 0.73
  fell below the 4.5:1 WCAG AA minimum for captions (quote and retrieval times, delay
  notes, table headers), so it is raised to `oklch(0.64 0.03 270)` in Pierce/27, which
  Alien Fractal and Seizure Mode inherit, and to `#848e98` in Modern. Both keep captions
  at 4.5:1 or better on the page and card grounds.
- Small `--danger` text on a danger wash or a selected row is lifted 27 % toward white,
  `oklch(from var(--danger) calc(l + (1 - l) * var(--m3)) c h)`, the derivation the link
  hover colour uses, so it keeps 4.5:1 at rest, hovered and selected.

## Silk rules

1. Panels: `background: var(--sheen); border: var(--glass-border); box-shadow: var(--glass-shadow); border-radius: var(--radius-lg)`.
2. Every transition uses `var(--transition-fast)` or `var(--transition-normal)`; no
   bouncy easings, no `transform: translateY(-3px)` hover jumps.
3. Glows are `box-shadow: var(--glow-p)` (or `-px`, `-s`) and scale with
   `--glow-intensity` where the component applies it: `opacity: var(--glow-intensity)`.
4. Focus is `box-shadow: var(--focus-ring)`; never remove it. Forced colours (Windows
   High Contrast) drop every box-shadow, so there `:focus-visible` also gets a 2 px
   `Highlight` outline (`src/index.css`); custom controls must not suppress it.
5. `prefers-reduced-motion` and the in-app Motion setting both zero the durations;
   components must not assume an animation ran.
6. Other themes (Modern, Alien Fractal, Seizure) must keep working: only use role tokens.
7. Theme effects (Alien Fractal's breathing hue, Seizure Mode's dimming) run on fixed
   background and overlay layers. Never put a `filter` on `<body>` or on any other
   ancestor of fixed elements: it becomes their containing block and pulls the alert
   toasts, the alert history button and its drawer out of the viewport.

## Settings are the source of truth

`import { useSettings } from '../state/settingsContext.js'` → `{ settings, update(path, value), reset(section), replace(doc) }`.
Constants and the document shape live in `src/state/settingsSchema.js` (`DEFAULT_SETTINGS`,
`THEMES`, `loadSettings`, `serializeSettings`, `parseSettingsImport`); the provider is
`src/state/settings.jsx`; sector ids are in `src/data/sectors.js`.
Sections: `appearance` (theme, density, motion, glow), `scanner` (excludedSectors,
refreshMinutes, reuseSeconds, scanDepth, defaultRating, sort), `futures` (defaultGroup, timeframe,
showDelayNotice), `alerts` (sound, volume, breakout, breakdown, trend, minScore,
historyLimit), `data` (chartCacheSeconds, requestTimeoutSeconds). The `data` values are
live, persisted preferences like the rest: Overview scoring, the stock page and Oil Watch
reuse a Yahoo chart response for `chartCacheSeconds`, and the main process applies
`requestTimeoutSeconds`, which is sent before the first render and on every change.
Every value must be one the desk offers (any whole scan depth from 1 to 500 is kept):
`loadSettings` replaces anything else with its default, repairing the excluded-sector
list instead, and `parseSettingsImport` reports every such value and applies nothing.
Seizure Mode (`theme-seizure`) is transient: it starts only from Settings → Appearance
→ Run Seizure Mode… behind a photosensitivity warning, and is never stored or exported.
Pages read what they need directly from `useSettings()`; App.jsx keeps passing the
legacy props too.

## Data integrity rules (unchanged from v1.3 / PR #6)

No simulated quotes, invented headlines, default scores, or placeholder numbers in any
view. Unavailable is shown as unavailable. Retrieval time and source quote time stay
separate. Do not alter `src/utils/scoring.js`, `src/utils/marketData.js`,
`src/services/futures.js`, or their tests from a styling task.

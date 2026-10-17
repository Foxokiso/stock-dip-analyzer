# dip::palette — Pierce/27 colors shared with the renderer

`include/dip/palette.hpp` is **generated** from `src/styles/tokens.css`
(the `:root, .theme-pierce27` block only) by `scripts/gen-native-palette.mjs`
so a future native UI draws exactly the colors the Electron renderer shows.
This preserves existing presentation behavior; it is not a trading backtest.

Do not edit the header by hand. After changing a palette token in `tokens.css`:

```bash
node scripts/gen-native-palette.mjs          # rewrites include/dip/palette.hpp
node scripts/gen-native-palette.mjs --check  # exit 1 when the header has drifted
```

The parity test regenerates the header into a temp path and fails if the
committed one differs (git `core.autocrlf` CRLF checkouts are tolerated and
reported), then drives the library through `tests/palette_driver.cpp`.

## What the table holds

For every `pierce-*`, `bg-*`, `line`/`line-strong`, `text-*`, `ink` and
semantic role token (`primary`, `primary-x`, `secondary`, `secondary-x`,
`tertiary`, `tertiary-x`, `accent`, `accent-x`, `success`, `danger`,
`warning`, `info`): the resolved OKLCH literal, the hue-grid slot `k`, the
gamma sRGB hex and packed `0xRRGGBB`, and whether sRGB clipping touched it.
Plus `kHueStep = 27`, `kGridSlots = 40`, `kComplementOffset = 20`,
`kMultiply = {0.73, 0.46, 0.27}` and `kFastMs / kSlowMs / kPulseMs`
(270 / 540 / 2700).

- **Hue grid** — `H(k) = 27·k mod 360`; `k` is the slot whose hue equals the
  token's (144° is k = 32, as the `k = ...` comments in `tokens.css` say), or
  `-1` off-grid. `complement(k)` is `hueDegrees(k + 20)`, the exact complement.
- **Tints** — `tint(color, f)` multiplies lightness and chroma, hue unchanged
  (the `--primary-73` relative-color rule).
- **sRGB** — OKLCH → OKLab → linear sRGB → **per-channel clip to [0, 1]** →
  IEC 61966-2-1 transfer. Clipping matches what Chromium/Electron does for an
  out-of-gamut `oklch()`; no chroma-reduction gamut mapping is applied.

## Build and test

```bash
cmake -S native -B artifacts/native-palette -G "Visual Studio 18 2026" -A x64
cmake --build artifacts/native-palette --config Release
ctest --test-dir artifacts/native-palette -C Release -R palette_reference_parity --output-on-failure
# or directly:
node scripts/verify-native-palette.mjs artifacts/native-palette/modules/palette/Release/palette_driver.exe
```

The verifier compares every token, every tint factor, the grid complements for
k in [-45, 85], the sRGB primaries and a seeded OKLCH grid against the
JavaScript reference with relative tolerance `1e-9`.

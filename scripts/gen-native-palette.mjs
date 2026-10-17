#!/usr/bin/env node
// Pierce/27 palette -> C++ header generator (pure Node, no dependencies).
//
// Parses the `:root, .theme-pierce27 { ... }` block of src/styles/tokens.css,
// resolves var() references (including the --h-* hue variables), evaluates
// oklch(L C H) literals and converts them to gamma-encoded sRGB, then emits
// native/modules/palette/include/dip/palette.hpp so a future native UI draws
// exactly the colors the Electron renderer shows. This preserves existing
// presentation behavior; it is not a trading backtest.
//
// Conversion pipeline (Bjorn Ottosson's OKLab reference matrices):
//   OKLCH -> OKLab        a = C*cos(h), b = C*sin(h)
//   OKLab -> LMS'         M1 (Lab -> non-linear LMS)
//   LMS'  -> LMS          cube
//   LMS   -> linear sRGB  M2
//   linear -> gamma sRGB  IEC 61966-2-1 transfer function
//
// Clipping rule: every linear-light sRGB channel is clamped to [0, 1] before
// the transfer function (per-channel clipping). This is what Chromium, and
// therefore Electron, does when it rasterises an out-of-gamut oklch() color
// onto an sRGB surface; no chroma-reduction gamut mapping is applied. Each
// table entry records `clipped` so a native UI can see which tokens lost
// chroma on sRGB displays.
//
// Hue-grid index: k is the grid slot with (27*k) mod 360 == hue, searched over
// the 40 distinct slots (gcd(27, 360) = 9), or -1 when the hue is off-grid.
// This matches the `k = ...` comments in tokens.css (e.g. 144 deg is k = 32).
//
// Usage: node scripts/gen-native-palette.mjs [--out <path>] [--check]
//   --out    write the header somewhere else (the verifier uses a temp path)
//   --check  do not write; exit 1 when the committed header has drifted
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(scriptDir, '..');
export const TOKENS_CSS = path.join(REPO_ROOT, 'src', 'styles', 'tokens.css');
export const HEADER_PATH = path.join(REPO_ROOT, 'native', 'modules', 'palette', 'include', 'dip', 'palette.hpp');

// Tokens that belong in the native table. Values must resolve to a single
// oklch(L C H) literal; gradients such as --bg-image / --pierce-gradient and
// the relative-color tints (--primary-73 ...) are intentionally not tabled.
const TABLE_TOKEN = /^(pierce-[a-z]+|bg-[a-z-]+|line(-strong)?|text-[a-z]+|ink|primary(-x)?|secondary(-x)?|tertiary(-x)?|accent(-x)?|success|danger|warning|info)$/;
const TINT_TOKEN = /^(primary|primary-x|secondary|success|danger)-(73|46|27)$/;

// ---------------------------------------------------------------- CSS parsing
export function extractPierceBlock(css) {
  const open = css.search(/:root\s*,\s*\.theme-pierce27\s*\{/);
  if (open < 0) throw new Error('tokens.css: ":root, .theme-pierce27 {" block not found');
  const brace = css.indexOf('{', open);
  let depth = 0;
  for (let i = brace; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(brace + 1, i);
  }
  throw new Error('tokens.css: unbalanced braces in the :root/.theme-pierce27 block');
}

export function parseDeclarations(block) {
  const declarations = new Map();
  const stripped = block.replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const statement of stripped.split(';')) {
    const text = statement.trim();
    if (!text) continue;
    const colon = text.indexOf(':');
    if (colon < 0) throw new Error(`tokens.css: declaration without a colon: "${text}"`);
    const name = text.slice(0, colon).trim();
    if (!name.startsWith('--')) continue;
    declarations.set(name.slice(2), text.slice(colon + 1).replace(/\s+/g, ' ').trim());
  }
  return declarations;
}

export function resolveVars(value, declarations, depth = 0) {
  if (depth > 32) throw new Error(`tokens.css: var() chain too deep while resolving "${value}"`);
  if (!value.includes('var(')) return value;
  const replaced = value.replace(/var\(\s*--([\w-]+)\s*(,[^)]*)?\)/g, (match, name, fallback) => {
    if (fallback !== undefined) throw new Error(`tokens.css: var() fallbacks are not supported: "${match}"`);
    if (!declarations.has(name)) throw new Error(`tokens.css: unknown custom property --${name}`);
    return declarations.get(name);
  });
  return resolveVars(replaced, declarations, depth + 1);
}

function parseCssNumber(text, kind) {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg)?$/i.exec(text);
  if (!match) throw new Error(`tokens.css: cannot parse ${kind} component "${text}"`);
  const value = Number(match[1]);
  const unit = (match[2] || '').toLowerCase();
  if (unit === '%') return kind === 'chroma' ? value * 0.004 : value / 100;
  if (unit === 'deg' && kind !== 'hue') throw new Error(`tokens.css: "${text}" is not a ${kind}`);
  return value;
}

// oklch(L C H) with plain numeric components (percent/deg accepted, no alpha).
export function parseOklchLiteral(text) {
  const match = /^oklch\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)$/i.exec(text.trim());
  if (!match || match[1].toLowerCase() === 'from') return null;
  return {
    l: parseCssNumber(match[1], 'lightness'),
    c: parseCssNumber(match[2], 'chroma'),
    h: parseCssNumber(match[3], 'hue'),
  };
}

// oklch(from oklch(...) calc(l * F) calc(c * F) h) -- the multiplied tints.
export function parseRelativeOklch(text) {
  const match = /^oklch\(\s*from\s+(oklch\([^()]*\))\s+calc\(\s*l\s*\*\s*(\S+?)\s*\)\s+calc\(\s*c\s*\*\s*(\S+?)\s*\)\s+h\s*\)$/i.exec(text.trim());
  if (!match) return null;
  const source = parseOklchLiteral(match[1]);
  if (!source) return null;
  return {
    source,
    lFactor: parseCssNumber(match[2], 'factor'),
    cFactor: parseCssNumber(match[3], 'factor'),
  };
}

function parseMilliseconds(text, name) {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/i.exec(text.trim());
  if (!match) throw new Error(`tokens.css: --${name} "${text}" is not a duration`);
  const value = Number(match[1]) * (match[2].toLowerCase() === 's' ? 1000 : 1);
  if (!Number.isInteger(value)) throw new Error(`tokens.css: --${name} is not a whole number of milliseconds`);
  return value;
}

// --------------------------------------------------------------- color math
export function floorMod(value, modulus) {
  const remainder = value % modulus;
  return remainder < 0 ? remainder + modulus : remainder;
}

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

export function makeHueGrid(step) {
  if (!Number.isInteger(step) || step <= 0) throw new Error(`hue step ${step} must be a positive integer`);
  const slots = 360 / gcd(step, 360);
  let complementOffset = -1;
  for (let n = 1; n < slots; n++) {
    if ((step * n) % 360 === 180) { complementOffset = n; break; }
  }
  if (complementOffset < 0) throw new Error(`hue step ${step} has no exact complement slot`);
  return { step, slots, complementOffset };
}

export const DEFAULT_GRID = makeHueGrid(27);

export function hueDegrees(k, grid = DEFAULT_GRID) {
  return floorMod(grid.step * floorMod(k, grid.slots), 360);
}
export function complementIndex(k, grid = DEFAULT_GRID) {
  return floorMod(k + grid.complementOffset, grid.slots);
}
export function complement(k, grid = DEFAULT_GRID) {
  return hueDegrees(complementIndex(k, grid), grid);
}
export function hueIndex(hue, grid = DEFAULT_GRID) {
  if (!Number.isFinite(hue)) return -1;
  const normalised = floorMod(hue, 360);
  for (let k = 0; k < grid.slots; k++) if (hueDegrees(k, grid) === normalised) return k;
  return -1;
}
export function tint(color, factor) {
  return { l: color.l * factor, c: color.c * factor, h: color.h };
}

function transfer(linear) {
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}

// OKLCH -> OKLab -> linear sRGB -> per-channel clip -> gamma sRGB (see top).
export function oklchToSrgb({ l, c, h }) {
  const radians = h * (Math.PI / 180);
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const l1 = l + 0.3963377774 * a + 0.2158037573 * b;
  const m1 = l - 0.1055613458 * a - 0.0638541728 * b;
  const s1 = l - 0.0894841775 * a - 1.2914855480 * b;
  const l3 = l1 * l1 * l1;
  const m3 = m1 * m1 * m1;
  const s3 = s1 * s1 * s1;
  const linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
  ];
  const clipped = linear.some(v => v < 0 || v > 1);
  const [r, g, bb] = linear.map(v => transfer(Math.min(1, Math.max(0, v))));
  return { r, g, b: bb, linear, clipped };
}

export function channelByte(gamma) {
  return Math.min(255, Math.max(0, Math.floor(gamma * 255 + 0.5)));
}
export function toHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => channelByte(v).toString(16).padStart(2, '0')).join('');
}

// --------------------------------------------------------------- palette
export function buildPalette(css) {
  const declarations = parseDeclarations(extractPierceBlock(css));
  const need = name => {
    if (!declarations.has(name)) throw new Error(`tokens.css: --${name} is missing`);
    return resolveVars(declarations.get(name), declarations);
  };
  const grid = makeHueGrid(Number(need('k')));
  const constants = {
    hueStep: grid.step,
    gridSlots: grid.slots,
    complementOffset: grid.complementOffset,
    multiply: ['m1', 'm2', 'm3'].map(name => parseCssNumber(need(name), 'factor')),
    fastMs: parseMilliseconds(need('t-fast'), 't-fast'),
    slowMs: parseMilliseconds(need('t-slow'), 't-slow'),
    pulseMs: parseMilliseconds(need('t-pulse'), 't-pulse'),
  };
  const tokens = [];
  const tints = [];
  for (const [name, raw] of declarations) {
    const resolved = resolveVars(raw, declarations);
    if (TABLE_TOKEN.test(name)) {
      const oklch = parseOklchLiteral(resolved);
      if (!oklch) continue;
      let alias = '';
      let cursor = raw;
      for (let m; (m = /^var\(\s*--([\w-]+)\s*\)$/.exec(cursor));) {
        alias = m[1];
        cursor = declarations.get(alias);
      }
      const rgb = oklchToSrgb(oklch);
      tokens.push({ name, alias, oklch, k: hueIndex(oklch.h, grid), hex: toHex(rgb), rgb, clipped: rgb.clipped });
    } else if (TINT_TOKEN.test(name)) {
      const relative = parseRelativeOklch(resolved);
      if (!relative) throw new Error(`tokens.css: --${name} is not a relative oklch() tint`);
      if (relative.lFactor !== relative.cFactor) throw new Error(`tokens.css: --${name} scales l and c differently`);
      tints.push({ name, base: name.replace(/-(73|46|27)$/, ''), factor: relative.lFactor, source: relative.source });
    }
  }
  if (tokens.length === 0) throw new Error('tokens.css: no palette tokens found');
  for (const t of tints) {
    const base = tokens.find(token => token.name === t.base);
    if (!base) throw new Error(`tokens.css: tint --${t.name} has no tabled base token`);
    const { l, c, h } = base.oklch;
    if (l !== t.source.l || c !== t.source.c || h !== t.source.h) {
      throw new Error(`tokens.css: --${t.name} does not derive from --${t.base}`);
    }
  }
  return { constants, tokens, tints };
}

// --------------------------------------------------------------- C++ output
function cppDouble(value) {
  if (!Number.isFinite(value)) throw new Error(`cannot emit ${value} as a C++ double`);
  let text = String(value);
  if (/^-?\d+$/.test(text)) text += '.0';
  if (Number(text) !== value) throw new Error(`double literal ${text} does not round-trip`);
  return text;
}
function cppString(value) { return JSON.stringify(value); }

export function renderHeader(palette) {
  const { constants, tokens } = palette;
  const nameWidth = Math.max(...tokens.map(t => cppString(t.name).length));
  const aliasWidth = Math.max(...tokens.map(t => cppString(t.alias).length));
  const rows = tokens.map(t => {
    const oklch = `{${cppDouble(t.oklch.l)}, ${cppDouble(t.oklch.c)}, ${cppDouble(t.oklch.h)}}`;
    const rgb = `0x${t.hex.slice(1).toUpperCase()}u`;
    return `    {${cppString(t.name).padEnd(nameWidth)}, ${cppString(t.alias).padEnd(aliasWidth)}, ${oklch.padEnd(22)}, ${String(t.k).padStart(2)}, ${cppString(t.hex)}, ${rgb}, ${t.clipped ? 'true' : 'false'}},`;
  });
  return [
    '// GENERATED by scripts/gen-native-palette.mjs from src/styles/tokens.css',
    '// (:root/.theme-pierce27 block). Do not edit; regenerate instead.',
    '//',
    '// dip::palette shares the Pierce/27 color system with the C++ side so a',
    '// future native UI uses identical colors. This preserves existing',
    '// presentation behavior; it is not a trading backtest.',
    '//',
    '// Hue grid: H(k) = kHueStep * k mod 360. kHueStep * kComplementOffset is',
    '// 540 = 180 mod 360, so slot k + kComplementOffset is the exact complement.',
    '// Tints multiply lightness and chroma by kMultiply[i]; washes use the same',
    '// factors as alpha. Timing shares the scale: 270 ms, 540 ms, 2.7 s.',
    '//',
    '// sRGB values use per-channel clipping of linear light to [0, 1] (what',
    '// Chromium/Electron does for out-of-gamut oklch()), not chroma-reduction',
    '// gamut mapping. `clipped` marks tokens that lost chroma on sRGB.',
    '#pragma once',
    '',
    '#include <array>',
    '#include <cstddef>',
    '#include <cstdint>',
    '#include <string>',
    '#include <string_view>',
    '',
    'namespace dip::palette {',
    '',
    `inline constexpr int kHueStep = ${constants.hueStep};`,
    `inline constexpr int kGridSlots = ${constants.gridSlots};`,
    `inline constexpr int kComplementOffset = ${constants.complementOffset};`,
    `inline constexpr std::array<double, 3> kMultiply{${constants.multiply.map(cppDouble).join(', ')}};`,
    `inline constexpr int kFastMs = ${constants.fastMs};`,
    `inline constexpr int kSlowMs = ${constants.slowMs};`,
    `inline constexpr int kPulseMs = ${constants.pulseMs};`,
    '',
    'static_assert(360 % kGridSlots == 0, "grid slots must tile the hue circle");',
    'static_assert((kHueStep * kComplementOffset) % 360 == 180, "complement offset must be exact");',
    '',
    'struct Oklch {',
    '    double l;  // lightness 0..1',
    '    double c;  // chroma',
    '    double h;  // hue in degrees',
    '};',
    '',
    'struct Rgb {',
    '    double r, g, b;  // gamma-encoded sRGB in [0, 1]',
    '    bool clipped;    // a linear channel fell outside [0, 1] and was clamped',
    '};',
    '',
    'struct Token {',
    '    std::string_view name;   // CSS custom property without the leading "--"',
    '    std::string_view alias;  // token it resolves to via var(), or empty',
    '    Oklch oklch;             // the CSS literal after var() resolution',
    '    int k;                   // hue-grid index, -1 when off-grid',
    '    std::string_view hex;    // "#rrggbb" gamma sRGB after clipping',
    '    std::uint32_t rgb;       // 0xRRGGBB',
    '    bool clipped;            // see Rgb::clipped',
    '};',
    '',
    `inline constexpr std::size_t kTokenCount = ${tokens.length};`,
    'inline constexpr std::array<Token, kTokenCount> kTokens{{',
    ...rows,
    '}};',
    '',
    '// Hue in degrees of grid slot k (any integer; wraps every kGridSlots).',
    'int hueDegrees(int k);',
    '// Grid slot of the exact complement of slot k.',
    'int complementIndex(int k);',
    '// Hue in degrees of the exact complement of slot k: hueDegrees(k + kComplementOffset).',
    'int complement(int k);',
    '// Multiplies lightness and chroma; hue is unchanged (the --primary-73 rule).',
    'Oklch tint(Oklch color, double factor);',
    '// OKLCH -> OKLab -> linear sRGB -> per-channel clip -> gamma sRGB.',
    'Rgb toSrgb(Oklch color);',
    '// "#rrggbb" with channels rounded half-up to 8 bits.',
    'std::string toHex(Rgb rgb);',
    '// Finds a token by name ("primary" or "--primary"); nullptr when unknown.',
    'const Token* lookup(std::string_view name);',
    '',
    '}  // namespace dip::palette',
    '',
  ].join('\n');
}

export function generateHeader(cssPath = TOKENS_CSS) {
  return renderHeader(buildPalette(fs.readFileSync(cssPath, 'utf8')));
}

export function main(argv) {
  let out = HEADER_PATH;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--check') check = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  const header = generateHeader();
  if (check) {
    const committed = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n') : '';
    if (committed !== header) {
      console.error(`palette header drift: ${out} does not match tokens.css; run node scripts/gen-native-palette.mjs`);
      return 1;
    }
    console.log(`${out} is up to date`);
    return 0;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, header, 'utf8');
  console.log(`wrote ${out}`);
  return 0;
}

const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));

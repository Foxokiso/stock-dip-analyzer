// Recorded/deterministic palette checks only; this is not a trading backtest.
//
// 1. Drift check: regenerates dip/palette.hpp into a temp path with the real
//    generator CLI and asserts it is byte-identical to the committed header.
// 2. Parity: drives the native library and compares every token, tint, grid
//    complement and a seeded OKLCH grid against the JavaScript conversion in
//    scripts/gen-native-palette.mjs (relative tolerance 1e-9 for doubles).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEADER_PATH, TOKENS_CSS, buildPalette, complement, complementIndex, hueDegrees, oklchToSrgb, tint, toHex,
} from './gen-native-palette.mjs';

const executable = process.argv[2];
assert.ok(executable, 'Pass the compiled native palette test driver');
const generator = fileURLToPath(new URL('./gen-native-palette.mjs', import.meta.url));
const TOLERANCE = 1e-9;
const near = (actual, expected, label) => {
  assert.ok(Number.isFinite(actual), `${label}: ${actual} is not a number`);
  assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * TOLERANCE, `${label}: ${actual} != ${expected}`);
};

// ── 1. The committed header must be exactly what tokens.css generates. ──
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dip-palette-'));
try {
  const tempHeader = path.join(tempDir, 'palette.hpp');
  const generated = spawnSync(process.execPath, [generator, '--out', tempHeader], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.error?.message || generated.stderr);
  const regenerated = fs.readFileSync(tempHeader);
  const committed = fs.readFileSync(HEADER_PATH);
  if (!committed.equals(regenerated)) {
    // git core.autocrlf may check the committed header out with CRLF on Windows;
    // that is the only difference tolerated, and it is reported.
    const lf = buffer => buffer.toString('utf8').replace(/\r\n/g, '\n');
    const a = lf(committed), b = lf(regenerated);
    if (a !== b) {
      const left = a.split('\n'), right = b.split('\n');
      const firstDiff = left.findIndex((text, i) => text !== right[i]);
      assert.fail(`palette header drift at ${HEADER_PATH}:${firstDiff + 1}: run node scripts/gen-native-palette.mjs`);
    }
    console.log('note: committed palette header has CRLF line endings (core.autocrlf); content matches');
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// ── 2. JavaScript reference sanity: the sRGB primaries round-trip. ──
// OKLCH coordinates of the sRGB primaries (CSS Color 4 / Ottosson reference values).
assert.equal(toHex(oklchToSrgb({ l: 0.6279553606145516, c: 0.25768330773615683, h: 29.2338851923426 })), '#ff0000');
assert.equal(toHex(oklchToSrgb({ l: 0.8664396115356694, c: 0.2948272403370167, h: 142.49533888780996 })), '#00ff00');
assert.equal(toHex(oklchToSrgb({ l: 0.4520137183853429, c: 0.31321437166460125, h: 264.052020638055 })), '#0000ff');
assert.equal(toHex(oklchToSrgb({ l: 1, c: 0, h: 0 })), '#ffffff');
assert.equal(toHex(oklchToSrgb({ l: 0, c: 0, h: 0 })), '#000000');
// Grid wrap for negative k must be +0, not -0: assert/strict uses Object.is, and the
// native driver prints "0" (regression: hueDegrees(-40) used to compare unequal).
for (const k of [-80, -40, 0, 40, 80]) {
  assert.equal(hueDegrees(k), 0, `hueDegrees(${k})`);
  assert.equal(complement(k - 20), 0, `complement(${k - 20})`);
}
assert.equal(hueDegrees(-1), 27 * 39 % 360, 'hueDegrees(-1) wraps to slot 39');

// ── 3. Build the driver cases. ──
const palette = buildPalette(fs.readFileSync(TOKENS_CSS, 'utf8'));
const { constants, tokens, tints } = palette;
const cases = [];
const add = (line, check) => cases.push({ line, check });
const fmt = value => String(value);

add('constants', fields => {
  assert.equal(Number(fields[0]), constants.hueStep, 'kHueStep');
  assert.equal(Number(fields[1]), constants.gridSlots, 'kGridSlots');
  assert.equal(Number(fields[2]), constants.complementOffset, 'kComplementOffset');
  constants.multiply.forEach((factor, i) => near(Number(fields[3 + i]), factor, `kMultiply[${i}]`));
  assert.equal(Number(fields[6]), constants.fastMs, 'kFastMs');
  assert.equal(Number(fields[7]), constants.slowMs, 'kSlowMs');
  assert.equal(Number(fields[8]), constants.pulseMs, 'kPulseMs');
  assert.equal(Number(fields[9]), tokens.length, 'kTokenCount');
});

const checkToken = (expected, label) => fields => {
  assert.notEqual(fields[0], 'null', `${label}: native token must exist`);
  assert.equal(fields[0], expected.name, `${label}: name`);
  assert.equal(fields[1], expected.alias, `${label}: alias`);
  near(Number(fields[2]), expected.oklch.l, `${label}: l`);
  near(Number(fields[3]), expected.oklch.c, `${label}: c`);
  near(Number(fields[4]), expected.oklch.h, `${label}: h`);
  assert.equal(Number(fields[5]), expected.k, `${label}: k`);
  assert.equal(fields[6], expected.hex, `${label}: table hex`);
  assert.equal(Number(fields[7]), parseInt(expected.hex.slice(1), 16), `${label}: packed rgb`);
  assert.equal(fields[8], expected.clipped ? '1' : '0', `${label}: table clipped`);
  // Recomputed through the library from the oklch literal, not read from the table.
  const rgb = oklchToSrgb(expected.oklch);
  near(Number(fields[9]), rgb.r, `${label}: r`);
  near(Number(fields[10]), rgb.g, `${label}: g`);
  near(Number(fields[11]), rgb.b, `${label}: b`);
  assert.equal(fields[12], toHex(rgb), `${label}: computed hex`);
  assert.equal(fields[12], expected.hex, `${label}: computed hex must equal the table`);
  assert.equal(fields[13], rgb.clipped ? '1' : '0', `${label}: computed clipped`);
};
tokens.forEach((token, index) => {
  add(`at ${index}`, checkToken(token, `kTokens[${index}]`));
  add(`token ${token.name}`, checkToken(token, `lookup(${token.name})`));
  add(`token --${token.name}`, checkToken(token, `lookup(--${token.name})`));
});
for (const line of ['token', 'token nope', 'token --', `at ${tokens.length}`, 'at -1', 'tint nope 0.5', 'tint primary', 'oklch 1 2', 'bogus']) {
  add(line, fields => assert.equal(fields.join('\t'), 'null', `${line}: expected null`));
}

const checkTint = (base, factor, label) => fields => {
  assert.notEqual(fields[0], 'null', `${label}: native tint must exist`);
  const expected = tint(base.oklch, factor);
  near(Number(fields[0]), expected.l, `${label}: l`);
  near(Number(fields[1]), expected.c, `${label}: c`);
  near(Number(fields[2]), expected.h, `${label}: h`);
  const rgb = oklchToSrgb(expected);
  near(Number(fields[3]), rgb.r, `${label}: r`);
  near(Number(fields[4]), rgb.g, `${label}: g`);
  near(Number(fields[5]), rgb.b, `${label}: b`);
  assert.equal(fields[6], toHex(rgb), `${label}: hex`);
  assert.equal(fields[7], rgb.clipped ? '1' : '0', `${label}: clipped`);
};
// The CSS relative-color tints (--primary-73 ...) evaluated by the generator.
assert.ok(tints.length >= 9, 'tokens.css should declare the multiplied tints');
for (const t of tints) {
  const base = tokens.find(token => token.name === t.base);
  add(`tint ${t.base} ${fmt(t.factor)}`, checkTint(base, t.factor, `--${t.name}`));
}
// Every tabled token at every multiplication factor, plus identity and zero.
for (const token of tokens) {
  for (const factor of [...constants.multiply, 1, 0]) {
    add(`tint ${token.name} ${fmt(factor)}`, checkTint(token, factor, `tint(${token.name}, ${factor})`));
  }
}

for (let k = -45; k <= 85; k++) {
  add(`complement ${k}`, fields => {
    assert.equal(Number(fields[0]), complement(k), `complement(${k})`);
    assert.equal(Number(fields[1]), complementIndex(k), `complementIndex(${k})`);
    assert.equal(Number(fields[2]), hueDegrees(k), `hueDegrees(${k})`);
  });
}
// The design pairs named in the brief: 324<->144, 189<->9, 270<->90, 54<->234.
for (const [k, hue] of [[12, 144], [7, 9], [10, 90], [2, 234], [32, 324], [27, 189], [30, 270], [22, 54]]) {
  add(`complement ${k}`, fields => assert.equal(Number(fields[0]), hue, `complement(${k}) should be ${hue}`));
}

const checkOklch = (color, label) => fields => {
  assert.notEqual(fields[0], 'null', `${label}: expected a conversion`);
  const rgb = oklchToSrgb(color);
  near(Number(fields[0]), rgb.r, `${label}: r`);
  near(Number(fields[1]), rgb.g, `${label}: g`);
  near(Number(fields[2]), rgb.b, `${label}: b`);
  // Rounding to 8 bits and the clipped flag are only compared away from their
  // decision boundaries, where last-ulp libm differences could legitimately flip them.
  const roundingSafe = [rgb.r, rgb.g, rgb.b].every(v => { const x = v * 255 + 0.5; return Math.abs(x - Math.round(x)) > 1e-6; });
  if (roundingSafe) assert.equal(fields[3], toHex(rgb), `${label}: hex`);
  const clipSafe = rgb.linear.every(v => Math.abs(v) > 1e-9 && Math.abs(v - 1) > 1e-9);
  if (clipSafe) assert.equal(fields[4], rgb.clipped ? '1' : '0', `${label}: clipped`);
};
const edges = [
  { l: 0, c: 0, h: 0 }, { l: 1, c: 0, h: 0 }, { l: 0.5, c: 0, h: 0 }, { l: 1, c: 0.4, h: 0 }, { l: 0, c: 0.4, h: 180 },
  { l: 0.5, c: 0.2, h: 360 }, { l: 0.5, c: 0.2, h: -90 }, { l: 0.5, c: 0.2, h: 720.5 }, { l: 1.2, c: 0.1, h: 45 },
  { l: 0.6279553606145516, c: 0.25768330773615683, h: 29.2338851923426 },
];
edges.forEach((color, i) => add(`oklch ${fmt(color.l)} ${fmt(color.c)} ${fmt(color.h)}`, checkOklch(color, `edge ${i}`)));
let seed = 0x27272727;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
for (let i = 0; i < 600; i++) {
  const color = { l: random(), c: random() * 0.4, h: random() * 1080 - 360 };
  add(`oklch ${fmt(color.l)} ${fmt(color.c)} ${fmt(color.h)}`, checkOklch(color, `grid ${i}`));
}

// ── 4. Run the driver once and check every row. ──
const input = cases.map(c => c.line).join('\n') + '\n';
const run = spawnSync(executable, [], { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
assert.equal(run.status, 0, run.error?.message || run.stderr);
// Windows text-mode stdout ends lines with CRLF; compare line content, not line endings.
const rows = run.stdout.trim().split(/\r?\n/);
assert.equal(rows.length, cases.length, 'one output row per case');
cases.forEach((c, i) => c.check(rows[i].split('\t')));
console.log(`${cases.length} native/JavaScript palette parity cases passed`);

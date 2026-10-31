// Recorded/deterministic calculations only; this is not a trading backtest.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { analyzeStock } from '../src/utils/scoring.js';

const executable = process.argv[2];
assert.ok(executable, 'Pass the compiled native analysis test driver');
const cases = [
  { closes: [], quote: null },
  { closes: [100, 90], quote: 92 },
  { closes: Array(20).fill(Infinity), quote: 90 },
  { closes: Array(20).fill(100), quote: Infinity },
  { closes: Array(20).fill(100), quote: 0 },
  { closes: [100, 98, 97, 99, 96, 95, 94, 96, 92, 93, 94, 95, 96, 97, 98], quote: 105 },
  { closes: [120, 119, 117, 115, 110, 105, 100, 99, 98, 97, 96, 95, 94, 93, 92, 91], quote: 90 },
  { closes: [100, NaN, -1, 0, Infinity, ...Array(14).fill(98)], quote: 96 },
];
for (const quote of [75, 75.00001, 85, 85.00001, 95, 95.00001, 100, 102]) {
  cases.push({ closes: [100, ...Array(19).fill(90)], quote });
}
// Breakouts: a 110 closing high `base` sessions before the current session's bar (the last close),
// then a retest from below, a touch and a break above; with no quote, the session price as the
// quote, and a quote that differs slightly from the bar. A second top at the high resets the base.
for (const base of [1, 8, 9, 10, 19]) {
  for (const price of [109.45, 109.6, 110, 110.0000001, 112]) {
    const closes = Array.from({ length: 21 }, (_, i) => (i === 20 ? price : i === 20 - base ? 110 : i < 20 - base ? 100 : 105));
    for (const quote of [null, price, price * 1.001, price * 0.999]) cases.push({ closes, quote });
  }
}
cases.push({ closes: [...Array(8).fill(100), 110, ...Array(7).fill(105), 110, 105, 105, 105, 112], quote: 112 });
// Breakdowns: the dip > 5 boundary at the post-peak low (4.5, 5, 5.0001), within and beyond 0.5%
// of that low, and a peak 9 or 10 bars back.
for (const low of [95.5, 95, 94.9999, 80]) {
  const closes = [...Array.from({ length: 14 }, (_, i) => 100 - (100 - low) * i / 14), low];
  for (const quote of [null, low, low * 1.005, low * 1.0051, low * 0.99]) cases.push({ closes, quote });
}
for (const peakAt of [5, 6]) {
  cases.push({ closes: [...Array(peakAt).fill(90), 100, 98, 96, 94, 92, 90, 88, 86, 85, 84].slice(0, 15), quote: 84 });
}
// Extreme but valid JavaScript numbers: subnormal closes (std::stod rejected 5e-324), closes near
// Number.MAX_VALUE, and alternating 1e308/1.79e308 closes whose gains and losses overflow to
// Infinity, which makes the RSI NaN.
const max = Number.MAX_VALUE;
cases.push(
  { closes: Array(15).fill(5e-324), quote: null },
  { closes: [...Array(14).fill(100), 5e-324], quote: null },
  { closes: Array(20).fill(100), quote: 5e-324 },
  { closes: [2.2250738585072014e-308, ...Array(14).fill(1e-300)], quote: 1e-310 },
  { closes: Array(15).fill(max), quote: null },
  { closes: [...Array(14).fill(1), max], quote: max },
  { closes: Array.from({ length: 15 }, (_, i) => (i % 2 ? 1.79e308 : 1e308)), quote: null },
  { closes: Array.from({ length: 16 }, (_, i) => (i % 2 ? 1.79e308 : 1e308)), quote: 1.5e308 },
);
// Seeded series exercise repeated peaks, factor boundaries, trend and invalid bars.
let seed = 0x12345678;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
for (let i = 0; i < 512; i++) {
  const count = 10 + Math.floor(random() * 90);
  const closes = [];
  let price = 10 + random() * 1000;
  for (let j = 0; j < count; j++) {
    price *= 0.92 + random() * 0.16;
    closes.push(j % 17 === 0 && i % 3 === 0 ? NaN : price);
  }
  cases.push({ closes, quote: i % 5 === 0 ? null : price * (0.8 + random() * 0.4) });
}
const encode = value => value === null ? 'null' : Number.isNaN(value) ? 'nan' : String(value);
const input = cases.map(({ closes, quote }) => [quote, ...closes].map(encode).join(' ')).join('\n') + '\n';
const run = spawnSync(executable, [], { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
assert.equal(run.status, 0, run.error?.message || run.stderr);
// Windows text-mode stdout ends lines with CRLF; compare line content, not line endings.
const rows = run.stdout.trim().split(/\r?\n/);
assert.equal(rows.length, cases.length);
const numericFields = ['score', 'currentPrice', 'peakPrice', 'peakIndex', 'dipPercentage', 'recentLow', 'recentHigh', 'rsi', 'ema5', 'ema10'];
const indexes = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11];
// Relative tolerance 1e-12; NaN and ±Infinity (printed as JavaScript spells them) must match exactly.
const near = (actual, expected) => (Number.isFinite(expected)
  ? Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12 : Object.is(actual, expected));
for (let i = 0; i < cases.length; i++) {
  const expected = analyzeStock(cases[i].closes, cases[i].quote);
  if (!expected) { assert.equal(rows[i], 'null', `case ${i}`); continue; }
  assert.notEqual(rows[i], 'null', `case ${i}: native result must exist`);
  const fields = rows[i].split('\t');
  for (let k = 0; k < numericFields.length; k++) {
    const key = numericFields[k], value = Number(fields[indexes[k]]);
    assert.ok(near(value, expected[key]), `case ${i}: ${key} ${value} != ${expected[key]}`);
  }
  assert.equal(fields[1], expected.verdict.label, `case ${i}: verdict`);
  assert.equal(fields[12], expected.trend, `case ${i}: trend`);
  for (const [index, key] of [[2, 'isZombie'], [13, 'trendAlertEligible'], [14, 'isBreakout'], [15, 'isBreakdown']]) {
    assert.equal(fields[index], expected[key] ? '1' : '0', `case ${i}: ${key}`);
  }
  assert.equal(fields[16], expected.factors.map(f => `${f.label}:${f.points}|`).join(''), `case ${i}: factor points`);
  const sparkline = fields[17].split(',').filter(Boolean).map(Number);
  assert.equal(sparkline.length, expected.sparkline.length, `case ${i}: sparkline length`);
  sparkline.forEach((price, j) => assert.ok(near(price, expected.sparkline[j]), `case ${i}: sparkline[${j}] ${price} != ${expected.sparkline[j]}`));
}
console.log(`${cases.length} native/JavaScript scoring parity cases passed`);

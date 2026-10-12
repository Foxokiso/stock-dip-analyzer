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
const rows = run.stdout.trim().split('\n');
assert.equal(rows.length, cases.length);
const numericFields = ['score', 'currentPrice', 'peakPrice', 'peakIndex', 'dipPercentage', 'recentLow', 'recentHigh', 'rsi', 'ema5', 'ema10'];
const indexes = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11];
for (let i = 0; i < cases.length; i++) {
  const expected = analyzeStock(cases[i].closes, cases[i].quote);
  if (!expected) { assert.equal(rows[i], 'null', `case ${i}`); continue; }
  assert.notEqual(rows[i], 'null', `case ${i}: native result must exist`);
  const fields = rows[i].split('\t');
  for (let k = 0; k < numericFields.length; k++) {
    const key = numericFields[k], value = Number(fields[indexes[k]]);
    const tolerance = Math.max(1, Math.abs(expected[key])) * 1e-12;
    assert.ok(Math.abs(value - expected[key]) <= tolerance, `case ${i}: ${key} ${value} != ${expected[key]}`);
  }
  assert.equal(fields[1], expected.verdict.label, `case ${i}: verdict`);
  assert.equal(fields[12], expected.trend, `case ${i}: trend`);
  for (const [index, key] of [[2, 'isZombie'], [13, 'trendAlertEligible'], [14, 'isBreakout'], [15, 'isBreakdown']]) {
    assert.equal(fields[index], expected[key] ? '1' : '0', `case ${i}: ${key}`);
  }
  assert.equal(fields[16], expected.factors.map(f => `${f.label}:${f.points}|`).join(''), `case ${i}: factor points`);
  const sparkline = fields[17].split(',').filter(Boolean).map(Number);
  assert.equal(sparkline.length, expected.sparkline.length, `case ${i}: sparkline length`);
  sparkline.forEach((price, j) => assert.ok(Math.abs(price - expected.sparkline[j]) <= Math.max(1, price) * 1e-12));
}
console.log(`${cases.length} native/JavaScript scoring parity cases passed`);

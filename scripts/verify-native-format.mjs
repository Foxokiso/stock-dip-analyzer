// Display-format parity between native/modules/format and src/utils/format.js.
// Preservation of existing presentation behavior only; this is not a trading backtest.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { formatCompact, formatPct, formatPrice } from '../src/utils/format.js';

const executable = process.argv[2];
assert.ok(executable, 'Pass the compiled native format test driver');

// formatCompact's sub-1000 branch calls Number.prototype.toLocaleString() with the host's
// default locale, and the native port reproduces en-US. Fail early with an explanation when
// this host's default Intl locale would make the JavaScript reference itself diverge.
const localeProbe = [1234.5678, -0.0001, 999.9995, 0.5, 1e21];
assert.deepEqual(
  localeProbe.map(v => v.toLocaleString()),
  localeProbe.map(v => v.toLocaleString('en-US')),
  `This verifier assumes the default Intl locale (${Intl.NumberFormat().resolvedOptions().locale}) formats numbers like en-US`
);

// Each case: { fn, value, digits? }. `value` may be a finite double, NaN, ±Infinity or null.
const cases = [];
const add = (fn, value, digits) => cases.push({ fn, value, digits });
const formatters = ['formatCompact', 'formatPct', 'formatPrice'];
const everyFormatter = value => formatters.forEach(fn => add(fn, value));

// Unavailable inputs render as "—" everywhere.
for (const value of [null, NaN, Infinity, -Infinity]) everyFormatter(value);
add('formatPct', null, 0);
add('formatPct', NaN, 4);

// Zero, signed zero, small and negative values.
for (const value of [0, -0, 1, -1, 0.5, -0.5, 0.001, -0.001, 0.0004, -0.0004, 0.0005, -0.0005, 0.0015, 0.1 + 0.2, 1 / 3, -2 / 3]) everyFormatter(value);

// Sub-1000 branch (toLocaleString): grouping, 3-fraction-digit half-expand rounding on the
// shortest decimal, trailing-zero trimming, carries into a new integer digit.
for (const value of [1.0005, 2.0005, 8.0005, 1.0015, 1.0025, 1.005, 1.015, 1.025, 2.675, 0.1235, 1.2345, 123.4567, 100, 100.5, 999, 999.5, 999.999, 999.9994, 999.9995, 999.9996, -999.9995, -999.9999, 0.9995, 0.9996, 0.00049999, 0.000499999, 1e-5, 1e-7, 5e-324, 2.2250738585072014e-308]) everyFormatter(value);

// 1e3..1e15 boundaries, one ulp either side, and the K/M/B/T hand-offs.
const nextAfter = (value, direction) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  let bits = view.getBigUint64(0);
  bits += direction > 0 ? 1n : -1n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
};
for (let exponent = 3; exponent <= 15; exponent++) {
  const boundary = 10 ** exponent;
  for (const value of [boundary, -boundary, nextAfter(boundary, -1), nextAfter(boundary, 1), boundary - 1, boundary + 1, boundary * 9.9994, boundary * 9.9995, boundary * 9.9996, boundary * 0.99995, boundary * 0.999949]) everyFormatter(value);
}
for (const value of [1500, 1250, 1350, 1450, 1050, 9950, 9949, 99950, 999950, 999949, 999999.5, 1125000, 1135000, 2.5e9, 2.505e9, 1.005e12, 1.125e12, 4500000, 1234567890, 1234567890123, 1e16, 1e18, 1e20, 123456789012345680000, 1e21, -1e21, 1.5e22, 1.2345e25, 1e33, 1.5e34, 1e300, 1.7976931348623157e308, -1.7976931348623157e308]) everyFormatter(value);

// Rounding at .5: exact binary ties (JS toFixed rounds them up, printf rounds half-even) and
// decimal literals that are not actually ties (1.005 is below 1.005 in binary).
const ties = [0.5, 1.5, 2.5, 12.125, 12.375, 12.625, 1.125, 0.125, 0.625, 0.375, 1.25, 1.75, 3.375, 10.005, 1.005, 1.015, 8.325, 2.675, 0.045, 0.055, 1.0049999999999999];
for (const value of ties) {
  for (const signed of [value, -value]) {
    everyFormatter(signed);
    for (const digits of [0, 1, 2, 3]) add('formatPct', signed, digits);
    add('toFixed', signed, 0);
    add('toFixed', signed, 1);
    add('toFixed', signed, 2);
  }
}
for (const digits of [0, 1, 2, 3, 4, 5, 8, 10, 15, 20, 100]) {
  add('formatPct', 2.345, digits);
  add('formatPct', -1.2, digits);
  add('formatPct', 1e-7, digits);
  add('formatPct', 123456.789, digits);
  add('toFixed', 0.1, digits);
  add('toFixed', 5e-324, digits);
}
// Building blocks exposed by the driver, compared against the engine's own methods.
for (const value of [0, -0, 1e21, 1e-7, 1e-6, 123456789012345680000, 1.5e22, 1.2345e25, 0.000001, 1234.5678, 0.1 + 0.2, 1e300, 5e-324]) {
  add('toString', value);
  add('toLocaleString', value);
}

// 500 seeded random magnitudes (1e-4 .. 1e16, both signs), each through every formatter plus
// a random precision for formatPct.
let seed = 0x5eed27;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
for (let i = 0; i < 500; i++) {
  const magnitude = Math.floor(random() * 21) - 4;
  let value = (1 + random() * 9) * 10 ** magnitude;
  if (i % 4 === 0) value = Math.round(value * 1000) / 1000;      // short decimals
  if (i % 9 === 0) value = Math.floor(value * 8) / 8;            // exact binary fractions (ties)
  if (i % 2 === 1) value = -value;
  everyFormatter(value);
  add('formatPct', value, Math.floor(random() * 7));
}

const encode = value => {
  if (value === null) return 'null';
  if (Number.isNaN(value)) return 'nan';
  if (Object.is(value, -0)) return '-0';
  return String(value);   // shortest round-trip literal; the driver parses it with strtod
};
const input = cases.map(({ fn, value, digits }) => [fn, encode(value), ...(digits === undefined ? [] : [digits])].join(' ')).join('\n') + '\n';
const run = spawnSync(executable, [], { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
assert.equal(run.status, 0, run.error?.message || run.stderr);
// Windows text-mode stdout ends lines with CRLF; compare line content, not line endings.
const rows = run.stdout.replace(/\r?\n$/, '').split(/\r?\n/);
assert.equal(rows.length, cases.length, 'one output line per case');

const reference = ({ fn, value, digits }) => {
  switch (fn) {
    case 'formatCompact': return formatCompact(value);
    case 'formatPct': return digits === undefined ? formatPct(value) : formatPct(value, digits);
    case 'formatPrice': return formatPrice(value);
    case 'toFixed': return value.toFixed(digits ?? 0);
    case 'toLocaleString': return value.toLocaleString();
    case 'toString': return String(value);
    default: throw new Error(`unknown fn ${fn}`);
  }
};
// Outputs are display strings, so parity is exact equality (no numeric tolerance applies).
for (let i = 0; i < cases.length; i++) {
  const expected = reference(cases[i]);
  const { fn, value, digits } = cases[i];
  assert.equal(rows[i], expected, `case ${i}: ${fn}(${encode(value)}${digits === undefined ? '' : `, ${digits}`}) native ${JSON.stringify(rows[i])} != reference ${JSON.stringify(expected)}`);
}
assert.ok(!run.stdout.includes('Zombie Corp') && !run.stdout.includes('Mock News'));
console.log(`${cases.length} native/JavaScript format parity cases passed`);

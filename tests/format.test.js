import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { formatCompact, formatPct, formatPrice, formatQuoteTime } from '../src/utils/format.js';

// formatQuoteTime uses the default zone; this file runs in its own process.
process.env.TZ = 'America/New_York';

test('compact numbers use K/M/B/T with fixed precision, and the host locale below 1000', () => {
    for (const [value, text] of [[1000, '1.0K'], [1500, '1.5K'], [-1250, '-1.3K'], ['2500', '2.5K'], [4500000, '4.50M'],
        [1234567890, '1.23B'], [1234567890123, '1.23T'], [1e16, '10000.00T'], [1e33, '1e+21T']]) {
        assert.equal(formatCompact(value), text, `formatCompact(${value})`);
    }
    for (const value of [0, 12.5, 999, -3.25, 999.9995]) assert.equal(formatCompact(value), value.toLocaleString());
});

test('compact numbers pick the unit after rounding, never printing 1000 of a unit', () => {
    for (const [value, text] of [[999949, '999.9K'], [999950, '1.00M'], [999999, '1.00M'], [-999950, '-1.00M'],
        [999994999, '999.99M'], [999995000, '1.00B'], [-999995000, '-1.00B'], [999995000000, '1.00T']]) {
        assert.equal(formatCompact(value), text, `formatCompact(${value})`);
    }
});

test('percentages sign gains and keep the requested precision', () => {
    assert.equal(formatPct(2.345), '+2.35%');
    assert.equal(formatPct(-1.2), '-1.20%');
    assert.equal(formatPct(0), '0.00%');
    assert.equal(formatPct(1.5, 0), '+2%');
    assert.equal(formatPct('3.14159', 3), '+3.142%');
    assert.equal(formatPct(-0.005), '-0.01%');
    assert.equal(formatPct(1e-7, 8), '+0.00000010%');
});

test('prices show two decimals and a dollar sign', () => {
    assert.equal(formatPrice(12.3456), '$12.35');
    assert.equal(formatPrice('7'), '$7.00');
    assert.equal(formatPrice(344.63), '$344.63');
    assert.equal(formatPrice(-5), '$-5.00');
});

test('a value that rounds to zero prints without a sign', () => {
    for (const value of [-0.004, 0.004, -0, -0.0049999]) assert.equal(formatPct(value), '0.00%', `formatPct(${value})`);
    assert.equal(formatPct(-0.4, 0), '0%');
    assert.equal(formatPct(-1e-7, 8), '-0.00000010%');
    assert.equal(formatPrice(-0.004), '$0.00');
    assert.equal(formatPrice(-0), '$0.00');
    assert.equal(formatPrice(-0.005), '$-0.01');
    for (const value of [-0, -0.0004]) assert.equal(formatCompact(value), (0).toLocaleString(), `formatCompact(${value})`);
    assert.equal(formatCompact(-0.0005), (-0.0005).toLocaleString());
});

// A process takes its default locale from LC_ALL/LANG when it starts (Windows uses the account
// setting instead), so other locales run in a child process.
const compactInLocale = (locale) => {
    const script = `import { formatCompact } from ${JSON.stringify(new URL('../src/utils/format.js', import.meta.url).href)};
const signed = [-0.0005, -3.25, -999.9996];
console.log(JSON.stringify({
    locale: Intl.NumberFormat().resolvedOptions().locale,
    zero: (0).toLocaleString(),
    roundedToZero: [-0, -0.0004, -1e-10, -5e-324].map(formatCompact),
    signed: signed.map(formatCompact),
    signedLocale: signed.map(value => value.toLocaleString()),
}));`;
    const name = `${locale.replace('-', '_')}.UTF-8`;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', env: { ...process.env, LC_ALL: name, LANG: name } });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
};

test('a compact value that rounds to zero has no sign in locales whose minus is not an ASCII hyphen', async (t) => {
    // Swedish writes U+2212; Arabic adds a letter mark and Arabic-Indic digits.
    for (const locale of ['sv-SE', 'ar-EG']) {
        await t.test(locale, (st) => {
            const result = compactInLocale(locale);
            if (result.locale !== locale) return st.skip(`the default locale does not follow LC_ALL here (${result.locale})`);
            assert.deepEqual(result.roundedToZero, Array(4).fill(result.zero));
            assert.deepEqual(result.signed, result.signedLocale);
        });
    }
});

test('quote times name their time zone and match toLocaleString', () => {
    const zoneName = (date) => new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(date).find(part => part.type === 'timeZoneName').value;
    for (const value of ['2026-10-30T20:00:01.000Z', 1793390401000, '2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z', '2026-11-01T05:30:00Z',
        '2026-11-01T06:30:00Z', '2000-02-29T12:00:00Z', '1970-01-01T00:00:00.001Z']) {
        const date = new Date(value);
        const text = formatQuoteTime(value);
        assert.equal(text, date.toLocaleString([], { timeZoneName: 'short' }));
        assert.ok(text.includes(zoneName(date)), `${text} names ${zoneName(date)}`);
    }
    for (const value of [null, undefined, '', 'garbage', NaN]) assert.equal(formatQuoteTime(value), 'Unavailable');
});

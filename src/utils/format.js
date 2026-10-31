// Shared display formatters.

// [divisor, suffix, fraction digits], smallest first.
const COMPACT_UNITS = [[1e3, 'K', 1], [1e6, 'M', 2], [1e9, 'B', 2], [1e12, 'T', 2]];

// A value that rounds to zero is shown unsigned: "-0.00" would read as a fall. toFixed always
// writes an ASCII '-'.
const unsignedZero = (text) => (/^-[0.]+$/.test(text) ? text.slice(1) : text);

// toLocaleString() with the same rule: signDisplay 'negative' drops the sign of a value that
// rounds to zero in every locale (sv and fi write U+2212, Arabic adds a mark). Built once, as
// passing options to toLocaleString builds a formatter on every call.
let localeNumberFormat;

// 1234567890 -> "1.23B", 4500000 -> "4.50M", null/undefined/NaN -> "—"
export function formatCompact(value) {
    if (!isDisplayNumber(value)) return '—';
    const n = Number(value);
    if (Math.abs(n) < 1e3) {
        localeNumberFormat ??= new Intl.NumberFormat(undefined, { signDisplay: 'negative' });
        return localeNumberFormat.format(n);
    }
    // The unit is chosen after rounding, so 999,950 is "1.00M", never "1000.0K".
    const scaled = COMPACT_UNITS.map(([divisor, suffix, digits]) => [(n / divisor).toFixed(digits), suffix]);
    const [text, suffix] = scaled.find(([mantissa]) => Math.abs(Number(mantissa)) < 1000) ?? scaled.at(-1);
    return `${text}${suffix}`;
}

// 2.345 -> "+2.35%", -1.2 -> "-1.20%", -0.001 -> "0.00%", null -> "—"
export function formatPct(value, digits = 2) {
    if (!isDisplayNumber(value)) return '—';
    const text = unsignedZero(Number(value).toFixed(digits));
    return `${Number(text) > 0 ? '+' : ''}${text}%`;
}

// 12.3456 -> "$12.35", null -> "—"
export function formatPrice(value) {
    if (!isDisplayNumber(value)) return '—';
    return `$${unsignedZero(Number(value).toFixed(2))}`;
}

function isDisplayNumber(value) {
    return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
        && Number.isFinite(Number(value));
}

// toLocaleString([], { timeZoneName: 'short' }) builds a formatter on every call; these are
// the options it resolves to, built once (with the default locale and zone of that moment).
let quoteTimeFormat;

export function formatQuoteTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || !Number.isFinite(date.getTime())) return 'Unavailable';
    quoteTimeFormat ??= new Intl.DateTimeFormat([], {
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', timeZoneName: 'short',
    });
    return quoteTimeFormat.format(date);
}

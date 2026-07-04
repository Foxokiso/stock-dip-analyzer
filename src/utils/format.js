// Shared display formatters.

// 1234567890 -> "1.23B", 4500000 -> "4.50M", null/undefined/NaN -> "—"
export function formatCompact(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
    const n = Number(value);
    const abs = Math.abs(n);
    if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return n.toLocaleString();
}

// 2.345 -> "+2.35%", -1.2 -> "-1.20%", null -> "—"
export function formatPct(value, digits = 2) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
    const n = Number(value);
    return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

// 12.3456 -> "$12.35", null -> "—"
export function formatPrice(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
    return `$${Number(value).toFixed(2)}`;
}

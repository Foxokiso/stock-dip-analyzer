const fields = {
    ticker: 'symbol', company: 'name', sector: 'sector', price: 'price', change: 'change',
    volume: 'volume', 'market cap': 'marketCap', 'perf month': 'perfMonth', 'perf year': 'perfYear', dividend: 'dividendYield',
};
// The current grid appends a short label ("Mkt Cap") and a sort indicator to a
// header cell's text, so the full name is taken from aria-label or the label
// span when present; the legacy <th> keeps its plain text.
const headerLabel = (cell) => {
    const explicit = cell.getAttribute?.('aria-label') || cell.querySelector?.('.fv-table_header-label')?.textContent;
    return (explicit || cell.textContent).trim().toLowerCase().replace(/\s+/g, ' ').replace(/^change\s*%$/, 'change');
};

export function resolveFinvizNewsUrl(href) {
    if (typeof href !== 'string' || !href.trim()) return null;
    try {
        const url = new URL(href, 'https://finviz.com/');
        return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
}

const tickerText = (anchor) => {
    const copy = anchor.cloneNode(true);
    // The current grid puts a logo fallback letter inside the ticker link.
    copy.querySelectorAll('[aria-hidden="true"]').forEach(element => element.remove());
    return copy.textContent.trim();
};

const gridCells = (row, role) => [...row.querySelectorAll(`[role="${role}"]`)]
    .filter(cell => cell.closest('[role="row"]') === row)
    .sort((a, b) => Number(a.getAttribute('aria-colindex')) - Number(b.getAttribute('aria-colindex')));
const completeGridColumns = cells => cells.every((cell, index) => cell.getAttribute('aria-colindex') === String(index + 1));

const numeric = (text) => {
    const normalized = text.trim().replace(/,/g, '').replace(/%$/, '');
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([KMBT])?$/i.exec(normalized);
    if (!match) return null;
    const scale = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase()] || 1;
    // toPrecision(15) removes binary float noise such as 33.24 × 1e6 = 33240000.000000004.
    const value = Number((Number(match[1]) * scale).toPrecision(15));
    return Number.isFinite(value) ? value : null;
};

// Finviz nests layout tables around the screener. Only direct cells belong to
// a quote row; querying all descendant td elements can invent ticker "1".
export function parseFinvizScreener(html, {
    fetchedAt = new Date().toISOString(), DOMParser = globalThis.DOMParser, view = '111',
} = {}) {
    if (!DOMParser) throw new Error('Finviz parser is unavailable in this environment.');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const stocks = new Map();
    let recognizedTable = false;
    let dataRows = 0;

    // Both the legacy table and the current server-rendered ARIA grid carry
    // the same labelled fields. Grid lanes may be reordered in the DOM, so
    // bind their cells by explicit column index rather than wrapper order.
    for (const table of doc.querySelectorAll('table, [role="grid"]')) {
        const isGrid = table.getAttribute('role') === 'grid';
        const containerSelector = isGrid ? '[role="grid"]' : 'table';
        const rows = [...table.querySelectorAll(isGrid ? '[role="row"]' : 'tr')]
            .filter(row => row.closest(containerSelector) === table);
        const headerCells = row => isGrid ? gridCells(row, 'columnheader') : [...row.children];
        const header = rows.find(row => {
            const cells = headerCells(row);
            if (isGrid && !completeGridColumns(cells)) return false;
            const labels = cells.map(headerLabel);
            return labels.includes('ticker') && labels.includes('price') && labels.includes('change');
        });
        if (!header) continue;
        const labels = headerCells(header).map(headerLabel);
        if (view === '111' && (labels.length !== 11 || labels[1] !== 'ticker' || labels[2] !== 'company' || labels[3] !== 'sector')) continue;
        if ((view === '141' || view === '152') && !labels.includes('perf month')) continue;
        if (view === '161' && !labels.includes('dividend')) continue;
        recognizedTable = true;
        const tickerIndex = labels.indexOf('ticker');

        for (const row of rows) {
            const cells = isGrid ? gridCells(row, 'gridcell') : [...row.children].filter(cell => cell.tagName === 'TD');
            if (!cells[0] || !/^[1-9]\d*$/.test(cells[0].textContent.trim())) continue;
            dataRows++;
            if (cells.length !== labels.length || (isGrid && !completeGridColumns(cells))) continue;
            const link = [...cells[tickerIndex].querySelectorAll('a[href]')].find(anchor => {
                const text = tickerText(anchor);
                if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(text)) return false;
                try {
                    const url = new URL(anchor.getAttribute('href'), 'https://finviz.com/');
                    return url.hostname === 'finviz.com' && ['/quote.ashx', '/stock', '/quote'].includes(url.pathname)
                        && url.searchParams.get('t') === text;
                } catch { return false; }
            });
            const symbol = link ? tickerText(link) : null;
            if (!symbol) continue;

            const stock = { symbol, name: symbol, sector: '', price: null, change: null, volume: null, marketCap: null,
                source: 'Finviz', delayMinutes: 1, quotedAt: null, fetchedAt };
            labels.forEach((label, index) => {
                const field = fields[label];
                if (!field || field === 'symbol') return;
                const text = cells[index].textContent.trim();
                stock[field] = field === 'name' || field === 'sector' ? text : numeric(text);
            });
            if (stock.price !== null && stock.price <= 0) stock.price = null;
            stock.changePercentage = stock.change;
            stocks.set(symbol, stock);
        }
    }

    if ((dataRows > 0 && stocks.size === 0) || (!recognizedTable && !/\b0\s+Total\b|No results found/i.test(doc.body?.textContent || ''))) {
        throw new Error('Finviz screener unavailable: response blocked or table schema changed.');
    }
    return [...stocks.values()];
}

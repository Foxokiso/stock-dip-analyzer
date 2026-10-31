import { stripInlineHandlers } from './inertHtml.js';

// The current grid tags every header and cell with Finviz's column id (its sort
// key), which survived the 2026-10-21 relabel. Each column is bound by that id
// first and by its accessible name otherwise; the legacy table has names only.
const COLUMN_IDS = new Map(Object.entries({
    row: 'row', ticker: 'symbol', company: 'name', sector: 'sector', price: 'price', change: 'change', volume: 'volume',
    marketCap: 'marketCap', perf4w: 'perfMonth', perf52w: 'perfYear', dividendYield: 'dividendYield',
}));
const COLUMN_NAMES = new Map(Object.entries({
    'no.': 'row', ticker: 'symbol', company: 'name', sector: 'sector', price: 'price', change: 'change', volume: 'volume',
    'market cap': 'marketCap', 'perf month': 'perfMonth', 'perf year': 'perfYear', dividend: 'dividendYield',
}));
// Fields each view must bind exactly once, besides the row number; any other
// column is tolerated.
const VIEW_FIELDS = {
    111: ['symbol', 'name', 'sector', 'price', 'change'],
    141: ['symbol', 'price', 'change', 'perfMonth'],
    152: ['symbol', 'price', 'change', 'perfMonth'],
    161: ['symbol', 'price', 'change', 'dividendYield'],
};
// Numeric fields a view relies on. When none of a column's values parses, the
// format changed: the page fails rather than turning every quote unavailable.
const VIEW_NUMBERS = {
    111: ['price', 'change'],
    141: ['price', 'change', 'perfMonth', 'perfYear'],
    152: ['price', 'change', 'perfMonth', 'perfYear'],
    161: ['price', 'change', 'dividendYield'],
};
const placeholder = (text) => /^[-\u2013\u2014\u2212]?$/.test(text); // empty, or a dash for "no value"
// The current grid appends a short label ("Mkt Cap") and a sort indicator to a
// header cell's text, so the full name is taken from aria-label or the label
// span when present; the legacy <th> keeps its plain text.
const headerLabel = (cell) => {
    const explicit = cell.getAttribute?.('aria-label') || cell.querySelector?.('.fv-table_header-label')?.textContent;
    return (explicit || cell.textContent).trim().toLowerCase().replace(/\s+/g, ' ').replace(/^change\s*%$/, 'change');
};
const bindingOf = (cell) => {
    const byId = COLUMN_IDS.get(cell.getAttribute?.('data-column-id'));
    return { field: byId ?? COLUMN_NAMES.get(headerLabel(cell)), byId: byId !== undefined };
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
const quoteLinkTicker = (anchor) => {
    try {
        const url = new URL(anchor.getAttribute('href'), 'https://finviz.com/');
        return url.hostname === 'finviz.com' && ['/quote.ashx', '/stock', '/quote'].includes(url.pathname) ? url.searchParams.get('t') : null;
    } catch { return null; }
};
// A ticker counts only when a finviz.com quote link in its cell names the same
// symbol: the cell's data-ticker where the grid supplies it, else the link text.
const cellSymbol = (cell) => {
    const tagged = cell.getAttribute('data-ticker') || null;
    for (const anchor of cell.querySelectorAll('a[href]')) {
        const symbol = tagged ?? tickerText(anchor);
        if (/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) && quoteLinkTicker(anchor) === symbol) return symbol;
    }
    return null;
};

const gridCells = (row, role) => [...row.querySelectorAll(`[role="${role}"]`)]
    .filter(cell => cell.closest('[role="row"]') === row)
    .sort((a, b) => Number(a.getAttribute('aria-colindex')) - Number(b.getAttribute('aria-colindex')));
const completeGridColumns = cells => cells.every((cell, index) => cell.getAttribute('aria-colindex') === String(index + 1));

// Group separators may be commas, no-break or thin spaces, and a minus may be
// typographic. A form Finviz does not use, such as "(5.2%)", stays unavailable.
const numeric = (text) => {
    const normalized = text.trim().replace(/[,\u00a0\u2009\u202f]/g, '').replace(/^[\u2212\u2013](?=[\d.])/, '-').replace(/%$/, '');
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([KMBT])?$/i.exec(normalized);
    if (!match) return null;
    const scale = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase()] || 1;
    // toPrecision(15) removes binary float noise such as 33.24 × 1e6 = 33240000.000000004.
    const value = Number((Number(match[1]) * scale).toPrecision(15));
    return Number.isFinite(value) ? value : null;
};

/** The screener rows of one page; see parseFinvizScreenerPage. */
export const parseFinvizScreener = (html, options) => parseFinvizScreenerPage(html, options).rows;

// Finviz nests layout tables around the screener. Only direct cells belong to
// a quote row; querying all descendant td elements can invent ticker "1".
/**
 * Parse one screener page. Besides the rows it accepted, it reports what the
 * page itself says about paging: `dataRows` counts every numbered row,
 * including any it skipped; `firstRowNumber` is the lowest "No." on the page;
 * `total` is the result count the page states, or null.
 * @returns {{ rows: object[], dataRows: number, firstRowNumber: number | null, total: number | null }}
 */
export function parseFinvizScreenerPage(html, {
    fetchedAt = new Date().toISOString(), DOMParser = globalThis.DOMParser, view = '111',
} = {}) {
    if (!DOMParser) throw new Error('Finviz parser is unavailable in this environment.');
    const doc = new DOMParser().parseFromString(stripInlineHandlers(html), 'text/html');
    const required = ['row', ...(VIEW_FIELDS[view] ?? ['symbol', 'price', 'change'])];
    const numbers = new Map((VIEW_NUMBERS[view] ?? ['price', 'change']).map(field => [field, { values: 0, parsed: 0 }]));
    const stocks = new Map();
    let recognizedTable = false;
    let dataRows = 0, firstRowNumber = null, lastRowNumber = 0, rowCount = null;

    // Both the legacy table and the current server-rendered ARIA grid carry
    // the same fields. Grid lanes may be reordered in the DOM, so bind their
    // cells by explicit column index rather than wrapper order.
    for (const table of doc.querySelectorAll('table, [role="grid"]')) {
        const isGrid = table.getAttribute('role') === 'grid';
        const containerSelector = isGrid ? '[role="grid"]' : 'table';
        const rows = [...table.querySelectorAll(isGrid ? '[role="row"]' : 'tr')]
            .filter(row => row.closest(containerSelector) === table);
        const headerCells = row => isGrid ? gridCells(row, 'columnheader') : [...row.children];
        const header = rows.find(row => {
            const cells = headerCells(row);
            if (isGrid && !completeGridColumns(cells)) return false;
            const bound = cells.map(cell => bindingOf(cell).field);
            return bound.includes('symbol') && bound.includes('price') && bound.includes('change');
        });
        if (!header) continue;
        const columns = headerCells(header).map(bindingOf);
        // A field claimed by two columns is ambiguous and stays unbound, unless
        // only one of them carries the field's column id.
        const columnOf = (field) => {
            const claims = columns.flatMap((column, index) => (column.field === field ? [index] : []));
            const identified = claims.filter(index => columns[index].byId);
            const candidates = identified.length > 0 ? identified : claims;
            return candidates.length === 1 ? candidates[0] : -1;
        };
        if (!required.every(field => columnOf(field) >= 0)) continue;
        recognizedTable = true;
        const ariaRows = Number(table.getAttribute('aria-rowcount'));
        if (rowCount === null && Number.isInteger(ariaRows) && ariaRows > 0) rowCount = ariaRows;
        const rowColumn = columnOf('row');
        const symbolColumn = columnOf('symbol');
        const valueColumns = [...new Set(columns.map(column => column.field))].filter(field => field && field !== 'row' && field !== 'symbol' && columnOf(field) >= 0)
            .map(field => [field, columnOf(field)]);
        const cellAt = (cells, column) => (isGrid ? cells.find(cell => cell.getAttribute('aria-colindex') === String(column + 1)) : cells[column]);

        for (const row of rows) {
            const cells = isGrid ? gridCells(row, 'gridcell') : [...row.children].filter(cell => cell.tagName === 'TD');
            const number = cellAt(cells, rowColumn)?.textContent.trim() ?? '';
            if (!/^[1-9]\d*$/.test(number)) continue;
            dataRows++;
            firstRowNumber = Math.min(firstRowNumber ?? Infinity, Number(number));
            lastRowNumber = Math.max(lastRowNumber, Number(number));
            if (cells.length !== columns.length || (isGrid && !completeGridColumns(cells))) continue;
            const symbol = cellSymbol(cells[symbolColumn]);
            if (!symbol) continue;

            const stock = { symbol, name: symbol, sector: '', price: null, change: null, volume: null, marketCap: null,
                source: 'Finviz', delayMinutes: 1, quotedAt: null, fetchedAt };
            for (const [field, column] of valueColumns) {
                const text = cells[column].textContent.trim();
                stock[field] = field === 'name' || field === 'sector' ? text : numeric(text);
                const tally = numbers.get(field);
                if (tally && !placeholder(text)) {
                    tally.values++;
                    if (stock[field] !== null) tally.parsed++;
                }
            }
            if (stock.price !== null && stock.price <= 0) stock.price = null;
            stock.changePercentage = stock.change;
            stocks.set(symbol, stock);
        }
    }

    if ((dataRows > 0 && stocks.size === 0) || (!recognizedTable && !/\b0\s+Total\b|No results found/i.test(doc.body?.textContent || ''))) {
        throw new Error('Finviz screener unavailable: response blocked or table schema changed.');
    }
    for (const [field, { values, parsed }] of numbers) {
        if (values > 0 && parsed === 0) throw new Error(`Finviz screener schema changed: ${field} unparseable.`);
    }
    // The grid's aria-rowcount includes its header row; both layouts also print
    // "#1 / 5620 Total". A count below a row number on the page is not trusted.
    const stated = rowCount !== null ? rowCount - 1 : Number(/#\d+\s*\/\s*(\d+)\s*Total/.exec(doc.documentElement?.textContent || '')?.[1] ?? NaN);
    const total = Number.isInteger(stated) && stated >= lastRowNumber ? stated : null;
    return { rows: [...stocks.values()], dataRows, firstRowNumber, total };
}

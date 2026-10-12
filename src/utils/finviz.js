const fields = {
    ticker: 'symbol', company: 'name', sector: 'sector', price: 'price', change: 'change',
    volume: 'volume', 'market cap': 'marketCap', 'perf month': 'perfMonth', 'perf year': 'perfYear', dividend: 'dividendYield',
};
const headerLabel = (cell) => cell.textContent.trim().toLowerCase().replace(/^change\s*%$/, 'change');

const numeric = (text) => {
    const normalized = text.trim().replace(/,/g, '').replace(/%$/, '');
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([KMBT])?$/i.exec(normalized);
    if (!match) return null;
    const scale = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase()] || 1;
    const value = Number(match[1]) * scale;
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

    for (const table of doc.querySelectorAll('table')) {
        const rows = [...table.querySelectorAll('tr')].filter(row => row.closest('table') === table);
        const header = rows.find(row => {
            const labels = [...row.children].map(headerLabel);
            return labels.includes('ticker') && labels.includes('price') && labels.includes('change');
        });
        if (!header) continue;
        const labels = [...header.children].map(headerLabel);
        if (view === '111' && (labels.length !== 11 || labels[1] !== 'ticker' || labels[2] !== 'company' || labels[3] !== 'sector')) continue;
        if ((view === '141' || view === '152') && !labels.includes('perf month')) continue;
        if (view === '161' && !labels.includes('dividend')) continue;
        recognizedTable = true;
        const tickerIndex = labels.indexOf('ticker');

        for (const row of rows) {
            const cells = [...row.children].filter(cell => cell.tagName === 'TD');
            if (!cells[0] || !/^[1-9]\d*$/.test(cells[0].textContent.trim())) continue;
            dataRows++;
            if (cells.length !== labels.length) continue;
            const link = [...cells[tickerIndex].querySelectorAll('a[href]')].find(anchor => {
                const text = anchor.textContent.trim();
                if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(text)) return false;
                try {
                    const url = new URL(anchor.getAttribute('href'), 'https://finviz.com/');
                    return url.hostname === 'finviz.com' && ['/quote.ashx', '/stock'].includes(url.pathname)
                        && url.searchParams.get('t') === text;
                } catch { return false; }
            });
            const symbol = link?.textContent.trim();
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

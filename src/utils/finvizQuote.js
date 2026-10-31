import { resolveFinvizNewsUrl } from './finviz.js';
import { stripInlineHandlers } from './inertHtml.js';

// The quote page lives at /stock; quote.ashx answers with two 301 hops (/quote, then /stock).
export const finvizQuoteUrl = (symbol) => `https://finviz.com/stock?t=${encodeURIComponent(symbol)}&p=d`;

const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();

// Finviz prints '-' (or leaves the cell empty) for a statistic it does not have.
const statValue = (cell) => {
    const value = text(cell);
    return value === '' || value === '-' ? null : value;
};

// '52W High' and '52W Low' read "351.73 -2.02%": the bound, then the distance from it.
const leadingPrice = (value) => {
    const match = /^(\d[\d,]*(?:\.\d+)?)(?:\s|$)/.exec(value ?? '');
    const price = match ? Number(match[1].replace(/,/g, '')) : NaN;
    return Number.isFinite(price) && price > 0 ? price : null;
};

// Each headline names its publisher beside the link, e.g. "(Zacks)". The link's host is
// often a syndicator (finance.yahoo.com, finviz.com), so it never stands in for one.
const publisher = (cell) => {
    const label = cell.querySelector('.news-link-right span') ?? cell.querySelector('.news-link-right');
    return (label ? text(label).replace(/^\((.*)\)$/, '$1').trim() : '') || null;
};

/**
 * Statistics, headlines and 52-week bounds from a Finviz quote page.
 * Missing values stay null; a page with neither table throws.
 * @returns {{ stats: Map<string, string|null>, news: { time: string, title: string, link: string, source: string|null }[],
 *   fiftyTwoWeekHigh: number|null, fiftyTwoWeekLow: number|null }}
 */
export function parseFinvizQuotePage(html, { DOMParser = globalThis.DOMParser } = {}) {
    if (!DOMParser) throw new Error('Finviz parser is unavailable in this environment.');
    const doc = new DOMParser().parseFromString(stripInlineHandlers(html), 'text/html');

    // The snapshot is a set of tables of label/value cell pairs. Pairing within each
    // row keeps one malformed row from shifting every later value onto the wrong label.
    const stats = new Map();
    for (const row of doc.querySelectorAll('.snapshot-table2 tr')) {
        const cells = [...row.children].filter(cell => cell.tagName === 'TD');
        for (let i = 0; i + 1 < cells.length; i += 2) {
            const label = text(cells[i]);
            if (label) stats.set(label, statValue(cells[i + 1]));
        }
    }

    // The first headline of each day carries the date ("Oct-29-26 01:08PM", "Today 06:51PM");
    // the rest of that day's rows carry only the time. Finviz prints US Eastern times.
    const news = [];
    let date = '';
    for (const row of doc.querySelectorAll('#news-table tr')) {
        const cells = [...row.children].filter(cell => cell.tagName === 'TD');
        if (cells.length !== 2) continue;
        const stamp = text(cells[0]);
        const split = stamp.lastIndexOf(' ');
        if (split > 0) date = stamp.slice(0, split);
        const anchor = cells[1].querySelector('a[href]');
        const link = resolveFinvizNewsUrl(anchor?.getAttribute('href'));
        const title = anchor ? text(anchor) : '';
        if (!link || !title) continue;
        news.push({ time: split > 0 || !date ? stamp : `${date} ${stamp}`, title, link, source: publisher(cells[1]) });
    }

    if (stats.size === 0 && news.length === 0) {
        throw new Error('Finviz quote page unavailable: response blocked or page schema changed.');
    }
    return {
        stats,
        news,
        fiftyTwoWeekHigh: leadingPrice(stats.get('52W High')),
        fiftyTwoWeekLow: leadingPrice(stats.get('52W Low')),
    };
}

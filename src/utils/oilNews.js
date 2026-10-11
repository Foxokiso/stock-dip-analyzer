const DEESCALATION_PHRASES = /ceasefire|cease-fire|truce|peace deal|peace talks|de-?escalat\w*|strikes? (a |an )?deal|deal struck|strike price/gi;
const HIGH_IMPACT_RE = /\b(?:hormuz|attack\w*|strikes?|struck|blockade\w*|sanction\w*|seiz\w*|closures?|closed|fires?|explosions?|blasts?|drones?|missiles?|war|escalat\w*|disrupt\w*|halts?|halted|embargo\w*)\b/i;

export function parseOilNews(xml, { DOMParser = globalThis.DOMParser } = {}) {
    if (!DOMParser) throw new Error('RSS parser is unavailable.');
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (!doc.querySelector('rss > channel') || doc.querySelector('parsererror')) throw new Error('News feed unavailable: invalid RSS response.');
    const headlines = new Map();
    for (const item of doc.querySelectorAll('channel > item')) {
        const rawTitle = item.querySelector('title')?.textContent.trim() || '';
        const link = item.querySelector('link')?.textContent.trim() || '';
        if (!rawTitle || !/^https?:\/\//i.test(link) || headlines.has(link)) continue;
        const separator = rawTitle.lastIndexOf(' - ');
        const source = item.querySelector('source')?.textContent.trim() || (separator > 0 ? rawTitle.slice(separator + 3) : 'Source not supplied');
        const title = separator > 0 ? rawTitle.slice(0, separator) : rawTitle;
        const pubDate = item.querySelector('pubDate')?.textContent;
        const date = pubDate ? new Date(pubDate) : null;
        headlines.set(link, {
            title, link, source,
            publishedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
            highImpact: HIGH_IMPACT_RE.test(title.replace(DEESCALATION_PHRASES, ' ')),
        });
    }
    return [...headlines.values()].slice(0, 15).sort((a, b) => Number(b.highImpact) - Number(a.highImpact));
}

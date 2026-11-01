const DEESCALATION_PHRASES = /ceasefire|cease-fire|truce|peace deal|peace talks|de-?escalat\w*|strikes? (a |an )?deal|deal struck|strike price/gi;
const HIGH_IMPACT_RE = /\b(?:hormuz|attack\w*|strikes?|struck|blockade\w*|sanction\w*|seiz\w*|closures?|closed|fires?|explosions?|blasts?|drones?|missiles?|war|escalat\w*|disrupt\w*|halts?|halted|embargo\w*)\b/i;

// Google News ranks search results by relevance, not time. Newest first; undated items last,
// and equal times keep feed order (Array.prototype.sort is stable).
const publishedTime = (headline) => headline.publishedAt === null ? -Infinity : Date.parse(headline.publishedAt);
const newestFirst = (a, b) => {
    const left = publishedTime(a);
    const right = publishedTime(b);
    return left === right ? 0 : left > right ? -1 : 1;
};

// An RSS field is the item's own child with that local name and no namespace prefix.
// querySelector would also match extensions such as <media:title> (Chromium's type selectors
// ignore namespaces; linkedom's do not), and descendants of other children.
const field = (item, name) => [...item.children].find(child => child.localName === name && !child.prefix)?.textContent.trim() || '';

// The publisher is the <source> element; Google also appends " - Publisher" to each title,
// and only that exact suffix is removed. Without a <source>, the last " - " is the best guess.
const splitHeadline = (rawTitle, publisher) => {
    if (publisher) {
        const suffix = ` - ${publisher}`;
        const cut = rawTitle.length - suffix.length;
        return { title: cut > 0 && rawTitle.endsWith(suffix) ? rawTitle.slice(0, cut) : rawTitle, source: publisher };
    }
    const separator = rawTitle.lastIndexOf(' - ');
    return separator > 0
        ? { title: rawTitle.slice(0, separator), source: rawTitle.slice(separator + 3) }
        : { title: rawTitle, source: 'Source not supplied' };
};

export function parseOilNews(xml, { DOMParser = globalThis.DOMParser } = {}) {
    if (!DOMParser) throw new Error('RSS parser is unavailable.');
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (!doc.querySelector('rss > channel') || doc.querySelector('parsererror')) throw new Error('News feed unavailable: invalid RSS response.');
    const headlines = new Map();
    for (const item of doc.querySelectorAll('channel > item')) {
        const rawTitle = field(item, 'title');
        const link = field(item, 'link');
        if (!rawTitle || !/^https?:\/\//i.test(link) || headlines.has(link)) continue;
        const { title, source } = splitHeadline(rawTitle, field(item, 'source'));
        const pubDate = field(item, 'pubDate');
        const date = pubDate ? new Date(pubDate) : null;
        headlines.set(link, {
            title, link, source,
            publishedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
            highImpact: HIGH_IMPACT_RE.test(title.replace(DEESCALATION_PHRASES, ' ')),
        });
    }
    // The 15 newest, then high-impact matches first; each group stays newest first.
    return [...headlines.values()].sort(newestFirst).slice(0, 15).sort((a, b) => Number(b.highImpact) - Number(a.highImpact));
}

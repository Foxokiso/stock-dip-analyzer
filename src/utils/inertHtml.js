// Third-party HTML (Finviz pages) is parsed with DOMParser, which never runs
// scripts, but Chromium still checks every inline event-handler attribute in
// the parsed markup against the page's Content Security Policy and logs a
// violation for each one (hundreds per screener page). Dropping the handlers
// before parsing keeps the console clean and means no handler text ever
// reaches a document in the renderer.
// A match can only start where a whitespace run starts: the lookbehind stops
// the engine from retrying every position inside a long run, which made the
// replace quadratic, and it removes exactly the same handlers.
const INLINE_HANDLER = /(?<!\s)\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/** @param {string} html @returns {string} the same markup without on*="…" attributes */
export const stripInlineHandlers = (html) => (typeof html === 'string' ? html.replace(INLINE_HANDLER, '') : html);

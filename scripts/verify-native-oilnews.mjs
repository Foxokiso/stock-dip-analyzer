// Headline-classification parity between native/modules/oilnews and src/utils/oilNews.js.
// Preservation of existing behavior only; this is not a trading backtest and no headline here
// is presented as news: every string is a synthetic probe of the classification rules.
//
// The JavaScript reference is the real parseOilNews() fed through linkedom exactly as
// tests/oilNews.test.js does, so RSS parsing, textContent trimming and <source> precedence all
// run on the JavaScript side; the native driver only receives the already trimmed strings.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DOMParser } from 'linkedom';
import { parseOilNews } from '../src/utils/oilNews.js';

const executable = process.argv[2];
assert.ok(executable, 'Pass the compiled native oilnews test driver');

// ---------------------------------------------------------------------------------------------
// Reference side: one RSS feed per case, built the way the unit test builds its fixtures.
const escapeXml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const feed = items => `<rss><channel>${items}</channel></rss>`;
const item = (title, link, source) =>
  `<item><title>${escapeXml(title)}</title><link>${escapeXml(link)}</link>` +
  `${source === undefined ? '' : `<source>${escapeXml(source)}</source>`}</item>`;
const parse = xml => parseOilNews(xml, { DOMParser });

// The driver is a line protocol: no TAB (field separator), CR or LF, and no other control
// characters (a 0x1A would end text-mode stdin on Windows). Titles and links are sent trimmed,
// which is what the JavaScript layer hands to the classification rules.
const CONTROL = /[\u0000-\u001f\u007f]/;
const lineSafe = text => !CONTROL.test(text);

// ---------------------------------------------------------------------------------------------
// Title cases: { rawTitle, source? } where source is the <source> element text (undefined = absent).
const titleCases = [];
const seen = new Set();
const addTitle = (title, source) => {
  const rawTitle = String(title).trim();
  if (!rawTitle) return;
  assert.ok(lineSafe(rawTitle), `control character in title ${JSON.stringify(rawTitle)}`);
  if (source !== undefined) assert.ok(lineSafe(source), `control character in source ${JSON.stringify(source)}`);
  const key = `${rawTitle}\u0000${source === undefined ? '\u0001' : source}`;
  if (seen.has(key)) return;
  seen.add(key);
  titleCases.push({ rawTitle, source });
};
const casings = [
  text => text.toLowerCase(),
  text => text.toUpperCase(),
  text => text.replace(/\b[a-z]/g, c => c.toUpperCase()),
  text => [...text].map((c, i) => i % 2 ? c.toUpperCase() : c.toLowerCase()).join(''),
];
const everyCasing = (text, source) => casings.forEach(casing => addTitle(casing(text), source));

// 1. Every phrase tests/oilNews.test.js uses, bare, with the " - Example Wire" suffix the test
//    fixture appends, and with the <source> element the fixture supplies.
const unitTestPhrases = [
  'Oil tanker traffic resumes', 'Ceasefire talks continue', 'Oil firm strikes a deal',
  'Refinery warns of higher costs', 'Drone attack disrupts refinery output', 'Unsafe', 'One', 'Duplicate',
];
for (const phrase of unitTestPhrases) {
  addTitle(phrase);
  addTitle(`${phrase} - Example Wire`);
  addTitle(`${phrase} - Example Wire`, 'Example Wire');
  addTitle(phrase, 'Example Wire');
}

// 2. The full HIGH_IMPACT_RE keyword list in isolation, every alternative with its `\w*` / `s?`
//    forms plus near misses, in four casings, bare and embedded in a sentence.
const exactWords = ['hormuz', 'struck', 'closed', 'war', 'halted'];
const stemWords = ['attack', 'blockade', 'sanction', 'seiz', 'escalat', 'disrupt', 'embargo'];
const pluralWords = ['strike', 'closure', 'fire', 'explosion', 'blast', 'drone', 'missile', 'halt'];
const keywordForms = [];
for (const word of exactWords) keywordForms.push(word, `${word}s`, `${word}ed`, `${word}ing`, `x${word}`, `${word}_`, `_${word}`, `9${word}`, `${word}9`);
for (const stem of stemWords) keywordForms.push(stem, `${stem}s`, `${stem}e`, `${stem}ed`, `${stem}ing`, `${stem}ion`, `${stem}ure`, `${stem}_x`, `${stem}9`, `x${stem}`, `counter${stem}`, `${stem.slice(0, -1)}`);
for (const word of pluralWords) keywordForms.push(word, `${word}s`, `${word}ss`, `${word}d`, `${word}r`, `${word}es`, `${word}ing`, `x${word}`, `${word.slice(0, -1)}`);
keywordForms.push(
  'warm', 'warning', 'warfare', 'anti-war', 'war-torn', 'firewall', 'firearm', 'fired', 'firing', 'ceasefire',
  'closedown', 'struckout', 'hormuzian', 'seizure', 'seize', 'attackers', 'counterattack', 'sanctioned', 'blockaded',
  'embargoes', 'halting', 'closures', 'close', 'disruption', 'escalator', 'de-escalator', 'deescalator', 'explosive',
  'blasting', 'droned', 'missiled', 'striker', 'striking', 'strikes', 'Hormuz', 'Strait of Hormuz', 'strait of hormuz',
);
for (const form of keywordForms) {
  everyCasing(form);
  everyCasing(`Oil ${form} today`);
  addTitle(`${form} - Example Wire`);
}

// 3. DEESCALATION_PHRASES alone (every alternative, every optional branch) in four casings.
const deescalationPhrases = [
  'ceasefire', 'cease-fire', 'truce', 'peace deal', 'peace talks', 'de-escalate', 'de-escalation', 'deescalate',
  'deescalation', 'de-escalat', 'deescalat', 'strike deal', 'strikes deal', 'strike a deal', 'strikes a deal',
  'strike an deal', 'strikes an deal', 'deal struck', 'strike price',
];
for (const phrase of deescalationPhrases) {
  everyCasing(phrase);
  everyCasing(`Talks: ${phrase}.`);
}

// 4. De-escalation phrases adjacent to, inside, or overlapping keywords: the blanking leaves a
//    single space, so whatever is left must still be judged on its own word boundaries.
const adjacency = [
  'ceasefirefire', 'ceasefires', 'ceasefirewar', 'ceasefire-attack', 'ceasefire fire', 'firetruce', 'truce fire',
  'truces', 'trucewar', 'cease fire', 'cease_fire', 'cease–fire', 'cease—fire', 'cease--fire', 'cease-fires',
  'cease-firestorm', 'strikes a dealer', 'strike deals', 'strikes deal struck', 'strikes  deal', 'strikes and deal',
  'strikes an  deal', 'strikes a  deal', 'strike  price', 'strike prices', 'strike priced deal', 'strike price war',
  'strike pricewar', 'deal strucks', 'deal struck strike price', 'dealstruck', 'deal  struck', 'peace dealer',
  'peace deals', 'peace talk', 'peace talks war', 'peace talkswar', 'peacedeal', 'peace  deal', 'de-escalate strikes',
  'de--escalation', 'de-escalation escalation', 'escalation de-escalates', 'dede-escalation', 'de-escalation9',
  'de-escalation_x', 'undeescalation', 'de-de-escalation', 'strikes a deal struck', 'strikes a deal strike price',
  'strike a dealstruck', 'strikes a deal fires', 'ceasefire truce peace deal peace talks de-escalation deal struck strike price',
  'ceasefireceasefire', 'trucetruce', 'strikes a dealstrikes a deal', 'strike pricestrike price', 'deal struckdeal struck',
  'strikesdeal', 'strikes a deal.', 'strikes an deal!', '(strike price)', 'deal struck,', 'truce.', 'ceasefire?',
  'de-escalation;', 'strikes a deal - Example Wire', 'Ceasefire talks continue - strikes a deal', 'strike - price',
  'strikes - deal', 'peace - deal', 'de - escalation', 'cease - fire',
];
for (const text of adjacency) everyCasing(text);

// 5. Punctuation boundaries around a keyword: `\b` is derived from [A-Za-z0-9_] only.
const punctuated = [
  'war.', 'war,', '(war)', 'war!', 'war-torn', 'anti-war', 'war_games', 'games_war', '9war', 'war9', "war's", "'war'",
  '"war"', '[fires]', 'fire/blast', '#drone', '@missiles', 'halt;', 'halts:', 'closed?', 'hormuz…', "Hormuz's",
  'attack...', '...attack', 'strike-price', 'strikes/deal', '--struck--', '~embargo~', '*blast*', 'missile+drone',
  'drone=missile', 'war&peace', 'war|peace', 'a.b.war.c', 'halt.halted', 'closed.closure', 'fire_fires', 'fires-fire',
  'x-attack-x', '1-attack', 'attack-1', '$war', 'war$', '%fire', 'fire%', '^blast', 'blast^', '`drone`', '{missiles}',
  '<halt>', '>closed<', 'seiz.', '.seiz', 'seiz-', '-seiz', 'escalat', 'escalat-', 'disrupt!', 'embargo?', 'struck?!',
];
for (const text of punctuated) { everyCasing(text); everyCasing(`Oil ${text} report`); }

// 6. Unicode: dashes that must not split the title, non-ASCII neighbours that are non-word code
//    units, and letters whose case folding is deliberately not applied without the `u` flag.
const unicode = [
  'Em dash — Source', 'En dash – Source', 'Hyphen ‐ Source', 'Non-breaking hyphen ‑ Source',
  'Minus − Source', 'Figure dash ‒ Source', 'Horizontal bar ― Source', 'Title - Source',
  'Title - Source', 'Title - Source', 'Title - Source', 'Title — war', 'Title – war - Wire',
  'Attack — Wire', 'Attack - Wire — more', 'A - B - C', 'A -  B', 'A  - B', 'A - B -', 'x -', '- only',
  '- - -', 'a - - b', 'Up-to-date - Wire', '- Leading hyphen - Src', 'trailing space  - Src', 'Title - Wire - ',
  'Title-Wire', 'Title -Wire', 'Title- Wire', 'Title -- Wire', 'Title  -  Wire', '— - —', 'Title - —',
  'ｗａｒ fullwidth', 'ẃar', 'éwar', 'waré', '日本war', 'war日本',
  '🔥fire🔥', 'fireſ', 'Mıssiles', 'mİssiles', 'ſtrikes', 'attacK',
  'firé', 'ﬁre', 'war​', '­war', 'wa﻿r', 'cease–fire', 'cease—fire',
  'strikes a deal', 'strikes a deal', 'peace deal', 'de‐escalation', 'de–escalation',
  '¿war?', '¡attack!', '«missiles»', '“drone”', '‘blast’', 'war•peace',
  'Атака attack', 'عربي war', 'שלום fire',
  'Straße strikes', 'Æwar', 'warÆ', 'Āattack', 'attackā', 'Hormuz — Ünicode Wire',
  'Oil tanker traffic resumes', ' war ', '　war　', '﻿war',
];
for (const text of unicode) { addTitle(text); addTitle(text.toUpperCase()); addTitle(`${text} - Example Wire`); }

// 7. <source> element resolution: non-empty trimmed text wins, empty or whitespace falls through.
const sources = ['Example Wire', '', '  ', 'Reuters', 'A - B', 'Ünïcode Wire', 'A & B <c>', ' ', 'War Desk', '0'];
for (const source of sources) {
  addTitle('Oil tanker traffic resumes - Example Wire', source);
  addTitle('Drone attack disrupts refinery output', source);
  addTitle('Title — Dash', source);
  addTitle('A - B - C', source);
}

// 8. 500 seeded headline compositions mixing keyword forms, de-escalation phrases, filler,
//    joiners (including unicode dashes, digits and underscores), casings, suffixes and sources.
const fillers = [
  'Oil', 'tanker', 'traffic', 'resumes', 'refinery', 'output', 'Brent', 'crude', 'OPEC', 'talks', 'continue', 'warns',
  'of', 'higher', 'costs', 'prices', 'in', 'the', 'Gulf', 'after', 'report', 'says', 'analysts', 'expect', 'supply',
  'demand', 'barrels', 'pipeline', 'export', 'Ünïcode', '日本', '😀', 'ſ', 'ı',
  'warm', 'warning', 'firewall', 'close', 'halting', 'explosive', 'striker', 'escalator', 'hormuzian',
];
const joiners = [' ', ' ', ' ', '  ', '-', '_', ', ', '. ', ': ', '/', '—', '–', ' ', ' (', ') ', "'", '"', '…', '9', ' · ', ' - '];
const suffixes = ['', '', '', ' - Example Wire', ' - A - B', ' — Wire', ' – Wire', ' -  Wire', '  - Wire', ' - ', '-Wire', ' - war', ' - Strike Desk'];
const seededSources = [undefined, undefined, undefined, 'Example Wire', '', '  ', 'A - B', 'War Desk'];
let seed = 0x011e27;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = list => list[Math.floor(random() * list.length)];
const pool = [...keywordForms, ...deescalationPhrases, ...adjacency, ...fillers];
let seeded = 0;
while (seeded < 500) {
  const count = 2 + Math.floor(random() * 6);
  let text = '';
  for (let i = 0; i < count; i++) {
    const roll = random();
    const fragment = roll < 0.35 ? pick(keywordForms) : roll < 0.55 ? pick(deescalationPhrases) : roll < 0.65 ? pick(adjacency) : roll < 0.7 ? pick(pool) : pick(fillers);
    text += (i ? pick(joiners) : '') + pick(casings)(fragment);
  }
  text += pick(suffixes);
  const before = titleCases.length;
  addTitle(text, pick(seededSources));
  if (titleCases.length > before) seeded++;
}

// ---------------------------------------------------------------------------------------------
// Link cases: /^https?:\/\//i on the trimmed <link> text.
const linkCases = [
  'https://example.com/report', 'HTTPS://EXAMPLE.COM', 'Http://x', 'hTtPs://x', 'http://', 'https://', 'https:/x',
  'http:/', 'http:', 'http', 'https', 'ftp://x', 'javascript:alert(1)', 'mailto:a@b', 'xhttp://a', 'http//a',
  'https ://a', 'http://a b', 'https://例え.jp', 'http://a&b=c', 'data:text/html,x', '//example.com',
  'http:\\\\a', 'https:// x', 'HTTP://', 'httpss://x', 'shttp://x', 'http:///x', 'https:////', 'http://127.0.0.1',
  'https://example.com/report?q=war - attack', 'https://example.com/😀', 'about:blank', 'file:///etc/passwd',
  'vbscript:x', 'HTTPS://example.com/javascript:alert(1)', ' https://padded', 'https://padded ', 'http:// ', '',
  'http://—', 'https://exa mple.com', 'HTtP://MiXeD', 'http:// http://', 'https://a\tb',
].map(link => link.trim());
for (let i = 0; i < 50; i++) {
  const scheme = pick(['http', 'https', 'HTTP', 'HtTpS', 'ftp', 'javascript', 'data', 'http ', 'xhttp', 'hxxp']);
  const separator = pick(['://', ':/', '//', ':', '://', '://', ':\\\\', ':// ']);
  linkCases.push(`${scheme}${separator}example.com/${i}`);
}
// A TAB is legal inside a link line (links have no second field); any other control character is not.
linkCases.forEach(link => assert.ok(lineSafe(link.replace(/\t/g, '')), `control character in link ${JSON.stringify(link)}`));

// ---------------------------------------------------------------------------------------------
// Order cases: insertion-order highImpact flags -> display order (first 15, high-impact first, stable).
const orderCases = [
  [], [false], [true], [false, true], [true, false], [true, true], [false, false],
  [false, true, false, true, false], [true, false, false, true, true, false, true],
  Array(14).fill(false), Array(15).fill(true), Array(16).fill(false).map((_, i) => i === 15),
  Array(16).fill(false).map((_, i) => i === 14), Array(20).fill(false).map((_, i) => i % 3 === 0),
  Array(30).fill(false).map((_, i) => i >= 15), Array(30).fill(true), Array(15).fill(false).map((_, i) => i === 0),
  Array(15).fill(false).map((_, i) => i === 14), Array(17).fill(false).map((_, i) => i % 2 === 1),
];
for (let i = 0; i < 60; i++) {
  const length = Math.floor(random() * 25);
  const bias = random();
  orderCases.push(Array.from({ length }, () => random() < bias));
}

// ---------------------------------------------------------------------------------------------
// Drive the native binary once per mode.
const runDriver = (mode, lines) => {
  const run = spawnSync(executable, [mode], { input: lines.join('\n') + '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.status, 0, `${mode}: ${run.error?.message || run.stderr}`);
  // Windows text-mode stdout ends lines with CRLF; compare line content, not line endings.
  const rows = run.stdout.replace(/\r?\n$/, '').split(/\r?\n/);
  assert.equal(rows.length, lines.length, `${mode}: one output line per case`);
  assert.ok(!run.stdout.includes('Zombie Corp') && !run.stdout.includes('Mock News'));
  return rows;
};

// titles mode: "rawTitle" or "rawTitle<TAB>sourceElementText"  ->  "title<TAB>source<TAB>0|1".
// The <source> text reaches the native rules already trimmed (that trim is the JS/DOM layer's
// job), so the driver gets source.trim() while the RSS fixture keeps the raw whitespace.
const titleRows = runDriver('titles', titleCases.map(({ rawTitle, source }) => source === undefined ? rawTitle : `${rawTitle}\t${source.trim()}`));
for (let i = 0; i < titleCases.length; i++) {
  const { rawTitle, source } = titleCases[i];
  const link = 'https://example.com/report';
  const headlines = parse(feed(item(rawTitle, link, source)));
  assert.equal(headlines.length, 1, `case ${i}: reference must accept ${JSON.stringify(rawTitle)}`);
  const [expected] = headlines;
  const fields = titleRows[i].split('\t');
  const label = `case ${i}: title ${JSON.stringify(rawTitle)}${source === undefined ? '' : ` source ${JSON.stringify(source)}`}`;
  assert.equal(fields.length, 3, `${label}: three fields`);
  assert.equal(fields[0], expected.title, `${label}: title`);
  assert.equal(fields[1], expected.source, `${label}: source`);
  assert.equal(fields[2], expected.highImpact ? '1' : '0', `${label}: highImpact`);
}

// links mode: one trimmed <link> per line -> "0|1".
const linkRows = runDriver('links', linkCases);
for (let i = 0; i < linkCases.length; i++) {
  const accepted = parse(feed(item('Oil tanker traffic resumes', linkCases[i]))).length;
  assert.ok(accepted === 0 || accepted === 1);
  assert.equal(linkRows[i], accepted ? '1' : '0', `link case ${i}: ${JSON.stringify(linkCases[i])}`);
}

// order mode: space-separated flags -> space-separated input indices in display order.
const orderRows = runDriver('order', orderCases.map(flags => flags.map(Number).join(' ')));
for (let i = 0; i < orderCases.length; i++) {
  const flags = orderCases[i];
  const items = flags.map((high, index) => item(high ? `Drone strike ${index}` : `Calm report ${index}`, `https://example.com/${index}`)).join('');
  const headlines = parse(feed(items));
  headlines.forEach((headline, position) => assert.equal(headline.highImpact, flags[Number(headline.link.split('/').pop())], `order case ${i}: reference flag ${position}`));
  const expected = headlines.map(headline => headline.link.split('/').pop()).join(' ');
  assert.equal(orderRows[i], expected, `order case ${i}: flags ${flags.map(Number).join('')}`);
}

const total = titleCases.length + linkCases.length + orderCases.length;
assert.ok(seeded === 500 && titleCases.length >= 1500, `expected a large case set, got ${titleCases.length} titles`);
console.log(`${total} native/JavaScript oilnews parity cases passed`);

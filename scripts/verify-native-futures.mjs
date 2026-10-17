// Futures-payload parity between native/modules/futures (with dip::jsonlite) and
// src/services/futures.js. Preservation of existing parsing and validation behavior only;
// this is not a trading backtest. Every input is the recorded 2026-10-11 regression fixture
// or a deterministic mutation of it, and nothing here is presented as a current quote.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { FUTURES_TIMEFRAMES, parseFinvizFutures } from '../src/services/futures.js';

const executable = process.argv[2];
assert.ok(executable, 'Pass the compiled native futures test driver');

const fixtureText = readFileSync(new URL('../tests/fixtures/futures-reference.json', import.meta.url), 'utf8');
const fixture = JSON.parse(fixtureText);
const symbols = Object.keys(fixture);
assert.equal(symbols.length, 59, 'the recorded fixture holds 59 reference instruments');
const ES = fixture.ES;

const fetchedAt = '2026-10-11T01:51:13.000Z';
const refreshedAt = '2026-10-11T01:56:13.000Z';
// The reference normalizes fetchedAt through Date; the native library takes it verbatim.
for (const stamp of [fetchedAt, refreshedAt]) assert.equal(new Date(stamp).toISOString(), stamp);

// ---------------------------------------------------------------------------------------------
// Cases. `input` is always the text the application would receive (raw JSON or an HTML page).
// `timeframe` / `sourceUrl` undefined means "option not given", so the reference's `??`
// defaults apply; the driver receives the token `null` for that.
const cases = [];
const add = (name, input, options = {}) => {
  assert.equal(typeof input, 'string', `${name}: input must be text`);
  if (typeof input.isWellFormed === 'function') {
    assert.ok(input.isWellFormed(), `${name}: raw lone surrogates cannot cross the UTF-8 pipe; escape them`);
  }
  for (const option of [options.timeframe, options.sourceUrl]) {
    if (option !== undefined) assert.ok(option !== 'null' && !/[\t\r\n]/.test(option), `${name}: option breaks the line protocol`);
  }
  cases.push({ name, input, fetchedAt, ...options });
};
const text = value => JSON.stringify(value);
const clone = value => JSON.parse(JSON.stringify(value));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const patch = (symbol, fields) => { const data = clone(fixture); data[symbol] = { ...data[symbol], ...fields }; return data; };
const replace = (symbol, value) => { const data = clone(fixture); data[symbol] = value; return data; };
const only = (...keep) => Object.fromEntries(keep.map(symbol => [symbol, clone(fixture[symbol])]));
// JSON text with a field holding a literal JSON.stringify cannot express (1e999, -0, NaN, ...).
const rawLiteral = (symbol, field, literal) => text(patch(symbol, { [field]: '@@RAW@@' })).replace('"@@RAW@@"', literal);
// JSON text with extra members appended after the serialized base, in the given order.
const appendKeys = (base, entries) => `${text(base).slice(0, -1)},${entries.map(([key, value]) => `${text(key)}:${text(value)}`).join(',')}}`;
const scriptJs = '<script>window.futures = { ES: { last: 1 } };</script>';
const page = (json, { attributes = 'type="application/json" id="futures-init-data"', before = '', after = '', open = '<script', close = '</script>' } = {}) =>
  `<!doctype html>\n<html><head><meta charset="utf-8"><title>Futures</title>${before}</head>\n<body>${open} ${attributes}>${json}${close}${after}</body></html>`;

// 1. The recorded fixture through every documented option.
add('fixture raw text', fixtureText);
add('fixture re-serialized', text(fixture));
add('fixture pretty-printed', JSON.stringify(fixture, null, 2));
add('fixture with surrounding whitespace and BOM', `﻿ \n\t${fixtureText}\r\n  `);
add('fixture, timeframe not given', fixtureText, { timeframe: undefined });
for (const { id } of FUTURES_TIMEFRAMES) add(`fixture timeframe ${id}`, fixtureText, { timeframe: id });
add('fixture unsupported timeframe text (parse does not validate it)', fixtureText, { timeframe: 'untrusted' });
add('fixture with explicit sourceUrl', fixtureText, { timeframe: 'd', sourceUrl: 'https://finviz.com/api/futures_all?timeframe=d' });
add('fixture with empty sourceUrl option', fixtureText, { sourceUrl: '' });
add('fixture at another fetchedAt', fixtureText, { fetchedAt: refreshedAt });

// 2. The live page layout: only the typed init-data script is read, never anything executable.
add('page default', page(fixtureText));
add('page attribute order swapped', page(fixtureText, { attributes: 'id="futures-init-data" type="application/json"' }));
add('page single quotes', page(fixtureText, { attributes: "id='futures-init-data' type='application/json'" }));
add('page upper-case tag and attributes', page(fixtureText, { open: '<SCRIPT', attributes: 'ID="FUTURES-INIT-DATA" TYPE="APPLICATION/JSON"', close: '</SCRIPT>' }));
add('page spaces around =', page(fixtureText, { attributes: 'id = "futures-init-data"  type\t=\n"application/json"' }));
add('page extra attributes', page(fixtureText, { attributes: 'data-x="1" id="futures-init-data" nonce="abc" type="application/json" defer' }));
add('page no-break space between attributes', page(fixtureText, { attributes: 'id="futures-init-data" type="application/json"' }));
add('page unicode whitespace before attributes', `<html><script id="futures-init-data"　type="application/json">${fixtureText}</script></html>`);
add('page closing tag with spaces', page(fixtureText, { close: '</script \t >' }));
add('page closing tag mixed case', page(fixtureText, { close: '</Script>' }));
add('page body padded with whitespace', page(`\n  ${fixtureText}\n  `));
add('page executable scripts around the init data', page(fixtureText, { before: scriptJs, after: '<script src="/app.js"></script><script type="module">import "x";</script>' }));
add('page decoy data-id script first', page(fixtureText, { before: `<script data-id="futures-init-data" type="application/json">${text({ ES: { ticker: 'ES', last: 1, change: 1 } })}</script>` }));
add('page decoy text/javascript with data-type first', page(fixtureText, { before: `<script id="futures-init-data" type="text/javascript" data-type="application/json">${text({ ES: { ticker: 'ES', last: 1, change: 1 } })}</script>` }));
add('page <scripts> decoy first', page(fixtureText, { before: '<scripts id="futures-init-data" type="application/json">{"ES":{"ticker":"ES","last":1,"change":1}}</scripts>' }));
add('page first init script wins', page(text(only('ES')), { after: `<script type="application/json" id="futures-init-data">${fixtureText}</script>` }));
add('page init script swallowing a later script is invalid JSON', `<html><script id="futures-init-data" type="application/json">${text(only('ES'))}<p>${scriptJs}</html>`);
add('page self-closing init tag followed by a script end', `<html><script id="futures-init-data" type="application/json"/>${fixtureText}</script></html>`);
add('page minimal (no html element)', `<script id="futures-init-data" type="application/json">${fixtureText}</script>`);
add('page init data followed by a commented copy', page(fixtureText, { after: '<!-- <script id="futures-init-data" type="application/json">{}</script> -->' }));
add('page with a closing tag inside a label', page(text(patch('ES', { label: 'Closing </script> tag inside' }))));
add('page without init data', '<html><h1>Just a moment...</h1></html>');
add('page init script without type', '<script id="futures-init-data">window.futures = {}</script>');
add('page init script text/javascript', '<script id="futures-init-data" type="text/javascript">({ES:{last:10}})</script>');
add('page decoy data-id only', `<script data-id="futures-init-data" type="application/json">${fixtureText}</script>`);
add('page decoy data-type only', `<script id="futures-init-data" type="text/javascript" data-type="application/json">${fixtureText}</script>`);
add('page type without whitespace before it', `<script id="futures-init-data"type="application/json">${fixtureText}</script>`);
add('page quote style mismatch', `<script id="futures-init-data' type="application/json">${fixtureText}</script>`);
add('page init script unterminated', `<html><script id="futures-init-data" type="application/json">${fixtureText}`);
add('page closing tag with attribute', `<html><script id="futures-init-data" type="application/json">${fixtureText}</script foo></html>`);
add('page open tag never closed', `<html><script id="futures-init-data" type="application/json"${fixtureText}`);
add('page lone <', '<');
add('page empty init script', page(''));
add('page init script with executable body', page('window.futures = {}'));
add('page init script with array body', page('[]'));
add('page init script JSON with trailing text', page(`${fixtureText};`));
add('page self-closing init tag with no body', '<html><script id="futures-init-data" type="application/json"/></html>');

// 3. Malformed, executable and empty texts (every case of tests/futures.test.js that is text,
//    plus JSON grammar corners).
for (const [name, input] of [
  ['invalid JSON braces', '{invalid JSON}'],
  ['empty text', ''],
  ['whitespace only', ' \n\t '],
  ['undefined literal', 'undefined'],
  ['null literal', 'null'],
  ['array', '[]'],
  ['empty object', '{}'],
  ['success flag only', '{"success":true}'],
  ['string document', '"ES"'],
  ['number document', '123'],
  ['boolean document', 'true'],
  ['__proto__ record only', '{"__proto__":{"ticker":"__proto__","label":"Injected","last":12,"change":0}}'],
  ['__proto__ beside a valid quote', `{"__proto__":{"ticker":"__proto__","label":"Injected","last":12,"change":0},"ES":${text(ES)}}`],
  ['constructor key beside a valid quote', `{"constructor":{"prototype":{}},"ES":${text(ES)}}`],
  ['NaN literal', '{"ES":{"ticker":"ES","last":NaN,"change":0}}'],
  ['Infinity literal', '{"ES":{"ticker":"ES","last":Infinity,"change":0}}'],
  ['trailing comma', '{"ES":{"ticker":"ES","last":1,"change":0},}'],
  ['single-quoted strings', "{'ES':{'ticker':'ES','last':1,'change':0}}"],
  ['line comment', '{"ES":{"ticker":"ES","last":1,"change":0}} // comment'],
  ['leading zero', '{"ES":{"ticker":"ES","last":01,"change":0}}'],
  ['hex number', '{"ES":{"ticker":"ES","last":0x10,"change":0}}'],
  ['plus sign', '{"ES":{"ticker":"ES","last":+1,"change":0}}'],
  ['bare fraction', '{"ES":{"ticker":"ES","last":.5,"change":0}}'],
  ['trailing dot', '{"ES":{"ticker":"ES","last":1.,"change":0}}'],
  ['dangling exponent', '{"ES":{"ticker":"ES","last":1e,"change":0}}'],
  ['raw control character in string', '{"ES":{"ticker":"ES","label":"a\tb","last":1,"change":0}}'],
  ['invalid escape', '{"ES":{"ticker":"ES","label":"\\x41","last":1,"change":0}}'],
  ['truncated unicode escape', '{"ES":{"ticker":"ES","label":"\\u12","last":1,"change":0}}'],
  ['unterminated string', '{"ES":{"ticker":"ES","label":"abc'],
  ['unterminated object', '{"ES":{"ticker":"ES","last":1,"change":0}'],
  ['two documents', '{"ES":{"ticker":"ES","last":1,"change":0}} {}'],
  ['uppercase TRUE literal', '{"ES":{"ticker":"ES","last":1,"change":0,"x":TRUE}}'],
  ['lowercase key only', `{"es":${text(ES)}}`],
  ['key too long', `{"ABCDEFGHI":${text({ ...ES, ticker: 'ABCDEFGHI' })}}`],
  ['every row unavailable', text({ ES: { ...ES, last: null }, ZB: { ...fixture.ZB, ticker: 'ZN' } })],
  ['record missing change', '{"ES":{"ticker":"ES","last":1}}'],
  ['record is null', '{"ES":null}'],
  ['record is an array', '{"ES":[]}'],
  ['escaped key decodes to ES', '{"E\\u0053":{"ticker":"ES","last":1,"change":0}}'],
  ['escaped key with surrogate pair', `{"\\ud83d\\ude00":{"ticker":"ES","last":1,"change":0},"ES":${text(ES)}}`],
  ['valid JSON whitespace everywhere', ' \r\n{ "ES" : { "ticker" : "ES" , "last" : 1 , "change" : 0 } } \t'],
  ['form feed is not JSON whitespace', '\f{"ES":{"ticker":"ES","last":1,"change":0}}'],
]) add(name, input);

// 4. Mutated records.
const numberLikes = [['null', null], ['string', '7866'], ['empty string', ''], ['false', false], ['true', true], ['array', [7866]], ['object', { value: 7866 }], ['zero', 0], ['negative', -1], ['missing', undefined]];
const rawNumbers = ['1e999', '-1e999', '1e-999', '-0', '5e-324', '1.7976931348623157e308', '0.1e1', '1E2', '123456789012345678901234567890', '0.000000000000000000000000000001', '-1.5e-5'];
for (const field of ['last', 'change']) {
  for (const [label, value] of numberLikes) add(`ES ${field} ${label}`, text(patch('ES', { [field]: value })));
  for (const literal of rawNumbers) add(`ES ${field} literal ${literal}`, rawLiteral('ES', field, literal));
}
for (const field of ['changeUsd', 'prevClose', 'high', 'low']) {
  for (const [label, value] of numberLikes) add(`ES ${field} ${label}`, text(patch('ES', { [field]: value })));
  for (const literal of ['1e999', '-1e999', '1e-999', '-0']) add(`ES ${field} literal ${literal}`, rawLiteral('ES', field, literal));
}
add('zero and negative quotes with non-finite optionals', rawLiteral('ES', 'low', '-1e999').replace('"ES":{', '"ES":{"high":1e999,').replace(text(ES.last), '0').replace(`"change":${text(ES.change)}`, '"change":0,"changeUsd":null,"prevClose":null'));
add('negative price and percent', text({ ...only('ES'), CL: { ...ES, ticker: 'CL', label: 'Crude Oil WTI', last: -1, change: -101 } }));
for (const [label, value] of [['mismatch NQ', 'NQ'], ['missing', undefined], ['null', null], ['number', 123], ['lowercase', 'es'], ['trailing space', 'ES '], ['array', ['ES']]]) {
  add(`ES ticker ${label}`, text(patch('ES', { ticker: value })));
}
add('ES ticker via unicode escape', text(patch('ES', {})).replace('"ticker":"ES"', '"ticker":"E\\u0053"'));
const longLabel = 'Reference instrument '.repeat(8);
for (const [label, value] of [
  ['missing', undefined], ['empty', ''], ['whitespace only', ' \t\n'], ['unicode whitespace only', ' ﻿ 　'],
  ['padded', '  S&P 500  '], ['padded unicode whitespace', '﻿ S&P 500  '], ['number', 500], ['null', null], ['array', ['S&P 500']],
  ['long', longLabel], ['exactly 100', 'x'.repeat(100)], ['101 chars', 'x'.repeat(101)],
  ['emoji split by the 100-unit cut', `${'y'.repeat(99)}\u{1F600}z`], ['emoji just before the cut', `${'y'.repeat(98)}\u{1F600}z`],
  ['escapes', 'q"uo\\te /sla\b\f\n\r\tsh'], ['accents', 'Café € ß'], ['cjk', '日経225'],
  ['lone high surrogate', 'a\ud83d'], ['lone low surrogate', '\ude00b'], ['separator characters', 'a|b;c=d,e\\f"g'], ['the word null', 'null'],
  ['leading whitespace then text', `${' '.repeat(100)}abc`], ['inner whitespace kept', 'S&P 500 E-mini'],
]) add(`ES label ${label}`, text(patch('ES', { label: value })));
add('ES label raw UTF-8 bytes', text(patch('ES', { label: 'RAW' })).replace('"RAW"', '"Café € \u{1F600}"'));
add('ES label with escaped surrogate pair', text(patch('ES', { label: 'RAW' })).replace('"RAW"', '"\\ud83d\\ude00 pair"'));
add('ES label with unpaired surrogate escapes', text(patch('ES', { label: 'RAW' })).replace('"RAW"', '"\\ud83d\\u0041 \\ude00\\ud83d"'));
add('ES label with every short escape', text(patch('ES', { label: 'RAW' })).replace('"RAW"', '"\\"\\\\\\/\\b\\f\\n\\r\\t\\u0000\\u001f"'));
for (const [label, value] of [['partial null', [7800, null, 7866]], ['string point', ['7800', 7866]], ['bool point', [true]], ['nested', [[7866]]], ['object', { 0: 7866 }], ['string', '7866'], ['empty', []], ['missing', undefined], ['null', null], ['mixed magnitudes', [0, -0, 1e-7, 1e21, 123456.789, -2.5]], ['single', [7866]]]) {
  add(`ES sparkline ${label}`, text(patch('ES', { sparkline: value })));
}
add('ES sparkline with overflow point', text(patch('ES', { sparkline: ['@@RAW@@'] })).replace('"@@RAW@@"', '1e999'));
add('ES sparkline with underflow point', text(patch('ES', { sparkline: ['@@RAW@@', 1] })).replace('"@@RAW@@"', '1e-999'));
const chartLabels = {
  0: 'Oct 10', 5: 'Oct 11', 59: 'last point', 60: 'past the end', 99: 'far', x: 'not an index', '-1': 'negative', '007': 'leading zeros',
  '00': 'double zero', 2: 123, 3: null, 4: 'a label clearly longer than forty characters in total', 6: `${'k'.repeat(39)}\u{1F600}`,
  1: '', ['__proto__']: 'proto', '4294967295': 'not an array index', '12345678901234567890': 'huge', ' 7': 'space before', '8 ': 'space after',
  '1e1': 'exponent', 9: 'sep|;=,', 10: '\ud83d lone', 11: '  padded  ',
};
add('ES chart labels', text(patch('ES', { sparklineDateChanges: chartLabels })));
add('ES chart labels in non-canonical text order', text(patch('ES', { sparklineDateChanges: 'RAW' })).replace('"RAW"', '{"5":"five","0":"zero","x":"ex","3":"three","007":"seven","1":"one","4294967294":"max index","4294967295":"beyond","00":"zz"}'));
add('ES chart labels with duplicate keys', text(patch('ES', { sparklineDateChanges: 'RAW' })).replace('"RAW"', '{"5":"first","0":"zero","5":"second","x":"a","x":"b"}'));
add('ES chart labels on a 3-point sparkline', text(patch('ES', { sparkline: [1, 2, 3], sparklineDateChanges: { 0: 'a', 2: 'c', 3: 'd' } })));
add('ES chart labels but empty sparkline', text(patch('ES', { sparkline: [], sparklineDateChanges: { 0: 'a' } })));
add('ES chart labels but invalid sparkline', text(patch('ES', { sparkline: [1, null], sparklineDateChanges: { 0: 'a' } })));
add('ES chart labels but unavailable row', text(patch('ES', { last: null, sparklineDateChanges: { 0: 'a' } })));
for (const [label, value] of [['array', ['a', 'b']], ['string', 'Oct'], ['null', null], ['number', 1], ['missing', undefined], ['empty', {}]]) {
  add(`ES chart labels ${label}`, text(patch('ES', { sparklineDateChanges: value })));
}
for (const [label, value] of [['null', null], ['array', []], ['string', 'ES'], ['number', 42], ['bool', true], ['empty object', {}], ['missing', undefined]]) {
  add(`ES record ${label}`, text(replace('ES', value)));
}
add('lowercase key filtered', text({ ...only('ZB'), es: clone(ES) }));
add('nine-character key filtered', text({ ...only('ZB'), ABCDEFGHI: { ...ES, ticker: 'ABCDEFGHI' } }));
add('eight-character key accepted', text({ ...only('ZB'), ABCDEFGH: { ...ES, ticker: 'ABCDEFGH' } }));
add('hyphenated key filtered', text({ ...only('ZB'), 'ES-1': { ...ES, ticker: 'ES-1' } }));
add('empty key filtered', text({ ...only('ZB'), '': { ...ES, ticker: '' } }));
add('numeric keys enumerate first', appendKeys(only('ZB', 'ES'), [
  ['123', { ...ES, ticker: '123', label: 'Index key' }], ['0', { ...ES, ticker: '0' }], ['12', { ...ES, ticker: '12' }], ['00', { ...ES, ticker: '00' }],
  ['4294967294', { ...ES, ticker: '4294967294' }], ['4294967295', { ...ES, ticker: '4294967295' }], ['99999999', { ...ES, ticker: '99999999' }], ['NQ', fixture.NQ],
]));
add('unknown symbol in group other', text({ ...only('ES'), XYZ: { ...ES, ticker: 'XYZ', label: 'Unknown root' } }));
add('bond units', text(only('ZT', 'ZF', 'ZN', 'TN', 'ZB', 'UB', 'ZQ', 'SR3')));
add('every group represented once', text(only('ES', 'ZN', 'CL', 'GC', 'ZC', 'KC', '6E')));
add('duplicate top-level key keeps first position, last value', `{"ES":${text({ ...ES, last: 1 })},"ZB":${text(fixture.ZB)},"ES":${text({ ...ES, last: 2, label: 'Second ES' })}}`);
add('duplicate field inside a record', '{"ES":{"ticker":"ES","last":1,"change":0,"last":7866,"label":"a","label":"b"}}');
add('__proto__ field inside a record is ordinary', text(patch('ES', { ['__proto__']: { last: 1 } })));
add('single row', text(only('ES')));
add('deeply nested extra key', `{"ES":${text(ES)},"DEEP":${'['.repeat(100)}${']'.repeat(100)}}`);
add('half the rows mutated', text(Object.fromEntries(symbols.map((symbol, index) => [symbol, index % 2 ? fixture[symbol] : { ...fixture[symbol], last: null }]))));

// 5. 300 seeded mutations of the fixture (deterministic LCG; no randomness at compare time).
let seed = 0x27f0a1;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = list => list[Math.floor(random() * list.length)];
const shuffle = list => {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};
const weirdLabels = ['', ' ', 'S&P 500', ' padded ', 'x'.repeat(120), 'Café', '\u{1F600}'.repeat(60), 'a|b;c', 'null', '\ud83d', '   ', '　﻿'];
const numberLike = () => pick([null, '1', '', true, false, [], {}, 0, 1e-9, -123.456, 7866, 1e21, 5e-324, '@@RAW@@']);
const mutations = [
  record => ({ ...record, last: numberLike() }),
  record => ({ ...record, change: numberLike() }),
  record => ({ ...record, changeUsd: numberLike() }),
  record => ({ ...record, prevClose: numberLike() }),
  record => ({ ...record, high: numberLike() }),
  record => ({ ...record, low: numberLike() }),
  record => ({ ...record, ticker: pick(['NQ', 'ES', undefined, null, 1, String(record.ticker ?? '').toLowerCase(), `${record.ticker} `]) }),
  record => ({ ...record, label: pick([undefined, null, 5, ...weirdLabels]) }),
  record => ({ ...record, sparkline: pick([undefined, null, [], 'x', {}, [1, null], [1, '2'], (Array.isArray(record.sparkline) ? record.sparkline : []).slice(0, Math.floor(random() * 10)), [...(Array.isArray(record.sparkline) ? record.sparkline : []), true], ['@@RAW@@', 1]]) }),
  record => ({ ...record, sparklineDateChanges: pick([undefined, null, [], 'x', {}, { 0: 'a' }, { 5: 'b', '007': 'c', x: 'd', 2: 7 }, { 59: 'end', 60: 'past' }, { 3: 'q'.repeat(50) }, { 1: pick(weirdLabels) }]) }),
  record => ({ ...record, last: undefined, change: undefined }),
  () => pick([null, [], 'ES', 42, true, {}]),
];
const extraKeys = ['es', 'ABCDEFGHI', 'ES-1', '', '123', '0', 'XYZ', '__proto__', '6E', 'ZT', 'ABCDEFGH', '4294967295'];
const attributeStyles = [
  'type="application/json" id="futures-init-data"', 'id="futures-init-data" type="application/json"',
  "id='futures-init-data' type='application/json'", 'ID="FUTURES-INIT-DATA" TYPE="application/json" defer',
  'id = "futures-init-data" type = "application/json"', 'id="futures-init-data" type="application/json"',
];
for (let i = 0; i < 300; i++) {
  let keys = random() < 0.5 ? symbols : symbols.filter(() => random() < 0.3);
  if (i % 5 === 0) keys = shuffle(keys);
  const payload = Object.fromEntries(keys.map(symbol => [symbol, clone(fixture[symbol])]));
  const count = 1 + Math.floor(random() * 4);
  for (let j = 0; j < count && keys.length > 0; j++) {
    const key = pick(keys);
    payload[key] = pick(mutations)(isRecord(payload[key]) ? payload[key] : clone(ES));
  }
  if (random() < 0.2) {
    const key = pick(extraKeys);
    payload[key] = pick([{ ...clone(ES), ticker: key }, null, [], { ticker: key, last: 1, change: 0 }]);
  }
  let input = i % 11 === 0 ? JSON.stringify(payload, null, 1) : text(payload);
  input = input.replace(/"@@RAW@@"/g, () => pick(rawNumbers));
  if (i % 29 === 0) input = input.slice(0, Math.floor(random() * input.length));
  if (i % 7 === 0) input = page(input, { attributes: pick(attributeStyles), before: random() < 0.5 ? scriptJs : '' });
  if (i % 13 === 0) input = `﻿\n${input}\n`;
  const timeframe = random() < 0.2 ? undefined : pick(FUTURES_TIMEFRAMES).id;
  const sourceUrl = random() < 0.1 ? `https://finviz.com/api/futures_all?timeframe=${timeframe ?? 'i5'}` : undefined;
  add(`seeded mutation ${i}`, input, { timeframe, sourceUrl, fetchedAt: i % 2 ? fetchedAt : refreshedAt });
}

// ---------------------------------------------------------------------------------------------
// Run the driver.
const encode = ({ input, timeframe, fetchedAt: stamp, sourceUrl }) => [
  Buffer.from(input, 'utf8').toString('base64'),
  timeframe === undefined ? 'null' : timeframe,
  stamp,
  sourceUrl === undefined ? 'null' : sourceUrl,
].join('\t');
const run = spawnSync(executable, [], { input: cases.map(encode).join('\n') + '\n', encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
assert.equal(run.status, 0, run.error?.message || run.stderr);
// Windows text-mode stdout ends lines with CRLF; compare line content, not line endings.
const rows = run.stdout.replace(/\r?\n$/, '').split(/\r?\n/);
assert.equal(rows.length, cases.length, 'one output line per case');

// ---------------------------------------------------------------------------------------------
// Compare field by field with the JavaScript reference.
const scalar = token => token === 'null' ? null : token.startsWith('"') ? JSON.parse(token) : Number(token);
const closeTo = (actual, expected, label) => {
  assert.equal(typeof actual, 'number', `${label}: expected a number, got ${JSON.stringify(actual)}`);
  assert.ok(Number.isFinite(actual), `${label}: ${actual} is not finite`);
  assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12, `${label}: ${actual} != ${expected}`);
};
const same = (token, expected, label) => {
  const actual = scalar(token);
  if (expected === null) assert.equal(actual, null, `${label}: expected null, got ${JSON.stringify(actual)}`);
  else if (typeof expected === 'number') closeTo(actual, expected, label);
  else if (typeof expected === 'boolean') assert.equal(actual, expected ? 1 : 0, label);
  else assert.equal(actual, expected, label);
};
const headerKeys = ['source', 'sourceUrl', 'timeframe', 'status', 'cached', 'partial', 'fetchedAt', 'attemptedAt', 'quotedAt', 'delayMinutes', 'error'];
const quoteKeys = ['symbol', 'name', 'group', 'status', 'price', 'changePct', 'change', 'prevClose', 'high', 'low', 'unit', 'quotedAt', 'contract', 'fetchedAt', 'sourceUrl'];
let snapshots = 0;
let rejections = 0;
for (let i = 0; i < cases.length; i++) {
  const { name, input, timeframe, fetchedAt: stamp, sourceUrl } = cases[i];
  const label = `case ${i} (${name})`;
  let expected = null;
  let failure = null;
  try {
    expected = parseFinvizFutures(input, { fetchedAt: stamp, timeframe, sourceUrl });
  } catch (error) {
    failure = error;
  }
  const row = rows[i];
  if (failure) {
    assert.ok(row.startsWith('ERROR\t'), `${label}: reference threw "${failure.message}" but native returned ${row.slice(0, 160)}`);
    assert.match(failure.message, /Finviz|JSON|quote/i, label);
    assert.match(row.slice('ERROR\t'.length), /Finviz|JSON|quote/i, `${label}: native error text`);
    rejections++;
    continue;
  }
  assert.ok(row.startsWith('OK\t'), `${label}: reference parsed the payload but native returned ${row.slice(0, 160)}`);
  const fields = row.split('\t');
  assert.ok(fields.length >= 13, `${label}: header field count`);
  headerKeys.forEach((key, k) => same(fields[k + 1], expected[key], `${label}: ${key}`));
  assert.equal(Number(fields[12]), expected.quotes.length, `${label}: quote count`);
  const groups = fields.slice(13);
  assert.equal(groups.length, expected.quotes.length, `${label}: quote groups`);
  expected.quotes.forEach((quote, q) => {
    const parts = groups[q].split('|');
    assert.equal(parts.length, 17, `${label}: quote ${q} field count`);
    quoteKeys.forEach((key, k) => same(parts[k], quote[key], `${label}: ${quote.symbol}.${key}`));
    const sparkline = parts[15] === '' ? [] : parts[15].split(',').map(Number);
    assert.equal(sparkline.length, quote.sparkline.length, `${label}: ${quote.symbol} sparkline length`);
    sparkline.forEach((value, p) => closeTo(value, quote.sparkline[p], `${label}: ${quote.symbol} sparkline[${p}]`));
    const labels = parts[16] === '' ? [] : parts[16].split(';').filter(Boolean).map(pair => {
      const at = pair.indexOf('=');
      return [JSON.parse(pair.slice(0, at)), JSON.parse(pair.slice(at + 1))];
    });
    assert.deepEqual(labels, Object.entries(quote.chartLabels), `${label}: ${quote.symbol} chartLabels`);
  });
  snapshots++;
}
assert.ok(snapshots > 0 && rejections > 0, 'both accepted and rejected payloads must be covered');
assert.ok(!run.stdout.includes('Zombie Corp') && !run.stdout.includes('Mock News'));
console.log(`${cases.length} native/JavaScript futures parity cases passed (${snapshots} snapshots, ${rejections} rejections)`);

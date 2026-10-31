// One versioned settings document replaces the loose localStorage keys the
// app accumulated (dipAnalyzerTheme, dipAnalyzerThemeV2, excludedSectors,
// autoRefreshInterval). Those keys are migrated once and then ignored.
//
// Pure module: no DOM, no React. The provider (settings.jsx) and the Settings
// desk import from here, and tests/settings.test.js exercises it under node:test.
import { SECTORS } from '../data/sectors.js';

export const SETTINGS_KEY = 'dipAnalyzerSettingsV2';
export const SETTINGS_VERSION = 2;
export const APP_VERSION = '2.1.0';

export const THEMES = [
  { id: 'theme-pierce27', label: 'Pierce/27', blurb: 'Black ink, electric complements, silk surfaces. The default.' },
  { id: 'theme-majestic', label: 'Modern', blurb: 'Solid, quiet workstation surfaces; no glows.' },
  { id: 'theme-anime', label: 'Alien Fractal', blurb: 'Acid green on deep violet glass.' },
  { id: 'theme-seizure', label: 'Seizure Mode', blurb: 'A 20-second stunt. Reverts on its own and is never saved.' },
];

// Transient themes are selectable but never written to storage or imported.
export const TRANSIENT_THEMES = Object.freeze(['theme-seizure']);

export const DENSITIES = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'compact', label: 'Compact' },
];
export const MOTIONS = [
  { id: 'system', label: 'System', blurb: 'Follow the OS reduced-motion preference.' },
  { id: 'full', label: 'Full', blurb: 'Always animate, even if the OS asks for less.' },
  { id: 'reduced', label: 'Reduced', blurb: 'No transitions or pulses.' },
];
export const REFRESH_MINUTES = [0, 1, 5, 15, 30];
export const REUSE_SECONDS = [0, 30, 90, 180, 600];
export const CHART_CACHE_SECONDS = [0, 30, 60, 300, 900];
export const SCAN_DEPTHS = [100, 250, 500];
export const RATING_FILTERS = ['All', 'Strong Buy', 'Buy', 'Hold', 'Sell/Strong Sell', 'Bullish', 'Bearish'];
export const SORTS = [
  { id: 'score', label: 'Score — highest first' },
  { id: 'change', label: 'Day change — biggest losers first' },
  { id: 'dip', label: 'Dip below 1-month high — deepest first' },
  { id: 'volume', label: 'Volume — highest first' },
];
export const FUTURES_GROUP_IDS = ['all', 'indices', 'rates', 'energy', 'metals', 'grains', 'softs', 'currencies'];
export const FUTURES_TIMEFRAME_IDS = ['i5', 'h', 'd', 'w', 'm'];
export const GLOW_STEP = 0.27;

const deepFreeze = (value) => {
  if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

export const DEFAULT_SETTINGS = deepFreeze({
  version: SETTINGS_VERSION,
  appearance: {
    theme: 'theme-pierce27',
    density: 'comfortable',   // comfortable | compact
    motion: 'system',         // system | full | reduced
    glow: 0.54,               // 0..1, drives --glow-intensity
  },
  scanner: {
    excludedSectors: [],
    refreshMinutes: 0,        // 0 = manual only
    reuseSeconds: 90,         // returning to the Overview reuses a scan this recent; 0 = always rescan
    scanDepth: 100,           // the desk offers 100 | 250 | 500; any whole depth up to 500 is kept
    defaultRating: 'All',
    sort: 'score',            // score | change | dip | volume
  },
  futures: {
    defaultGroup: 'all',      // all | indices | rates | energy | metals | grains | softs | currencies
    timeframe: 'i5',          // i5 | h | d | w | m
    showDelayNotice: true,
  },
  alerts: {
    sound: true,
    volume: 0.27,             // 0..1
    breakout: true,
    breakdown: true,
    trend: true,
    minScore: 60,             // only alert on names at or above this score
    historyLimit: 50,
  },
  data: {
    chartCacheSeconds: 0,     // how long a Yahoo chart response is reused; 0 = always refetch
    requestTimeoutSeconds: 12,    // main.cjs starts with the same 12 s deadline until told otherwise
  },
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const copyLeaf = (value) => (Array.isArray(value) ? [...value] : value);

// Deep-merge `patch` over `base`, only keeping keys that exist in `base`
// so an old or hand-edited document cannot introduce unknown settings.
// Leaf arrays are copied so no document ever aliases the frozen defaults.
export const mergeKnown = (base, patch) => {
  if (!isRecord(base)) return copyLeaf(patch === undefined ? base : patch);
  const out = {};
  for (const key of Object.keys(base)) {
    const value = isRecord(patch) ? patch[key] : undefined;
    out[key] = isRecord(base[key]) ? mergeKnown(base[key], value) : copyLeaf(value === undefined ? base[key] : value);
  }
  return out;
};

export const setPath = (object, path, value) => {
  const [head, ...rest] = path;
  return { ...object, [head]: rest.length ? setPath(object[head] ?? {}, rest, value) : value };
};

export const isTransientTheme = (theme) => TRANSIENT_THEMES.includes(theme);
export const isPersistableTheme = (theme) => THEMES.some(item => item.id === theme) && !isTransientTheme(theme);

// ── validation ────────────────────────────────────────────────────────────
// Each rule returns a problem string or null. A choice the desk offers from a
// list must be one of that list, except the scan depth: any whole number up to
// the deepest preset is kept, as v1 saved depths of 10 to 50 and the Overview
// still offers them. A whole-number field must be a whole number in its range,
// the sliders (glow, volume) take any number in theirs, and a transient theme
// is never stored. loadSettings silently substitutes the fallback (the default,
// unless FALLBACKS repairs the value); parseSettingsImport reports the problems
// instead.
const number = (min, max, { integer = false } = {}) => (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
  if (integer && !Number.isInteger(value)) return 'must be a whole number';
  if (value < min || value > max) return `must be between ${min} and ${max}`;
  return null;
};
const oneOf = (allowed, describe = (v) => JSON.stringify(v)) => (value) => allowed.includes(value) ? null : `must be one of ${allowed.map(describe).join(', ')}`;
const boolean = (value) => typeof value === 'boolean' ? null : 'must be true or false';
const SECTOR_IDS = SECTORS.map(sector => sector.id);
const isSectorId = (value) => SECTOR_IDS.includes(value);
const sectorList = (value) => (
  Array.isArray(value) && value.every(isSectorId) && new Set(value).size === value.length
    ? null
    : `must be a list of distinct sector ids, each one of ${SECTOR_IDS.map(id => JSON.stringify(id)).join(', ')}`
);

// A stale or repeated sector id must not clear the user's other exclusions.
const FALLBACKS = {
  'scanner.excludedSectors': (value) => (Array.isArray(value) ? [...new Set(value)].filter(isSectorId) : []),
};

const RULES = {
  'appearance.theme': (value) => {
    if (isTransientTheme(value)) return 'is a transient theme and cannot be saved';
    return oneOf(THEMES.map(item => item.id).filter(id => !isTransientTheme(id)))(value);
  },
  'appearance.density': oneOf(DENSITIES.map(item => item.id)),
  'appearance.motion': oneOf(MOTIONS.map(item => item.id)),
  'appearance.glow': number(0, 1),
  'scanner.excludedSectors': sectorList,
  'scanner.refreshMinutes': oneOf(REFRESH_MINUTES),
  'scanner.reuseSeconds': oneOf(REUSE_SECONDS),
  'scanner.scanDepth': number(1, Math.max(...SCAN_DEPTHS), { integer: true }),
  'scanner.defaultRating': oneOf(RATING_FILTERS),
  'scanner.sort': oneOf(SORTS.map(item => item.id)),
  'futures.defaultGroup': oneOf(FUTURES_GROUP_IDS),
  'futures.timeframe': oneOf(FUTURES_TIMEFRAME_IDS),
  'futures.showDelayNotice': boolean,
  'alerts.sound': boolean,
  'alerts.volume': number(0, 1),
  'alerts.breakout': boolean,
  'alerts.breakdown': boolean,
  'alerts.trend': boolean,
  'alerts.minScore': number(0, 100, { integer: true }),
  'alerts.historyLimit': number(1, 1000, { integer: true }),
  'data.chartCacheSeconds': oneOf(CHART_CACHE_SECONDS),
  'data.requestTimeoutSeconds': number(1, 600, { integer: true }),
};

const readPath = (object, path) => path.split('.').reduce((cursor, key) => (isRecord(cursor) ? cursor[key] : undefined), object);

// What a number field on the desk commits when the user leaves it or presses
// Enter: the draft as a whole number clamped to the field's range, or null when
// it is empty or not a number, in which case the field keeps its saved value.
export const parseNumberDraft = (draft, min, max) => {
  const text = typeof draft === 'string' ? draft.trim() : '';
  const value = text === '' ? NaN : Math.round(Number(text));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
};

// Returns { settings, problems }: `settings` is the document with every
// invalid value replaced by its fallback; `problems` lists what was replaced.
export const normalizeSettings = (document) => {
  let settings = mergeKnown(DEFAULT_SETTINGS, document);
  const problems = [];
  for (const [path, rule] of Object.entries(RULES)) {
    const value = readPath(settings, path);
    const problem = rule(value);
    if (problem) {
      problems.push(`${path} ${problem}`);
      settings = setPath(settings, path.split('.'), FALLBACKS[path] ? FALLBACKS[path](value) : readPath(DEFAULT_SETTINGS, path));
    }
  }
  settings.version = SETTINGS_VERSION;
  return { settings, problems };
};

// What goes to storage: the same document minus transient state. A transient
// theme is replaced by `fallbackTheme` (the theme in force before the stunt)
// when the caller knows it, otherwise by the default theme.
export const persistableSettings = (settings, fallbackTheme = DEFAULT_SETTINGS.appearance.theme) => (
  isTransientTheme(settings.appearance.theme)
    ? setPath(settings, ['appearance', 'theme'], isPersistableTheme(fallbackTheme) ? fallbackTheme : DEFAULT_SETTINGS.appearance.theme)
    : settings
);

const readJson = (storage, key) => {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

// Legacy keys → v2 document. Seizure mode was never persisted and still isn't.
const migrateLegacy = (storage) => {
  const patch = { appearance: {}, scanner: {} };
  const theme = storage.getItem('dipAnalyzerThemeV2') || storage.getItem('dipAnalyzerTheme');
  if (isPersistableTheme(theme)) patch.appearance.theme = theme;
  const sectors = readJson(storage, 'excludedSectors');
  if (Array.isArray(sectors)) patch.scanner.excludedSectors = sectors.filter(item => typeof item === 'string');
  const refresh = readJson(storage, 'autoRefreshInterval');
  if (typeof refresh === 'number' && Number.isFinite(refresh)) patch.scanner.refreshMinutes = refresh;
  const depth = readJson(storage, 'dipAnalyzerChartCount');
  if (Number.isInteger(depth) && depth > 0) patch.scanner.scanDepth = depth;
  return patch;
};

export const loadSettings = (storage) => {
  try {
    if (storage === undefined) storage = globalThis.localStorage;
    if (!storage) return mergeKnown(DEFAULT_SETTINGS, {});
    const stored = readJson(storage, SETTINGS_KEY);
    const base = stored && stored.version === SETTINGS_VERSION ? stored : migrateLegacy(storage);
    return normalizeSettings(base).settings;
  } catch {
    // Both the storage getter and legacy reads can fail in restricted contexts.
    return mergeKnown(DEFAULT_SETTINGS, {});
  }
};

export const serializeSettings = (settings) => JSON.stringify({ ...persistableSettings(settings), version: SETTINGS_VERSION }, null, 2);

// Strict: the import must be a JSON object and every known value must be
// valid. Unknown keys are dropped (mergeKnown), invalid values are reported.
export const parseSettingsImport = (text) => {
  let parsed;
  try {
    parsed = JSON.parse(typeof text === 'string' ? text : '');
  } catch (error) {
    throw new Error(`Not valid JSON: ${error.message}`);
  }
  if (!isRecord(parsed)) throw new Error('Settings file must contain a JSON object.');
  for (const [section, defaults] of Object.entries(DEFAULT_SETTINGS)) {
    if (isRecord(defaults) && Object.hasOwn(parsed, section) && !isRecord(parsed[section])) {
      throw new Error(`Invalid settings: ${section} must be an object.`);
    }
  }
  const { settings, problems } = normalizeSettings(parsed);
  if (problems.length) throw new Error(`Invalid settings: ${problems.join('; ')}.`);
  return settings;
};

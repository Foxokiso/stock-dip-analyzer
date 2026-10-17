// One versioned settings document replaces the loose localStorage keys the
// app accumulated (dipAnalyzerTheme, dipAnalyzerThemeV2, excludedSectors,
// autoRefreshInterval). Those keys are migrated once and then ignored.
export const SETTINGS_KEY = 'dipAnalyzerSettingsV2';
export const SETTINGS_VERSION = 2;

export const THEMES = [
  { id: 'theme-pierce27', label: 'Pierce/27' },
  { id: 'theme-majestic', label: 'Modern' },
  { id: 'theme-anime', label: 'Alien Fractal' },
  { id: 'theme-seizure', label: 'Seizure Mode' },
];

export const DEFAULT_SETTINGS = Object.freeze({
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
    scanDepth: 100,           // 100 | 250 | 500
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
    chartCacheSeconds: 45,    // mirrors main.cjs; informational unless wired over IPC
    requestTimeoutSeconds: 15,
  },
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Deep-merge `patch` over `base`, only keeping keys that exist in `base`
// so an old or hand-edited document cannot introduce unknown settings.
export const mergeKnown = (base, patch) => {
  if (!isRecord(base)) return patch === undefined ? base : patch;
  const out = {};
  for (const key of Object.keys(base)) {
    const value = isRecord(patch) ? patch[key] : undefined;
    out[key] = isRecord(base[key]) ? mergeKnown(base[key], value) : (value === undefined ? base[key] : value);
  }
  return out;
};

export const setPath = (object, path, value) => {
  const [head, ...rest] = path;
  return { ...object, [head]: rest.length ? setPath(object[head] ?? {}, rest, value) : value };
};

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
  if (theme && THEMES.some(item => item.id === theme) && theme !== 'theme-seizure') patch.appearance.theme = theme;
  const sectors = readJson(storage, 'excludedSectors');
  if (Array.isArray(sectors)) patch.scanner.excludedSectors = sectors.filter(item => typeof item === 'string');
  const refresh = readJson(storage, 'autoRefreshInterval');
  if (typeof refresh === 'number' && Number.isFinite(refresh)) patch.scanner.refreshMinutes = refresh;
  return patch;
};

export const loadSettings = (storage = globalThis.localStorage) => {
  if (!storage) return mergeKnown(DEFAULT_SETTINGS, {});
  const stored = readJson(storage, SETTINGS_KEY);
  const base = stored && stored.version === SETTINGS_VERSION ? stored : migrateLegacy(storage);
  const settings = mergeKnown(DEFAULT_SETTINGS, base);
  if (!THEMES.some(item => item.id === settings.appearance.theme) || settings.appearance.theme === 'theme-seizure') {
    settings.appearance.theme = DEFAULT_SETTINGS.appearance.theme;
  }
  return settings;
};

export const serializeSettings = (settings) => JSON.stringify({ ...settings, version: SETTINGS_VERSION }, null, 2);

export const parseSettingsImport = (text) => {
  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('Settings file must contain a JSON object.');
  return mergeKnown(DEFAULT_SETTINGS, parsed);
};

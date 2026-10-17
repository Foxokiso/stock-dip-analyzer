import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, SETTINGS_KEY, SETTINGS_VERSION, THEMES,
  loadSettings, mergeKnown, normalizeSettings, parseSettingsImport, persistableSettings,
  serializeSettings, setPath,
} from '../src/state/settingsSchema.js';

// Minimal Storage stand-in: the schema only ever calls getItem/setItem.
const fakeStorage = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    get size() { return map.size; },
  };
};

test('defaults: empty or missing storage yields the default document', () => {
  assert.deepEqual(loadSettings(fakeStorage()), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(null), DEFAULT_SETTINGS);
  assert.equal(loadSettings(fakeStorage()).version, SETTINGS_VERSION);
  assert.ok(THEMES.some(item => item.id === DEFAULT_SETTINGS.appearance.theme));
});

test('defaults: loadSettings never hands out the frozen default object itself', () => {
  const loaded = loadSettings(fakeStorage());
  assert.notEqual(loaded, DEFAULT_SETTINGS);
  assert.notEqual(loaded.scanner, DEFAULT_SETTINGS.scanner);
  loaded.scanner.excludedSectors.push('energy');
  assert.deepEqual(DEFAULT_SETTINGS.scanner.excludedSectors, []);
});

test('legacy migration: old keys are folded into the v2 document once', () => {
  const storage = fakeStorage({
    dipAnalyzerTheme: 'theme-anime',
    excludedSectors: JSON.stringify(['energy', 'utilities', 7, null]),
    autoRefreshInterval: '15',
    dipAnalyzerChartCount: '250',
  });
  const settings = loadSettings(storage);
  assert.equal(settings.appearance.theme, 'theme-anime');
  assert.equal(settings.scanner.scanDepth, 250);
  assert.deepEqual(settings.scanner.excludedSectors, ['energy', 'utilities']);
  assert.equal(settings.scanner.refreshMinutes, 15);
  // Everything the legacy keys did not cover keeps its default.
  assert.equal(settings.scanner.sort, DEFAULT_SETTINGS.scanner.sort);
  assert.deepEqual(settings.alerts, DEFAULT_SETTINGS.alerts);
  assert.equal(settings.version, SETTINGS_VERSION);
});

test('legacy migration: the V2 theme key wins over the original, malformed values are ignored', () => {
  const storage = fakeStorage({
    dipAnalyzerTheme: 'theme-anime',
    dipAnalyzerThemeV2: 'theme-majestic',
    excludedSectors: '{not json',
    autoRefreshInterval: '"soon"',
    dipAnalyzerChartCount: '"lots"',
  });
  const settings = loadSettings(storage);
  assert.equal(settings.appearance.theme, 'theme-majestic');
  assert.equal(settings.scanner.scanDepth, DEFAULT_SETTINGS.scanner.scanDepth);
  assert.deepEqual(settings.scanner.excludedSectors, []);
  assert.equal(settings.scanner.refreshMinutes, 0);
});

test('legacy migration: an unknown legacy theme falls back to the default theme', () => {
  const settings = loadSettings(fakeStorage({ dipAnalyzerTheme: 'theme-orange' }));
  assert.equal(settings.appearance.theme, DEFAULT_SETTINGS.appearance.theme);
});

test('stored v2 document: unknown keys are dropped and missing keys are filled', () => {
  const storage = fakeStorage({
    [SETTINGS_KEY]: JSON.stringify({
      version: SETTINGS_VERSION,
      appearance: { theme: 'theme-majestic', glow: 0.27, surprise: true },
      scanner: { scanDepth: 250 },
      telemetry: { send: true },
    }),
    // Legacy keys must be ignored once a v2 document exists.
    dipAnalyzerTheme: 'theme-anime',
    autoRefreshInterval: '30',
  });
  const settings = loadSettings(storage);
  assert.equal(settings.appearance.theme, 'theme-majestic');
  assert.equal(settings.appearance.glow, 0.27);
  assert.equal(settings.appearance.density, 'comfortable');
  assert.equal(settings.scanner.scanDepth, 250);
  assert.equal(settings.scanner.refreshMinutes, 0);
  assert.equal('surprise' in settings.appearance, false);
  assert.equal('telemetry' in settings, false);
});

test('mergeKnown: only keys present in the base survive, at every depth', () => {
  const merged = mergeKnown(DEFAULT_SETTINGS, {
    bogus: 1,
    scanner: { scanDepth: 500, evil: 'yes', excludedSectors: ['energy'] },
    alerts: 'not an object',
  });
  assert.deepEqual(Object.keys(merged).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  assert.equal(merged.scanner.scanDepth, 500);
  assert.deepEqual(merged.scanner.excludedSectors, ['energy']);
  assert.equal('evil' in merged.scanner, false);
  // A non-object patch for a section leaves the section at its defaults.
  assert.deepEqual(merged.alerts, DEFAULT_SETTINGS.alerts);
  assert.deepEqual(mergeKnown(DEFAULT_SETTINGS, null), DEFAULT_SETTINGS);
  assert.deepEqual(mergeKnown(DEFAULT_SETTINGS, undefined), DEFAULT_SETTINGS);
});

test('seizure mode is never loaded from storage', () => {
  assert.equal(loadSettings(fakeStorage({ dipAnalyzerTheme: 'theme-seizure' })).appearance.theme, DEFAULT_SETTINGS.appearance.theme);
  assert.equal(loadSettings(fakeStorage({ dipAnalyzerThemeV2: 'theme-seizure' })).appearance.theme, DEFAULT_SETTINGS.appearance.theme);
  const stored = fakeStorage({ [SETTINGS_KEY]: JSON.stringify({ version: SETTINGS_VERSION, appearance: { theme: 'theme-seizure' } }) });
  assert.equal(loadSettings(stored).appearance.theme, DEFAULT_SETTINGS.appearance.theme);
});

test('seizure mode is never persisted or exported', () => {
  const live = setPath(mergeKnown(DEFAULT_SETTINGS, {}), ['appearance', 'theme'], 'theme-seizure');
  const persisted = persistableSettings(live);
  assert.equal(persisted.appearance.theme, DEFAULT_SETTINGS.appearance.theme);
  assert.equal(live.appearance.theme, 'theme-seizure', 'the in-memory document is left alone');
  assert.equal(JSON.parse(serializeSettings(live)).appearance.theme, DEFAULT_SETTINGS.appearance.theme);
  // Round trip through storage lands on the default theme, not the stunt.
  const storage = fakeStorage();
  storage.setItem(SETTINGS_KEY, JSON.stringify(persisted));
  assert.equal(loadSettings(storage).appearance.theme, DEFAULT_SETTINGS.appearance.theme);
  // A persistable theme passes through untouched (same reference).
  const modern = setPath(live, ['appearance', 'theme'], 'theme-majestic');
  assert.equal(persistableSettings(modern), modern);
  // The provider passes the theme in force before the stunt; junk fallbacks are ignored.
  assert.equal(persistableSettings(live, 'theme-majestic').appearance.theme, 'theme-majestic');
  assert.equal(persistableSettings(live, 'theme-seizure').appearance.theme, DEFAULT_SETTINGS.appearance.theme);
  assert.equal(persistableSettings(live, 'theme-orange').appearance.theme, DEFAULT_SETTINGS.appearance.theme);
});

test('parseSettingsImport rejects anything that is not a JSON object', () => {
  for (const text of ['[]', '[1,2]', '"theme-majestic"', '42', 'null', 'true', '']) {
    assert.throws(() => parseSettingsImport(text), /JSON/, `rejects ${JSON.stringify(text)}`);
  }
  assert.throws(() => parseSettingsImport('{not json'), /Not valid JSON/);
  assert.throws(() => parseSettingsImport(undefined), /Not valid JSON/);
  assert.throws(() => parseSettingsImport({ appearance: {} }), /Not valid JSON/, 'only text is accepted');
});

test('parseSettingsImport reports invalid values instead of silently fixing them', () => {
  assert.throws(() => parseSettingsImport(JSON.stringify({ appearance: { theme: 'theme-seizure' } })), /appearance\.theme .*transient/);
  assert.throws(() => parseSettingsImport(JSON.stringify({ appearance: { glow: 4 } })), /appearance\.glow must be between 0 and 1/);
  assert.throws(() => parseSettingsImport(JSON.stringify({ scanner: { excludedSectors: 'energy' } })), /scanner\.excludedSectors/);
  assert.throws(() => parseSettingsImport(JSON.stringify({ alerts: { historyLimit: 2.5 }, futures: { timeframe: 'NO' } })), /futures\.timeframe must be one of .*; alerts\.historyLimit must be a whole number/);
});

test('parseSettingsImport merges a valid object over the defaults and drops unknown keys', () => {
  const imported = parseSettingsImport(JSON.stringify({ scanner: { scanDepth: 250, nope: 1 }, futures: { timeframe: 'd' }, extra: {} }));
  assert.equal(imported.scanner.scanDepth, 250);
  assert.equal(imported.futures.timeframe, 'd');
  assert.equal(imported.appearance.theme, DEFAULT_SETTINGS.appearance.theme);
  assert.equal('nope' in imported.scanner, false);
  assert.equal('extra' in imported, false);
  assert.equal(imported.version, SETTINGS_VERSION);
});

test('export → import round trip is lossless for a persistable document', () => {
  const doc = normalizeSettings({
    appearance: { theme: 'theme-anime', density: 'compact', motion: 'reduced', glow: 0.81 },
    scanner: { excludedSectors: ['financial'], refreshMinutes: 5, scanDepth: 500, defaultRating: 'Buy', sort: 'dip' },
    futures: { defaultGroup: 'rates', timeframe: 'w', showDelayNotice: false },
    alerts: { sound: false, volume: 0.73, breakout: false, breakdown: true, trend: false, minScore: 75, historyLimit: 200 },
  }).settings;
  assert.deepEqual(parseSettingsImport(serializeSettings(doc)), doc);
});

test('normalizeSettings substitutes defaults for bad values and names each one', () => {
  const { settings, problems } = normalizeSettings({ appearance: { density: 'cosy', glow: '0.5' }, alerts: { minScore: 140 } });
  assert.equal(settings.appearance.density, 'comfortable');
  assert.equal(settings.appearance.glow, DEFAULT_SETTINGS.appearance.glow);
  assert.equal(settings.alerts.minScore, DEFAULT_SETTINGS.alerts.minScore);
  assert.deepEqual(problems.map(p => p.split(' ')[0]), ['appearance.density', 'appearance.glow', 'alerts.minScore']);
  assert.deepEqual(normalizeSettings(DEFAULT_SETTINGS).problems, []);
});

test('setPath returns a new document and never mutates the input', () => {
  const base = mergeKnown(DEFAULT_SETTINGS, {});
  const next = setPath(base, ['alerts', 'volume'], 0.9);
  assert.equal(next.alerts.volume, 0.9);
  assert.equal(base.alerts.volume, DEFAULT_SETTINGS.alerts.volume);
  assert.notEqual(next.alerts, base.alerts);
  assert.equal(next.scanner, base.scanner, 'untouched sections keep their identity');
});

test('defaults: denied storage reads do not prevent startup', () => {
  const loaded = loadSettings({ getItem() { throw new Error('storage denied'); } });
  assert.deepEqual(loaded, DEFAULT_SETTINGS);
  assert.notEqual(loaded, DEFAULT_SETTINGS);
  loaded.scanner.excludedSectors.push('energy');
  assert.deepEqual(DEFAULT_SETTINGS.scanner.excludedSectors, []);
});

test('defaults: a denied global storage getter does not prevent startup', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('storage denied'); },
  });
  try {
    assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('parseSettingsImport rejects malformed known sections without resetting preferences', () => {
  const sections = Object.keys(DEFAULT_SETTINGS).filter(key => key !== 'version');
  for (const section of sections) {
    for (const value of [null, [], false, 42, 'invalid']) {
      assert.throws(
        () => parseSettingsImport(JSON.stringify({ [section]: value })),
        new RegExp(section + ' must be an object'),
      );
    }
  }
  // Unknown sections remain forward-compatible and optional sections keep defaults.
  assert.deepEqual(parseSettingsImport('{"unknown": null}'), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettingsImport('{}'), DEFAULT_SETTINGS);
});

test('read-only source facts always reflect the current app, including old exports', () => {
  const oldExport = {
    version: SETTINGS_VERSION,
    appearance: { theme: 'theme-majestic' },
    data: { chartCacheSeconds: 45, requestTimeoutSeconds: 600 },
  };
  const imported = parseSettingsImport(JSON.stringify(oldExport));
  const loaded = loadSettings(fakeStorage({ [SETTINGS_KEY]: JSON.stringify(oldExport) }));
  for (const settings of [imported, loaded]) {
    assert.equal(settings.appearance.theme, 'theme-majestic');
    assert.deepEqual(settings.data, { chartCacheSeconds: 0, requestTimeoutSeconds: 12 });
    assert.notEqual(settings.data, DEFAULT_SETTINGS.data);
  }
  assert.throws(() => parseSettingsImport('{"data":{"requestTimeoutSeconds":"forever"}}'), /data\.requestTimeoutSeconds/);
});

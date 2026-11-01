import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHART_CACHE_SECONDS, DEFAULT_SETTINGS, REFRESH_MINUTES, REUSE_SECONDS, SCAN_DEPTHS, SETTINGS_KEY, SETTINGS_VERSION, THEMES,
  loadSettings, mergeKnown, normalizeSettings, parseNumberDraft, parseSettingsImport, persistableSettings,
  serializeSettings, setPath,
} from '../src/state/settingsSchema.js';
import { SECTORS } from '../src/data/sectors.js';

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
    data: { chartCacheSeconds: 900, requestTimeoutSeconds: 130 },
  }).settings;
  assert.deepEqual(doc.data, { chartCacheSeconds: 900, requestTimeoutSeconds: 130 });
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

test('data preferences survive a restart, an import, an export round trip and replace()', () => {
  const saved = {
    version: SETTINGS_VERSION,
    appearance: { theme: 'theme-majestic' },
    data: { chartCacheSeconds: 300, requestTimeoutSeconds: 45 },
  };
  const loaded = loadSettings(fakeStorage({ [SETTINGS_KEY]: JSON.stringify(saved) }));
  const imported = parseSettingsImport(JSON.stringify(saved));
  const roundTrip = parseSettingsImport(serializeSettings(loaded));
  // SettingsProvider.replace() keeps exactly what normalizeSettings returns.
  const replaced = normalizeSettings(saved).settings;
  for (const settings of [loaded, imported, roundTrip, replaced]) {
    assert.equal(settings.appearance.theme, 'theme-majestic');
    assert.deepEqual(settings.data, { chartCacheSeconds: 300, requestTimeoutSeconds: 45 });
    assert.notEqual(settings.data, DEFAULT_SETTINGS.data);
  }
});

test('data preferences the desk does not offer fall back on load and are reported on import', () => {
  // 45 s was a pre-release chart cache value; the desk offers CHART_CACHE_SECONDS only,
  // and the request timeout field takes whole seconds from 1 to 600.
  const cases = [
    [{ chartCacheSeconds: 45 }, /data\.chartCacheSeconds must be one of 0, 30, 60, 300, 900/],
    [{ chartCacheSeconds: '300' }, /data\.chartCacheSeconds/],
    [{ requestTimeoutSeconds: 0 }, /data\.requestTimeoutSeconds must be between 1 and 600/],
    [{ requestTimeoutSeconds: 601 }, /data\.requestTimeoutSeconds must be between 1 and 600/],
    [{ requestTimeoutSeconds: 12.5 }, /data\.requestTimeoutSeconds must be a whole number/],
    [{ requestTimeoutSeconds: 'forever' }, /data\.requestTimeoutSeconds must be a number/],
  ];
  for (const [data, problem] of cases) {
    const loaded = loadSettings(fakeStorage({ [SETTINGS_KEY]: JSON.stringify({ version: SETTINGS_VERSION, data: { chartCacheSeconds: 60, requestTimeoutSeconds: 30, ...data } }) }));
    const [path] = Object.keys(data);
    assert.equal(loaded.data[path], DEFAULT_SETTINGS.data[path], `${JSON.stringify(data)} falls back to the default`);
    // The other, valid data preference is kept.
    const other = path === 'chartCacheSeconds' ? ['requestTimeoutSeconds', 30] : ['chartCacheSeconds', 60];
    assert.equal(loaded.data[other[0]], other[1]);
    assert.throws(() => parseSettingsImport(JSON.stringify({ data })), problem);
  }
});

test('every choice the desk offers is accepted on import and survives a restart', () => {
  const offered = [
    ...REFRESH_MINUTES.map(refreshMinutes => ({ scanner: { refreshMinutes } })),
    ...REUSE_SECONDS.map(reuseSeconds => ({ scanner: { reuseSeconds } })),
    ...SCAN_DEPTHS.map(scanDepth => ({ scanner: { scanDepth } })),
    ...CHART_CACHE_SECONDS.map(chartCacheSeconds => ({ data: { chartCacheSeconds } })),
    { scanner: { excludedSectors: SECTORS.map(sector => sector.id) } },
    { alerts: { minScore: 0, historyLimit: 1 } },
    { alerts: { minScore: 100, historyLimit: 1000 } },
    { data: { requestTimeoutSeconds: 1 } },
    { data: { requestTimeoutSeconds: 600 } },
  ];
  for (const patch of offered) {
    const imported = parseSettingsImport(JSON.stringify(patch));
    const loaded = loadSettings(fakeStorage({ [SETTINGS_KEY]: JSON.stringify({ ...patch, version: SETTINGS_VERSION }) }));
    for (const [section, values] of Object.entries(patch)) {
      assert.deepEqual(imported[section], { ...DEFAULT_SETTINGS[section], ...values }, JSON.stringify(patch));
      assert.deepEqual(loaded[section], imported[section], JSON.stringify(patch));
    }
  }
});

test('scanner and alert values the desk never offers fall back on load and are reported on import', () => {
  const cases = [
    // A fractional interval made every desk poll continuously (0.0001 min = every 6 ms).
    [{ scanner: { refreshMinutes: 0.0001 } }, /scanner\.refreshMinutes must be one of 0, 1, 5, 15, 30/],
    [{ scanner: { refreshMinutes: 2 } }, /scanner\.refreshMinutes must be one of/],
    [{ scanner: { reuseSeconds: 0.5 } }, /scanner\.reuseSeconds must be one of 0, 30, 90, 180, 600/],
    // Any whole depth up to the deepest preset is kept (v1 saved 10 to 50); deeper scans are refused.
    [{ scanner: { scanDepth: 10000 } }, /scanner\.scanDepth must be between 1 and 500/],
    [{ scanner: { scanDepth: 501 } }, /scanner\.scanDepth must be between 1 and 500/],
    [{ scanner: { scanDepth: 0 } }, /scanner\.scanDepth must be between 1 and 500/],
    [{ scanner: { scanDepth: 12.5 } }, /scanner\.scanDepth must be a whole number/],
    [{ scanner: { scanDepth: '100' } }, /scanner\.scanDepth must be a number/],
    [{ alerts: { minScore: 62.5 } }, /alerts\.minScore must be a whole number/],
    [{ alerts: { historyLimit: 1001 } }, /alerts\.historyLimit must be between 1 and 1000/],
    [{ alerts: { historyLimit: 0 } }, /alerts\.historyLimit must be between 1 and 1000/],
  ];
  for (const [patch, problem] of cases) {
    const [[section, values]] = Object.entries(patch);
    const [key] = Object.keys(values);
    const loaded = loadSettings(fakeStorage({ [SETTINGS_KEY]: JSON.stringify({ ...patch, version: SETTINGS_VERSION }) }));
    assert.equal(loaded[section][key], DEFAULT_SETTINGS[section][key], `${JSON.stringify(patch)} falls back to the default`);
    assert.throws(() => parseSettingsImport(JSON.stringify(patch)), problem);
  }
});

test('legacy scan depths survive the v1 migration, a restart, an import and an export round trip', () => {
  // v1 saved 10, 20 (its default), 30 or 50; the Overview still offers them beside the presets.
  for (const scanDepth of [10, 20, 30, 50, 1, 499]) {
    assert.equal(loadSettings(fakeStorage({ dipAnalyzerChartCount: String(scanDepth) })).scanner.scanDepth, scanDepth, `v1 depth ${scanDepth}`);
    const stored = loadSettings(fakeStorage({ [SETTINGS_KEY]: JSON.stringify({ version: SETTINGS_VERSION, scanner: { scanDepth } }) }));
    assert.equal(stored.scanner.scanDepth, scanDepth, `stored depth ${scanDepth}`);
    assert.equal(parseSettingsImport(JSON.stringify({ scanner: { scanDepth } })).scanner.scanDepth, scanDepth, `imported depth ${scanDepth}`);
    assert.deepEqual(parseSettingsImport(serializeSettings(stored)), stored);
  }
  // A v1 depth past the deepest preset is not migrated into a larger scan.
  assert.equal(loadSettings(fakeStorage({ dipAnalyzerChartCount: '10000' })).scanner.scanDepth, DEFAULT_SETTINGS.scanner.scanDepth);
});

test('excluded sectors: stored lists keep their known ids once each, imports must be clean', () => {
  const stored = (excludedSectors) => loadSettings(fakeStorage({
    [SETTINGS_KEY]: JSON.stringify({ version: SETTINGS_VERSION, scanner: { excludedSectors, scanDepth: 250 } }),
  }));
  // One stale or repeated id does not clear the user's other exclusions.
  const repaired = stored(['energy', '', 'nonsense', 'energy', 7, null, 'utilities']);
  assert.deepEqual(repaired.scanner.excludedSectors, ['energy', 'utilities']);
  assert.equal(repaired.scanner.scanDepth, 250);
  // The list is bounded by the sector list, however long the stored one is.
  // Check the bound first: if it regresses, deepEqual would diff all 50,000
  // entries and run out of memory instead of failing.
  const flood = Array.from({ length: 50000 }, (_, i) => (i % 2 ? `sector-${i}` : 'energy'));
  const kept = stored(flood).scanner.excludedSectors;
  assert.ok(kept.length <= SECTORS.length, `${kept.length} of ${flood.length} stored ids kept`);
  assert.deepEqual(kept, ['energy']);
  // Not a list at all: no exclusions, and never the frozen default array itself.
  const reset = stored('energy');
  assert.deepEqual(reset.scanner.excludedSectors, []);
  reset.scanner.excludedSectors.push('energy');
  assert.deepEqual(DEFAULT_SETTINGS.scanner.excludedSectors, []);

  for (const excludedSectors of [['energy', 'nonsense'], ['energy', 'energy'], [''], ['Energy'], flood]) {
    assert.throws(
      () => parseSettingsImport(JSON.stringify({ scanner: { excludedSectors } })),
      /scanner\.excludedSectors must be a list of distinct sector ids/,
      JSON.stringify(excludedSectors).slice(0, 60),
    );
  }
  assert.deepEqual(parseSettingsImport('{"scanner":{"excludedSectors":["photonics","energy"]}}').scanner.excludedSectors, ['photonics', 'energy']);
});

test('number field drafts commit as whole numbers within the field range', () => {
  assert.equal(parseNumberDraft('45', 1, 600), 45);
  assert.equal(parseNumberDraft(' 45 ', 1, 600), 45);
  assert.equal(parseNumberDraft('045', 0, 100), 45);
  assert.equal(parseNumberDraft('12.6', 1, 600), 13);
  assert.equal(parseNumberDraft('1e3', 1, 1000), 1000);
  // Out of range: clamped at commit time, not on every keystroke.
  assert.equal(parseNumberDraft('0', 1, 600), 1);
  assert.equal(parseNumberDraft('2000', 1, 1000), 1000);
  assert.equal(parseNumberDraft('-5', 0, 100), 0);
});

test('number field drafts that are empty or not a number commit nothing', () => {
  // A cleared field used to become the minimum at once, so retyping 45 over 12 gave 145.
  for (const draft of ['', '   ', '-', 'e', 'abc', '1e400', null, undefined]) {
    assert.equal(parseNumberDraft(draft, 1, 600), null, JSON.stringify(draft));
  }
});

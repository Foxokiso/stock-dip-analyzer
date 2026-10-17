import { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsContext } from './settingsContext.js';
import { DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, mergeKnown, setPath } from './settingsSchema.js';

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => loadSettings());

  useEffect(() => {
    // Seizure mode is a 20-second stunt; never let it survive a restart.
    const persisted = settings.appearance.theme === 'theme-seizure'
      ? setPath(settings, ['appearance', 'theme'], DEFAULT_SETTINGS.appearance.theme) : settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted));
  }, [settings]);

  // Appearance → document attributes consumed by tokens.css.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.motion = settings.appearance.motion;
    root.dataset.density = settings.appearance.density;
    root.style.setProperty('--glow-intensity', String(settings.appearance.glow));
  }, [settings.appearance]);

  const update = useCallback((path, value) => {
    const keys = typeof path === 'string' ? path.split('.') : path;
    setSettings(current => setPath(current, keys, typeof value === 'function' ? value(keys.reduce((o, k) => o?.[k], current)) : value));
  }, []);

  const reset = useCallback((section) => {
    setSettings(current => section ? { ...current, [section]: DEFAULT_SETTINGS[section] } : mergeKnown(DEFAULT_SETTINGS, {}));
  }, []);

  const replace = useCallback((next) => setSettings(mergeKnown(DEFAULT_SETTINGS, next)), []);

  const value = useMemo(() => ({ settings, update, reset, replace }), [settings, update, reset, replace]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

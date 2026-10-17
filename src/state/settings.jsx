import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsContext } from './settingsContext.js';
import { DEFAULT_SETTINGS, SETTINGS_KEY, isTransientTheme, loadSettings, mergeKnown, normalizeSettings, persistableSettings, setPath } from './settingsSchema.js';

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => loadSettings());
  // The last theme that may be saved, so a restart during the 20-second
  // Seizure Mode stunt lands on the theme the user actually chose.
  const lastPersistableTheme = useRef(settings.appearance.theme);

  useEffect(() => {
    const theme = settings.appearance.theme;
    if (!isTransientTheme(theme)) lastPersistableTheme.current = theme;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistableSettings(settings, lastPersistableTheme.current)));
    } catch {
      // Storage can be unavailable (private window, quota); the session still works.
    }
  }, [settings]);

  // Apply the theme at the root so derived tokens re-resolve against its roles.
  // Legacy themes also have body selectors. Pierce inherits from the root:
  // repeating its token block on body would reset density, glow and motion.
  useEffect(() => {
    const root = document.documentElement;
    root.className = settings.appearance.theme;
    document.body.className = settings.appearance.theme === 'theme-pierce27' ? '' : settings.appearance.theme;
    root.dataset.motion = settings.appearance.motion;
    root.dataset.density = settings.appearance.density;
    root.style.setProperty('--glow-intensity', String(settings.appearance.glow));
  }, [settings.appearance]);

  const update = useCallback((path, value) => {
    const keys = typeof path === 'string' ? path.split('.') : path;
    setSettings(current => setPath(current, keys, typeof value === 'function' ? value(keys.reduce((o, k) => o?.[k], current)) : value));
  }, []);

  const reset = useCallback((section) => {
    setSettings(current => section ? { ...current, [section]: mergeKnown(DEFAULT_SETTINGS[section], {}) } : mergeKnown(DEFAULT_SETTINGS, {}));
  }, []);

  const replace = useCallback((next) => setSettings(normalizeSettings(next).settings), []);

  const value = useMemo(() => ({ settings, update, reset, replace }), [settings, update, reset, replace]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

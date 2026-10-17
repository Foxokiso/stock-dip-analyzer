import { createContext, useContext } from 'react';

export const SettingsContext = createContext(null);

// { settings, update(path, value), reset(section?), replace(document) }
export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) throw new Error('useSettings must be used inside <SettingsProvider>.');
  return context;
}

import { getInvoke } from '../utils/bridge.js';

// The main process owns the provider request deadline and starts every launch
// at its built-in 12 s. Outside the desktop app there is no bridge and nothing
// to configure, and a refused call leaves the previous deadline in place, so
// failures are ignored.
export function configureNetwork(requestTimeoutSeconds, invoke = getInvoke()) {
  if (!invoke) return;
  try {
    Promise.resolve(invoke('configure-network', { requestTimeoutSeconds })).catch(() => {});
  } catch {
    // A bridge that throws synchronously must not stop the app from starting.
  }
}

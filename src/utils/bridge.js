// How the renderer reaches the desktop process. The packaged app exposes
// window.dipAnalyzer.invoke from preload.cjs (context-isolated, sandboxed).
// A legacy window.require('electron') shape is still honoured so the browser
// regression scripts can stub the desktop with a plain object.

const legacyInvoke = () => {
    if (typeof window === 'undefined' || typeof window.require !== 'function') return null;
    try {
        const invoke = window.require('electron')?.ipcRenderer?.invoke;
        return typeof invoke === 'function' ? invoke : null;
    } catch { return null; }
};

// Electron rejects an invoke with "Error invoking remote method '<channel>':
// <Name>: <message>". The main process words its errors for people, so the
// desks get that message alone.
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:\w*Error: )?/;
const readableError = (error) => {
    const message = String(error?.message ?? error);
    return IPC_ERROR_PREFIX.test(message) ? new Error(message.replace(IPC_ERROR_PREFIX, ''), { cause: error }) : error;
};

/** @returns {((channel: string, ...args: any[]) => Promise<any>) | null} null outside the desktop app */
export function getInvoke() {
    if (typeof window === 'undefined') return null;
    const bridged = window.dipAnalyzer?.invoke;
    const bridge = typeof bridged === 'function' ? bridged : legacyInvoke();
    if (!bridge) return null;
    return async (channel, ...args) => {
        try {
            return await bridge(channel, ...args);
        } catch (error) {
            throw readableError(error);
        }
    };
}

export const hasDesktop = () => getInvoke() !== null;

/** Invoke a desktop channel, or reject with the standard "needs the desktop app" error. */
export function invoke(channel, ...args) {
    const bridge = getInvoke();
    if (!bridge) return Promise.reject(new Error('Market data requires the desktop app connection. No sample quotes are shown.'));
    return bridge(channel, ...args);
}

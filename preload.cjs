// The only bridge between the sandboxed renderer and the main process.
// The renderer gets one function, window.dipAnalyzer.invoke, limited to the
// channels below; it never sees Node, Electron or ipcRenderer itself.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set(['fetch-url', 'fetch-yahoo-chart', 'configure-network']);

contextBridge.exposeInMainWorld('dipAnalyzer', {
    invoke(channel, ...args) {
        if (!CHANNELS.has(channel)) return Promise.reject(new Error(`Unknown desktop channel: ${String(channel)}`));
        return ipcRenderer.invoke(channel, ...args);
    },
});

// Splash preload — exposes a minimal channel so the splash window can render the
// REAL load status the main process (and renderer) report during startup.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("splash", {
  onStatus: (cb) => ipcRenderer.on("splash:status", (_e, msg) => cb(msg)),
});

// electron/preload.js
// Secure contextBridge — exposes only specific APIs to the renderer
// This replaces ALL @tauri-apps/* imports in the frontend

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ether", {
  // ── Audio ────────────────────────────────────────────────────
  audio: {
    load: (deck, filePath, title, artist, gainDb) =>
      ipcRenderer.invoke("audio:load", deck, filePath, title, artist, gainDb),
    play: (deck) => ipcRenderer.invoke("audio:play", deck),
    pause: (deck) => ipcRenderer.invoke("audio:pause", deck),
    stop: (deck) => ipcRenderer.invoke("audio:stop", deck),
    setVolume: (deck, volume) => ipcRenderer.invoke("audio:setVolume", deck, volume),
    getState: () => ipcRenderer.invoke("audio:getState"),
    getLevels: () => ipcRenderer.invoke("audio:getLevels"),
    getFileDuration: (filePath) => ipcRenderer.invoke("audio:getFileDuration", filePath),
    watchdogSet: (active, thresholdSec) => ipcRenderer.invoke("audio:watchdogSet", active, thresholdSec),
  },

  // ── Database ─────────────────────────────────────────────────
  db: {
    query: (sql, params) => ipcRenderer.invoke("db:query", sql, params),
    execute: (sql, params) => ipcRenderer.invoke("db:execute", sql, params),
    backup: () => ipcRenderer.invoke("db:backup"),
    listBackups: () => ipcRenderer.invoke("db:listBackups"),
    restore: (name) => ipcRenderer.invoke("db:restore", name),
  },

  // ── File system ──────────────────────────────────────────────
  fs: {
    readFile: (filePath) => ipcRenderer.invoke("fs:readFile", filePath),
    exists: (filePath) => ipcRenderer.invoke("fs:exists", filePath),
    readDir: (dirPath) => ipcRenderer.invoke("fs:readDir", dirPath),
  },

  // ── Dialogs ──────────────────────────────────────────────────
  dialog: {
    openFile: (options) => ipcRenderer.invoke("dialog:openFile", options),
    openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
    saveFile: (options) => ipcRenderer.invoke("dialog:saveFile", options),
  },

  // ── System ───────────────────────────────────────────────────
  system: {
    getLocalIp: () => ipcRenderer.invoke("system:getLocalIp"),
    openUrl: (url) => ipcRenderer.invoke("system:openUrl", url),
    openSoundSettings: () => ipcRenderer.invoke("system:openSoundSettings"),
    getAppDataDir: () => ipcRenderer.invoke("system:getAppDataDir"),
    getPlatform: () => ipcRenderer.invoke("system:getPlatform"),
  },

  // ── Autostart ────────────────────────────────────────────────
  autostart: {
    enable: () => ipcRenderer.invoke("autostart:enable"),
    disable: () => ipcRenderer.invoke("autostart:disable"),
    isEnabled: () => ipcRenderer.invoke("autostart:isEnabled"),
  },

  // ── Generic invoke passthrough ────────────────────────────────
  // Used by App.tsx shims: invoke("watchdog_set", {...}) etc.
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  // ── Events (any channel — no whitelist) ──────────────────────
  // on() returns the raw ipcRenderer handler so off() can remove it precisely
  on: (channel, callback) => {
    const handler = (_, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    return handler;
  },
  off: (channel, handler) => {
    if (handler) ipcRenderer.removeListener(channel, handler);
    else ipcRenderer.removeAllListeners(channel);
  },

  // ── Emit to main / other windows ─────────────────────────────
  emit: (channel, payload) => ipcRenderer.send(channel, payload),
});

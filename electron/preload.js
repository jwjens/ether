const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ether", {
  audio: {
    load: (deck, fp, title, artist, gainDb) => ipcRenderer.invoke("audio:load", deck, fp, title, artist, gainDb),
    play: (deck) => ipcRenderer.invoke("audio:play", deck),
    pause: (deck) => ipcRenderer.invoke("audio:pause", deck),
    stop: (deck) => ipcRenderer.invoke("audio:stop", deck),
    setVolume: (deck, v) => ipcRenderer.invoke("audio:setVolume", deck, v),
    getState: () => ipcRenderer.invoke("audio:getState"),
    getLevels: () => ipcRenderer.invoke("audio:getLevels"),
    getFileDuration: (fp) => ipcRenderer.invoke("audio:getFileDuration", fp),
    watchdogSet: (a, t) => ipcRenderer.invoke("audio:watchdogSet", a, t),
  },
  db: {
    query: (sql, p) => ipcRenderer.invoke("db:query", sql, p),
    execute: (sql, p) => ipcRenderer.invoke("db:execute", sql, p),
    backup: () => ipcRenderer.invoke("db:backup"),
    listBackups: () => ipcRenderer.invoke("db:listBackups"),
    restore: (n) => ipcRenderer.invoke("db:restore", n),
  },
  fs: {
    readFile: (fp) => ipcRenderer.invoke("fs:readFile", fp),
    exists: (fp) => ipcRenderer.invoke("fs:exists", fp),
    readDir: (dp) => ipcRenderer.invoke("fs:readDir", dp),
    writeFile: (fp, d) => ipcRenderer.invoke("fs:writeFile", fp, d),
    mkdir: (dp) => ipcRenderer.invoke("fs:mkdir", dp),
    copyFile: (s, d) => ipcRenderer.invoke("fs:copyFile", s, d),
  },
  dialog: {
    openFile: (o) => ipcRenderer.invoke("dialog:openFile", o),
    openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
    saveFile: (o) => ipcRenderer.invoke("dialog:saveFile", o),
  },
  system: {
    getLocalIp: () => ipcRenderer.invoke("system:getLocalIp"),
    openUrl: (u) => ipcRenderer.invoke("system:openUrl", u),
    openSoundSettings: () => ipcRenderer.invoke("system:openSoundSettings"),
    getAppDataDir: () => ipcRenderer.invoke("system:getAppDataDir"),
    getPlatform: () => ipcRenderer.invoke("system:getPlatform"),
  },
  autostart: {
    enable: () => ipcRenderer.invoke("autostart:enable"),
    disable: () => ipcRenderer.invoke("autostart:disable"),
    isEnabled: () => ipcRenderer.invoke("autostart:isEnabled"),
  },
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, cb) => {
    const h = (_, ...a) => cb(...a);
    ipcRenderer.on(channel, h);
    return h;
  },
  off: (channel, h) => {
    if (h) ipcRenderer.removeListener(channel, h);
    else ipcRenderer.removeAllListeners(channel);
  },
  emit: (channel, payload) => ipcRenderer.send(channel, payload),
});

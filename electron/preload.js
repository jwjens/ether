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
    setEq: (deck, bands) => ipcRenderer.invoke("audio:setEq", deck, bands),
    // Push-based level subscription — 30fps from main process, no polling
    onLevels:  (cb) => { const h = (_, v) => cb(v); ipcRenderer.on("audio:levels", h); return h; },
    offLevels: (h)  => ipcRenderer.removeListener("audio:levels", h),
  },
  theme: {
    export: (presetId, vars, font) => ipcRenderer.invoke("theme:export", { presetId, vars, font }),
    import: ()                     => ipcRenderer.invoke("theme:import"),
  },
  station: {
    uploadLogo: () => ipcRenderer.invoke("station:uploadLogo"),
  },
  spotify: {
    setCredentials:       (clientId, clientSecret) => ipcRenderer.invoke("spotify:setCredentials", { clientId, clientSecret }),
    getCredentialStatus:  ()                       => ipcRenderer.invoke("spotify:getCredentialStatus"),
    getRecommendations:   (params)                 => ipcRenderer.invoke("spotify:getRecommendations", params),
  },
  musixmatch: {
    setKey:       (key)            => ipcRenderer.invoke("musixmatch:setKey", { key }),
    getKeyStatus: ()               => ipcRenderer.invoke("musixmatch:getKeyStatus"),
    scanLyrics:   (title, artist)  => ipcRenderer.invoke("musixmatch:scanLyrics", { title, artist }),
  },
  library: {
    writeTrack: (track) => ipcRenderer.invoke("library:writeTrack", track),
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
  iris: {
    // Fires when Iris sends a command — payload: { action, label }
    onCommand:   (cb) => { const h = (_, v) => cb(v); ipcRenderer.on('iris:command-received', h); return h; },
    offCommand:  (h)  => ipcRenderer.removeListener('iris:command-received', h),
    // Fires with true/false as Iris connects or drops off
    onConnected: (cb) => { const h = (_, v) => cb(v); ipcRenderer.on('iris:connected', h); return h; },
    offConnected:(h)  => ipcRenderer.removeListener('iris:connected', h),
    // Iris requesting next-track (renderer auto-advance handles it)
    onNextTrack: (cb) => { const h = (_, v) => cb(v); ipcRenderer.on('iris:next-track', h); return h; },
    offNextTrack:(h)  => ipcRenderer.removeListener('iris:next-track', h),
  },
  ffmpeg: {
    bounceAudio:  (inputPath, outputPath, format) => ipcRenderer.invoke("ffmpeg:bounce-audio", { inputPath, outputPath, format }),
    mixAudio:     (opts) => ipcRenderer.invoke("ffmpeg:mix-audio", opts),
    bounceVideo:  (audioPath, videoPath, outputPath) => ipcRenderer.invoke("ffmpeg:bounce-video", { audioPath, videoPath, outputPath }),
    export:       (sourcePath, defaultName, filters) => ipcRenderer.invoke("ffmpeg:export", { sourcePath, defaultName, filters }),
    writeAudio:   (data, filePath) => ipcRenderer.invoke("voxpro:writeAudio", { data, filePath }),
    getSaveDir:   () => ipcRenderer.invoke("voxpro:getSaveDir"),
    getTempDir:   () => ipcRenderer.invoke("voxpro:getTempDir"),
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

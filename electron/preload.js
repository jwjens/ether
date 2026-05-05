const { contextBridge, ipcRenderer } = require("electron");
const handlers = require('./preload-handlers')(ipcRenderer);

contextBridge.exposeInMainWorld("ether", {
  audio: {
    load: (deck, fp, title, artist, gainDb, stationId) => ipcRenderer.invoke("audio:load", deck, fp, title, artist, gainDb, stationId),
    play: (deck, stationId) => ipcRenderer.invoke("audio:play", deck, stationId),
    pause: (deck, stationId) => ipcRenderer.invoke("audio:pause", deck, stationId),
    stop: (deck, stationId) => ipcRenderer.invoke("audio:stop", deck, stationId),
    setVolume: (deck, v, stationId) => ipcRenderer.invoke("audio:setVolume", deck, v, stationId),
    getState: (stationId) => ipcRenderer.invoke("audio:getState", stationId),
    getLevels: (stationId) => ipcRenderer.invoke("audio:getLevels", stationId),
    getFileDuration: (fp) => ipcRenderer.invoke("audio:getFileDuration", fp),
    watchdogSet: (a, t, stationId) => ipcRenderer.invoke("audio:watchdogSet", a, t, stationId),
    setEq: (deck, bands, stationId) => ipcRenderer.invoke("audio:setEq", deck, bands, stationId),
    listOutputDevices: () => ipcRenderer.invoke("audio:listOutputDevices"),
    setOutputDevice: (stationId, deviceName) => ipcRenderer.invoke("audio:setOutputDevice", stationId, deviceName),
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
  discogs: {
    setCredentials:      (consumerKey, consumerSecret) => ipcRenderer.invoke("discogs:setCredentials", { consumerKey, consumerSecret }),
    getCredentialStatus: ()                            => ipcRenderer.invoke("discogs:getCredentialStatus"),
    search:              (title, artist)               => ipcRenderer.invoke("discogs:search", { title, artist }),
    updateTrack:         (fields)                      => ipcRenderer.invoke("discogs:updateTrack", fields),
  },
  captions: {
    start:             ()        => ipcRenderer.invoke("captions:start"),
    stop:              ()        => ipcRenderer.invoke("captions:stop"),
    irisLine:          (text)    => ipcRenderer.invoke("captions:iris-line", text),
    getTranscript:     ()        => ipcRenderer.invoke("captions:get-transcript"),
    getLoopbackSource: ()        => ipcRenderer.invoke("captions:get-loopback-source"),
    // Push events from main → renderer
    onLine:    (cb) => { const h = (_, v) => cb(v); ipcRenderer.on("captions:line", h);   return h; },
    offLine:   (h)  => ipcRenderer.removeListener("captions:line", h),
    onStatus:  (cb) => { const h = (_, v) => cb(v); ipcRenderer.on("captions:status", h); return h; },
    offStatus: (h)  => ipcRenderer.removeListener("captions:status", h),
    // Raw PCM chunks from renderer → main (fire-and-forget, use 'send' not 'invoke')
    sendAudioChunk: (float32Array) => ipcRenderer.send("captions:audio-chunk", float32Array),
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
  schedule: {
    generate: (days) => ipcRenderer.invoke("schedule:generate", days ?? 7),
    get:      (fromTs, toTs) => ipcRenderer.invoke("schedule:get", fromTs, toTs),
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
  // ── Video engine (renderer composites; main spawns ffmpeg for RTMP/MP4) ─
  video: {
    listSources:    (kinds) => ipcRenderer.invoke("video:list-sources", kinds),
    setDesktopSource: (id)  => ipcRenderer.invoke("video:set-desktop-source", id),
    listEncoders:   () => ipcRenderer.invoke("video:list-encoders"),
    startStream:    (dest) => ipcRenderer.invoke("video:start-stream", dest),
    stopStream:     (sinkId) => ipcRenderer.invoke("video:stop-stream", sinkId),
    startRecording: (opts) => ipcRenderer.invoke("video:start-recording", opts),
    stopRecording:  () => ipcRenderer.invoke("video:stop-recording"),
    pushChunk:      (uint8) => ipcRenderer.invoke("video:chunk", uint8),
    getStatus:      () => ipcRenderer.invoke("video:get-status"),
  },
  // ── GPIO hardware I/O ───────────────────────────────────────
  gpio: {
    listDevices:    ()             => ipcRenderer.invoke("gpio:list-devices"),
    addDevice:      (d)            => ipcRenderer.invoke("gpio:add-device", d),
    updateDevice:   (id, d)        => ipcRenderer.invoke("gpio:update-device", id, d),
    deleteDevice:   (id)           => ipcRenderer.invoke("gpio:delete-device", id),
    connect:        (id)           => ipcRenderer.invoke("gpio:connect", id),
    disconnect:     (id)           => ipcRenderer.invoke("gpio:disconnect", id),
    listMappings:   (deviceId)     => ipcRenderer.invoke("gpio:list-mappings", deviceId),
    addMapping:     (m)            => ipcRenderer.invoke("gpio:add-mapping", m),
    updateMapping:  (id, m)        => ipcRenderer.invoke("gpio:update-mapping", id, m),
    deleteMapping:  (id)           => ipcRenderer.invoke("gpio:delete-mapping", id),
    sendGpo:        (devId, pin, state) => ipcRenderer.invoke("gpio:send-gpo", devId, pin, state),
    getStatus:      ()             => ipcRenderer.invoke("gpio:get-status"),
  },
  // ── Site replication ────────────────────────────────────────
  repl: {
    getConfig:   ()           => ipcRenderer.invoke("repl:get-config"),
    addPeer:     (p)          => ipcRenderer.invoke("repl:add-peer", p),
    removePeer:  (id)         => ipcRenderer.invoke("repl:remove-peer", id),
    updatePeer:  (id, d)      => ipcRenderer.invoke("repl:update-peer", id, d),
    syncNow:     (peerId)     => ipcRenderer.invoke("repl:sync-now", peerId),
    startAuto:   (min)        => ipcRenderer.invoke("repl:start-auto", min),
    stopAuto:    ()           => ipcRenderer.invoke("repl:stop-auto"),
    getSiteId:   ()           => ipcRenderer.invoke("repl:get-site-id"),
  },
  // ── User / PIN security ─────────────────────────────────────
  users: {
    hashPin:   (pin) => ipcRenderer.invoke("user:hash-pin", pin),
    verifyPin: (pin, stored) => ipcRenderer.invoke("user:verify-pin", pin, stored),
  },
  // ── Multi-station management (operator tier) ───────────────
  stations: {
    list:      ()         => ipcRenderer.invoke("stations:list"),
    getActive: ()         => ipcRenderer.invoke("stations:get-active"),
    switch:    (id)       => ipcRenderer.invoke("stations:switch", id),
    create:    (data)     => ipcRenderer.invoke("stations:create", data),
    update:    (id, data) => ipcRenderer.invoke("stations:update", id, data),
    delete:    (id)       => ipcRenderer.invoke("stations:delete", id),
  },
  // ── Typed sync handlers — opt-in per migrated table (Phase 3.5+) ───────
  stationProgramming: handlers.stationProgramming,
  stationConfigKv:    handlers.stationConfigKv,
  installConfigKv:    handlers.installConfigKv,
  operators:          handlers.operators,
  pinnedSongs:        handlers.pinnedSongs,
  playLog:            handlers.playLog,
  scheduledLog:       handlers.scheduledLog,
  songs:              handlers.songs,
  // ── Cloud DR Backup (R2) ────────────────────────────────────
  cloudBackup: {
    getConfig:   ()  => ipcRenderer.invoke("cloud-backup:get-config"),
    setConfig:   (c) => ipcRenderer.invoke("cloud-backup:set-config", c),
    getR2Config: ()  => ipcRenderer.invoke("cloud-backup:get-r2-config"),
    setR2Config: (c) => ipcRenderer.invoke("cloud-backup:set-r2-config", c),
    runNow:      ()  => ipcRenderer.invoke("cloud-backup:run-now"),
    getHistory:  ()  => ipcRenderer.invoke("cloud-backup:get-history"),
  },
  // ── Live stream status (push events + snapshot query) ──────
  stream: {
    onDestStatus:  (cb) => { const h = (_, v) => cb(v); ipcRenderer.on('stream:status:dest', h);   return h; },
    offDestStatus: (h)  => ipcRenderer.removeListener('stream:status:dest', h),
    onGlobal:      (cb) => { const h = (_, v) => cb(v); ipcRenderer.on('stream:status:global', h); return h; },
    offGlobal:     (h)  => ipcRenderer.removeListener('stream:status:global', h),
    getAllStatus:   ()   => ipcRenderer.invoke('stream:get-all-status'),
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

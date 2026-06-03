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
    embeddedArt: (fp) => ipcRenderer.invoke("audio:embeddedArt", fp),
    // Broadcast (profanity) delay + dump.
    setBroadcastDelay: (seconds, stationId) => ipcRenderer.invoke("audio:setBroadcastDelay", seconds, stationId),
    dump: (stationId) => ipcRenderer.invoke("audio:dump", stationId),
    broadcastDelayState: (stationId) => ipcRenderer.invoke("audio:broadcastDelayState", stationId),
    watchdogSet: (a, t, stationId) => ipcRenderer.invoke("audio:watchdogSet", a, t, stationId),
    setEq: (deck, bands, stationId) => ipcRenderer.invoke("audio:setEq", deck, bands, stationId),
    listOutputDevices: () => ipcRenderer.invoke("audio:listOutputDevices"),
    setOutputDevice: (stationId, deviceName) => ipcRenderer.invoke("audio:setOutputDevice", stationId, deviceName),
    // Push-based level subscription — 30fps from main process, no polling
    onLevels:  (cb) => { const h = (_, v) => cb(v); ipcRenderer.on("audio:levels", h); return h; },
    offLevels: (h)  => ipcRenderer.removeListener("audio:levels", h),
    // Item 10 Phase 2 Step 2 — out-of-process daemon. daemonEnabled() lets the engine decide
    // whether to drive advance locally (false) or proxy the daemon (true). daemon() sends a
    // queue/automation command; onDeck/onQueue/onPlayStart subscribe to the daemon's state.
    daemonEnabled: () => ipcRenderer.invoke("audio:daemonEnabled"),
    daemon: (cmd, args) => ipcRenderer.invoke("audio:daemon", cmd, args),
    onDeck:       (cb) => { const h = (_, v) => cb(v); ipcRenderer.on("audio:daemon-deck", h); return h; },
    offDeck:      (h)  => ipcRenderer.removeListener("audio:daemon-deck", h),
    onQueue:      (cb) => { const h = (_, v) => cb(v); ipcRenderer.on("audio:daemon-queue", h); return h; },
    offQueue:     (h)  => ipcRenderer.removeListener("audio:daemon-queue", h),
    onPlayStart:  (cb) => { const h = (_, v) => cb(v); ipcRenderer.on("audio:daemon-playstart", h); return h; },
    offPlayStart: (h)  => ipcRenderer.removeListener("audio:daemon-playstart", h),
  },
  theme: {
    export: (presetId, vars, font) => ipcRenderer.invoke("theme:export", { presetId, vars, font }),
    import: ()                     => ipcRenderer.invoke("theme:import"),
  },
  station: {
    uploadLogo: () => ipcRenderer.invoke("station:uploadLogo"),
    // Public listener page config (Phase 2) — talks to ether-backend via main.
    metadata: {
      get:        (uuid)             => ipcRenderer.invoke("station:metadata:get", uuid),
      save:       (uuid, metadata)   => ipcRenderer.invoke("station:metadata:save", uuid, metadata),
      checkSlug:  (slug, uuid)       => ipcRenderer.invoke("station:metadata:check-slug", slug, uuid),
      uploadLogo: (uuid, bytes, ext) => ipcRenderer.invoke("station:metadata:upload-logo", uuid, bytes, ext),
    },
    // Embedded cover art of the on-air file → R2 public, for the listener page.
    // Returns the cached art_url (or null) — call on each now-playing push.
    nowPlayingArt: (uuid, filePath) => ipcRenderer.invoke("nowPlayingArt:ensure", uuid, filePath),
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
  // ── Library ↔ R2 sync (upload from this machine / download to this machine) ─
  // Phase B.1-B.2. subscribe-returns-unsubscribe pattern matches `sync:` below.
  // The returned function from on*Progress / on*Done is the useEffect cleanup.
  libraryR2: {
    upload:             ()    => ipcRenderer.invoke("library:sync-r2:upload"),
    uploadCancel:       ()    => ipcRenderer.invoke("library:sync-r2:upload:cancel"),
    download:           ()    => ipcRenderer.invoke("library:sync-r2:download"),
    downloadCancel:     ()    => ipcRenderer.invoke("library:sync-r2:download:cancel"),
    getDownloadState:   ()    => ipcRenderer.invoke("library:sync-r2:download:get-state"),
    onUploadProgress:   (cb)  => { const h = (_, v) => cb(v); ipcRenderer.on("library:sync-r2:upload:progress", h);   return () => ipcRenderer.removeListener("library:sync-r2:upload:progress", h); },
    onUploadDone:       (cb)  => { const h = (_, v) => cb(v); ipcRenderer.on("library:sync-r2:upload:done", h);       return () => ipcRenderer.removeListener("library:sync-r2:upload:done", h); },
    onDownloadProgress: (cb)  => { const h = (_, v) => cb(v); ipcRenderer.on("library:sync-r2:download:progress", h); return () => ipcRenderer.removeListener("library:sync-r2:download:progress", h); },
    onDownloadDone:     (cb)  => { const h = (_, v) => cb(v); ipcRenderer.on("library:sync-r2:download:done", h);     return () => ipcRenderer.removeListener("library:sync-r2:download:done", h); },
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
    readFileTail: (fp, n) => ipcRenderer.invoke("fs:readFileTail", fp, n),
    exists: (fp) => ipcRenderer.invoke("fs:exists", fp),
    readDir: (dp) => ipcRenderer.invoke("fs:readDir", dp),
    writeFile: (fp, d) => ipcRenderer.invoke("fs:writeFile", fp, d),
    mkdir: (dp) => ipcRenderer.invoke("fs:mkdir", dp),
    copyFile: (s, d) => ipcRenderer.invoke("fs:copyFile", s, d),
    logRotation: (msg) => ipcRenderer.send("log:rotation", msg),
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
    getVersion: () => ipcRenderer.invoke("system:getVersion"),
    factoryReset: () => ipcRenderer.invoke("system:factoryReset"),
  },
  autostart: {
    enable: () => ipcRenderer.invoke("autostart:enable"),
    disable: () => ipcRenderer.invoke("autostart:disable"),
    isEnabled: () => ipcRenderer.invoke("autostart:isEnabled"),
  },
  // ── High Availability (watchdog supervision) ───────────────
  // status: HA control-plane (watchdog/task/alarm). dashboard: health snapshot +
  // control-plane in one round-trip (5s panel poll). alarmStatus: alarm-only,
  // cheap (footer dot). readLog: watchdog.log tail, on-demand.
  ha: {
    status:      ()         => ipcRenderer.invoke("ha:status"),
    dashboard:   ()         => ipcRenderer.invoke("ha:dashboard"),
    alarmStatus: ()         => ipcRenderer.invoke("ha:alarmStatus"),
    readLog:     (lines)    => ipcRenderer.invoke("ha:readLog", lines),
    // Phase 4 auto-logon — each fires one UAC prompt in main via the elevated helper
    enable:      (password) => ipcRenderer.invoke("ha:enable", password),
    disable:     ()         => ipcRenderer.invoke("ha:disable"),
    repair:      (password) => ipcRenderer.invoke("ha:repair", password),
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
  // ── AI Voice Studio (TTS generation + segment library) ─────
  ai: {
    getConfig:       ()                   => ipcRenderer.invoke("ai-voice:get-config"),
    setConfig:       (cfg)                => ipcRenderer.invoke("ai-voice:set-config", cfg),
    listVoices:      (opts)               => ipcRenderer.invoke("ai-voice:list-voices", opts),
    generate:        (opts)               => ipcRenderer.invoke("ai-voice:generate", opts),
    listSegments:    (opts)               => ipcRenderer.invoke("ai-voice:list-segments", opts),
    updateSegment:   (id, patch)          => ipcRenderer.invoke("ai-voice:update-segment", { id, ...patch }),
    deleteSegment:   (id, stationId)      => ipcRenderer.invoke("ai-voice:delete-segment", { id, stationId }),
    listTemplates:   ()                   => ipcRenderer.invoke("ai-voice:list-templates"),
    saveTemplate:    (t)                  => ipcRenderer.invoke("ai-voice:save-template", t),
    deleteTemplate:  (id)                 => ipcRenderer.invoke("ai-voice:delete-template", { id }),
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
  // ── Machine identity (for /account/* endpoints + Manage Devices) ─
  identity: {
    get: () => ipcRenderer.invoke("identity:get"),
  },
  // ── Sync progress (for OnboardingFlow Screen 4) ────────────
  // Subscribe-returns-unsubscribe pattern — the return value of onProgress/
  // onInitialComplete is the cleanup function, suitable as a useEffect
  // teardown. Renderer should call getState() on mount to catch up on any
  // event that may have already fired before subscription.
  sync: {
    getState: () => ipcRenderer.invoke("sync:get-state"),
    onProgress: (cb) => {
      const h = (_, event) => cb(event);
      ipcRenderer.on("sync:progress", h);
      return () => ipcRenderer.removeListener("sync:progress", h);
    },
    onInitialComplete: (cb) => {
      const h = () => cb();
      ipcRenderer.on("sync:initial-complete", h);
      return () => ipcRenderer.removeListener("sync:initial-complete", h);
    },
  },
  // ── Typed sync handlers — all 34 namespaces wired (Phase 3.5) ──────────
  albums:                    handlers.albums,
  announcements:             handlers.announcements,
  artists:                   handlers.artists,
  cartSlots:                 handlers.cartSlots,
  categories:                handlers.categories,
  clockSlots:                handlers.clockSlots,
  clocks:                    handlers.clocks,
  deckConfigs:               handlers.deckConfigs,
  formatClocks:              handlers.formatClocks,
  generatedSchedule:         handlers.generatedSchedule,
  installConfigKv:           handlers.installConfigKv,
  linerCards:                handlers.linerCards,
  macros:                    handlers.macros,
  metadataDefinitions:       handlers.metadataDefinitions,
  metadataVocabulary:        handlers.metadataVocabulary,
  moodTags:                  handlers.moodTags,
  operatorNotes:             handlers.operatorNotes,
  operators:                 handlers.operators,
  pinnedSongs:               handlers.pinnedSongs,
  playLog:                   handlers.playLog,
  prepNotes:                 handlers.prepNotes,
  publishedEpisodes:         handlers.publishedEpisodes,
  rtmpDestinations:          handlers.rtmpDestinations,
  scheduledLog: {
    ...handlers.scheduledLog,
    getByDate:   (stationId, logDate)        => ipcRenderer.invoke('scheduled_log:get-by-date',   stationId, logDate),
    batchInsert: (stationId, rows)           => ipcRenderer.invoke('scheduled_log:batch-insert',  stationId, rows),
    clearByDate: (stationId, logDate)        => ipcRenderer.invoke('scheduled_log:clear-by-date', stationId, logDate),
    clearByHour:          (stationId, logDate, hour) => ipcRenderer.invoke('scheduled_log:clear-by-hour',          stationId, logDate, hour),
    batchUpdatePosition:  (items)                    => ipcRenderer.invoke('scheduled_log:batch-update-position', items),
  },
  separationRules:           handlers.separationRules,
  shows:                     handlers.shows,
  smartScheduleRules:        handlers.smartScheduleRules,
  songMetadataValues:        handlers.songMetadataValues,
  songs: {
    ...handlers.songs,
    // Local-only file_path setter (Phase B.3) — bypasses the mutation log.
    // See electron/main.js handler comment for why this isn't via songs:update.
    setLocalFilePath: (id, fp) => ipcRenderer.invoke("songs:set-local-file-path", id, fp),
  },
  spots:                     handlers.spots,
  stationConfigKv:           handlers.stationConfigKv,
  stationProgramming:        handlers.stationProgramming,
  stationProgrammingMoods:   handlers.stationProgrammingMoods,
  voiceTracks:               handlers.voiceTracks,
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

// electron/main.js
// Ether Electron main process
// Replaces src-tauri entirely — Chromium rendering, Node.js backend, NAPI audio

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, safeStorage } = require("electron");

// ── Sentry (main process) ─────────────────────────────────────
try {
  const Sentry = require("@sentry/electron/main");
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    enabled: app.isPackaged,
    release: "ether@" + app.getVersion(),
    tracesSampleRate: 0.1,
  });
} catch (e) {
  console.log("[SENTRY] Not initialized:", e.message);
}
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// ── Load .env (API keys etc.) ─────────────────────────────────
try { require("dotenv").config(); } catch (e) { /* dotenv optional */ }

// ── Fix DPI scaling on Windows ────────────────────────────────
app.commandLine.appendSwitch("high-dpi-support", "1");
app.commandLine.appendSwitch("force-device-scale-factor", "1");

// ── Environment ───────────────────────────────────────────────
const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
const VITE_DEV_URL = "http://127.0.0.1:1420";

// ── Load native audio addon ───────────────────────────────────
let audio;
try {
  audio = require("../native/ether-audio.node");
  audio.initAudioEngine();
  console.log("[AUDIO] Native engine initialized");
} catch (e) {
  console.error("[AUDIO] Failed to load native addon:", e.message);
  // Fallback stub so app doesn't crash during development
  audio = {
    initAudioEngine: () => true,
    audioLoad: () => true,
    audioPlay: () => true,
    audioPause: () => true,
    audioStop: () => true,
    audioSetVolume: () => true,
    audioGetState: () => JSON.stringify({ deckA: {}, deckB: {}, deckC: {} }),
    audioGetLevels: () => JSON.stringify({ a: 0, b: 0, c: 0 }),
    getFileDuration: () => 0,
    getLocalIp: () => "localhost",
    analyzeFile: () => -14,
    openUrl: () => true,
    openSoundSettings: () => true,
    watchdogSet: () => true,
  };
}

// ── Database ──────────────────────────────────────────────────
let db;

function getDbPath() {
  // Use same path as Tauri so existing databases are found
  const appData = app.getPath("appData");
  const etherDir = path.join(appData, "com.ether.radio");
  require("fs").mkdirSync(etherDir, { recursive: true });
  return path.join(etherDir, "openair.db");
}

function initDb() {
  console.log("[DB] Path:", getDbPath());
  // temp: log song count on startup
  setTimeout(() => { try { console.log("[DB] Song count:", db.prepare("SELECT COUNT(*) as c FROM songs").get()); } catch(e) { console.log("[DB] Song count error:", e.message); } }, 2000);
  const dbPath = getDbPath();
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  console.log("[DB] Connected:", dbPath);
}

// ── Window ────────────────────────────────────────────────────
let mainWindow;
let tray;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "Ether",
    icon: path.join(__dirname, "../src-tauri/icons/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // Allow localhost in dev
    },
    show: false,
  });

  // Allow localhost connections
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": ["default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"]
      }
    });
  });

  // Load app with retry for dev server
  if (isDev) {
    const tryLoad = () => {
      const net = require("net");
      const client = new net.Socket();
      client.setTimeout(1000);
      client.connect(1420, "127.0.0.1", () => {
        client.destroy();
        mainWindow.loadURL(VITE_DEV_URL);
        mainWindow.webContents.openDevTools();
      });
      client.on("error", () => {
        client.destroy();
        console.log("[ELECTRON] Vite not ready, retrying in 1s...");
        setTimeout(tryLoad, 1000);
      });
      client.on("timeout", () => {
        client.destroy();
        setTimeout(tryLoad, 1000);
      });
    };
    setTimeout(tryLoad, 500);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Hide instead of close (keeps app in tray)
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Grant mic permission automatically — no dialog needed
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "media" || permission === "microphone" || permission === "audioCapture") {
      callback(true); // Always grant
    } else {
      callback(true);
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, "../src-tauri/icons/icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  const menu = Menu.buildFromTemplate([
    { label: "Show Ether", click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip("Ether — On Air");
  tray.on("click", () => {
    if (mainWindow.isVisible()) { mainWindow.hide(); }
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

// ── App lifecycle ─────────────────────────────────────────────
function buildMenu() {
  const send = (cmd) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (win) win.webContents.send("menu-action", cmd);
  };
  const template = [
    { label: "File", submenu: [
      { label: "New Session", accelerator: "CmdOrCtrl+N", click: () => send("file:new-session") },
      { label: "Save Layout", accelerator: "CmdOrCtrl+S", click: () => send("file:save") },
      { type: "separator" },
      { label: "Import Music...", click: () => send("file:import") },
      { label: "Preferences", click: () => send("file:preferences") },
      { type: "separator" },
      { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => { app.isQuitting = true; app.quit(); } },
    ]},
    { label: "View", submenu: [
      { label: "Play Queue", click: () => send("view:queue") },
      { label: "Deck A", click: () => send("view:deckA") },
      { label: "Deck B", click: () => send("view:deckB") },
      { label: "Deck C", click: () => send("view:deckC") },
      { label: "Mic Deck", click: () => send("view:mic") },
      { type: "separator" },
      { label: "Configure Decks...", click: () => send("view:configure-decks") },
      { label: "Reset to Default", click: () => send("view:reset") },
      { type: "separator" },
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => mainWindow?.webContents.reload() },
      { label: "Toggle DevTools", accelerator: "F12", click: () => mainWindow?.webContents.toggleDevTools() },
    ]},
    { label: "Library", submenu: [
      { label: "Song Library", click: () => send("nav:library") },
      { label: "Spots & Promos", click: () => send("nav:spots") },
      { label: "Voice Tracker", click: () => send("nav:voicetrack") },
      { type: "separator" },
      { label: "Import from Folder...", click: () => send("file:import") },
      { label: "Cue Editor", click: () => send("nav:trackedit") },
    ]},
    { label: "Schedule", submenu: [
      { label: "Format Clocks", click: () => send("nav:clocks") },
      { label: "Program Log", click: () => send("nav:programlog") },
      { label: "Play Log", click: () => send("nav:logs") },
    ]},
    { label: "Tools", submenu: [
      { label: "Voice Tracker", click: () => send("nav:voicetrack") },
      { label: "Studio Editor", click: () => send("nav:studio") },
      { label: "Cue Editor", click: () => send("nav:trackedit") },
      { type: "separator" },
      { label: "Stream Manager", click: () => send("nav:streaming") },
      { label: "Smart Scheduler", click: () => send("nav:smartschedule") },
      { label: "Listener Analytics", click: () => send("nav:analytics") },
      { label: "Audio Routing", click: () => send("nav:multioutput") },
      { label: "Station Manager", click: () => send("nav:stationmanager") },
      { type: "separator" },
      { label: "System Health", click: () => send("nav:health") },
    ]},
    { label: "Help", submenu: [
      { label: "Keyboard Shortcuts", click: () => send("help:shortcuts") },
      { label: "Documentation", click: () => shell.openExternal("https://github.com/jwjens/ether") },
      { type: "separator" },
      { label: "Check for Updates", click: () => send("help:check-updates") },
      { label: "About Ether", click: () => send("nav:about") },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  initDb();
  createWindow();
  createTray();
  buildMenu();
});

app.on("window-all-closed", () => {
  // Keep running on Windows/Linux (app lives in tray)
  if (process.platform === "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow.show();
});

app.on("before-quit", () => {
  app.isQuitting = true;
});

// ── IPC Handlers ──────────────────────────────────────────────
// These replace all Tauri invoke() calls

// Audio
ipcMain.handle("audio:load", (_, deck, filePath, title, artist, gainDb) =>
  audio.audioLoad(deck, filePath, title, artist, gainDb ?? 0));

ipcMain.handle("audio:play", (_, deck) => audio.audioPlay(deck));
ipcMain.handle("audio:pause", (_, deck) => audio.audioPause(deck));
ipcMain.handle("audio:stop", (_, deck) => audio.audioStop(deck));
ipcMain.handle("audio:setVolume", (_, deck, volume) => audio.audioSetVolume(deck, volume));
ipcMain.handle("audio:getState", () => JSON.parse(audio.audioGetState()));
ipcMain.handle("audio:getLevels", () => JSON.parse(audio.audioGetLevels()));
ipcMain.handle("audio:getFileDuration", (_, filePath) => audio.getFileDuration(filePath));
ipcMain.handle("audio:watchdogSet", (_, active, thresholdSec) => audio.watchdogSet(active, thresholdSec));

// Database
ipcMain.handle("db:query", (_, sql, params) => {
  try {
    const stmt = db.prepare(sql);
    return { data: stmt.all(...(params || [])), error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
});

ipcMain.handle("db:execute", (_, sql, params) => {
  try {
    // Drop and recreate FTS triggers around deletes to avoid contentless table errors
    if (sql.trim().toUpperCase().startsWith("DELETE FROM SONGS")) {
      db.exec("DROP TRIGGER IF EXISTS trg_songs_fts_delete");
      const stmt = db.prepare(sql);
      const result = stmt.run(...(params || []));
      db.exec(`CREATE TRIGGER IF NOT EXISTS trg_songs_fts_delete
        AFTER DELETE ON songs BEGIN
          DELETE FROM songs_fts WHERE rowid = OLD.id;
        END`);
      return { data: result, error: null };
    }
    const stmt = db.prepare(sql);
    const result = stmt.run(...(params || []));
    return { data: result, error: null };
  } catch (e) {
    console.error("[DB execute error]", sql.slice(0, 100), e.message);
    return { data: null, error: e.message };
  }
});

// File system
ipcMain.handle("fs:readFile", async (_, filePath) => {
  try {
    const fd = fs.openSync(filePath, "r");
    const size = Math.min(fs.fstatSync(fd).size, 256 * 1024);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    fs.closeSync(fd);
    return { data: Array.from(buf), error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
});

ipcMain.handle("fs:exists", (_, filePath) => fs.existsSync(filePath));

ipcMain.handle("fs:readDir", (_, dirPath) => {
  try {
    return fs.readdirSync(dirPath).map(name => ({
      name,
      path: path.join(dirPath, name),
      isDir: fs.statSync(path.join(dirPath, name)).isDirectory(),
    }));
  } catch { return []; }
});

// Dialog
ipcMain.handle("dialog:openFile", async (_, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", ...(options?.multiple ? ["multiSelections"] : [])],
    filters: options?.filters || [{ name: "Audio", extensions: ["mp3", "flac", "wav", "aac", "m4a", "ogg"] }],
  });
  return result.canceled ? null : result.filePaths;
});

ipcMain.handle("dialog:openDirectory", async () => {
  console.log("[DIALOG] openDirectory called");
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:saveFile", async (_, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options || {});
  return result.canceled ? null : result.filePath;
});

// System
ipcMain.handle("system:getLocalIp", () => audio.getLocalIp());
ipcMain.handle("system:openUrl", (_, url) => shell.openExternal(url));
ipcMain.handle("system:openSoundSettings", () => audio.openSoundSettings());
ipcMain.handle("system:getAppDataDir", () => app.getPath("userData"));
ipcMain.handle("system:getPlatform", () => process.platform);

// Backup
ipcMain.handle("db:backup", () => {
  try {
    const dbPath = getDbPath();
    const backupDir = path.join(app.getPath("userData"), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = Math.floor(Date.now() / 1000);
    const backupName = `openair-backup-${timestamp}.db`;
    const backupPath = path.join(backupDir, backupName);
    fs.copyFileSync(dbPath, backupPath);
    // Delete backups older than 7 days
    const cutoff = timestamp - 7 * 24 * 3600;
    fs.readdirSync(backupDir).forEach(name => {
      const match = name.match(/openair-backup-(\d+)\.db/);
      if (match && parseInt(match[1]) < cutoff) {
        fs.unlinkSync(path.join(backupDir, name));
      }
    });
    return { data: backupPath, error: null };
  } catch (e) { return { data: null, error: e.message }; }
});

ipcMain.handle("db:listBackups", () => {
  try {
    const backupDir = path.join(app.getPath("userData"), "backups");
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir)
      .filter(n => n.startsWith("openair-backup-"))
      .sort().reverse();
  } catch { return []; }
});

ipcMain.handle("db:restore", (_, backupName) => {
  try {
    const backupPath = path.join(app.getPath("userData"), "backups", backupName);
    const dbPath = getDbPath();
    if (!fs.existsSync(backupPath)) return { error: "Backup not found" };
    // Close DB before restore
    db.close();
    fs.copyFileSync(backupPath, dbPath);
    initDb(); // Reopen
    return { data: "Restored successfully", error: null };
  } catch (e) { return { data: null, error: e.message }; }
});

// Autostart
ipcMain.handle("autostart:enable", () => app.setLoginItemSettings({ openAtLogin: true }));
ipcMain.handle("autostart:disable", () => app.setLoginItemSettings({ openAtLogin: false }));
ipcMain.handle("autostart:isEnabled", () => app.getLoginItemSettings().openAtLogin);

// ── Generic invoke aliases (old Tauri command names) ─────────

ipcMain.handle("watchdog_set", (_, args) => {
  const { active, thresholdSec } = args || {};
  return audio.watchdogSet(active ?? false, thresholdSec ?? 30);
});

// -- Streaming stubs (Icecast client to be implemented) -------
let streamActive = false;
let streamStartTime = 0;

ipcMain.handle("stream_status", () => streamActive);

ipcMain.handle("stream_health", () => ({
  status: streamActive ? "live" : "disconnected",
  uptimeSecs: streamActive ? Math.floor((Date.now() - streamStartTime) / 1000) : 0,
  dropCount: 0,
  bufferSecs: 0,
}));

ipcMain.handle("stream_start", async (_, args) => {
  console.log("[STREAM] Start requested:", args?.config);
  streamActive = true;
  streamStartTime = Date.now();
  return true;
});

ipcMain.handle("stream_update_metadata", (_, args) => {
  console.log("[STREAM] Metadata:", args?.title, "-", args?.artist);
  return true;
});

ipcMain.handle("stream_start_if_configured", async () => {
  try { return audio.streamStart ? audio.streamStart() : true; } catch { return true; }
});

ipcMain.handle("stream_stop", async () => {
  try { return audio.streamStop ? audio.streamStop() : true; } catch { return true; }
});

ipcMain.handle("analyze_lufs", (_, args) => {
  const filePath = args?.filePath ?? args;
  try { return audio.analyzeFile(filePath); } catch { return -14; }
});

ipcMain.handle("open_url", (_, args) => {
  const url = args?.url ?? args;
  return shell.openExternal(url);
});

ipcMain.handle("open_desk_window", async () => {
  const existing = BrowserWindow.getAllWindows().find(w => w.getTitle().includes("Producer Desk"));
  if (existing) { existing.show(); existing.focus(); return; }
  const { screen } = require("electron");
  const desk = new BrowserWindow({
    width: 900, height: 620, minWidth: 600, minHeight: 400,
    title: "Ether — Producer Desk",
    x: Math.round(screen.getPrimaryDisplay().workAreaSize.width * 0.55),
    y: 80,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  if (isDev) desk.loadURL(VITE_DEV_URL + "#desk");
  else desk.loadFile(path.join(__dirname, "../dist/index.html"), { hash: "desk" });
});

// ── Event relay: ether.emit() in renderer → broadcast to all windows ──
// Relay now-playing-request to main window so it responds with current state
ipcMain.on("now-playing-request", (event) => {
  const sender = event.sender;
  BrowserWindow.getAllWindows().forEach(w => {
    if (w.webContents.id !== sender.id) {
      w.webContents.send("now-playing-request", {});
    }
  });
});

ipcMain.on("now-playing-update", (_, payload) => {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send("now-playing-update", payload));
});
ipcMain.handle("set_now_playing", (_, args) => {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send("now-playing-update", args));
  return true;
});

ipcMain.on("desk-send-to-queue", (_, payload) => {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send("desk-send-to-queue", payload));
});

// ── Relaunch ──────────────────────────────────────────────────
ipcMain.handle("relaunch", () => { app.relaunch(); app.exit(0); });

ipcMain.handle("open_nowplaying_window", async () => {
  const existing = BrowserWindow.getAllWindows().find(w => w.getTitle().includes("Now Playing"));
  if (existing) { existing.show(); existing.focus(); return; }
  const { screen } = require("electron");
  const np = new BrowserWindow({
    width: 1280, height: 720,
    minWidth: 1280, minHeight: 720,
    title: "Ether - Now Playing",
    resizable: false,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  if (isDev) np.loadURL(VITE_DEV_URL + "#nowplaying");
  else np.loadFile(path.join(__dirname, "../dist/index.html"), { hash: "nowplaying" });
});

// ── Auto-updater ──────────────────────────────────────────────
let autoUpdater = null;
try {
  const { autoUpdater: au } = require("electron-updater");
  autoUpdater = au;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
} catch (e) {
  console.log("[UPDATER] electron-updater not available:", e.message);
}

ipcMain.handle("updater:check", async () => {
  if (!autoUpdater) return { available: false };
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result?.updateInfo) return { available: false };
    const current = app.getVersion();
    const latest = result.updateInfo.version;
    return {
      available: latest !== current,
      version: latest,
      notes: result.updateInfo.releaseNotes ?? null,
      date: result.updateInfo.releaseDate ?? null,
    };
  } catch { return { available: false }; }
});

ipcMain.handle("updater:download", async () => {
  if (!autoUpdater) return;
  autoUpdater.on("download-progress", (progress) => {
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send("updater:progress", progress));
  });
  await autoUpdater.downloadUpdate();
});

ipcMain.handle("updater:install", () => {
  if (!autoUpdater) { app.relaunch(); app.exit(0); return; }
  autoUpdater.quitAndInstall();
});

// ── AI key storage (safeStorage) ─────────────────────────────
function getAiConfigPath() {
  return path.join(app.getPath("userData"), "ai-config.json");
}
function readAiConfig() {
  try { return JSON.parse(fs.readFileSync(getAiConfigPath(), "utf8")); }
  catch { return { provider: "anthropic", keys: {} }; }
}
function writeAiConfig(cfg) {
  fs.writeFileSync(getAiConfigPath(), JSON.stringify(cfg, null, 2));
}
function encryptKey(key) {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(key).toString("base64");
  }
  return Buffer.from(key).toString("base64") + ":plain";
}
function decryptKey(stored) {
  if (!stored) return null;
  if (stored.endsWith(":plain")) {
    return Buffer.from(stored.slice(0, -6), "base64").toString("utf8");
  }
  try { return safeStorage.decryptString(Buffer.from(stored, "base64")); }
  catch { return null; }
}

ipcMain.handle("ai:setKey", (_, { provider, key }) => {
  const cfg = readAiConfig();
  if (!cfg.keys) cfg.keys = {};
  if (key) cfg.keys[provider] = encryptKey(key);
  else delete cfg.keys[provider];
  writeAiConfig(cfg);
  return true;
});

ipcMain.handle("ai:getKeyStatus", () => {
  const cfg = readAiConfig();
  return {
    anthropic: !!(cfg.keys?.anthropic),
    openai:    !!(cfg.keys?.openai),
    google:    !!(cfg.keys?.google),
    weather:   !!(cfg.keys?.weather) || !!(process.env.OPENWEATHERMAP_API_KEY),
  };
});

ipcMain.handle("ai:setProvider", (_, provider) => {
  const cfg = readAiConfig();
  cfg.provider = provider;
  writeAiConfig(cfg);
  return true;
});

ipcMain.handle("ai:getProvider", () => readAiConfig().provider || "anthropic");

// ── AI assistant — multi-provider ─────────────────────────────
ipcMain.handle("ai:ask", async (_, messages) => {
  const cfg = readAiConfig();
  const provider = cfg.provider || "anthropic";
  let apiKey = decryptKey(cfg.keys?.[provider]);
  if (!apiKey && provider === "anthropic") apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "__NO_KEY__";

  const system = "You are a show producer AI assistant for a live radio/podcast broadcast. Be concise, practical, and creative. Keep responses short and scannable — use bullet points when listing ideas.";

  try {
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: messages.map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) return `API error ${res.status}: ${data.error?.message || JSON.stringify(data)}`;
      return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim() || "No response.";

    } else if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 1000,
          messages: [{ role: "system", content: system }, ...messages.map(m => ({ role: m.role, content: m.content }))],
        }),
      });
      const data = await res.json();
      if (!res.ok) return `API error ${res.status}: ${data.error?.message || JSON.stringify(data)}`;
      return data.choices?.[0]?.message?.content?.trim() || "No response.";

    } else if (provider === "google") {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: 1000 },
        }),
      });
      const data = await res.json();
      if (!res.ok) return `API error ${res.status}: ${data.error?.message || JSON.stringify(data)}`;
      return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "No response.";
    }
    return "Unknown provider.";
  } catch (e) {
    return `Request failed: ${e.message}`;
  }
});

// ── Weather — OpenWeatherMap (Las Vegas) ──────────────────────
ipcMain.handle("weather:getLasVegas", async () => {
  const cfg = readAiConfig();
  const apiKey = decryptKey(cfg.keys?.weather) || process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Las+Vegas,US&appid=${apiKey}&units=imperial`);
    const data = await res.json();
    if (!res.ok) return null;
    return {
      temp:        Math.round(data.main.temp),
      feels_like:  Math.round(data.main.feels_like),
      description: data.weather?.[0]?.description || "",
      humidity:    data.main.humidity,
      wind_speed:  Math.round(data.wind?.speed || 0),
    };
  } catch { return null; }
});

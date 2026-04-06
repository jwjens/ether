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

// ── App identity ──────────────────────────────────────────────
app.setAppUserModelId("ether");

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
  const dbPath = getDbPath();
  console.log("[DB] Path:", dbPath);
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  console.log("[DB] Connected:", dbPath);
  runMigrations();
  setTimeout(() => { try { console.log("[DB] Song count:", db.prepare("SELECT COUNT(*) as c FROM songs").get()); } catch(e) { console.log("[DB] Song count error:", e.message); } }, 500);
}

function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

    CREATE TABLE IF NOT EXISTS artists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_name TEXT,
      gender TEXT DEFAULT 'unknown',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist_id INTEGER REFERENCES artists(id),
      year INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      color TEXT,
      spins_per_hour INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      file_path TEXT,
      artist_id INTEGER REFERENCES artists(id),
      album_id INTEGER REFERENCES albums(id),
      category_id INTEGER REFERENCES categories(id),
      genre TEXT,
      duration_ms INTEGER,
      bpm REAL,
      energy REAL,
      mood TEXT,
      gender TEXT DEFAULT 'unknown',
      rotation_status TEXT DEFAULT 'active',
      daypart_mask INTEGER DEFAULT 16777215,
      no_repeat_hours INTEGER DEFAULT 2,
      lufs_measured REAL,
      peak_db REAL,
      gain_db REAL DEFAULT 0,
      is_processed INTEGER DEFAULT 0,
      cue_in INTEGER,
      cue_out INTEGER,
      cue_in_ms INTEGER,
      cue_out_ms INTEGER,
      intro_end INTEGER,
      outro_start INTEGER,
      intro_end_ms INTEGER,
      outro_start_ms INTEGER,
      intro_version_path TEXT,
      has_intro INTEGER DEFAULT 0,
      last_played_at INTEGER,
      play_count INTEGER DEFAULT 0,
      is_explicit INTEGER DEFAULT 0,
      raw_metadata TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS separation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type TEXT NOT NULL,
      scope TEXT DEFAULT 'global',
      value INTEGER NOT NULL DEFAULT 0,
      is_hard INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS clocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      show_id INTEGER,
      description TEXT,
      color TEXT
    );

    CREATE TABLE IF NOT EXISTS clock_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clock_id INTEGER NOT NULL REFERENCES clocks(id),
      position INTEGER NOT NULL DEFAULT 0,
      slot_type TEXT NOT NULL DEFAULT 'music',
      category_id INTEGER REFERENCES categories(id),
      label TEXT,
      duration_min INTEGER DEFAULT 4
    );

    CREATE TABLE IF NOT EXISTS shows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_hour INTEGER DEFAULT 0,
      end_hour INTEGER DEFAULT 1,
      days TEXT DEFAULT '0123456',
      color TEXT,
      description TEXT,
      is_active INTEGER DEFAULT 1,
      clock_id INTEGER REFERENCES clocks(id)
    );

    CREATE TABLE IF NOT EXISTS play_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist TEXT,
      deck TEXT,
      deck_id TEXT,
      duration_ms INTEGER,
      session_id TEXT,
      played_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS scheduled_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_date TEXT,
      hour INTEGER,
      position INTEGER,
      song_id INTEGER REFERENCES songs(id),
      title TEXT,
      artist TEXT,
      category_id INTEGER,
      duration_ms INTEGER,
      clock_id INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS spots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      file_path TEXT,
      spot_type TEXT DEFAULT 'promo',
      advertiser TEXT,
      start_date TEXT,
      end_date TEXT,
      max_plays_day INTEGER,
      play_count INTEGER DEFAULT 0,
      last_played_at INTEGER,
      is_active INTEGER DEFAULT 1,
      notes TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS cart_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_number INTEGER UNIQUE,
      title TEXT,
      file_path TEXT,
      color TEXT DEFAULT '#3b82f6',
      hotkey TEXT
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      file_path TEXT,
      trigger_time TEXT,
      days TEXT DEFAULT '0123456',
      duck_music INTEGER DEFAULT 1,
      resume_music INTEGER DEFAULT 1,
      duck_level REAL DEFAULT 0.2,
      is_active INTEGER DEFAULT 1,
      last_played_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS voice_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      file_path TEXT,
      show_id INTEGER REFERENCES shows(id),
      clock_slot_id INTEGER REFERENCES clock_slots(id),
      duration_ms INTEGER,
      recorded_by TEXT,
      recorded_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS station_config_kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS smart_schedule_rules (
      id TEXT PRIMARY KEY,
      description TEXT,
      days TEXT,
      start_hour INTEGER,
      end_hour INTEGER,
      energy_level TEXT,
      bpm_min INTEGER,
      bpm_max INTEGER,
      genre TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS stream_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      host TEXT,
      port INTEGER,
      mount TEXT,
      username TEXT,
      password TEXT,
      format TEXT DEFAULT 'mp3',
      bitrate INTEGER DEFAULT 128,
      is_active INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS stations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      callsign TEXT,
      frequency TEXT,
      city TEXT,
      state TEXT,
      country TEXT DEFAULT 'US',
      website TEXT,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS liner_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT DEFAULT 'Custom',
      color TEXT DEFAULT '#94a3b8',
      pinned INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS prep_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      show_date TEXT DEFAULT '',
      category TEXT DEFAULT 'Script',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS published_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      file_path TEXT,
      show_id INTEGER,
      published_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS format_clocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slots TEXT DEFAULT '[]',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS crash_recovery (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data TEXT,
      saved_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS rtmp_destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      stream_key TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1
    );
  `);

  // Seed default separation rules if empty
  const ruleCount = db.prepare("SELECT COUNT(*) as c FROM separation_rules").get();
  if (ruleCount.c === 0) {
    db.exec(`
      INSERT INTO separation_rules (rule_type, scope, value, is_hard, is_active, description) VALUES
        ('artist_separation_min', 'global', 60, 1, 1, 'Minimum minutes between songs by the same artist'),
        ('song_separation_min',   'global', 180, 1, 1, 'Minimum minutes before a song can repeat'),
        ('title_separation_min',  'global', 120, 1, 1, 'Minimum minutes between songs with the same title'),
        ('max_same_gender',       'global', 3,   0, 1, 'Max consecutive songs of the same gender'),
        ('max_same_category',     'global', 3,   0, 1, 'Max consecutive songs from the same category');
    `);
    console.log("[DB] Seeded default separation rules");
  }

  // Add any missing columns via ALTER TABLE (safe to re-run)
  const alterSafe = (sql) => { try { db.exec(sql); } catch(e) { /* column already exists */ } };
  alterSafe("ALTER TABLE songs ADD COLUMN is_explicit INTEGER DEFAULT 0");
  alterSafe("ALTER TABLE songs ADD COLUMN raw_metadata TEXT");
  // Fix songs that got the wrong daypart_mask default (127 = only hours 0-6)
  db.exec("UPDATE songs SET daypart_mask = 16777215 WHERE daypart_mask = 127");
  alterSafe("ALTER TABLE songs ADD COLUMN daypart_mask INTEGER DEFAULT 127");
  alterSafe("ALTER TABLE songs ADD COLUMN no_repeat_hours INTEGER DEFAULT 2");
  alterSafe("ALTER TABLE songs ADD COLUMN rotation_status TEXT DEFAULT 'active'");
  alterSafe("ALTER TABLE songs ADD COLUMN intro_version_path TEXT");
  alterSafe("ALTER TABLE songs ADD COLUMN has_intro INTEGER DEFAULT 0");
  alterSafe("ALTER TABLE clocks ADD COLUMN show_id INTEGER");
  alterSafe("ALTER TABLE clocks ADD COLUMN description TEXT");
  alterSafe("ALTER TABLE clocks ADD COLUMN color TEXT");
  alterSafe("ALTER TABLE shows ADD COLUMN clock_id INTEGER REFERENCES clocks(id)");
  alterSafe("ALTER TABLE play_log ADD COLUMN deck_id TEXT");
  alterSafe("ALTER TABLE play_log ADD COLUMN session_id TEXT");
  alterSafe("ALTER TABLE artists ADD COLUMN gender TEXT DEFAULT 'unknown'");

  // FTS index for song search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(title, artist, content='songs', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS trg_songs_fts_insert AFTER INSERT ON songs BEGIN
      INSERT INTO songs_fts(rowid, title, artist) SELECT NEW.id, NEW.title, a.name FROM artists a WHERE a.id = NEW.artist_id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_songs_fts_delete AFTER DELETE ON songs BEGIN
      DELETE FROM songs_fts WHERE rowid = OLD.id;
    END;
  `);

  console.log("[DB] Schema ready");
}

// ── Window ────────────────────────────────────────────────────
let mainWindow;
let splashWindow;
let tray;

const ICON_PNG   = path.join(__dirname, "assets/icon.png");
const TRAY_PNG   = path.join(__dirname, "assets/tray-icon.png");

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 340,
    height: 340,
    frame: false,
    transparent: false,
    backgroundColor: "#0e0e14",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  const svgIcon = fs.readFileSync(path.join(__dirname, "assets/icon.svg"), "utf8");
  const html = `<!DOCTYPE html><html><head><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    html,body{width:340px;height:340px;background:#0e0e14;display:flex;align-items:center;justify-content:center;overflow:hidden;}
    .logo{width:180px;height:180px;opacity:0;animation:fadeIn 0.6s ease forwards;}
    @keyframes fadeIn{to{opacity:1;}}
  </style></head><body>
    <div class="logo">${svgIcon}</div>
  </body></html>`;

  splashWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  splashWindow.center();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "ether",
    icon: ICON_PNG,
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
    // Fade out splash then show main window
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.executeJavaScript("document.body.style.transition='opacity 0.35s';document.body.style.opacity='0';");
      setTimeout(() => {
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
        splashWindow = null;
        mainWindow.show();
        mainWindow.focus();
      }, 370);
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
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
  const icon = nativeImage.createFromPath(TRAY_PNG).resize({ width: 32, height: 32 });
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
      { label: "Video Studio",  click: () => send("nav:videostudio") },
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
  createSplash();
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

// ── Studio — WebSocket signaling server ──────────────────────
// Serves guest-join.html on GET /join and relays WebRTC signals
// between the host (main window) and browser guests.
// Falls back silently if the `ws` package is not installed.

let _signalingServer  = null;
let _signalingClients = new Map(); // id -> { ws, role, name }
let _rtmpProcess      = null;
let _recordStream     = null;

function startSignalingServer() {
  let WsServer;
  try { WsServer = require("ws").Server; } catch {
    console.log("[STUDIO] ws package not found — signaling server disabled");
    return;
  }
  if (_signalingServer) return;

  const httpMod  = require("http");
  const crypto   = require("crypto");

  const server = httpMod.createServer((req, res) => {
    if (req.url && req.url.startsWith("/join")) {
      try {
        const html = fs.readFileSync(path.join(__dirname, "guest-join.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch {
        res.writeHead(404); res.end("Not found");
      }
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Ether Studio");
    }
  });

  const wss = new WsServer({ server });

  wss.on("connection", (ws, req) => {
    const url  = new URL(req.url, "http://localhost");
    const role = url.searchParams.get("role") || "guest";
    const id   = crypto.randomUUID();

    ws.studioId = id;
    _signalingClients.set(id, { ws, role, name: "" });

    ws.send(JSON.stringify({ type: "welcome", id }));

    // Notify main window of new guest
    if (role === "guest") {
      mainWindow?.webContents.send("studio:guest-joined", { id });
      // Also notify any other guests so they can peer-connect
      for (const [cid, c] of _signalingClients) {
        if (cid !== id && c.role === "guest") {
          c.ws.send(JSON.stringify({ type: "guest-joined", from: id }));
        }
      }
    }

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "hello") {
          const entry = _signalingClients.get(id);
          if (entry) entry.name = msg.name || "";
          return;
        }

        if (msg.type === "leave") {
          cleanup(id);
          return;
        }

        // Route the message: if toHost is true, route to main window via IPC
        if (msg.toHost) {
          mainWindow?.webContents.send("studio:signal", { ...msg, from: id });
          return;
        }

        // Route to a specific peer id
        if (msg.to) {
          const dest = _signalingClients.get(msg.to);
          if (dest) dest.ws.send(JSON.stringify({ ...msg, from: id }));
          return;
        }

        // Broadcast to host if no target
        mainWindow?.webContents.send("studio:signal", { ...msg, from: id });
      } catch {}
    });

    ws.on("close", () => cleanup(id));
    ws.on("error", () => cleanup(id));
  });

  function cleanup(id) {
    const entry = _signalingClients.get(id);
    if (!entry) return;
    _signalingClients.delete(id);
    mainWindow?.webContents.send("studio:guest-left", { id });
    // Notify remaining guests
    for (const [, c] of _signalingClients) {
      if (c.role === "guest") {
        try { c.ws.send(JSON.stringify({ type: "leave", from: id })); } catch {}
      }
    }
  }

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.warn("[STUDIO] Port 9091 already in use — signaling server skipped (another instance running?)");
    } else {
      console.error("[STUDIO] Signaling server error:", e.message);
    }
  });

  server.listen(9091, "0.0.0.0", () => {
    console.log("[STUDIO] Signaling server listening on :9091");
  });

  _signalingServer = server;
}

// Start signaling server when app is ready (called from app.whenReady)
app.whenReady().then(() => {
  startSignalingServer();
}).catch(() => {});

// Host → guest: relay a signal message from the renderer to a guest WS client
ipcMain.handle("studio:signal-to-guest", (_, { to, type, payload }) => {
  const dest = _signalingClients.get(to);
  if (dest) dest.ws.send(JSON.stringify({ type, payload, from: "host" }));
  return true;
});

ipcMain.handle("studio:getLocalIp", () => {
  try {
    const { networkInterfaces } = require("os");
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === "IPv4" && !net.internal) return net.address;
      }
    }
  } catch {}
  return "127.0.0.1";
});

ipcMain.handle("studio:getGuestCount", () => {
  let n = 0;
  for (const [, c] of _signalingClients) { if (c.role === "guest") n++; }
  return n;
});

// ── RTMP destinations ─────────────────────────────────────────
ipcMain.handle("studio:rtmp:list", () => {
  try {
    return db.prepare("SELECT * FROM rtmp_destinations WHERE is_active = 1 ORDER BY name").all();
  } catch { return []; }
});

ipcMain.handle("studio:rtmp:save", (_, { id, name, url, key }) => {
  if (id) {
    db.prepare("UPDATE rtmp_destinations SET name=?, url=?, stream_key=? WHERE id=?").run(name, url, key || "", id);
    return { id };
  } else {
    const r = db.prepare("INSERT INTO rtmp_destinations (name, url, stream_key) VALUES (?,?,?)").run(name, url, key || "");
    return { id: r.lastInsertRowid };
  }
});

ipcMain.handle("studio:rtmp:delete", (_, id) => {
  db.prepare("UPDATE rtmp_destinations SET is_active=0 WHERE id=?").run(id);
  return { ok: true };
});

// ── RTMP stream via ffmpeg ────────────────────────────────────
ipcMain.handle("studio:rtmp:start", (_, { url, key }) => {
  if (_rtmpProcess) return { ok: false, error: "Already streaming" };
  const target = (key && key.trim()) ? `${url}/${key.trim()}` : url;
  try {
    const { spawn } = require("child_process");
    _rtmpProcess = spawn("ffmpeg", [
      "-re", "-f", "webm", "-i", "pipe:0",
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
      "-c:a", "aac", "-ar", "44100", "-b:a", "128k",
      "-f", "flv", target,
    ], { stdio: ["pipe", "ignore", "pipe"] });

    _rtmpProcess.stderr.on("data", (d) => {
      console.log("[STUDIO/ffmpeg]", d.toString().slice(0, 120));
    });
    _rtmpProcess.on("error", (e) => {
      console.error("[STUDIO] ffmpeg error:", e.message);
      _rtmpProcess = null;
      mainWindow?.webContents.send("studio:rtmp:stopped", { error: e.message });
    });
    _rtmpProcess.on("exit", (code) => {
      console.log("[STUDIO] ffmpeg exit:", code);
      _rtmpProcess = null;
      mainWindow?.webContents.send("studio:rtmp:stopped", { code });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("studio:rtmp:chunk", (_, chunk) => {
  if (!_rtmpProcess) return;
  try { _rtmpProcess.stdin.write(Buffer.from(chunk)); } catch {}
});

ipcMain.handle("studio:rtmp:stop", () => {
  if (_rtmpProcess) {
    try { _rtmpProcess.stdin.end(); } catch {}
    _rtmpProcess = null;
  }
  return { ok: true };
});

// ── Local recording via MediaRecorder chunks ──────────────────
ipcMain.handle("studio:record:start", (_, filePath) => {
  try {
    _recordStream = fs.createWriteStream(filePath, { flags: "w" });
    _recordStream.on("error", (e) => console.error("[STUDIO] Record write error:", e.message));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("studio:record:chunk", (_, chunk) => {
  if (!_recordStream) return;
  try { _recordStream.write(Buffer.from(chunk)); } catch {}
});

ipcMain.handle("studio:record:stop", () => {
  if (_recordStream) { _recordStream.end(); _recordStream = null; }
  return { ok: true };
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

// ── Iris bridge ───────────────────────────────────────────────
// Lets the Iris voice assistant control OpenAir via IPC or HTTP.

let irisConnected = false;
let irisLastSeen  = 0;

function sendToAllWindows(channel, payload) {
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  });
}

function routeIrisCommand(cmd) {
  const { action, payload = {} } = cmd;
  switch (action) {
    case 'play':
      audio.audioPlay('A');
      sendToAllWindows('iris:command-received', { action, label: 'Playing deck A' });
      return { ok: true };

    case 'stop':
      audio.audioStop('A');
      sendToAllWindows('iris:command-received', { action, label: 'Stopped deck A' });
      return { ok: true };

    case 'next': {
      // Pause current deck — the auto-advance engine in the renderer handles loading next
      audio.audioPause('A');
      sendToAllWindows('iris:command-received', { action, label: 'Skip requested' });
      sendToAllWindows('iris:next-track', {});
      return { ok: true };
    }

    case 'getStatus': {
      let state = {};
      try { state = JSON.parse(audio.audioGetState()); } catch {}
      const deck = state.deckA ?? {};
      return {
        ok:     true,
        status: deck.status ?? 'unknown',
        title:  deck.title  ?? null,
        artist: deck.artist ?? null,
        queueLength: null   // renderer-side queue; not accessible from main
      };
    }

    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}

// IPC: Iris electron app (same machine, future use)
ipcMain.handle('iris:command', (_, cmd) => routeIrisCommand(cmd));

// HTTP: Iris can POST http://localhost:3400 without shared IPC
const irisHttpServer = require('http').createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '127.0.0.1');

  if (req.method === 'GET' && req.url === '/ping') {
    irisConnected = true;
    irisLastSeen  = Date.now();
    sendToAllWindows('iris:connected', true);
    res.end(JSON.stringify({ ok: true, pong: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const cmd = JSON.parse(body);
        irisConnected = true;
        irisLastSeen  = Date.now();
        const result = routeIrisCommand(cmd);
        res.end(JSON.stringify(result));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

irisHttpServer.listen(3400, '127.0.0.1', () => {
  console.log('[iris-bridge] HTTP server listening on http://127.0.0.1:3400');
});

// Mark Iris disconnected if no ping for 30 seconds
setInterval(() => {
  if (irisConnected && Date.now() - irisLastSeen > 30000) {
    irisConnected = false;
    sendToAllWindows('iris:connected', false);
  }
}, 5000);

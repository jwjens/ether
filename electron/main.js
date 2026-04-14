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
if (process.platform === "win32") {
  app.commandLine.appendSwitch("high-dpi-support", "1");
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
}

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
  seedDeckConfigs();
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
      daypart TEXT NOT NULL DEFAULT 'Morning Drive',
      slots_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS crash_recovery (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data TEXT,
      queue_json TEXT DEFAULT '[]',
      deck_a_path TEXT,
      deck_a_title TEXT,
      deck_a_artist TEXT,
      deck_a_position INTEGER DEFAULT 0,
      was_playing INTEGER DEFAULT 0,
      saved_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'jock',
      pin_hash TEXT,
      color TEXT NOT NULL DEFAULT '#22d3ee'
    );

    CREATE TABLE IF NOT EXISTS rtmp_destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      stream_key TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS deck_configs (
      slot    TEXT PRIMARY KEY,
      type    TEXT NOT NULL DEFAULT 'music',
      label   TEXT NOT NULL,
      color   TEXT NOT NULL DEFAULT '#34d399',
      enabled INTEGER NOT NULL DEFAULT 0
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

  // Part 1 — deck purpose (controls mode-based visibility)
  alterSafe("ALTER TABLE deck_configs ADD COLUMN purpose TEXT DEFAULT ''");
  // Part 7 — per-operator theme + station logo
  alterSafe("ALTER TABLE operators ADD COLUMN theme TEXT DEFAULT NULL");
  // Part 8 — Spotify URI on songs
  alterSafe("ALTER TABLE songs ADD COLUMN spotify_uri TEXT DEFAULT NULL");
  // Format clock columns missing from early migration (slots → slots_json + daypart)
  alterSafe("ALTER TABLE format_clocks ADD COLUMN daypart TEXT NOT NULL DEFAULT 'Morning Drive'");
  alterSafe("ALTER TABLE format_clocks ADD COLUMN slots_json TEXT NOT NULL DEFAULT '[]'");
  // crash_recovery columns added after initial schema
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN queue_json TEXT DEFAULT '[]'");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_path TEXT");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_title TEXT");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_artist TEXT");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_position INTEGER DEFAULT 0");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN was_playing INTEGER DEFAULT 0");
  // Ensure the single crash_recovery sentinel row exists
  db.exec("INSERT OR IGNORE INTO crash_recovery (id) VALUES (1)");
  // Seed default users if table is empty
  const userCount = db.prepare("SELECT COUNT(*) as n FROM users").get();
  if (userCount.n === 0) {
    db.exec(`
      INSERT INTO users (name, role, pin_hash, color) VALUES ('Admin', 'admin', '1234', '#f87171');
      INSERT INTO users (name, role, pin_hash, color) VALUES ('Jock', 'jock', NULL, '#22d3ee');
      INSERT INTO users (name, role, pin_hash, color) VALUES ('Music Director', 'music_director', '1234', '#a78bfa');
    `);
  }
  // EQ settings stored in station_config_kv with keys eq_deck_A, eq_deck_B, eq_deck_C, eq_deck_mic, eq_master
  // Part 2 — operators and operator notes
  db.exec(`
    CREATE TABLE IF NOT EXISTS operators (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT NOT NULL,
      initials TEXT NOT NULL DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS operator_notes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_id INTEGER NOT NULL REFERENCES operators(id),
      note        TEXT NOT NULL DEFAULT '',
      updated_at  INTEGER DEFAULT (unixepoch())
    );
  `);

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

// ── Deck config seeder ────────────────────────────────────────
// Deck slots A-F are defined HERE, in the database, on every startup.
// Do NOT hardcode deck slot lists in any React component or UI file.
// UI code reads from this table; it never defines which slots exist.
function seedDeckConfigs() {
  const defaults = [
    { slot: "A", type: "music", label: "Deck A", color: "#34d399", enabled: 1 },
    { slot: "B", type: "music", label: "Deck B", color: "#38bdf8", enabled: 1 },
    { slot: "C", type: "music", label: "Deck C", color: "#a78bfa", enabled: 1 },
    { slot: "D", type: "music", label: "Deck D", color: "#f97316", enabled: 0 },
    { slot: "E", type: "music", label: "Deck E", color: "#ef4444", enabled: 0 },
    { slot: "F", type: "music", label: "Deck F", color: "#a78bfa", enabled: 0 },
  ];
  const insert = db.prepare(
    "INSERT OR IGNORE INTO deck_configs (slot, type, label, color, enabled) VALUES (?, ?, ?, ?, ?)"
  );
  const seed = db.transaction((decks) => {
    for (const d of decks) insert.run(d.slot, d.type, d.label, d.color, d.enabled);
  });
  seed(defaults);
  const { c } = db.prepare("SELECT COUNT(*) as c FROM deck_configs").get();
  console.log(`[DeckGuard] ✓ deck_configs: ${c}/6 slots present — A B C D E F guaranteed in database`);
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
  const popout = (panel) => {
    // Re-use the same handler logic as the IPC "window:popout" handler
    const tag = `popout:${panel}`;
    const existing = BrowserWindow.getAllWindows().find(w => w.getTitle() === tag);
    if (existing) { existing.show(); existing.focus(); return; }
    const { screen } = require("electron");
    const size = POPOUT_SIZES[panel] || { width: 640, height: 520 };
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const secondary = displays.find(d => d.id !== primary.id);
    const x = secondary ? secondary.workArea.x + 60 : undefined;
    const y = secondary ? secondary.workArea.y + 60 : undefined;
    const win = new BrowserWindow({
      width: size.width, height: size.height,
      minWidth: 320, minHeight: 200, x, y,
      title: tag, frame: false, transparent: false,
      backgroundColor: "#0e0e14", resizable: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true, nodeIntegration: false, webSecurity: false,
      },
    });
    if (isDev) win.loadURL(VITE_DEV_URL + `#popout/${panel}`);
    else win.loadFile(path.join(__dirname, "../dist/index.html"), { hash: `popout/${panel}` });
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
      { label: "Format Clock",     click: () => { send("nav:clocks"); send("nav:scheduler-tab:clocks"); } },
      { label: "Shows & Dayparts", click: () => { send("nav:clocks"); send("nav:scheduler-tab:shows"); } },
      { label: "Music Categories", click: () => { send("nav:clocks"); send("nav:scheduler-tab:categories"); } },
      { type: "separator" },
      { label: "Program Log",      click: () => send("nav:programlog") },
      { label: "Play Log",         click: () => send("nav:logs") },
    ]},
    { label: "Tools", submenu: [
      { label: "Voice Tracker", click: () => send("nav:voicetrack") },
      { label: "Studio Editor", click: () => send("nav:studio") },
      { label: "Video Studio",  click: () => send("nav:videostudio") },
      { label: "Cue Editor", click: () => send("nav:trackedit") },
      { type: "separator" },
      { label: "Import Library...", click: () => send("nav:importlibrary") },
      { type: "separator" },
      { label: "Stream Manager", click: () => send("nav:streaming") },
      { label: "Smart Scheduler", click: () => send("nav:smartschedule") },
      { label: "Listener Analytics", click: () => send("nav:analytics") },
      { label: "Audio Routing", click: () => send("nav:multioutput") },
      { label: "Station Manager", click: () => send("nav:stationmanager") },
      { type: "separator" },
      { label: "System Health", click: () => send("nav:health") },
      { type: "separator" },
      { label: "Monitors", submenu: [
        { label: "Decks",          click: () => popout("decks") },
        { label: "Video Studio",   click: () => popout("videostudio") },
        { label: "Camera",         click: () => popout("camera") },
        { label: "Queue / Up Next",click: () => popout("upnext") },
        { label: "Station Health", click: () => popout("health") },
        { type: "separator" },
        { label: "Mic",            click: () => popout("mic") },
        { label: "Master Output",  click: () => popout("master") },
        { label: "Phone Desk",     click: () => popout("phone") },
        { label: "Voice Tracker",  click: () => popout("voicetrack") },
      ]},
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

// ── VIP invite file detection ─────────────────────────────────
// Checks for ether-invite.json in the exe dir or resources path.
// Runs once after DB is ready. Deletes the file after reading so it never fires twice.
let _inviteUsed = false;
let _invitedBy = "";

function processInviteFile() {
  const searchPaths = [
    path.join(path.dirname(app.getPath("exe")), "ether-invite.json"),
    path.join(process.resourcesPath || "", "ether-invite.json"),
    path.join(app.getAppPath(), "ether-invite.json"),
  ];

  let invitePath = null;
  for (const p of searchPaths) {
    try { if (fs.existsSync(p)) { invitePath = p; break; } } catch {}
  }
  if (!invitePath) return;

  let invite;
  try {
    invite = JSON.parse(fs.readFileSync(invitePath, "utf8"));
  } catch (e) {
    console.error("[Invite] Failed to parse invite file:", e.message);
    return;
  }

  try {
    // Check if first run is already complete
    const existing = db.prepare("SELECT value FROM station_config_kv WHERE key = 'first_run_complete'").get();
    if (existing && existing.value === "1") {
      console.log("[Invite] First run already complete — skipping invite processing");
      fs.renameSync(invitePath, invitePath + ".used");
      return;
    }

    // Create operator
    const name = invite.operator_name || "Operator";
    const initials = invite.operator_initials || name.charAt(0);
    db.prepare("INSERT OR IGNORE INTO operators (name, initials) VALUES (?, ?)").run(name, initials);
    const op = db.prepare("SELECT id FROM operators WHERE name = ?").get(name);

    if (op && invite.personal_note) {
      db.prepare("INSERT OR REPLACE INTO operator_notes (operator_id, note, updated_at) VALUES (?, ?, unixepoch())").run(op.id, invite.personal_note);
    }

    // Set experience mode
    const mode = invite.experience_mode || "standard";
    db.prepare("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('experience_mode', ?)").run(mode);

    // Mark first run complete
    db.prepare("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('first_run_complete', '1')").run();

    // Store invite metadata for Iris greeting
    db.prepare("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('invite_used', '1')").run();
    db.prepare("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('invited_by', ?)").run(invite.invited_by || "Deniro");
    db.prepare("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('last_operator_id', ?)").run(op ? String(op.id) : "");

    _inviteUsed = true;
    _invitedBy = invite.invited_by || "Deniro";

    console.log(`[Invite] ✓ Processed invite for ${name} (invited by ${_invitedBy})`);

    // Rename so it never runs again
    fs.renameSync(invitePath, invitePath + ".used");
  } catch (e) {
    console.error("[Invite] Error processing invite:", e.message);
  }
}

// Module-level handle so before-quit can clear it
let levelPushId = null;

app.whenReady().then(() => {
  createSplash();
  initDb(); // runMigrations() + seedDeckConfigs() run here before window loads
  processInviteFile(); // VIP invite seeding — runs after DB is ready
  createWindow();
  createTray();
  buildMenu();

  // Start 30fps real-time audio level push to renderer
  // Renderer subscribes via window.ether.audio.onLevels(cb) — no polling, no fake sim
  mainWindow.webContents.on("did-finish-load", () => {
    if (levelPushId) clearInterval(levelPushId);
    levelPushId = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        const levels = JSON.parse(audio.audioGetLevels());
        levels.master = Math.max(levels.a || 0, levels.b || 0, levels.c || 0);
        sendToAllWindows("audio:levels", levels);
      } catch {}
    }, 33);
  });
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
  if (levelPushId) { clearInterval(levelPushId); levelPushId = null; }
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
// EQ — sends band gains to native engine. audioSetEq(deck, bandsJson) to be implemented in native addon.
ipcMain.handle("audio:setEq", (_, deck, bands) => {
  try { if (typeof audio.audioSetEq === "function") return audio.audioSetEq(deck, JSON.stringify(bands)); }
  catch(e) { console.warn("[EQ] audioSetEq not yet implemented in native addon:", e.message); }
  return true;
});

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

// Generate a VIP invite file and save it via save dialog
ipcMain.handle("invite:generate", async (_, { name, initials, note, mode, invitedBy }) => {
  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Save Invite File",
      defaultPath: "ether-invite.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!filePath) return { ok: false, reason: "cancelled" };
    const payload = {
      operator_name: name,
      operator_initials: initials,
      invited_by: invitedBy || "Deniro",
      personal_note: note,
      experience_mode: mode,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return { ok: true, filePath };
  } catch (e) { return { ok: false, reason: e.message }; }
});

// Reset deck configs to factory defaults and return fresh rows
ipcMain.handle("deck-configs:reset", () => {
  try {
    db.exec("DELETE FROM deck_configs");
    seedDeckConfigs();
    return { data: db.prepare("SELECT * FROM deck_configs ORDER BY slot").all(), error: null };
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

// ── Multi-monitor pop-out windows — Tony Stark mode ──────────
// Each popped panel gets a frameless BrowserWindow loading #popout/<panel>
const POPOUT_SIZES = {
  "decks":       { width: 1320, height: 460 },  // all visible decks in a row
  "mic":         { width: 400,  height: 300 },
  "master":      { width: 800,  height: 600 },
  "upnext":      { width: 480,  height: 640 },
  "phone":       { width: 720,  height: 520 },
  "voicetrack":  { width: 860,  height: 540 },
  "videostudio": { width: 1024, height: 640 },
  "camera":      { width: 640,  height: 480 },
  "health":      { width: 720,  height: 540 },
};

ipcMain.handle("window:popout", async (_, panel) => {
  const tag = `popout:${panel}`;
  const existing = BrowserWindow.getAllWindows().find(w => w.getTitle() === tag);
  if (existing) { existing.show(); existing.focus(); return; }

  const { screen } = require("electron");
  const size = POPOUT_SIZES[panel] || { width: 640, height: 520 };
  const displays = screen.getAllDisplays();
  const primary  = screen.getPrimaryDisplay();
  const secondary = displays.find(d => d.id !== primary.id);
  // Place on secondary monitor if available, else offset from center
  const x = secondary ? secondary.workArea.x + 60 : undefined;
  const y = secondary ? secondary.workArea.y + 60 : undefined;

  const win = new BrowserWindow({
    width:  size.width,
    height: size.height,
    minWidth:  320,
    minHeight: 200,
    x, y,
    title: tag,
    frame: false,
    transparent: false,
    backgroundColor: "#0e0e14",
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  if (isDev) win.loadURL(VITE_DEV_URL + `#popout/${panel}`);
  else win.loadFile(path.join(__dirname, "../dist/index.html"), { hash: `popout/${panel}` });
});

// ── Guest Editor pop-out window ───────────────────────────────
ipcMain.handle("window:guesteditor", async () => {
  const title = "Ether — Guest Editor";
  const existing = BrowserWindow.getAllWindows().find(w => w.getTitle() === title);
  if (existing) { existing.show(); existing.focus(); return; }

  const { screen } = require("electron");
  const displays  = screen.getAllDisplays();
  const primary   = screen.getPrimaryDisplay();
  const secondary = displays.find(d => d.id !== primary.id);
  const x = secondary ? secondary.workArea.x + 60 : undefined;
  const y = secondary ? secondary.workArea.y + 60 : undefined;

  const win = new BrowserWindow({
    width: 800, height: 600,
    minWidth: 400, minHeight: 300,
    x, y,
    title,
    frame: false,
    transparent: false,
    backgroundColor: "#0e0e14",
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  if (isDev) win.loadURL(VITE_DEV_URL + "#guesteditor");
  else win.loadFile(path.join(__dirname, "../dist/index.html"), { hash: "guesteditor" });
});

// ── Cross-window broadcast relay ─────────────────────────────
// Renderer: ether.emit("ether:broadcast", { channel, data })
// All other windows receive: ether.on(channel, cb)
ipcMain.on("ether:broadcast", (event, { channel, data }) => {
  BrowserWindow.getAllWindows().forEach(win => {
    if (win.webContents.id !== event.sender.id) {
      win.webContents.send(channel, data);
    }
  });
});

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
// Shared now-playing state updated by the main window
let _nowPlayingContext = { title: null, artist: null };
ipcMain.on("iris:nowplaying", (_, payload) => {
  if (payload && typeof payload === "object") {
    _nowPlayingContext = { title: payload.title || null, artist: payload.artist || null };
  }
});

ipcMain.handle("ai:ask", async (_, messages) => {
  const cfg = readAiConfig();
  const provider = cfg.provider || "anthropic";
  let apiKey = decryptKey(cfg.keys?.[provider]);
  if (!apiKey && provider === "anthropic") apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "__NO_KEY__";

  // Build station context string for Iris
  const nowPlayingLine = _nowPlayingContext.title
    ? `Station is currently playing: "${_nowPlayingContext.title}" by ${_nowPlayingContext.artist || "Unknown"}.`
    : "No song is currently playing.";

  const system = `You are Iris, the Executive Producer for ether radio. You are professional, sharp, and slightly witty. You have direct knowledge of the station's current state. Use radio terminology. Never break character. Be concise.\n\nCurrent station state: ${nowPlayingLine}`;

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

// ── localtunnel — public guest URL ───────────────────────────
let _tunnel = null;

ipcMain.handle("studio:startTunnel", async () => {
  try {
    if (_tunnel) { try { _tunnel.close(); } catch {} _tunnel = null; }
    const localtunnel = require("localtunnel");
    _tunnel = await localtunnel({ port: 9091 });
    _tunnel.on("error", () => { _tunnel = null; });
    return { url: _tunnel.url, error: null };
  } catch (e) {
    return { url: null, error: e.message };
  }
});

ipcMain.handle("studio:stopTunnel", () => {
  if (_tunnel) { try { _tunnel.close(); } catch {} _tunnel = null; }
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

// ── VoxPro / FFmpeg ───────────────────────────────────────────
let ffmpegBin = null;
try {
  ffmpegBin = require("ffmpeg-static");
  // When bundled in asar, the binary lives in app.asar.unpacked
  if (ffmpegBin && ffmpegBin.includes("app.asar") && !ffmpegBin.includes("unpacked")) {
    ffmpegBin = ffmpegBin.replace("app.asar", "app.asar.unpacked");
  }
  console.log("[FFMPEG] Binary:", ffmpegBin);
} catch (e) {
  console.warn("[FFMPEG] ffmpeg-static not available:", e.message);
}

function runFFmpeg(args) {
  const { execFile } = require("child_process");
  return new Promise((resolve, reject) => {
    if (!ffmpegBin) return reject(new Error("FFmpeg not bundled"));
    execFile(ffmpegBin, args, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(true);
    });
  });
}

// Write raw binary (Uint8Array / Buffer) to disk — used by VoxPro to persist recorded audio
ipcMain.handle("voxpro:writeAudio", (_, { data, filePath }) => {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(data));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Encode a WAV/WebM/OGG source file to MP3 or WAV via FFmpeg
ipcMain.handle("ffmpeg:bounce-audio", async (_, { inputPath, outputPath, format }) => {
  const args = format === "mp3"
    ? ["-y", "-i", inputPath, "-codec:a", "libmp3lame", "-q:a", "2", outputPath]
    : ["-y", "-i", inputPath, "-codec:a", "pcm_s16le", outputPath];
  await runFFmpeg(args);
  return outputPath;
});

// Mix voice + music bed with per-track gain and music fade in/out
ipcMain.handle("ffmpeg:mix-audio", async (_, { voicePath, musicPath, voiceGain, musicGain, fadeDuration, outputPath }) => {
  const vg = Number(voiceGain) || 1;
  const mg = Number(musicGain) || 0.3;
  const fd = Number(fadeDuration) || 2;
  // Get voice duration for fade-out timing
  const { execFile } = require("child_process");
  let duration = 30;
  try {
    const probe = await new Promise((res) => {
      execFile(ffmpegBin, ["-i", voicePath], { maxBuffer: 1024 * 1024 }, (_, __, stderr) => {
        const m = stderr && stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        res(m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 30);
      });
    });
    duration = Number(probe) || 30;
  } catch {}
  const fadeOutStart = Math.max(0, duration - fd);
  const filter = [
    `[1:a]volume=${mg},afade=t=in:st=0:d=${fd},afade=t=out:st=${fadeOutStart}:d=${fd}[music]`,
    `[0:a]volume=${vg}[voice]`,
    `[voice][music]amix=inputs=2:duration=first:dropout_transition=2[out]`,
  ].join(";");
  await runFFmpeg(["-y", "-i", voicePath, "-i", musicPath, "-filter_complex", filter, "-map", "[out]", "-codec:a", "libmp3lame", "-q:a", "2", outputPath]);
  return outputPath;
});

// Mux audio + video into MP4
ipcMain.handle("ffmpeg:bounce-video", async (_, { audioPath, videoPath, outputPath }) => {
  await runFFmpeg(["-y", "-i", videoPath, "-i", audioPath, "-c:v", "copy", "-c:a", "aac", "-shortest", outputPath]);
  return outputPath;
});

// Export: open save dialog and copy the rendered file there
ipcMain.handle("ffmpeg:export", async (_, { sourcePath, defaultName, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath("downloads"), defaultName || "voxpro-export"),
    filters: filters || [{ name: "Audio Files", extensions: ["mp3"] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.copyFileSync(sourcePath, result.filePath);
  return result.filePath;
});

// Return the VoxPro auto-save directory path
ipcMain.handle("voxpro:getSaveDir", () => {
  const dir = path.join(app.getPath("userData"), "voxpro");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
});

// Return a temp directory path for intermediate files
ipcMain.handle("voxpro:getTempDir", () => {
  const dir = path.join(app.getPath("temp"), "ether-voxpro");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

// ── Part 8 — Spotify Library Integration ─────────────────────
// Credentials stored via safeStorage (same helper as AI keys).
// Spotify token cached in memory; refreshed automatically.

let _spotifyToken = null;
let _spotifyTokenExpiry = 0;

function getSpotifyConfig() {
  const cfg = readAiConfig();
  return {
    clientId:     decryptKey(cfg.keys?.spotify_client_id)  || null,
    clientSecret: decryptKey(cfg.keys?.spotify_client_secret) || null,
  };
}

async function getSpotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyTokenExpiry) return _spotifyToken;
  const { clientId, clientSecret } = getSpotifyConfig();
  if (!clientId || !clientSecret) return null;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) return null;
  const data = await res.json();
  _spotifyToken = data.access_token || null;
  _spotifyTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000 - 60000;
  return _spotifyToken;
}

ipcMain.handle("spotify:setCredentials", (_, { clientId, clientSecret }) => {
  const cfg = readAiConfig();
  if (!cfg.keys) cfg.keys = {};
  if (clientId)     cfg.keys.spotify_client_id     = encryptKey(clientId);
  if (clientSecret) cfg.keys.spotify_client_secret = encryptKey(clientSecret);
  writeAiConfig(cfg);
  _spotifyToken = null; // force token refresh
  return true;
});

ipcMain.handle("spotify:getCredentialStatus", () => {
  const { clientId, clientSecret } = getSpotifyConfig();
  return { hasClientId: !!clientId, hasClientSecret: !!clientSecret };
});

ipcMain.handle("spotify:getRecommendations", async (_, { seeds, valence, energy, speechiness, limit }) => {
  try {
    const token = await getSpotifyToken();
    if (!token) return { ok: false, error: "No Spotify credentials — add Client ID and Secret in Settings > AI & Integrations" };

    const params = new URLSearchParams({
      limit: String(Math.min(limit || 100, 100)), // Spotify max per call is 100
      seed_genres: (seeds || ["pop"]).slice(0, 5).join(","), // Spotify max 5 seeds
      target_valence:    String(valence    ?? 0.7),
      min_valence:       String(Math.max(0, (valence ?? 0.7) - 0.2)),
      target_energy:     String(energy     ?? 0.7),
      min_energy:        String(Math.max(0, (energy  ?? 0.7) - 0.2)),
      max_speechiness:   String(speechiness ?? 0.05),
      target_popularity: "60",
    });

    const res = await fetch(`https://api.spotify.com/v1/recommendations?${params}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: err.error?.message || `Spotify API error ${res.status}` };
    }
    const data = await res.json();
    const tracks = (data.tracks || [])
      .filter(t => !t.explicit) // server-side explicit filter
      .map(t => ({
        title:       t.name,
        artist:      t.artists?.map(a => a.name).join(", ") || "Unknown",
        album:       t.album?.name || "",
        durationMs:  t.duration_ms,
        spotifyUri:  t.uri,
        spotifyId:   t.id,
        explicit:    t.explicit,
        previewUrl:  t.preview_url || null,
        imageUrl:    t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || null,
        valence:     null, // available in audio features, not recommendations response
        energy:      null,
        speechiness: null,
      }));
    return { ok: true, tracks };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Musixmatch lyric scan — fetches lyrics then checks for red-flag terms
const LYRIC_FLAG_CATEGORIES = {
  violence:    ["kill", "murder", "shoot", "gun", "knife", "blood", "dead", "death", "violent", "stab", "assault", "rape", "bomb", "terrorist", "weapon", "slaughter"],
  sexual:      ["sex", "naked", "pussy", "dick", "cock", "fuck", "bitch", "ass", "booty", "twerk", "strip", "lust", "orgasm", "explicit", "erotic", "horny"],
  hate_speech: ["nigger", "nigga", "faggot", "spic", "kike", "slut", "whore", "retard", "cunt"],
  political:   ["trump", "biden", "democrat", "republican", "maga", "antifa", "blm", "protest", "revolution"],
};

ipcMain.handle("musixmatch:setKey", (_, { key }) => {
  const cfg = readAiConfig();
  if (!cfg.keys) cfg.keys = {};
  cfg.keys.musixmatch = encryptKey(key);
  writeAiConfig(cfg);
  return true;
});

ipcMain.handle("musixmatch:getKeyStatus", () => {
  const cfg = readAiConfig();
  return { hasKey: !!(cfg.keys?.musixmatch) };
});

ipcMain.handle("musixmatch:scanLyrics", async (_, { title, artist }) => {
  try {
    const cfg = readAiConfig();
    const apiKey = decryptKey(cfg.keys?.musixmatch);
    if (!apiKey) return { ok: false, error: "No Musixmatch API key — add it in Settings > AI & Integrations" };

    const searchUrl = `https://api.musixmatch.com/ws/1.1/matcher.lyrics.get?format=json&q_track=${encodeURIComponent(title)}&q_artist=${encodeURIComponent(artist)}&apikey=${apiKey}`;
    const res = await fetch(searchUrl);
    const data = await res.json();

    const statusCode = data?.message?.header?.status_code;
    if (statusCode !== 200) {
      // 404 = lyrics not found — treat as clean (no lyrics = can't scan)
      return { ok: true, found: false, flagged: false, matches: [] };
    }

    const lyrics = (data?.message?.body?.lyrics?.lyrics_body || "").toLowerCase();
    if (!lyrics) return { ok: true, found: false, flagged: false, matches: [] };

    const matches = [];
    for (const [category, terms] of Object.entries(LYRIC_FLAG_CATEGORIES)) {
      for (const term of terms) {
        if (lyrics.includes(term)) {
          matches.push({ category, term });
        }
      }
    }
    return { ok: true, found: true, flagged: matches.length > 0, matches };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Write a Spotify-imported track to the songs table
ipcMain.handle("library:writeTrack", (_, { title, artist, album, durationMs, spotifyUri }) => {
  try {
    // Upsert artist
    db.prepare("INSERT OR IGNORE INTO artists (name) VALUES (?)").run(artist || "Unknown");
    const artistRow = db.prepare("SELECT id FROM artists WHERE name = ?").get(artist || "Unknown");
    const artistId = artistRow?.id || null;

    // Upsert album
    let albumId = null;
    if (album && artistId) {
      db.prepare("INSERT OR IGNORE INTO albums (title, artist_id) VALUES (?, ?)").run(album, artistId);
      const albumRow = db.prepare("SELECT id FROM albums WHERE title = ? AND artist_id = ?").get(album, artistId);
      albumId = albumRow?.id || null;
    }

    // Insert song — no file_path (stream-only via Spotify URI)
    const existing = db.prepare("SELECT id FROM songs WHERE title = ? AND artist_id = ?").get(title, artistId);
    if (existing) return { ok: true, id: existing.id, skipped: true };

    const result = db.prepare(`
      INSERT INTO songs (title, artist_id, album_id, duration_ms, is_explicit, spotify_uri, rotation_status, daypart_mask)
      VALUES (?, ?, ?, ?, 0, ?, 'active', 16777215)
    `).run(title, artistId, albumId, durationMs || 0, spotifyUri || null);
    return { ok: true, id: result.lastInsertRowid, skipped: false };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Theme export / import (.ethertheme files) ─────────────────

ipcMain.handle("theme:export", async (_, { presetId, vars, font }) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export Theme",
      defaultPath: `ether-theme-${presetId || "custom"}.ethertheme`,
      filters: [{ name: "Ether Theme", extensions: ["ethertheme"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const payload = { presetId, vars, font: font || null, version: 1 };
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), "utf8");
    return { ok: true, filePath: result.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("theme:import", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Import Theme",
      properties: ["openFile"],
      filters: [{ name: "Ether Theme", extensions: ["ethertheme", "json"] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    const raw = fs.readFileSync(result.filePaths[0], "utf8");
    const data = JSON.parse(raw);
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Station logo (base64 stored in station_config_kv) ─────────

ipcMain.handle("station:uploadLogo", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose Station Logo",
      properties: ["openFile"],
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "svg", "webp"] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    const filePath = result.filePaths[0];
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const mime = ext === "svg" ? "image/svg+xml" : ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : "image/jpeg";
    const b64 = `data:${mime};base64,${buf.toString("base64")}`;
    return { ok: true, dataUrl: b64 };
  } catch (e) { return { ok: false, error: e.message }; }
});

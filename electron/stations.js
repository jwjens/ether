// electron/stations.js — multi-station profile management.
//
// Strategy: each station has its own SQLite DB file. No schema migrations,
// no "station_id" FKs littered through every table. Total isolation — a
// college running 3 stations gets 3 independent databases. Switching
// stations = close current DB, open another, restart app.
//
// File layout in the Ether user-data directory:
//   openair.db                  — the "default" station (existing installs)
//   openair-<slug>.db           — additional stations
//   active-station.json         — { slug: "default" | "<slug>", switchedAt }
//   stations-registry.json      — array of { slug, name, callsign, freq, ... }
//
// On app boot, main.js calls getActiveDbPath() here; it reads the active
// station file and returns the right DB path. Switching writes the active
// file + relaunches the app so every module picks up the fresh DB.

const fs   = require("fs");
const path = require("path");

let rootDir = null; // the Ether user-data folder (set by install)

function ensureDir() {
  if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
}
function registryPath() { return path.join(rootDir, "stations-registry.json"); }
function activePath()   { return path.join(rootDir, "active-station.json"); }
function dbPathForSlug(slug) {
  if (!slug || slug === "default") return path.join(rootDir, "openair.db");
  return path.join(rootDir, `openair-${slug}.db`);
}

function readRegistry() {
  try {
    if (!fs.existsSync(registryPath())) return [];
    return JSON.parse(fs.readFileSync(registryPath(), "utf8"));
  } catch { return []; }
}
function writeRegistry(list) {
  try { fs.writeFileSync(registryPath(), JSON.stringify(list, null, 2), "utf8"); }
  catch (e) { console.warn("[STATIONS] writeRegistry failed:", e.message); }
}
function readActive() {
  try {
    if (!fs.existsSync(activePath())) return { slug: "default" };
    return JSON.parse(fs.readFileSync(activePath(), "utf8"));
  } catch { return { slug: "default" }; }
}
function writeActive(slug) {
  try { fs.writeFileSync(activePath(), JSON.stringify({ slug, switchedAt: Date.now() }, null, 2), "utf8"); }
  catch (e) { console.warn("[STATIONS] writeActive failed:", e.message); }
}

// Auto-heal: if there's an existing openair.db but no registry, seed a
// "Default Station" row so multi-station UI isn't empty on first run.
function seedDefaultIfNeeded() {
  const reg = readRegistry();
  const defaultDb = dbPathForSlug("default");
  if (reg.length === 0 && fs.existsSync(defaultDb)) {
    const entry = { slug: "default", name: "Default Station", callsign: "", frequency: "", city: "", createdAt: Date.now() };
    writeRegistry([entry]);
    writeActive("default");
    return [entry];
  }
  return reg;
}

// ── Public: called from main.js BEFORE initDb() ──
function init(userDataPath) {
  rootDir = userDataPath;
  ensureDir();
  seedDefaultIfNeeded();
}

function getActiveDbPath() {
  if (!rootDir) return null;
  const active = readActive();
  return dbPathForSlug(active.slug);
}
function getActiveSlug() {
  return readActive().slug;
}

// ── IPC install — called AFTER initDb so we have db reference for any
//    future cross-DB features. For now these handlers only touch JSON files
//    and filesystem. ──
function installStations(ipcMain, _db, opts = {}) {
  rootDir = opts.userDataPath || rootDir;
  const { app, BrowserWindow } = require("electron");

  ipcMain.handle("stations:list", () => {
    const reg  = readRegistry();
    const active = readActive().slug;
    return reg.map(s => {
      const dbp = dbPathForSlug(s.slug);
      let size = 0, exists = false;
      try { const stat = fs.statSync(dbp); size = stat.size; exists = true; } catch {}
      return { ...s, dbPath: dbp, dbSizeBytes: size, dbExists: exists, isActive: s.slug === active };
    });
  });

  ipcMain.handle("stations:get-active", () => {
    const a = readActive();
    const reg = readRegistry();
    const entry = reg.find(s => s.slug === a.slug) || { slug: "default", name: "Default Station" };
    return entry;
  });

  ipcMain.handle("stations:create", (_, { name, callsign, frequency, city }) => {
    try {
      if (!name || !name.trim()) return { ok: false, error: "Name is required" };
      const slug = slugify(name);
      if (slug === "default") return { ok: false, error: "'default' is reserved" };
      const reg = readRegistry();
      if (reg.some(s => s.slug === slug)) return { ok: false, error: "A station with this name/slug already exists" };
      const entry = { slug, name: name.trim(), callsign: callsign || "", frequency: frequency || "", city: city || "", createdAt: Date.now() };
      reg.push(entry);
      writeRegistry(reg);
      // Don't create the DB yet — it'll be created on first switch-to
      // when initDb runs. That keeps this endpoint instant.
      return { ok: true, station: entry };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle("stations:update", (_, { slug, patch }) => {
    try {
      const reg = readRegistry();
      const idx = reg.findIndex(s => s.slug === slug);
      if (idx < 0) return { ok: false, error: "Station not found" };
      reg[idx] = { ...reg[idx], ...patch, slug: reg[idx].slug }; // slug immutable
      writeRegistry(reg);
      return { ok: true, station: reg[idx] };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle("stations:delete", (_, { slug }) => {
    try {
      if (slug === "default") return { ok: false, error: "Cannot delete the default station" };
      const active = readActive().slug;
      if (active === slug) return { ok: false, error: "Cannot delete the currently active station — switch first" };
      const reg = readRegistry().filter(s => s.slug !== slug);
      writeRegistry(reg);
      // Also remove the DB file if it exists
      const dbp = dbPathForSlug(slug);
      if (fs.existsSync(dbp)) {
        try { fs.unlinkSync(dbp); } catch {}
        // Also remove WAL/SHM sidecar files
        try { fs.unlinkSync(dbp + "-wal"); } catch {}
        try { fs.unlinkSync(dbp + "-shm"); } catch {}
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Switch = write active-station.json, then relaunch the app so every module
  // reloads against the fresh DB.
  ipcMain.handle("stations:switch", (_, { slug }) => {
    try {
      const reg = readRegistry();
      if (!reg.some(s => s.slug === slug)) return { ok: false, error: "Unknown station" };
      writeActive(slug);
      setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  console.log("[STATIONS] installed — active:", readActive().slug, "registry:", readRegistry().length);
}

function slugify(s) {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "station";
}

module.exports = { init, installStations, getActiveDbPath, getActiveSlug };

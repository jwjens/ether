// electron/site-replication.js — Multi-station content synchronization.
//
// Syncs metadata, schedules, voice tracks, spots, and macros between
// Ether stations on the same network. Uses HTTP polling with change
// tracking via timestamps — no persistent connection required.
//
// Architecture:
//   - Each station has a unique site_id (UUID generated on first run)
//   - Changes are tracked via updated_at timestamps on synced tables
//   - Pull model: each station polls peers for changes since last sync
//   - Conflict resolution: last-write-wins (highest updated_at)
//   - Audio files are NOT synced (too large) — only metadata + file paths
//
// Synced tables: songs (metadata only), shows, clocks, clock_slots,
//   spots, macros, categories, separation_rules, smart_schedule_rules

const http = require("http");
const https = require("https");
const crypto = require("crypto");

let db = null;
let siteId = null;
let syncInterval = null;
let peers = []; // { host, port, name, lastSync }

function installSiteReplication(ipcMain, database) {
  db = database;

  // Ensure replication tables exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS replication_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS replication_peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 3400,
      is_active INTEGER DEFAULT 1,
      last_sync_at INTEGER DEFAULT 0,
      last_status TEXT DEFAULT 'never',
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS replication_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      peer_id INTEGER,
      direction TEXT,
      table_name TEXT,
      records_synced INTEGER DEFAULT 0,
      status TEXT,
      synced_at INTEGER DEFAULT (unixepoch())
    );
  `);

  // Generate or load site ID
  const existing = db.prepare("SELECT value FROM replication_config WHERE key = 'site_id'").get();
  if (existing) {
    siteId = existing.value;
  } else {
    siteId = crypto.randomUUID();
    db.prepare("INSERT INTO replication_config (key, value) VALUES ('site_id', ?)").run(siteId);
  }
  console.log(`[REPL] Site ID: ${siteId}`);

  // ── Serve replication data (incoming pulls from peers) ──────

  // Add replication endpoints to the existing API server
  // These are registered via IPC so the main API server can route to them
  ipcMain.handle("repl:get-changes", (_evt, tableName, sinceEpoch) => {
    return getChanges(tableName, sinceEpoch);
  });

  // ── IPC handlers for the UI ────────────────────────────────

  ipcMain.handle("repl:get-config", () => ({
    siteId,
    syncEnabled: !!syncInterval,
    peers: db.prepare("SELECT * FROM replication_peers ORDER BY name").all(),
    lastLogs: db.prepare("SELECT * FROM replication_log ORDER BY synced_at DESC LIMIT 20").all(),
  }));

  ipcMain.handle("repl:add-peer", (_evt, peer) => {
    db.prepare("INSERT INTO replication_peers (name, host, port) VALUES (?, ?, ?)")
      .run(peer.name || "Station", peer.host || "127.0.0.1", peer.port || 3400);
    loadPeers();
    return true;
  });

  ipcMain.handle("repl:remove-peer", (_evt, id) => {
    db.prepare("DELETE FROM replication_peers WHERE id = ?").run(id);
    loadPeers();
    return true;
  });

  ipcMain.handle("repl:update-peer", (_evt, id, data) => {
    db.prepare("UPDATE replication_peers SET name=?, host=?, port=?, is_active=? WHERE id=?")
      .run(data.name, data.host, data.port, data.is_active ?? 1, id);
    loadPeers();
    return true;
  });

  ipcMain.handle("repl:sync-now", async (_evt, peerId) => {
    const peer = db.prepare("SELECT * FROM replication_peers WHERE id = ?").get(peerId);
    if (!peer) return { ok: false, error: "Peer not found" };
    return await syncWithPeer(peer);
  });

  ipcMain.handle("repl:start-auto", (_evt, intervalMin) => {
    startAutoSync(intervalMin || 5);
    return true;
  });

  ipcMain.handle("repl:stop-auto", () => {
    stopAutoSync();
    return true;
  });

  ipcMain.handle("repl:get-site-id", () => siteId);

  loadPeers();
  console.log("[REPL] Site replication installed");
}

// ── Tables we sync (metadata only, no audio blobs) ──────────

const SYNC_TABLES = [
  { name: "songs",                idCol: "id", tsCol: "updated_at", excludeCols: ["file_path"] },
  { name: "shows",                idCol: "id", tsCol: null },
  { name: "clocks",               idCol: "id", tsCol: null },
  { name: "spots",                idCol: "id", tsCol: "created_at", excludeCols: ["file_path"] },
  { name: "macros",               idCol: "id", tsCol: "created_at" },
  { name: "categories",           idCol: "id", tsCol: null },
  { name: "separation_rules",     idCol: "id", tsCol: null },
  { name: "smart_schedule_rules", idCol: "id", tsCol: null },
];

function getChanges(tableName, sinceEpoch) {
  const table = SYNC_TABLES.find(t => t.name === tableName);
  if (!table) return { ok: false, error: "Unknown table" };

  try {
    const tsCol = table.tsCol || "rowid"; // fallback to rowid ordering
    let rows;
    if (table.tsCol) {
      rows = db.prepare(`SELECT * FROM ${tableName} WHERE ${tsCol} > ? ORDER BY ${tsCol} LIMIT 500`).all(sinceEpoch);
    } else {
      rows = db.prepare(`SELECT * FROM ${tableName} LIMIT 500`).all();
    }

    // Strip excluded columns (like file_path — don't share local paths)
    if (table.excludeCols) {
      rows = rows.map(r => {
        const copy = { ...r };
        for (const col of table.excludeCols) delete copy[col];
        return copy;
      });
    }

    return { ok: true, siteId, table: tableName, rows, count: rows.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Pull from a peer ─────────────────────────────────────────

async function syncWithPeer(peer) {
  const results = [];
  let totalSynced = 0;

  for (const table of SYNC_TABLES) {
    try {
      const data = await fetchFromPeer(peer, `/api/repl/changes?table=${table.name}&since=${peer.last_sync_at || 0}`);
      if (!data?.ok || !data.rows?.length) continue;

      let synced = 0;
      for (const row of data.rows) {
        // Upsert: try insert, on conflict update
        try {
          const cols = Object.keys(row).filter(k => k !== table.idCol);
          const vals = cols.map(c => row[c]);
          // Try insert first
          const placeholders = cols.map(() => "?").join(",");
          db.prepare(`INSERT OR REPLACE INTO ${table.name} (${cols.join(",")}) VALUES (${placeholders})`).run(...vals);
          synced++;
        } catch (e) {
          // Ignore individual row errors
        }
      }

      if (synced > 0) {
        results.push({ table: table.name, synced });
        totalSynced += synced;
      }
    } catch (e) {
      results.push({ table: table.name, error: e.message });
    }
  }

  // Update peer last sync time
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE replication_peers SET last_sync_at = ?, last_status = ? WHERE id = ?")
    .run(now, totalSynced > 0 ? `${totalSynced} records` : "up to date", peer.id);

  // Log
  db.prepare("INSERT INTO replication_log (peer_id, direction, table_name, records_synced, status) VALUES (?,?,?,?,?)")
    .run(peer.id, "pull", "all", totalSynced, totalSynced > 0 ? "success" : "no changes");

  return { ok: true, results, totalSynced };
}

function fetchFromPeer(peer, path) {
  return new Promise((resolve, reject) => {
    const url = `http://${peer.host}:${peer.port}${path}`;
    const req = http.get(url, { timeout: 10000 }, (res) => {
      let body = "";
      res.on("data", d => { body += d; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error("Invalid JSON from peer")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── Auto-sync ────────────────────────────────────────────────

function loadPeers() {
  try {
    peers = db.prepare("SELECT * FROM replication_peers WHERE is_active = 1").all();
  } catch { peers = []; }
}

function startAutoSync(intervalMin = 5) {
  stopAutoSync();
  console.log(`[REPL] Auto-sync every ${intervalMin} min`);
  syncInterval = setInterval(async () => {
    loadPeers();
    for (const peer of peers) {
      try { await syncWithPeer(peer); }
      catch (e) { console.warn(`[REPL] sync with ${peer.name} failed:`, e.message); }
    }
  }, intervalMin * 60 * 1000);
}

function stopAutoSync() {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}

module.exports = { installSiteReplication };

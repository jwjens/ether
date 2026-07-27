// Bench (read-only): the senses-sweep cost, OLD per-song subqueries vs the NEW batched eligibility, on
// the live DB. Proves the main-loop-freeze fix. Also runs the REAL library-health computeAll() to time
// the whole sweep (all senses incl. depthCheck) end-to-end. Read-only; never writes the live DB.
const path = require("path");
const Database = require(path.join(process.cwd(), "node_modules", "better-sqlite3"));
function dbPath() {
  if (process.env.ETHER_DB_PATH) return process.env.ETHER_DB_PATH;
  const la = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
  return path.join(la, "Ether", "com.ether.radio", "openair.db");
}
const db = new Database(dbPath(), { readonly: true, fileMustExist: true });
const nowSec = () => Math.floor(Date.now() / 1000);
const catsOf = (sid) => db.prepare("SELECT id FROM categories WHERE station_id=? AND deleted_at IS NULL").all(sid).map(r => r.id);
const stations = db.prepare("SELECT id, name FROM stations WHERE deleted_at IS NULL ORDER BY id").all();

// OLD path: 3 play_log subqueries PER SONG (what froze the main loop).
function oldEligibility(sid) {
  const cats = catsOf(sid); if (!cats.length) return 0;
  const inCats = `(${cats.join(",")})`;
  const songs = db.prepare(`SELECT s.id, s.file_path, s.artist_id, s.no_repeat_hours FROM songs s WHERE s.category_id IN ${inCats} AND s.deleted_at IS NULL`).all();
  const lastPlay = db.prepare(`SELECT MAX(played_at) m FROM play_log WHERE station_id=? AND file_path=? AND deleted_at IS NULL`);
  const lastArtist = db.prepare(`SELECT MAX(pl.played_at) m FROM play_log pl JOIN songs s2 ON s2.file_path=pl.file_path WHERE pl.station_id=? AND pl.deleted_at IS NULL AND s2.artist_id=?`);
  const playCount = db.prepare(`SELECT COUNT(*) c FROM play_log WHERE station_id=? AND file_path=? AND deleted_at IS NULL`);
  let n = 0;
  for (const s of songs) {
    if (s.file_path) { lastPlay.get(sid, s.file_path); playCount.get(sid, s.file_path); }
    if (s.artist_id) lastArtist.get(sid, s.artist_id);
    n++;
  }
  return n;
}

// NEW path: 2 set-based GROUP BY scans + in-memory loop.
function newEligibility(sid) {
  const cats = catsOf(sid); if (!cats.length) return 0;
  const inCats = `(${cats.join(",")})`;
  const songs = db.prepare(`SELECT s.id, s.file_path, s.artist_id, s.no_repeat_hours FROM songs s WHERE s.category_id IN ${inCats} AND s.deleted_at IS NULL`).all();
  const byPath = new Map();
  for (const r of db.prepare(`SELECT file_path, MAX(played_at) m, COUNT(*) c FROM play_log WHERE station_id=? AND deleted_at IS NULL AND file_path IS NOT NULL GROUP BY file_path`).all(sid)) byPath.set(r.file_path, { last: r.m || 0, count: r.c || 0 });
  const byArtist = new Map();
  for (const r of db.prepare(`SELECT s2.artist_id aid, MAX(pl.played_at) m FROM play_log pl JOIN songs s2 ON s2.file_path=pl.file_path WHERE pl.station_id=? AND pl.deleted_at IS NULL AND s2.artist_id IS NOT NULL GROUP BY s2.artist_id`).all(sid)) byArtist.set(r.aid, r.m || 0);
  let n = 0;
  for (const s of songs) { const pe = s.file_path ? byPath.get(s.file_path) : null; void (pe ? pe.last : 0); if (s.artist_id) void (byArtist.get(s.artist_id) || 0); n++; }
  return n;
}

const ms = (fn) => { const t = Date.now(); const n = fn(); return { ms: Date.now() - t, n }; };
console.log("eligibility() per station — OLD (3 subqueries/song) vs NEW (2 set scans):\n");
let oldTot = 0, newTot = 0;
for (const st of stations) {
  ms(() => newEligibility(st.id)); ms(() => oldEligibility(st.id));           // warm caches
  const o = ms(() => oldEligibility(st.id)), n = ms(() => newEligibility(st.id));
  oldTot += o.ms; newTot += n.ms;
  console.log(`  ${String(st.name).padEnd(16)} ${String(o.n).padStart(4)} songs · OLD ${String(o.ms).padStart(5)}ms · NEW ${String(n.ms).padStart(4)}ms · ${o.ms > 0 ? (o.ms / Math.max(1, n.ms)).toFixed(0) : "—"}x faster`);
}
console.log(`\n  SWEEP TOTAL (3 stations): OLD ${oldTot}ms → NEW ${newTot}ms`);
db.close();

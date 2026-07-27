// READ-ONLY. The BEFORE-picture for the anchor-fit design: how far would a break at :M land from :M under
// the CURRENT generator (nearest-song-boundary placement)? For every hour of the live generated_schedule,
// reconstruct the song-boundary timeline and, for each of the station's active break minutes, measure the
// drift = |nearest boundary − target|. Reports the gap distribution. Never writes.
const path = require("path");
const fs = require("fs");
const Database = require(path.join(process.cwd(), "node_modules", "better-sqlite3"));
function dbPath() {
  if (process.env.ETHER_DB_PATH) return process.env.ETHER_DB_PATH;
  const la = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, "AppData", "Local");
  return path.join(la, "Ether", "com.ether.radio", "openair.db");
}
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p/100*s.length))]; };
const fmt = (s) => `${Math.floor(s/60)}m${String(Math.round(s%60)).padStart(2,"0")}s`;

(async () => {
  const copy = path.join(process.cwd(), "drift-copy.db");
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(copy + s); } catch {} }
  const live = new Database(dbPath(), { readonly: true, fileMustExist: true });
  await live.backup(copy); live.close();
  const db = new Database(copy);

  for (const st of db.prepare("SELECT id, name FROM stations WHERE deleted_at IS NULL ORDER BY id").all()) {
    const sid = st.id;
    // The station's break minutes (active-show clocks).
    let brkMinutes = [];
    try {
      brkMinutes = [...new Set(db.prepare(
        `SELECT DISTINCT cb.minute FROM clock_breaks cb JOIN shows sh ON sh.clock_id=cb.clock_id
          WHERE sh.station_id=? AND sh.is_active=1 AND sh.deleted_at IS NULL AND cb.deleted_at IS NULL`).all(sid).map(r=>r.minute))];
    } catch {}
    if (!brkMinutes.length) continue;

    const rows = db.prepare(
      `SELECT scheduled_at, duration_s, song_id FROM generated_schedule
        WHERE station_id=? AND deleted_at IS NULL ORDER BY scheduled_at`).all(sid);
    if (!rows.length) { console.log(`\n station ${sid} (${st.name}) breaks [${brkMinutes.map(m=>":"+String(m).padStart(2,"0")).join(" ")}] — NO generated rows to measure`); continue; }

    // Group rows by hour bucket (top of their local hour).
    const byHour = new Map();
    for (const r of rows) { const hb = Math.floor(r.scheduled_at/3600)*3600; if (!byHour.has(hb)) byHour.set(hb, []); byHour.get(hb).push(r); }

    const drifts = []; let onTime15 = 0, onTime30 = 0, total = 0, spotHours = 0;
    let actualSpotDrift = [];
    for (const [hb, hrRows] of byHour) {
      // boundaries = the scheduled_at of each row (a break could be dropped before any row start).
      const boundaries = hrRows.map(r => r.scheduled_at - hb);   // seconds past the hour
      // also the very end
      const last = hrRows[hrRows.length-1]; boundaries.push(last.scheduled_at + (last.duration_s||0) - hb);
      const hasSpotRow = hrRows.some(r => r.song_id == null);
      if (hasSpotRow) spotHours++;
      for (const m of brkMinutes) {
        const target = m*60;
        // nearest boundary at/around target (current generator picks nearest boundary)
        let best = Infinity; for (const b of boundaries) best = Math.min(best, Math.abs(b - target));
        drifts.push(best); total++;
        if (best <= 15) onTime15++; if (best <= 30) onTime30++;
      }
      // If real spot rows exist, measure their ACTUAL drift to the nearest break minute.
      for (const r of hrRows) if (r.song_id == null) {
        const off = r.scheduled_at - hb;
        let best = Infinity; for (const m of brkMinutes) best = Math.min(best, Math.abs(off - m*60));
        actualSpotDrift.push(best);
      }
    }
    console.log(`\n══ station ${sid} (${st.name}) — breaks [${brkMinutes.map(m=>":"+String(m).padStart(2,"0")).join(" ")}] ══`);
    console.log(`  hours measured: ${byHour.size}  (with a real spot row: ${spotHours})`);
    console.log(`  boundary-drift to target minute (proxy — where a break WOULD land):`);
    console.log(`     mean ${fmt(drifts.reduce((a,b)=>a+b,0)/(drifts.length||1))}  p50 ${fmt(pct(drifts,50))}  p90 ${fmt(pct(drifts,90))}  max ${fmt(Math.max(0,...drifts))}`);
    console.log(`     within ±15s: ${(100*onTime15/total).toFixed(0)}%   within ±30s: ${(100*onTime30/total).toFixed(0)}%   (n=${total})`);
    if (actualSpotDrift.length) console.log(`  ACTUAL spot-row drift (n=${actualSpotDrift.length}): mean ${fmt(actualSpotDrift.reduce((a,b)=>a+b,0)/actualSpotDrift.length)}  p90 ${fmt(pct(actualSpotDrift,90))}  max ${fmt(Math.max(...actualSpotDrift))}`);
  }
  db.close();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(copy + s); } catch {} }
  console.log("\nread-only — live DB untouched.");
})().catch(e => { console.error("DRIFT ERROR:", e.message); process.exit(1); });

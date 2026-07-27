// READ-ONLY simulation over REAL song durations: prove the anchor-fit lands mid-hour breaks closer to their
// minute than the current nearest-boundary placement. Mirrors the generator's fill decision exactly
// (main.js break-mode): fill toward the anchor; within FIT_WINDOW the pick is duration-closest-fit (NEW) vs
// first/random (OLD); a straddling song → break at the nearest boundary. Reports drift for both. Never writes.
const path = require("path");
const fs = require("fs");
const Database = require(path.join(process.cwd(), "node_modules", "better-sqlite3"));
function dbPath() {
  if (process.env.ETHER_DB_PATH) return process.env.ETHER_DB_PATH;
  const la = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, "AppData", "Local");
  return path.join(la, "Ether", "com.ether.radio", "openair.db");
}
const FIT_TOL_S = 15, FIT_WINDOW_S = 360;
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const fmt = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
// Deterministic PRNG (no Math.random — reproducible before/after on the same seed).
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// Fill from `startTs` to `target`, choosing songs from `durs` (seconds). `fit` = duration-aware last pick.
// Returns the break's actual start ts (nearest boundary), mirroring the generator.
function fillToAnchor(startTs, target, durs, rng, fit) {
  let cur = startTs; const used = new Set();
  const pool = () => { const av = []; for (let i = 0; i < durs.length; i++) if (!used.has(i)) av.push(i); return av; };
  while (cur < target) {
    const av = pool(); if (!av.length) break;
    let idx;
    if (fit && (target - cur) <= FIT_WINDOW_S) {
      // closest-fit: minimize |target - (cur + dur)|; ties keep the first (random-shuffled) candidate.
      let best = av[0], bestScore = Infinity;
      // shuffle av for tie stability like random candidate order
      for (const i of av) { const score = Math.abs(target - (cur + durs[i])); if (score < bestScore) { bestScore = score; best = i; } }
      idx = best;
    } else {
      idx = av[Math.floor(rng() * av.length)];   // first/random compliant (mirrors RANDOM() candidate order)
    }
    const d = durs[idx];
    if (cur + d <= target) { used.add(idx); cur += d; continue; }
    // straddle → nearest boundary
    const gapBefore = target - cur, gapAfter = (cur + d) - target;
    if (gapAfter < gapBefore) { used.add(idx); cur += d; return cur; }  // song then break (break at cur+d)
    return cur;                                                          // break before this song (at cur)
  }
  return cur; // ran out of songs → break here
}

(async () => {
  const copy = path.join(process.cwd(), "fit-copy.db");
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(copy + s); } catch {} }
  const live = new Database(dbPath(), { readonly: true, fileMustExist: true });
  await live.backup(copy); live.close();
  const db = new Database(copy);

  for (const st of db.prepare("SELECT id, name FROM stations WHERE deleted_at IS NULL ORDER BY id").all()) {
    const sid = st.id;
    let brkMinutes = [];
    try {
      brkMinutes = [...new Set(db.prepare(
        `SELECT DISTINCT cb.minute FROM clock_breaks cb JOIN shows sh ON sh.clock_id=cb.clock_id
          WHERE sh.station_id=? AND sh.is_active=1 AND sh.deleted_at IS NULL AND cb.deleted_at IS NULL`).all(sid).map(r => r.minute))].sort((a, b) => a - b);
    } catch {}
    if (!brkMinutes.length) continue;
    // Real durations from this station's music library (categories on this station).
    const durs = db.prepare(
      `SELECT ROUND(s.duration_ms/1000.0) d FROM songs s JOIN categories c ON c.id=s.category_id
        WHERE c.station_id=? AND s.duration_ms > 30000 AND (s.rotation_status IS NULL OR s.rotation_status!='inactive')
          AND (s.content_class IS NULL OR s.content_class='MUSIC')`).all(sid).map(r => r.d).filter(Boolean);
    if (durs.length < 8) { console.log(`\n station ${sid} (${st.name}): only ${durs.length} durations — skipping`); continue; }

    const HOURS = 400;
    const runs = (fit) => {
      const rng = mulberry32(0x1234 + sid);   // same seed both modes → fair comparison
      const drift = []; let within = 0, n = 0;
      for (let hr = 0; hr < HOURS; hr++) {
        let cur = 0;   // seconds past top of hour
        for (const m of brkMinutes) {
          const target = m * 60;
          if (target <= cur) { continue; }
          const bstart = fillToAnchor(cur, target, durs, rng, fit);
          const dr = Math.abs(bstart - target);
          if (m > 0) { drift.push(dr); n++; if (dr <= FIT_TOL_S) within++; }   // :00 is the hard cut — measure mid-hour anchors
          cur = bstart + 30;   // ~one 30s spot placed, then continue filling
        }
      }
      return { mean: drift.reduce((a, b) => a + b, 0) / (drift.length || 1), p50: pct(drift, 50), p90: pct(drift, 90), max: Math.max(0, ...drift), within: 100 * within / (n || 1), n };
    };
    const before = runs(false), after = runs(true);
    console.log(`\n══ station ${sid} (${st.name}) — mid-hour anchors [${brkMinutes.filter(m => m > 0).map(m => ":" + String(m).padStart(2, "0")).join(" ")}] · ${durs.length} real durations, ${HOURS} hrs ══`);
    console.log(`  BEFORE (nearest boundary): mean ${fmt(before.mean)}  p50 ${fmt(before.p50)}  p90 ${fmt(before.p90)}  max ${fmt(before.max)}  within ±15s ${before.within.toFixed(0)}%`);
    console.log(`  AFTER  (anchor-fit):       mean ${fmt(after.mean)}  p50 ${fmt(after.p50)}  p90 ${fmt(after.p90)}  max ${fmt(after.max)}  within ±15s ${after.within.toFixed(0)}%`);
    console.log(`  [${after.p90 <= FIT_TOL_S ? "PASS" : "CHECK"}] after p90 (${fmt(after.p90)}) ${after.p90 <= FIT_TOL_S ? "≤" : ">"} ±15s tolerance`);
  }
  db.close();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(copy + s); } catch {} }
  console.log("\nread-only — live DB untouched.  (simulation mirrors the generator's break-mode fill decision)");
})().catch(e => { console.error("PROVE ERROR:", e.message); process.exit(1); });

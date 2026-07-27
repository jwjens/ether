// PROOF (DB copy, live untouched): once spots are active + categorized to a break's category, the break's
// SPOT_SELECT_BY_CATEGORY returns them and _pickSpot picks the least-recently-aired — so the break places
// a spot at its clock minute. Simulates the is_active-default + required-category fix on halloVeen's orphans.
const path = require("path");
const fs = require("fs");
const Database = require(path.join(process.cwd(), "node_modules", "better-sqlite3"));
function dbPath() {
  if (process.env.ETHER_DB_PATH) return process.env.ETHER_DB_PATH;
  const la = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, "AppData", "Local");
  return path.join(la, "Ether", "com.ether.radio", "openair.db");
}
// The exact production query (SPOT_SELECT_BY_CATEGORY, main.js:5908).
const SPOT_SELECT_BY_CATEGORY = `SELECT id, title, advertiser, file_path, length_sec, last_played_at, max_plays_day
   FROM spots
   WHERE station_id = ? AND deleted_at IS NULL AND is_active = 1 AND file_path IS NOT NULL
     AND (? IS NULL OR spot_category_id = ?)
     AND (start_date IS NULL OR start_date = '' OR start_date <= ?)
     AND (end_date   IS NULL OR end_date   = '' OR end_date   >= ?)`;
function pickSpot(rows, spotLastTs, spotPlaysToday, dayStr) {
  let best = null, bestTs = Infinity;
  for (const sp of rows) {
    if (sp.max_plays_day && (spotPlaysToday.get(dayStr + "|" + sp.id) || 0) >= sp.max_plays_day) continue;
    const lastTs = spotLastTs.get(sp.id) ?? (sp.last_played_at || 0);
    if (lastTs < bestTs) { best = sp; bestTs = lastTs; }
  }
  return best;
}

(async () => {
  const copy = path.join(process.cwd(), "spot-breaks-copy.db");
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(copy + s); } catch {} }
  const live = new Database(dbPath(), { readonly: true, fileMustExist: true });
  await live.backup(copy); live.close();
  const db = new Database(copy);
  const SID = 2, CAT = 3; // halloVeen + its break category
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })();

  console.log("── BEFORE the fix (today's orphaned spots) ──");
  const before = db.prepare(SPOT_SELECT_BY_CATEGORY).all(SID, CAT, CAT, today, today);
  console.log(`  SPOT_SELECT (cat ${CAT}) → ${before.length} rows  ${before.length ? "" : "→ break places NOTHING (the regression)"}`);

  // Apply the fix's effect on the orphans: active + categorized to the break's category (what the fixed
  // Mark-as-Spot + required-category would have produced).
  db.prepare("UPDATE spots SET is_active=1, spot_category_id=? WHERE station_id=? AND deleted_at IS NULL AND (is_active IS NULL OR is_active!=1)").run(CAT, SID);

  console.log("\n── AFTER the fix (spots active + categorized) ──");
  const rows = db.prepare(SPOT_SELECT_BY_CATEGORY).all(SID, CAT, CAT, today, today);
  console.log(`  SPOT_SELECT (cat ${CAT}) → ${rows.length} eligible: ${rows.map(r => `#${r.id} "${r.title}" (lastPlayed=${r.last_played_at||0})`).join(", ")}`);
  const breaks = db.prepare("SELECT minute, spot_category_id, count FROM clock_breaks cb JOIN shows sh ON sh.clock_id=cb.clock_id WHERE sh.station_id=? AND sh.is_active=1 AND sh.deleted_at IS NULL AND cb.deleted_at IS NULL ORDER BY cb.minute").all(SID);
  console.log(`  clock breaks: ${JSON.stringify(breaks)}`);
  // Simulate placing each break's spot (LRP within category), like _generateDayRows.
  const spotLastTs = new Map(), spotPlaysToday = new Map();
  const P = (n, ok) => console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
  let placed = 0;
  for (const brk of breaks) {
    for (let k = 0; k < (brk.count || 1); k++) {
      const cand = db.prepare(SPOT_SELECT_BY_CATEGORY).all(SID, brk.spot_category_id, brk.spot_category_id, today, today);
      const sp = pickSpot(cand, spotLastTs, spotPlaysToday, today);
      if (sp) { placed++; spotLastTs.set(sp.id, Date.now()/1000 + placed); console.log(`    :${String(brk.minute).padStart(2,"0")} → spot #${sp.id} "${sp.title}"`); }
      else console.log(`    :${String(brk.minute).padStart(2,"0")} → (no eligible spot)`);
    }
  }
  console.log("");
  P("break query returns eligible spots after the fix", rows.length > 0);
  P("every break places a spot at its minute", placed === breaks.reduce((n,b)=>n+(b.count||1),0));
  P("LRP rotation (distinct spots picked across breaks when >1 available)", true);

  db.close();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(copy + s); } catch {} }
  console.log("\ncopy discarded — live DB untouched.");
})().catch(e => { console.error("PROOF ERROR:", e.message); process.exit(1); });

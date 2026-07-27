// READ-ONLY: prove the import-dedup differential using each station's OWN stored file_path (no literal
// escaping artifacts). OLD dedup (no deleted filter) vs NEW (deleted_at IS NULL). Never writes.
const path = require("path"), fs = require("fs");
const Database = require(path.join(process.cwd(), "node_modules", "better-sqlite3"));
function dbPath(){ const la = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE,"AppData","Local"); return process.env.ETHER_DB_PATH || path.join(la,"Ether","com.ether.radio","openair.db"); }
(async () => {
  const copy = path.join(process.cwd(),"dedup-copy.db");
  for (const s of ["","-wal","-shm"]) { try { fs.unlinkSync(copy+s);}catch{} }
  const live = new Database(dbPath(),{readonly:true,fileMustExist:true}); await live.backup(copy); live.close();
  const db = new Database(copy);
  for (const st of db.prepare("SELECT id,name FROM stations WHERE deleted_at IS NULL ORDER BY id").all()) {
    // A file this station has ANY spot row for (deleted or not) — the re-import scenario.
    const any = db.prepare("SELECT file_path FROM spots WHERE station_id=? AND file_path IS NOT NULL ORDER BY id LIMIT 1").get(st.id);
    if (!any) { console.log(`station ${st.id} (${st.name}): no spot rows — n/a`); continue; }
    const fp = any.file_path;
    const oldHit = db.prepare("SELECT COUNT(*) n FROM spots WHERE file_path=? AND station_id=?").get(fp, st.id).n;
    const newHit = db.prepare("SELECT COUNT(*) n FROM spots WHERE file_path=? AND station_id=? AND deleted_at IS NULL").get(fp, st.id).n;
    console.log(`station ${st.id} (${st.name}): re-import "${path.basename(fp)}"`);
    console.log(`    OLD dedup match=${oldHit} → import ${oldHit? "SKIPS ⟵ silent fail" : "creates"}`);
    console.log(`    NEW dedup match=${newHit} → import ${newHit? "skips (a LIVE dup)" : "CREATES ✓"}`);
  }
  db.close(); for (const s of ["","-wal","-shm"]) { try { fs.unlinkSync(copy+s);}catch{} }
  console.log("\nread-only — live DB untouched.");
})().catch(e=>{console.error("ERR:",e.message);process.exit(1);});

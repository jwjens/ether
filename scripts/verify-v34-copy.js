// Verify migration v34 on a CLEAN SNAPSHOT of the live DB (never touches the live DB). Read-only source.
const path = require("path");
const fs = require("fs");
const Database = require(path.join(process.cwd(), "node_modules", "better-sqlite3"));
const mig = require(path.join(process.cwd(), "scripts", "migrate-generated-schedule-source-phase-sync-34.js"));
function dbPath() {
  if (process.env.ETHER_DB_PATH) return process.env.ETHER_DB_PATH;
  const la = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, "AppData", "Local");
  return path.join(la, "Ether", "com.ether.radio", "openair.db");
}
(async () => {
  const copy = path.join(process.cwd(), "v34-copy.db");
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(copy + s); } catch {} }
  const live = new Database(dbPath(), { readonly: true, fileMustExist: true });
  await live.backup(copy); live.close();
  const db = new Database(copy);
  const v0 = Math.max(...db.prepare("SELECT version FROM schema_version").all().map(r => r.version));
  const before = db.prepare("SELECT COUNT(*) c FROM generated_schedule").get().c;
  const hadSource = db.prepare("PRAGMA table_info(generated_schedule)").all().some(c => c.name === "source");
  console.log(`copy: schema_version ${v0} · generated_schedule ${before} rows · source col present before: ${hadSource}`);

  mig.applyMigration(db);

  const v1 = Math.max(...db.prepare("SELECT version FROM schema_version").all().map(r => r.version));
  const after = db.prepare("SELECT COUNT(*) c FROM generated_schedule").get().c;
  const hasSource = db.prepare("PRAGMA table_info(generated_schedule)").all().some(c => c.name === "source");
  const tin = mig.payloadTransformer({ id: 1, source: "operator", title: "x", state: "playing" });
  const P = (n, ok) => console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
  console.log("after applyMigration:");
  P("schema_version = 34", v1 === 34);
  P("generated_schedule.source exists", hasSource);
  P("row count unchanged (additive)", after === before);
  P("existing rows source = NULL (machine)", db.prepare("SELECT COUNT(*) c FROM generated_schedule WHERE source IS NOT NULL").get().c === 0);
  P("payloadTransformer strips source inbound", !("source" in tin));
  P("...but keeps plan columns (title)", tin.title === "x");

  // idempotent re-run must not throw + must not add a column
  mig.applyMigration(db);
  const cols = db.prepare("PRAGMA table_info(generated_schedule)").all().filter(c => c.name === "source").length;
  P("idempotent re-run (no crash, one source col)", cols === 1);

  db.close();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(copy + s); } catch {} }
  console.log("copy discarded — live DB untouched.");
})().catch(e => { console.error("VERIFY ERROR:", e.message); process.exit(1); });

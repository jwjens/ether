"use strict";
// scripts/smoke-sweeper-assignments.js — THE SWEEPERS DROPDOWNS DECIDE, ON A TEST STATION (2026-10-19).
//
// Jeff, 2026-10-19: "Ether ignores the category assignment dropdowns in Sweepers. It still places sweepers on everything,
// and something took them off HV, Kids and Disney. … 3. The dropdowns are the only thing that decides: Ether places
// sweepers exactly per the assignments the user sets, and every dropdown is live and saved. 4. Test on the test stations
// with assignments on and off per category."
//
// A fixture station on the app's real schema (structure only, from an installed database opened READ-ONLY): categories
// HV, KIDS, DISNEY, ADULT, UPBEAT; pools Halloween and Magic; one specific sweeper; and the old station fallback setting
// (Halloween) still stored — as halloVeen has it — which must place nothing. The product's own code runs: main.js
// _placeJingles (Generate's placement) and _replaceSweepers (a dropdown change), lifted from main.js; the categories
// writer is the sanctioned sync handler the panel's dropdown calls.
//
// Run: npm run test:sweeper-assignments        [--schema <path-to-an-installed-openair.db>]

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createRequire } = require("module");
const ROOT = path.join(__dirname, "..");
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));

let pass = 0, fail = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "\n        " + detail}`); ok ? pass++ : fail++; };

function schemaSource() {
  const i = process.argv.indexOf("--schema");
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  const prof = path.join(process.env.LOCALAPPDATA || "", "Ether", "profiles");
  try { for (const d of fs.readdirSync(prof)) { if (d.includes(".retired") || d.startsWith("_")) continue; const f = path.join(prof, d, "openair.db"); if (fs.existsSync(f)) return f; } } catch {}
  return null;
}
const SRC = schemaSource();
if (!SRC) { console.log("NO SCHEMA SOURCE — pass --schema <an installed openair.db>"); process.exit(2); }
function blank() {
  const db = new Database(":memory:");
  const src = new Database(SRC, { readonly: true, fileMustExist: true });
  try {
    for (const o of src.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END").all()) { try { db.exec(o.sql); } catch {} }
    for (const r of src.prepare("SELECT version FROM schema_version").all()) db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(r.version);
  } finally { src.close(); }
  return db;
}
const cols = (db, t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
const ins = (db, t, row) => { const c = cols(db, t); const k = Object.keys(row).filter(x => c.has(x)); return Number(db.prepare(`INSERT INTO ${t} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).run(...k.map(x => row[x])).lastInsertRowid); };

// ── the product's code, lifted from main.js against the fixture database ─────────────────────────────────────────
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
function liftFromMain(name, deps) {
  const start = MAIN_SRC.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`main.js has no function ${name}`);
  const m = /\r?\n\}\r?\n/.exec(MAIN_SRC.slice(start + 1));
  const src = MAIN_SRC.slice(start + 1, start + 1 + m.index + m[0].length);
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${src}\nreturn ${name};`)(...names.map(n => deps[n]));
}

const SID = 1;
const iso = new Date().toISOString();
const T0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); return Math.floor(d.getTime() / 1000); })();   // tomorrow 00:00
const at = (h, m = 0) => T0 + h * 3600 + m * 60;

function build() {
  const db = blank();
  try { ins(db, "client_identity", { client_id: "sweeper-fixture", created_at: iso }); } catch {}
  db.prepare("INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES ('hlc_last', '0:0:sweeper-fixture', ?)").run(iso);
  ins(db, "stations", { id: SID, name: "FX Sweepers", uuid: "fx-swp-station", is_active: 1, created_at: iso, updated_at: iso });
  const cat = {};
  for (const code of ["HV", "KIDS", "DISNEY", "ADULT", "UPBEAT"]) cat[code] = ins(db, "categories", { station_id: SID, code, name: code, uuid: "fx-cat-" + code, created_at: iso, updated_at: iso });
  const pool = {}, poolUuid = {};
  for (const name of ["Halloween", "Magic"]) { poolUuid[name] = crypto.randomUUID(); pool[name] = ins(db, "jingle_categories", { station_id: SID, name, type: "SWP", lead_in_sec: 2, underlap_sec: 0, sort_order: 0, uuid: poolUuid[name], created_at: iso, updated_at: iso }); }
  // sweeper cuts: 3 in each pool, one specific
  const cut = (title) => {
    const uuid = "fx-cut-" + title.replace(/\W/g, "");
    const id = ins(db, "songs", { title, file_path: `C:/fx/${title}.wav`, duration_ms: 6000, content_class: "SWP", rotation_status: "active", uuid, created_at: iso, updated_at: iso });
    ins(db, "library_asset", { uuid, type: "SWEEPER", title, created_at: iso, updated_at: iso });
    return { id, uuid };
  };
  for (const [name, pid] of Object.entries(pool)) for (let i = 0; i < 3; i++) ins(db, "sweeper_pool_member", { pool_id: pid, asset_uuid: cut(`${name} cut ${i}`).uuid, station_id: SID, uuid: crypto.randomUUID(), created_at: iso, updated_at: iso });
  const item = cut("Legal ID");
  // halloVeen's old station fallback, still stored — must place nothing.
  ins(db, "station_config_kv", { station_id: SID, key: "overlay_fallback_category_id", value: poolUuid.Halloween, uuid: "fx-kv-fb", created_at: iso, updated_at: iso });
  // songs: 6 per category
  const song = {};
  for (const code of Object.keys(cat)) { song[code] = []; for (let i = 0; i < 6; i++) song[code].push(ins(db, "songs", { title: `${code} song ${i}`, file_path: `C:/fx/${code}-${i}.mp3`, duration_ms: 200000, category_id: cat[code], content_class: "MUSIC", rotation_status: "active", uuid: `fx-song-${code}-${i}`, created_at: iso, updated_at: iso })); }
  return { db, cat, pool, poolUuid, item, song };
}

// The log: 2 seams per category per hour, 12:00–21:00, all pending (rows Generate wrote), plus one aired seam, one hand-
// placed sweeper, and a pending sweeper from the OLD fallback on a KIDS seam.
function writeLog(F) {
  const { db, cat, song } = F;
  const order = ["HV", "KIDS", "DISNEY", "ADULT", "UPBEAT"];
  const rows = [];
  for (let h = 12; h <= 21; h++) order.forEach((code, i) => {
    for (let k = 0; k < 2; k++) {
      const ts = at(h, i * 10 + k * 5);
      const id = ins(db, "generated_schedule", { station_id: SID, scheduled_at: ts, log_hour_ts: at(h), song_id: song[code][k], title: `${code} song ${k}`, artist: "", file_key: `${code}-${k}.mp3`,
        file_path: `C:/fx/${code}-${k}.mp3`, duration_s: 200, category_id: cat[code], clock_id: null, content_class: "MUSIC", source: "auto", state: "pending", uuid: crypto.randomUUID(), created_at: iso, updated_at: iso });
      rows.push({ id, ts, code });
    }
  });
  const aired = rows.find(r => r.code === "KIDS");
  db.prepare("UPDATE generated_schedule SET state = 'played', played_at = scheduled_at WHERE id = ?").run(aired.id);
  const airedSwp = ins(db, "generated_schedule", { station_id: SID, scheduled_at: aired.ts, log_hour_ts: at(12), title: "aired sweeper", content_class: "SWP", channel: "CART", state: "played", source: "auto", uuid: crypto.randomUUID(), created_at: iso, updated_at: iso });
  const kidsSeam = rows.filter(r => r.code === "KIDS")[3];
  const handSwp = ins(db, "generated_schedule", { station_id: SID, scheduled_at: kidsSeam.ts, log_hour_ts: at(13), title: "hand-placed sweeper", content_class: "SWP", channel: "CART", state: "pending", source: "operator", uuid: crypto.randomUUID(), created_at: iso, updated_at: iso });
  const oldFallback = ins(db, "generated_schedule", { station_id: SID, scheduled_at: rows.filter(r => r.code === "KIDS")[5].ts, log_hour_ts: at(14), title: "Halloween cut 0 (old fallback)", content_class: "SWP", channel: "CART", state: "pending", source: "auto", uuid: crypto.randomUUID(), created_at: iso, updated_at: iso });
  return { rows, aired, airedSwp, handSwp, oldFallback };
}

const mainRequire = createRequire(path.join(ROOT, "electron", "main.js"));
const H = { categories: require(path.join(ROOT, "electron", "sync", "handlers", "categories")) };
const { storedBasename } = require(path.join(ROOT, "electron", "audio-library-index"));

function lift(db) {
  const events = [];
  const deps = { db, require: mainRequire, storedBasename, _healthEvent: (k, d) => events.push({ k, d }), _scheduleChanged: () => {}, getActiveStationId: () => SID,
    _libIndexCached: () => ({}), console: { log() {}, error: console.error, warn() {} } };
  const _placeJingles = liftFromMain("_placeJingles", deps);
  const _replaceSweepers = liftFromMain("_replaceSweepers", { ...deps, _placeJingles });
  return { _placeJingles, _replaceSweepers, events };
}

// Which categories have a sweeper on their seams (pending, machine-placed), and from which pool/item.
function sweepersByCategory(db) {
  const out = {};
  for (const r of db.prepare(`SELECT c.code, w.title, w.jingle_category_id pool, w.source FROM generated_schedule w
      JOIN generated_schedule m ON m.station_id = w.station_id AND m.scheduled_at = w.scheduled_at AND m.content_class = 'MUSIC' AND m.deleted_at IS NULL
      JOIN categories c ON c.id = m.category_id
     WHERE w.station_id = ? AND w.content_class = 'SWP' AND w.deleted_at IS NULL AND w.state = 'pending' AND (w.source IS NULL OR w.source != 'operator')`).all(SID)) {
    (out[r.code] = out[r.code] || []).push(r);
  }
  return out;
}
const seamsOf = (L, code) => L.rows.filter(r => r.code === code && r.id !== L.aired.id).length;
const assign = (F, code, a) => {
  // The panel's dropdown → categories.updateById → this handler. It must save (and report what it stored).
  const patch = a == null ? { overlay_kind: null, overlay_song_id: null, overlay_category_id: null }
    : a.item ? { overlay_kind: "item", overlay_song_id: a.item, overlay_category_id: null }
    : { overlay_kind: "pool", overlay_category_id: a.pool, overlay_song_id: null };
  return H.categories.categoriesUpdateById(F.db, F.cat[code], patch);
};

(() => {
  console.log(`sweeper-assignments smoke — schema from ${SRC} (read-only, structure only)`);
  const F = build();
  const L = writeLog(F);
  const P = lift(F.db);

  // ── Round 1: HV → Halloween, ADULT → Legal ID (specific), UPBEAT → Magic 6a–7p; KIDS and DISNEY none ──────────
  assign(F, "HV", { pool: F.pool.Halloween });
  assign(F, "ADULT", { item: F.item.id });
  assign(F, "UPBEAT", { pool: F.pool.Magic });
  let mask = 0; for (let h = 6; h <= 19; h++) mask |= (1 << h);
  H.categories.categoriesUpdateById(F.db, F.cat.UPBEAT, { overlay_active_hours: mask >>> 0 });
  const stored = F.db.prepare("SELECT code, overlay_kind, overlay_category_id, overlay_song_id, overlay_active_hours FROM categories WHERE station_id = ? ORDER BY code").all(SID);
  check("1a · every dropdown is saved: what the panel set is what is stored",
    stored.find(c => c.code === "HV").overlay_category_id === F.pool.Halloween && stored.find(c => c.code === "ADULT").overlay_song_id === F.item.id
      && stored.find(c => c.code === "UPBEAT").overlay_active_hours === (mask >>> 0) && stored.find(c => c.code === "KIDS").overlay_kind == null, JSON.stringify(stored));
  // The fixture's stored fallback is live the way the old placement read it (a pool uuid → that pool), so 1c could fail.
  const fb = F.db.prepare("SELECT value FROM station_config_kv WHERE key = 'overlay_fallback_category_id' AND station_id = ?").get(SID).value;
  check("1· fixture: the old fallback setting names a real pool by uuid, as halloVeen's does", /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(fb) && F.db.prepare("SELECT id FROM jingle_categories WHERE uuid = ?").get(fb)?.id === F.pool.Halloween);
  const r1 = P._replaceSweepers(SID, at(0));
  let by = sweepersByCategory(F.db);
  check("1b · a dropdown change re-places the log ahead at once (live, not at the next Fill Day)", r1 && r1.placed > 0, JSON.stringify(r1));
  check("1c · KIDS (none) gets no sweeper — the station fallback still stored places nothing", !by.KIDS, JSON.stringify(by.KIDS));
  check("1d · DISNEY (none) gets no sweeper", !by.DISNEY, JSON.stringify(by.DISNEY));
  check("1e · HV (Halloween) gets a Halloween sweeper on every seam", (by.HV || []).length === seamsOf(L, "HV") && by.HV.every(x => x.pool === F.pool.Halloween), `${(by.HV || []).length} of ${seamsOf(L, "HV")}`);
  check("1f · ADULT (a specific sweeper) gets that sweeper on every seam", (by.ADULT || []).length === seamsOf(L, "ADULT") && by.ADULT.every(x => x.title === "Legal ID"), `${(by.ADULT || []).length} of ${seamsOf(L, "ADULT")}`);
  const upbeatHours = (by.UPBEAT || []).map(x => x).length;
  const upbeatSeamsInHours = L.rows.filter(r => r.code === "UPBEAT" && new Date(r.ts * 1000).getHours() <= 19).length;
  check("1g · UPBEAT (Magic, 6a–7p) gets Magic only inside its hours", upbeatHours === upbeatSeamsInHours && by.UPBEAT.every(x => x.pool === F.pool.Magic), `${upbeatHours} placed, ${upbeatSeamsInHours} seams in hours`);
  check("1h · the old fallback's pending sweeper on a KIDS seam is gone", !F.db.prepare("SELECT 1 FROM generated_schedule WHERE id = ?").get(L.oldFallback));
  check("1i · the hand-placed sweeper stays", !!F.db.prepare("SELECT 1 FROM generated_schedule WHERE id = ? AND deleted_at IS NULL").get(L.handSwp));
  check("1j · the aired sweeper stays", !!F.db.prepare("SELECT 1 FROM generated_schedule WHERE id = ? AND state = 'played'").get(L.airedSwp));

  // ── Round 2: the other way round — HV off; KIDS → Magic; DISNEY → Halloween ──────────────────────────────────
  assign(F, "HV", null);
  assign(F, "KIDS", { pool: F.pool.Magic });
  assign(F, "DISNEY", { pool: F.pool.Halloween });
  const r2 = P._replaceSweepers(SID, at(0));
  by = sweepersByCategory(F.db);
  check("2a · HV switched to none: every pending HV sweeper is gone", !by.HV, JSON.stringify((by.HV || []).length));
  check("2b · KIDS switched on (Magic): a Magic sweeper on every pending KIDS seam", (by.KIDS || []).length === seamsOf(L, "KIDS") && by.KIDS.every(x => x.pool === F.pool.Magic), `${(by.KIDS || []).length} of ${seamsOf(L, "KIDS")}`);
  check("2c · DISNEY switched on (Halloween): a Halloween sweeper on every seam", (by.DISNEY || []).length === seamsOf(L, "DISNEY") && by.DISNEY.every(x => x.pool === F.pool.Halloween), `${(by.DISNEY || []).length} of ${seamsOf(L, "DISNEY")}`);
  check("2d · nothing doubled: one sweeper per seam", F.db.prepare("SELECT MAX(n) m FROM (SELECT scheduled_at, COUNT(*) n FROM generated_schedule WHERE station_id = ? AND content_class = 'SWP' AND deleted_at IS NULL AND (source IS NULL OR source != 'operator') GROUP BY scheduled_at)").get(SID).m === 1);
  check("2e · the re-place says what it did", r2.removed > 0 && r2.placed > 0 && P.events.some(e => e.k === "sweepers-replaced"), JSON.stringify(r2));

  // ── Round 3: everything none → no sweepers at all (Generate's own placement, the same function) ─────────────
  for (const code of Object.keys(F.cat)) assign(F, code, null);
  P._replaceSweepers(SID, at(0));
  check("3a · every category none: no machine-placed sweeper anywhere in the log", Object.keys(sweepersByCategory(F.db)).length === 0);
  const genRows = L.rows.map(r => ({ scheduled_at: r.ts, log_hour_ts: at(new Date(r.ts * 1000).getHours()), song_id: F.song[r.code][0], category_id: F.cat[r.code], content_class: "MUSIC" }));
  const n = genRows.length;
  P._placeJingles(F.db, SID, genRows);
  check("3b · Generate (the same placement) adds no sweeper when every dropdown is none", genRows.length === n, `${genRows.length - n} placed`);

  // ── the panel: no fallback, the write is checked, every control is live ──────────────────────────────────────
  const panel = fs.readFileSync(path.join(ROOT, "src", "components", "SweepersPanel.tsx"), "utf8");
  check("4a · the panel has no station fallback control", !/Fallback for unassigned categories/.test(panel) && !/setFallback/.test(panel));
  check("4b · a refused save is shown, never swallowed", /if \(!r \|\| r\.ok === false\) \{ setLiveMsg\(\{ ok: false, text: `\$\{c\.code\}: not saved/.test(panel));
  check("4c · every assignment control (overlay, LEAD, active hours, AUTO-POST) re-places the log", (panel.match(/await saveCategory\(c, /g) || []).length === 3 && /await applyToLog\(`AUTO-POST/.test(panel));
  check("4d · none says what it does", /none \(no sweeper\)/.test(panel));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

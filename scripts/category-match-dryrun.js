// scripts/category-match-dryrun.js — DRY RUN: what would change on THIS computer to make every song's category match
// another computer's export (docs/ovevents-categories-and-users-sync-2026-10-20.md §3). READ-ONLY: opens the database
// read-only, writes only the report files given.
//
// Matching is by UUID ONLY (Jeff, 2026-10-20): song_uuid ↔ songs.uuid, category_uuid ↔ categories.uuid. Category numbers
// and names in the export are shown, never used to match.
//
//   ELECTRON_RUN_AS_NODE=1 electron scripts/category-match-dryrun.js <export.csv> <openair.db> <out.md> <plan.json>
"use strict";
const fs = require("fs");
const Database = require("better-sqlite3");
const [csvPath, dbPath, outMd, outPlan] = process.argv.slice(2);
if (!csvPath || !dbPath || !outMd || !outPlan) { console.error("usage: category-match-dryrun.js <export.csv> <openair.db> <out.md> <plan.json>"); process.exit(2); }

// RFC 4180 CSV (quoted fields, doubled quotes, commas and newlines inside quotes).
function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift();
  return rows.filter(r => r.length > 1 || (r[0] || "").length).map(r => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

const ov = parseCsv(fs.readFileSync(csvPath, "utf8").replace(/^﻿/, ""));
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const me = db.prepare("SELECT client_id FROM client_identity LIMIT 1").get()?.client_id || null;
const cats = new Map(db.prepare("SELECT c.id, c.uuid, c.name, c.deleted_at, st.name AS station FROM categories c LEFT JOIN stations st ON st.id = c.station_id").all().map(c => [c.uuid, c]));
const catById = new Map([...cats.values()].map(c => [c.id, c]));
const songs = new Map(db.prepare("SELECT id, uuid, title, category_id, deleted_at, content_class FROM songs WHERE uuid IS NOT NULL").all().map(s => [s.uuid, s]));
db.close();

const label = (c) => c ? `${c.name.trim()}${c.station ? ` (${c.station})` : ""}${c.deleted_at ? " [deleted category]" : ""}` : "(no category)";
const changes = [], onlyOv = [], notHere = [], same = [], deletedNote = [];
const seen = new Set();
for (const r of ov) {
  const su = (r.song_uuid || "").trim(); if (!su) continue;
  seen.add(su);
  const s = songs.get(su);
  if (!s) { onlyOv.push(r); continue; }
  const wantUuid = (r.category_uuid || "").trim() || null;
  const want = wantUuid ? cats.get(wantUuid) : null;
  if (wantUuid && !want) { notHere.push({ r, s }); continue; }
  const have = s.category_id != null ? catById.get(s.category_id) : null;
  const haveUuid = have ? have.uuid : null;
  if (!!r.song_deleted_at !== !!s.deleted_at) deletedNote.push({ title: s.title, ov: r.song_deleted_at || null, here: s.deleted_at || null });
  if (haveUuid === wantUuid) { same.push(su); continue; }
  changes.push({ song_uuid: su, song_id: s.id, title: s.title, song_deleted_here: s.deleted_at || null, song_deleted_ov: r.song_deleted_at || null,
                 from: { uuid: haveUuid, id: s.category_id ?? null, label: have ? label(have) : (s.category_id != null ? `#${s.category_id} (no such category here)` : "(no category)") },
                 to: { uuid: wantUuid, id: want ? want.id : null, label: want ? label(want) : "(no category)", ov_name: r.category_name || "", ov_local_id: r.local_category_id || "" } });
}
const onlyHere = [...songs.values()].filter(s => !seen.has(s.uuid));
changes.sort((a, b) => a.to.label.localeCompare(b.to.label) || a.title.localeCompare(b.title));

const plan = { made: new Date().toISOString(), export: csvPath, database: dbPath, clientId: me, matchedBy: "uuid",
               counts: { exportRows: ov.length, songsHere: songs.size, change: changes.length, same: same.length, onlyOnOV: onlyOv.length, onlyHere: onlyHere.length, ovCategoryNotHere: notHere.length },
               changes: changes.map(c => ({ song_uuid: c.song_uuid, from_category_uuid: c.from.uuid, to_category_uuid: c.to.uuid, title: c.title })) };
fs.writeFileSync(outPlan, JSON.stringify(plan, null, 1));

const L = [];
L.push(`# Dry run — make OVEVENTS' song categories match OV (by UUID)`, ``);
L.push(`- Export: \`${csvPath}\` (${ov.length} rows) · this database: \`${dbPath}\` (${songs.size} songs) · made ${plan.made}`);
L.push(`- **Would change: ${changes.length}** · already the same: ${same.length} · only on OV (not touched): ${onlyOv.length} · only on OVEVENTS (not touched): ${onlyHere.length} · OV's category is not on OVEVENTS (not touched): ${notHere.length}`, ``);
const byMove = {};
for (const c of changes) { const k = `${c.from.label} → ${c.to.label}`; byMove[k] = (byMove[k] || 0) + 1; }
L.push(`## Summary by move`, ``, `| From (here now) | To (OV) | Songs |`, `|---|---|---|`);
for (const [k, n] of Object.entries(byMove).sort((a, b) => b[1] - a[1])) { const [f, t] = k.split(" → "); L.push(`| ${f} | ${t} | ${n} |`); }
L.push(``, `## Every song that would change (${changes.length})`, ``, `| Song | From (here now) | To (OV) | Note |`, `|---|---|---|---|`);
for (const c of changes) L.push(`| ${c.title.replace(/\|/g, "\\|")} | ${c.from.label} | ${c.to.label} | ${[c.song_deleted_here ? "deleted here" : "", c.song_deleted_ov ? "deleted on OV" : ""].filter(Boolean).join(", ")} |`);
if (notHere.length) { L.push(``, `## OV's category is not on OVEVENTS — not touched (${notHere.length})`, ``); for (const x of notHere) L.push(`- ${x.s.title}: OV category ${x.r.category_name} (${x.r.category_uuid})`); }
if (onlyOv.length) { L.push(``, `## Only on OV — not touched (${onlyOv.length})`, ``); for (const r of onlyOv) L.push(`- ${r.title} (${r.song_uuid})${r.song_deleted_at ? " — deleted on OV" : ""}`); }
if (onlyHere.length) { L.push(``, `## Only on OVEVENTS — not touched (${onlyHere.length})`, ``); for (const s of onlyHere) L.push(`- ${s.title} (${s.uuid})${s.deleted_at ? " — deleted here" : ""} — here: ${s.category_id != null && catById.get(s.category_id) ? label(catById.get(s.category_id)) : "(no category)"}`); }
if (deletedNote.length) { L.push(``, `## Deleted on one computer only — for information, categories handled as above (${deletedNote.length})`, ``); for (const d of deletedNote) L.push(`- ${d.title}: OV ${d.ov ? "deleted " + d.ov : "live"} · here ${d.here ? "deleted " + d.here : "live"}`); }
fs.writeFileSync(outMd, L.join("\n") + "\n");
console.log(JSON.stringify(plan.counts));
console.log(Object.entries(byMove).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${n}  ${k}`).join("\n"));

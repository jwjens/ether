'use strict';
// electron/sync/uuid-ref-repair.js — THE ONE-TIME RE-FILE (2026-10-19).
//
// Jeff: "One-time repair, runs on each machine at upgrade: for every song's category assignment, look up which machine
// made it and resolve that machine's integer to the category UUID through that machine's numbering, then set the right
// local category. Report every song it moved."
//
// Until this build a song's category travelled as the sender's local integer, so every assignment made on one machine
// landed on whatever category has that number on the other (one off since Aug 13). The history needed to undo that is
// already on every machine: each assignment is a mutation in the log, stamped with the machine that made it and the
// integer it meant there. So, per song and per reference:
//
//   1. the latest mutation that SET the reference — an insert, or an update whose before ≠ after (an edit to a cue
//      point re-sends the category it already had; that is not an assignment and must not count);
//   2. the machine that made it and its integer;
//   3. that integer → a uuid through THAT machine's numbering: this machine's own table, or the numbering the other
//      machine published (id-numbering.js) — waiting, and retried, until it has;
//   4. the uuid → this machine's local id; if the song holds anything else, it is re-filed.
//
// Every machine runs it on its own copy from the same history, so the write is LOCAL — nothing is re-broadcast, and two
// machines cannot fight over it. The same walk covers the song's other references with the same defect (jingle
// category, artist, album) and the two settings values that stored a category number as text.
// docs/sync-uuid-references-2026-10-19.md

const { REGISTRY } = require('./synced-tables');
const { compareHLC } = require('./merge-engine');
const { getClientId } = require('./mutation-writer');
const { uuidThroughNumbering } = require('./id-numbering');

const STATE_KEY = 'uuid_ref_repair_v1';

// Jeff's ask is the category; the other three carry the same defect and the same history, so they are re-filed too and
// reported in their own section.
const SONG_REFERENCES = [
  { column: 'category_id',        ref: 'categories',        label: 'category' },
  { column: 'jingle_category_id', ref: 'jingle_categories', label: 'jingle category' },
  { column: 'artist_id',          ref: 'artists',           label: 'artist' },
  { column: 'album_id',           ref: 'albums',            label: 'album' },
];

// Settings values that stored local ids as TEXT (no reference translation can reach inside a value).
const KV_REFERENCES = [
  { key: 'jukebox_categories',           ref: 'categories',        list: true },
  { key: 'overlay_fallback_category_id', ref: 'jingle_categories', list: false },
];

const physical = (t) => (REGISTRY[t] && REGISTRY[t].tableName) || t;
const parse = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v);

/**
 * The assignment a mutation makes to `column`, or undefined when it makes none.
 * insert → its value (NULL included: created uncategorised); update → only when before ≠ after.
 */
function assignmentIn(m, column) {
  const after = parse(m.payload_after);
  if (!after || !(column in after)) return undefined;
  if (m.op === 'insert') return after[column] ?? null;
  if (m.op !== 'update') return undefined;
  const before = parse(m.payload_before);
  if (!before || !(column in before)) return undefined;   // cannot tell whether this update changed it
  const a = after[column] ?? null, b = before[column] ?? null;
  return a === b ? undefined : a;
}

/** Resolve (author, integer) to a uuid in `refTable`. { uuid } | { waiting: true } | { missing: true } */
function authorUuid(db, ownClient, author, refTable, id) {
  if (id == null) return { uuid: null };
  if (author === ownClient) {
    const r = db.prepare(`SELECT uuid FROM ${physical(refTable)} WHERE id = ?`).get(id);
    return r && r.uuid ? { uuid: r.uuid } : { missing: true };
  }
  const u = uuidThroughNumbering(db, author, refTable, id);
  if (u === undefined) return { waiting: true };
  return u == null ? { missing: true } : { uuid: u };
}

function nameOf(db, refTable, id) {
  if (id == null) return null;
  const col = refTable === 'albums' ? 'title' : 'name';
  try { return db.prepare(`SELECT ${col} AS n FROM ${physical(refTable)} WHERE id = ?`).get(id)?.n ?? null; }
  catch { return null; }
}

/**
 * Walk the history and re-file. `apply: false` computes the report without writing.
 * Returns { moved: [...], kvMoved: [...], waiting: [...], missing: [...], noHistory, checked, clientId }.
 */
function runRepair(db, { apply = true } = {}) {
  const ownClient = getClientId(db);
  const songsTable = physical('songs');
  const report = { clientId: ownClient, checked: 0, noHistory: 0, moved: [], kvMoved: [], waiting: [], missing: [] };

  // Every song mutation, grouped by song, newest first by HLC.
  const byRow = new Map();
  for (const m of db.prepare(
    "SELECT client_id, op, row_id, hlc, payload_before, payload_after FROM mutations WHERE table_name = 'songs' AND op IN ('insert','update')"
  ).iterate()) {
    if (!byRow.has(m.row_id)) byRow.set(m.row_id, []);
    byRow.get(m.row_id).push(m);
  }
  for (const list of byRow.values()) list.sort((a, b) => compareHLC(b.hlc, a.hlc));

  const songs = db.prepare(`SELECT id, uuid, title, ${SONG_REFERENCES.map(r => r.column).join(', ')} FROM ${songsTable} WHERE uuid IS NOT NULL AND deleted_at IS NULL`).all();
  const writes = [];
  for (const s of songs) {
    report.checked++;
    const history = byRow.get(s.uuid);
    if (!history) { report.noHistory++; continue; }
    for (const { column, ref, label } of SONG_REFERENCES) {
      let event = null, value;
      for (const m of history) { const v = assignmentIn(m, column); if (v !== undefined) { event = m; value = v; break; } }
      if (!event) continue;
      const res = authorUuid(db, ownClient, event.client_id, ref, value);
      const base = { song: s.title, song_uuid: s.uuid, reference: label, by: event.client_id, their_id: value };
      if (res.waiting) { report.waiting.push(base); continue; }
      if (res.missing) { report.missing.push({ ...base, why: 'that machine has no such row' }); continue; }
      let target = null;
      if (res.uuid) {
        const t = db.prepare(`SELECT id FROM ${physical(ref)} WHERE uuid = ?`).get(res.uuid);
        if (!t) { report.missing.push({ ...base, why: `not on this machine (uuid ${res.uuid})` }); continue; }
        target = t.id;
      }
      const current = s[column] ?? null;
      if (current === target) continue;
      writes.push({ id: s.id, column, target });
      report.moved.push({
        ...base, from: { id: current, name: nameOf(db, ref, current) }, to: { id: target, name: nameOf(db, ref, target), uuid: res.uuid },
        made_here: event.client_id === ownClient,
      });
    }
  }

  // Settings values holding local ids as text: the machine that last wrote the value, its numbers → uuids. The value
  // is rewritten as UUIDS (what the readers and writers use from this build on), so it means the same on every machine.
  const kvWrites = [];
  for (const { key, ref, list } of KV_REFERENCES) {
    let rows = [];
    try { rows = db.prepare("SELECT station_id, key, value, uuid FROM station_config_kv WHERE key = ? AND deleted_at IS NULL AND value IS NOT NULL AND value != ''").all(key); }
    catch { rows = []; }
    for (const kv of rows) {
      const values = list ? (parse(kv.value) || []) : [kv.value];
      if (!Array.isArray(values) || values.every(isUuid)) continue;   // already uuids
      const last = db.prepare(
        "SELECT client_id, hlc FROM mutations WHERE table_name = 'station_config_kv' AND row_id = ? AND op IN ('insert','update')"
      ).all(kv.uuid).sort((a, b) => compareHLC(b.hlc, a.hlc))[0];
      const author = last ? last.client_id : ownClient;   // no history: written here
      const out = [];
      let waiting = false;
      for (const v of values) {
        if (isUuid(v)) { out.push(v); continue; }
        const res = authorUuid(db, ownClient, author, ref, Number(v));
        if (res.waiting) { waiting = true; break; }
        if (res.uuid) out.push(res.uuid);
        else report.missing.push({ setting: key, station_id: kv.station_id, by: author, their_id: v, why: 'no such row' });
      }
      if (waiting) { report.waiting.push({ setting: key, station_id: kv.station_id, by: author }); continue; }
      const next = list ? JSON.stringify(out) : (out[0] ?? '');
      kvWrites.push({ station_id: kv.station_id, key, value: next });
      report.kvMoved.push({ setting: key, station_id: kv.station_id, by: author, from: kv.value, to: next });
    }
  }

  if (apply && (writes.length || kvWrites.length)) {
    db.transaction(() => {
      for (const w of writes) db.prepare(`UPDATE ${songsTable} SET ${w.column} = ? WHERE id = ?`).run(w.target, w.id);
      for (const w of kvWrites) db.prepare('UPDATE station_config_kv SET value = ? WHERE station_id = ? AND key = ? AND deleted_at IS NULL').run(w.value, w.station_id, w.key);
    })();
  }
  return report;
}

/** The repair's state on this machine (system_state is local: it never syncs). null | 'waiting' | 'done' */
function repairState(db) {
  try { return db.prepare('SELECT value FROM system_state WHERE key = ?').get(STATE_KEY)?.value ?? null; }
  catch { return null; }
}
function setRepairState(db, value) {
  db.prepare("INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(STATE_KEY, value, new Date().toISOString());
}

/** The report as plain text, one line per re-filed song — what the operator reads. */
function formatReport(r, { machineLabel = '', at = new Date() } = {}) {
  const L = [];
  L.push(`Ether — songs re-filed by reference (one-time repair), ${at.toLocaleString()}`);
  if (machineLabel) L.push(`This computer: ${machineLabel} (${r.clientId})`);
  L.push('');
  L.push(`Songs checked: ${r.checked}. Re-filed: ${r.moved.length}. Settings rewritten: ${r.kvMoved.length}. ` +
    `Waiting for the other computer's numbering: ${r.waiting.length}. Could not be placed: ${r.missing.length}. No history: ${r.noHistory}.`);
  for (const label of ['category', 'jingle category', 'artist', 'album']) {
    const rows = r.moved.filter(x => x.reference === label);
    if (!rows.length) continue;
    L.push('', `${label.toUpperCase()} — ${rows.length} song${rows.length === 1 ? '' : 's'} moved:`);
    for (const x of rows) {
      L.push(`  ${x.song}: ${x.from.name ?? '(none)'} [${x.from.id ?? '-'}] → ${x.to.name ?? '(none)'} [${x.to.id ?? '-'}]` +
        `  (assigned ${x.made_here ? 'on this computer' : 'on the other computer'})`);
    }
  }
  if (r.kvMoved.length) {
    L.push('', 'SETTINGS rewritten as stable ids:');
    for (const x of r.kvMoved) L.push(`  station ${x.station_id} ${x.setting}: ${x.from} → ${x.to}`);
  }
  if (r.waiting.length) {
    L.push('', `WAITING — the computer that made these assignments has not published its numbering yet (it runs this build ` +
      `when it next opens). They are re-filed automatically when it does:`);
    for (const x of r.waiting.slice(0, 200)) L.push(`  ${x.song || x.setting} (${x.reference || 'station ' + x.station_id}) — made on ${x.by}`);
    if (r.waiting.length > 200) L.push(`  … and ${r.waiting.length - 200} more`);
  }
  if (r.missing.length) {
    L.push('', 'COULD NOT BE PLACED (left exactly as they were):');
    for (const x of r.missing) L.push(`  ${x.song || x.setting} (${x.reference || 'station ' + x.station_id}) — their id ${x.their_id}: ${x.why}`);
  }
  return L.join('\n') + '\n';
}

module.exports = { runRepair, repairState, setRepairState, formatReport, assignmentIn, SONG_REFERENCES, KV_REFERENCES, STATE_KEY };

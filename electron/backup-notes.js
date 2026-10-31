// electron/backup-notes.js — the "Description (optional)" of a cloud backup (Tools → Cloud Log Backup).
//
// The box was typed into and never sent (dead-controls list item 7). The description now travels WITH the backup — it is
// written into the backup's .meta.json in the cloud (electron/cloud-backup.js) — and is kept on this computer in
// system_state (this computer's own bookkeeping, never synced), keyed by the backup's timestamp, so the backup lists can
// show it next to the backup it belongs to. The backend's list does not read .meta.json, so a description is shown on
// the computer that made the backup.
"use strict";

const KEY = "cloud_backup_notes";
const MAX_NOTES = 500;      // the oldest are dropped past this; a note is a line of text, not a log
const MAX_LEN = 200;

function readNotes(db) {
  try {
    const v = db.prepare("SELECT value FROM system_state WHERE key = ?").get(KEY)?.value;
    const o = v ? JSON.parse(v) : {};
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

/** Clean what the operator typed: one line, at most MAX_LEN characters. Empty → null (no note). */
function cleanDescription(text) {
  if (text == null) return null;
  const t = String(text).replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
  return t || null;
}

/** Remember the description of the backup stamped `timestamp`. No description → nothing written. */
function addNote(db, timestamp, text) {
  const d = cleanDescription(text);
  if (!d || !timestamp) return false;
  const notes = readNotes(db);
  notes[timestamp] = d;
  const keys = Object.keys(notes).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_NOTES))) delete notes[k];
  db.prepare("INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES (?, ?, ?)")
    .run(KEY, JSON.stringify(notes), new Date().toISOString());
  return true;
}

/** Each cloud backup entry ({ timestamp, ... }) with its `description` (or null). */
function attachNotes(db, backups) {
  const notes = readNotes(db);
  return (backups || []).map(b => ({ ...b, description: (b && notes[b.timestamp]) || null }));
}

module.exports = { addNote, attachNotes, readNotes, cleanDescription, KEY, MAX_LEN };

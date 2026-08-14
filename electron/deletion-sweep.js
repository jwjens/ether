'use strict';
// ── deletion-sweep — the report-only R2 release pipeline ────────────────────────────────────────
//
// REPORT ONLY. Nothing here sends a DELETE to R2 or to any backend. The sweep decides what WOULD be
// eligible and records that decision; releasing the object is a separate job.
//
// Three parts, kept in one module so the rules live in one place:
//   enqueueForDeletion  — called at the soft-delete path, BEFORE the row is modified
//   dequeueOnRestore    — the exact reverse; a restored song must not leave a row that later marks
//                         a LIVE song's audio for release
//   runSweep            — once daily, designation-gated, evaluates the ownership checks
//
// Pure functions over a db handle: no Electron, no IPC, no timers. That is what makes it testable
// (electron/sync/tests) and what keeps the caller in main.js down to a few lines.

const fs = require('fs');
const path = require('path');

const GRACE_DAYS = 30;
const PLAY_LOG_WINDOW_DAYS = 90;
const REPORT_FILE = 'r2-deletion-report.jsonl';
/** Keep the report bounded. health-events.jsonl reached 38 MB with no rotation and is a standing
 *  problem; this file is capped from the first line rather than after someone notices. */
const REPORT_MAX_BYTES = 2 * 1024 * 1024;

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * THE UNIT TRAP, handled once.
 *
 * play_log.played_at is an INTEGER epoch. Comparing it to datetime('now','-90 days') — a TEXT value
 * — is false for EVERY row, which reads as "nothing has aired recently" and would clear songs for
 * deletion that aired this morning. That exact comparison already produced a wrong answer (0 rows
 * against a true 442).
 *
 * So the unit is DETECTED from the data rather than assumed: epoch seconds are ~1.7e9, milliseconds
 * ~1.7e12. Returns the cutoff in whatever unit the column actually uses.
 */
function playLogCutoff(db, windowDays = PLAY_LOG_WINDOW_DAYS, now = nowSec()) {
  let max = 0;
  try { max = db.prepare('SELECT MAX(played_at) m FROM play_log').get()?.m || 0; } catch { /* no table */ }
  const inMs = max > 1e11;
  const cutoffSec = now - windowDays * 86400;
  return { cutoff: inMs ? cutoffSec * 1000 : cutoffSec, inMs };
}

/**
 * Record a deleted song so its audio can be considered for release after the grace period — and so
 * it can be put back before then.
 *
 * MUST be called BEFORE the row is modified. The value of song_json is the complete row as it was:
 * restoring from a partial capture would resurrect a song missing its cue points, loudness and
 * category, which is a restore in name only.
 *
 * Never throws into the delete path. A song must delete even if the queue insert fails — the queue
 * is bookkeeping for a background job, not part of the operator's action.
 */
function enqueueForDeletion(db, song, now = nowSec()) {
  try {
    if (!song) return { ok: false, skipped: 'no row' };
    const fileKey = song.file_key && String(song.file_key).trim();
    // No key means no R2 object to release. Nothing to queue, and not an error.
    if (!fileKey) return { ok: true, skipped: 'no file_key' };
    // Idempotent: re-deleting a song that is already queued must not create a second row.
    const existing = db.prepare(
      "SELECT id FROM deletion_queue WHERE file_key = ? AND status NOT IN ('done') LIMIT 1"
    ).get(fileKey);
    if (existing) return { ok: true, skipped: 'already queued', id: existing.id };

    const info = db.prepare(`
      INSERT INTO deletion_queue
        (file_key, file_path, station_id, song_json, deleted_at, grace_expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    ).run(
      fileKey,
      song.file_path ?? null,
      song.station_id ?? song.stationId ?? 0,
      JSON.stringify(song),
      now,
      now + GRACE_DAYS * 86400
    );
    return { ok: true, id: info.lastInsertRowid };
  } catch (e) {
    console.error('[deletion-sweep] enqueue failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * The reverse of enqueue. A restored song's queue row must go, or the sweep would later mark a LIVE
 * song's audio for release — the one way this feature could destroy something in use.
 *
 * Matches on file_key because that is what the queue keys on and what the release would target.
 */
function dequeueOnRestore(db, song) {
  try {
    const fileKey = song && song.file_key && String(song.file_key).trim();
    if (!fileKey) return { ok: true, removed: 0 };
    const info = db.prepare('DELETE FROM deletion_queue WHERE file_key = ?').run(fileKey);
    if (info.changes > 0) console.log(`[deletion-sweep] restore — removed ${info.changes} queue row(s) for ${fileKey}`);
    return { ok: true, removed: info.changes };
  } catch (e) {
    console.error('[deletion-sweep] dequeue failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * The ownership checks for ONE queued row. All local, all read-only.
 *
 * Order matters: `permanent_shared` is terminal and is therefore decided first, so a row held by a
 * live song is never repeatedly re-evaluated against the log and play history.
 *
 * The backend performs the AUTHORITATIVE account-scoped check before any future DELETE. These
 * checks see only this install; another machine on the account may hold a reference this one cannot
 * see. `marked` therefore means "eligible as far as this machine can tell", never "safe to delete".
 */
function evaluateRow(db, row, opts = {}) {
  const now = opts.now ?? nowSec();

  // 1. songs — any other LIVE row on the same key. Terminal: the file belongs to something in use.
  const liveSong = db.prepare(
    'SELECT id, title FROM songs WHERE file_key = ? AND deleted_at IS NULL LIMIT 1'
  ).get(row.file_key);
  if (liveSong) {
    return { status: 'permanent_shared', reason: `file_key shared with live song "${liveSong.title}" (id ${liveSong.id})` };
  }

  // 2. generated_schedule — anything still to air. Held, not terminal: it ages out.
  let futureLog = null;
  try {
    futureLog = db.prepare(`
      SELECT gs.id FROM generated_schedule gs
        JOIN songs s ON s.id = gs.song_id
       WHERE s.file_key = ? AND gs.deleted_at IS NULL AND gs.scheduled_at >= ?
       LIMIT 1`).get(row.file_key, now);
  } catch (e) {
    return { status: 'error', reason: 'generated_schedule check failed: ' + e.message };
  }
  if (futureLog) {
    return { status: 'pending', reason: 'referenced by a future generated_schedule row' };
  }

  // 3. play_log — aired within the window. play_log has NO file_key and NO song_id (verified against
  //    the live schema), so this can only match on file_path. A queued row with no file_path cannot
  //    be checked at all, and that is UNVERIFIABLE — explicitly not "clear". Expected to be 0 today
  //    because the delete path leaves file_path intact; it exists so a future change that nulls the
  //    field degrades to "cannot tell" rather than silently to "eligible".
  if (!row.file_path || !String(row.file_path).trim()) {
    return { status: 'unverifiable', reason: 'no file_path — the 90-day play_log check cannot run' };
  }
  let recent = null;
  try {
    const { cutoff } = playLogCutoff(db, PLAY_LOG_WINDOW_DAYS, now);
    recent = db.prepare(
      'SELECT id, played_at FROM play_log WHERE file_path = ? AND played_at >= ? LIMIT 1'
    ).get(row.file_path, cutoff);
  } catch (e) {
    return { status: 'error', reason: 'play_log check failed: ' + e.message };
  }
  if (recent) {
    return { status: 'pending', reason: `aired within the last ${PLAY_LOG_WINDOW_DAYS} days` };
  }

  // 4. The backend's account-scoped check is NOT performed here and is not available to this
  //    machine. Recorded in the reason so `marked` can never be mistaken for "verified safe".
  return { status: 'marked', reason: 'local checks clear; backend account-scoped check still required before any DELETE' };
}

/** Append one summary line, rotating once the file passes its cap. Per-object detail lives in the
 *  queue table's status/reason, deliberately — the report stays one line per sweep so it can be
 *  read at a glance and cannot grow the way health-events.jsonl did. */
function writeReport(dir, summary) {
  try {
    const file = path.join(dir, REPORT_FILE);
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > REPORT_MAX_BYTES) {
        fs.renameSync(file, file + '.1');
      }
    } catch { /* rotation is best-effort */ }
    fs.appendFileSync(file, JSON.stringify(summary) + '\n', 'utf8');
  } catch (e) {
    console.error('[deletion-sweep] report write failed:', e.message);
  }
}

/**
 * One sweep. Evaluates every queue row whose grace has expired and which is still workable.
 *
 * `permanent_shared` is terminal and is never re-examined — that is the "never re-report" rule.
 * `marked` rows are also left alone: the decision has been made and nothing here acts on it.
 */
function runSweep(db, opts = {}) {
  const now = opts.now ?? nowSec();
  const counts = { marked: 0, permanent_shared: 0, error: 0, unverifiable: 0, pending: 0 };

  // Rows past grace that are still open. Anything terminal is excluded by the status filter.
  const due = db.prepare(`
    SELECT id, file_key, file_path, status FROM deletion_queue
     WHERE status IN ('pending', 'error') AND grace_expires_at <= ?
     ORDER BY id`).all(now);

  const upd = db.prepare('UPDATE deletion_queue SET status = ?, reason = ?, last_checked_at = ? WHERE id = ?');
  const apply = db.transaction((rows) => {
    for (const row of rows) {
      let verdict;
      try { verdict = evaluateRow(db, row, { now }); }
      catch (e) { verdict = { status: 'error', reason: e.message }; }
      upd.run(verdict.status, verdict.reason, now, row.id);
      if (counts[verdict.status] != null) counts[verdict.status]++;
    }
  });
  apply(due);

  // Rows still inside their grace period are `pending` by definition and were not examined. Counted
  // separately so the summary describes the WHOLE queue, not only what was looked at today.
  let waiting = 0;
  try {
    waiting = db.prepare(
      "SELECT COUNT(*) n FROM deletion_queue WHERE status = 'pending' AND grace_expires_at > ?"
    ).get(now)?.n ?? 0;
  } catch { /* counted as 0 */ }

  const summary = {
    ts: new Date(now * 1000).toISOString(),
    machine: opts.machineId ?? null,
    examined: due.length,
    counts: { ...counts, pending: counts.pending + waiting },
    withinGrace: waiting,
    queueTotal: db.prepare('SELECT COUNT(*) n FROM deletion_queue').get()?.n ?? 0,
    mode: 'report-only',
  };
  if (opts.logDir) writeReport(opts.logDir, summary);
  console.log('[deletion-sweep]', JSON.stringify(summary));
  return summary;
}

module.exports = {
  enqueueForDeletion,
  dequeueOnRestore,
  evaluateRow,
  runSweep,
  playLogCutoff,
  GRACE_DAYS,
  PLAY_LOG_WINDOW_DAYS,
  REPORT_FILE,
};

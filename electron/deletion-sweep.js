'use strict';
// ── deletion-sweep — the R2 release pipeline ────────────────────────────────────────────────────
//
// The sweep decides what is eligible and records that decision; RELEASE is a separate, explicit
// step below (releaseRow / releaseMarked / releaseAfterDelete) and is the only place in the app
// that causes an R2 object to be deleted.
//
// Five parts, kept in one module so the rules live in one place:
//   enqueueForDeletion  — called at the soft-delete path, BEFORE the row is modified
//   dequeueOnRestore    — the exact reverse; a restored song must not leave a row that later marks
//                         a LIVE song's audio for release
//   runSweep            — once daily, designation-gated, evaluates the ownership checks
//   releaseAfterDelete  — the delete path's own release attempt, run AFTER the transaction commits
//   releaseMarked       — the sweep's release pass over rows the checks cleared
//
// Pure functions over a db handle: no Electron, no IPC, no timers, and NO HTTP — the network call
// is INJECTED (setObjectDeleter / opts.deleteObject). That is what makes it testable
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
 *
 * runSweep itself still deletes NOTHING. It only records verdicts. Rows it leaves at `marked` are
 * acted on by releaseMarked(), which the caller runs immediately afterwards — kept as two calls so
 * the evaluation stays synchronous and transactional while the network work does not.
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
    mode: 'evaluate',   // this call records verdicts only; releaseMarked() performs the deletes
  };
  if (opts.logDir) writeReport(opts.logDir, summary);
  console.log('[deletion-sweep]', JSON.stringify(summary));
  return summary;
}

// ── RELEASE — the only path in the app that deletes an R2 object ───────────────────────────────
//
// THE HTTP CALL IS INJECTED, never made here. main.js registers the real one at startup
// (setObjectDeleter); tests pass one through opts.deleteObject. With NO deleter registered nothing
// is released and rows stay exactly where the sweep left them — the pre-mirror behaviour, which is
// also what an install with no signed-in account gets.
//
// Deleter contract:  async (fileKey) => { ok: boolean, detail?: string }
// It may reject; a rejection is caught here and treated as a failure, never propagated.
let _objectDeleter = null;
function setObjectDeleter(fn) { _objectDeleter = typeof fn === 'function' ? fn : null; }

/**
 * 64-hex names are the content-hash objects. They are OUT OF SCOPE and are NEVER released.
 *
 * One hash object backs any number of library rows on any number of installs — it is addressed by
 * its CONTENT, so "this song was the sole reference" is a statement this queue is structurally
 * unable to make about it. The queue keys on file_key alone and cannot see the other references.
 *
 * Same shape library-client.js:59 matches on. Checked at the release gate rather than at enqueue
 * because the gate is where the irreversible thing happens — and because the v37 backfill already
 * put rows in the queue that enqueue-time filtering would never have seen.
 */
const HASH_NAMED_RE = /^[0-9a-f]{64}(\.[A-Za-z0-9]+)?$/;
function isHashNamed(fileKey) { return HASH_NAMED_RE.test(String(fileKey || '').trim()); }

/** Status writes are best-effort and NEVER throw at a caller: a failed bookkeeping write must not
 *  turn into a failed delete, and must not turn a successful release into an exception either. */
function setStatus(db, id, status, reason, now) {
  try {
    db.prepare('UPDATE deletion_queue SET status = ?, reason = ?, last_checked_at = ? WHERE id = ?')
      .run(status, reason, now, id);
  } catch (e) {
    console.error('[deletion-sweep] status write failed:', e.message);
  }
}

/**
 * Release ONE queue row. Records the outcome in the row itself, which IS the retry state:
 *   done          released (or already absent — the endpoint is idempotent and reports both)
 *   error         the call failed; runSweep picks 'error' rows up again and re-evaluates them
 *   out_of_scope  hash-named — terminal, and selected by neither the sweep nor the release pass
 */
async function releaseRow(db, row, opts = {}) {
  const now = opts.now ?? nowSec();
  const del = opts.deleteObject || _objectDeleter;

  if (isHashNamed(row.file_key)) {
    setStatus(db, row.id, 'out_of_scope', 'hash-named (content-addressed) object — never released', now);
    return { status: 'out_of_scope' };
  }
  // No deleter means no account session / no wiring. Leave the row untouched so it is retried
  // later, rather than writing an 'error' that reads like the backend refused.
  if (!del) return { status: row.status, skipped: 'no object deleter registered' };

  let out;
  try { out = await del(row.file_key); }
  catch (e) { out = { ok: false, detail: e && e.message ? e.message : String(e) }; }

  if (out && out.ok) {
    setStatus(db, row.id, 'done', `released${out.detail ? ' — ' + out.detail : ''}`, now);
    return { status: 'done', detail: out.detail };
  }
  const detail = (out && out.detail) || 'unknown error';
  console.error(`[deletion-sweep] release failed for ${row.file_key}: ${detail}`);
  setStatus(db, row.id, 'error', `release failed: ${detail}`, now);
  return { status: 'error', detail };
}

/**
 * The DELETE PATH's own release attempt. Called AFTER the delete transaction commits — the song row
 * must already carry its tombstone, or evaluateRow's first check would find the song being deleted
 * and call it a live sharer of its own key.
 *
 * Runs the SAME evaluateRow the sweep runs: the local checks are one rule with one implementation.
 * Anything other than `marked` is recorded and left alone — the sweep owns it from there.
 *
 * NEVER throws, and never blocks the delete: the operator's action completed before this ran.
 */
async function releaseAfterDelete(db, fileKey, opts = {}) {
  try {
    const key = fileKey && String(fileKey).trim();
    if (!key) return { ok: true, skipped: 'no file_key' };
    const now = opts.now ?? nowSec();
    const row = db.prepare(
      "SELECT id, file_key, file_path, status FROM deletion_queue WHERE file_key = ? AND status NOT IN ('done', 'out_of_scope') ORDER BY id DESC LIMIT 1"
    ).get(key);
    if (!row) return { ok: true, skipped: 'not queued' };

    let verdict;
    try { verdict = evaluateRow(db, row, { now }); }
    catch (e) { verdict = { status: 'error', reason: e.message }; }

    if (verdict.status !== 'marked') {
      setStatus(db, row.id, verdict.status, verdict.reason, now);
      return { ok: true, status: verdict.status, reason: verdict.reason };
    }
    const r = await releaseRow(db, row, { now, deleteObject: opts.deleteObject });
    return { ok: r.status !== 'error', status: r.status, detail: r.detail };
  } catch (e) {
    // A failure here leaves the queue row where it was, which is precisely the retry state.
    console.error('[deletion-sweep] releaseAfterDelete failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * The SWEEP's release pass: every row the checks cleared. Run immediately after runSweep, so a row
 * marked today is released today rather than waiting a further 24h for the next tick.
 */
async function releaseMarked(db, opts = {}) {
  const now = opts.now ?? nowSec();
  const counts = { done: 0, error: 0, out_of_scope: 0, skipped: 0 };
  let rows = [];
  try {
    rows = db.prepare(
      "SELECT id, file_key, file_path, status FROM deletion_queue WHERE status = 'marked' ORDER BY id"
    ).all();
  } catch (e) {
    console.error('[deletion-sweep] release query failed:', e.message);
    return counts;
  }
  for (const row of rows) {
    const r = await releaseRow(db, row, { now, deleteObject: opts.deleteObject });
    if (counts[r.status] != null) counts[r.status]++;
    else counts.skipped++;
  }
  if (rows.length) console.log('[deletion-sweep] release pass', JSON.stringify({ examined: rows.length, ...counts }));
  return counts;
}

module.exports = {
  enqueueForDeletion,
  dequeueOnRestore,
  evaluateRow,
  runSweep,
  playLogCutoff,
  setObjectDeleter,
  isHashNamed,
  releaseRow,
  releaseAfterDelete,
  releaseMarked,
  GRACE_DAYS,
  PLAY_LOG_WINDOW_DAYS,
  REPORT_FILE,
};

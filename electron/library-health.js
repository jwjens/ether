'use strict';
// library-health.js — Log-reader/library "senses" for Iris + the Health Monitor (Slice A: the
// deterministic data layer + the R2 PREFETCH). Main-process, read-only against the DB except it
// DOWNLOADS absent audio files to their file_path (files only, never the DB). All senses are computed
// deterministically from the DB + disk and appended to health-events.jsonl; the latest snapshot is
// served over IPC. Display (Health Monitor LIBRARY section, Library PLAYS column) is Slice C.
//
// Senses (per station):
//  (1) MATERIALIZATION  — resolvable / total library songs (local file present OR file_key present).
//  (2) POOL HEALTH      — spun-pool (24h) vs library size + top song spins/24h (repetition signal).
//  (3) SKIPPED-AT-LOAD  — counter fed by the daemon's loud skip events (Slice B wires the feed).
//  (4) PREFETCH LAG     — upcoming-window rows whose file is not yet local.
//  (5) ROTATION ELIGIBILITY — per song: last_played, rest_remaining (from the ACTUAL separation
//      rules), status ELIGIBLE|RESTING|NEVER_PLAYED|UNRESOLVABLE — summarized per station; the
//      per-song list backs the Library PLAYS column + queue lint (Slice C).
//
// NON-BLOCKING BY CONSTRUCTION: prefetch runs on a timer in the background and only ever writes files
// ahead of playout; it never sits on the deck-load path (a deck load must never stall on a fetch).

const fs = require('fs');
const path = require('path');

function createLibraryHealth(opts) {
  const { getDb, backendUrl, licenseKeyFn, broadcast, userDataDir } = opts;
  const jsonlPath = path.join(userDataDir, 'health-events.jsonl');
  const inFlight = new Set();          // file_key currently downloading (dedup)
  const skipCounts = new Map();        // stationId -> { hour: <epoch hour>, n }
  let lastSnapshot = { stations: [], t: null };

  const nowSec = () => Math.floor(Date.now() / 1000);
  const exists = (fp) => { try { return !!fp && fs.existsSync(fp); } catch { return false; } };
  const appendJsonl = (rec) => { try { fs.appendFileSync(jsonlPath, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n'); } catch { /* best-effort */ } };

  function stationIds(db) {
    try { return db.prepare("SELECT id FROM stations WHERE deleted_at IS NULL ORDER BY id").all().map(r => r.id); } catch { return []; }
  }
  function libraryCategoryIds(db, sid) {
    try { return db.prepare("SELECT id FROM categories WHERE station_id=? AND deleted_at IS NULL").all(sid).map(r => r.id); } catch { return []; }
  }
  function sepConfig(db, sid) {
    try {
      const rows = db.prepare("SELECT rule_type, value, is_active FROM separation_rules WHERE station_id=?").all(sid);
      const a = rows.find(r => r.rule_type === 'artist_separation_min');
      const on = !!(a && a.is_active);
      return { artistSepSec: on ? (a.value || 60) * 60 : 0 };
    } catch { return { artistSepSec: 0 }; }
  }

  // ── (5) rotation eligibility for one library, returns per-song rows + a summary ──
  function eligibility(db, sid) {
    const cats = libraryCategoryIds(db, sid);
    if (!cats.length) return { rows: [], summary: { eligible: 0, resting: 0, neverPlayed: 0, unresolvable: 0, total: 0 } };
    const inCats = `(${cats.join(',')})`;
    const { artistSepSec } = sepConfig(db, sid);
    const now = nowSec();
    const songs = db.prepare(
      `SELECT s.id, s.title, s.file_path, s.file_key, s.artist_id, s.no_repeat_hours
         FROM songs s WHERE s.category_id IN ${inCats} AND s.deleted_at IS NULL`).all();
    const lastPlay = db.prepare(
      `SELECT MAX(played_at) m FROM play_log WHERE station_id=? AND file_path=? AND deleted_at IS NULL`);
    const lastArtist = db.prepare(
      `SELECT MAX(pl.played_at) m FROM play_log pl JOIN songs s2 ON s2.file_path=pl.file_path
         WHERE pl.station_id=? AND pl.deleted_at IS NULL AND s2.artist_id=?`);
    // Slice C: the repaired PLAYS join — station-scoped play count by file_path (this is what the
    // Library page's plays column reads, replacing the stale/empty songs.play_count).
    const playCount = db.prepare(
      `SELECT COUNT(*) c FROM play_log WHERE station_id=? AND file_path=? AND deleted_at IS NULL`);
    const out = []; const sum = { eligible: 0, resting: 0, neverPlayed: 0, unresolvable: 0, total: songs.length };
    for (const s of songs) {
      const resolvable = exists(s.file_path) || !!s.file_key;
      const lp = s.file_path ? (lastPlay.get(sid, s.file_path).m || 0) : 0;
      const songRest = lp ? Math.max(0, (lp + (s.no_repeat_hours || 3) * 3600) - now) : 0;
      let artRest = 0;
      if (artistSepSec && s.artist_id) { const la = lastArtist.get(sid, s.artist_id).m || 0; artRest = la ? Math.max(0, (la + artistSepSec) - now) : 0; }
      const rest = Math.max(songRest, artRest);
      let status;
      if (!resolvable) { status = 'UNRESOLVABLE'; sum.unresolvable++; }
      else if (!lp) { status = 'NEVER_PLAYED'; sum.neverPlayed++; }
      else if (rest > 0) { status = 'RESTING'; sum.resting++; }
      else { status = 'ELIGIBLE'; sum.eligible++; }
      const plays = s.file_path ? playCount.get(sid, s.file_path).c : 0;
      out.push({ id: s.id, title: s.title, plays, lastPlayed: lp || null, restSec: rest, status, resolvable });
    }
    return { rows: out, summary: sum };
  }

  // ── Queue/Generate LINT: upcoming rows whose song/artist is still RESTING at its projected air time ──
  // Deterministic, rules-derived (no_repeat_hours + artist separation), evaluated against the plays that
  // precede each row's scheduled_at. Returns the violations; the SAME check serves the live queue chip
  // (UpNext) and Generate-time placement warnings — a violation means "N minutes too early".
  function lintUpcoming(db, sid) {
    const { artistSepSec } = sepConfig(db, sid);
    const now = nowSec();
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT g.id rowId, g.scheduled_at at, g.title, s.file_path, s.artist_id, s.no_repeat_hours
           FROM generated_schedule g LEFT JOIN songs s ON s.id=g.song_id
          WHERE g.station_id=? AND g.deleted_at IS NULL AND (g.state IS NULL OR g.state IN ('pending','playing'))
            AND g.scheduled_at BETWEEN ? AND ? AND (g.content_class IS NULL OR g.content_class NOT IN ('JIN','SWP'))
            AND g.song_id IS NOT NULL
          ORDER BY g.scheduled_at LIMIT 60`).all(sid, now - 300, now + 7200);
    } catch { return []; }
    const lastSong = db.prepare("SELECT MAX(played_at) m FROM play_log WHERE station_id=? AND file_path=? AND deleted_at IS NULL AND played_at < ?");
    const lastArt = db.prepare("SELECT MAX(pl.played_at) m FROM play_log pl JOIN songs s2 ON s2.file_path=pl.file_path WHERE pl.station_id=? AND pl.deleted_at IS NULL AND s2.artist_id=? AND pl.played_at < ?");
    const out = [];
    for (const r of rows) {
      if (!r.file_path) continue;
      const sl = lastSong.get(sid, r.file_path, r.at).m || 0;
      const songViol = sl ? Math.max(0, (sl + (r.no_repeat_hours || 3) * 3600) - r.at) : 0;
      let artViol = 0;
      if (artistSepSec && r.artist_id) { const al = lastArt.get(sid, r.artist_id, r.at).m || 0; artViol = al ? Math.max(0, (al + artistSepSec) - r.at) : 0; }
      const viol = Math.max(songViol, artViol);
      if (viol > 0) out.push({ rowId: r.rowId, scheduledAt: r.at, title: r.title, violatesBySec: viol, kind: songViol >= artViol ? "song" : "artist" });
    }
    return out;
  }

  // ── (1) materialization, (2) pool, (4) prefetch-lag, (3) skipped ──
  function computeStation(db, sid) {
    const cats = libraryCategoryIds(db, sid);
    const inCats = cats.length ? `(${cats.join(',')})` : '(-1)';
    const songs = db.prepare(
      `SELECT s.file_path, s.file_key FROM songs s WHERE s.category_id IN ${inCats} AND s.deleted_at IS NULL`).all();
    const total = songs.length;
    let resolvable = 0, localOnly = 0, r2Only = 0, dead = 0;
    for (const s of songs) {
      const local = exists(s.file_path);
      if (local) { resolvable++; localOnly++; }
      else if (s.file_key) { resolvable++; r2Only++; }
      else dead++;
    }
    // (2) pool — spins in the last 24h.
    const dayAgo = nowSec() - 86400;
    const spin = db.prepare(
      `SELECT s.file_path fp, COUNT(pl.id) n FROM songs s
         LEFT JOIN play_log pl ON pl.file_path=s.file_path AND pl.station_id=? AND pl.deleted_at IS NULL AND pl.played_at>?
        WHERE s.category_id IN ${inCats} AND s.deleted_at IS NULL GROUP BY s.file_path`).all(sid, dayAgo);
    const spun = spin.filter(r => r.n > 0);
    const topSpins = spin.reduce((m, r) => Math.max(m, r.n), 0);
    // (4) prefetch lag — upcoming pending rows in the next 2h whose file isn't local yet.
    let lag = 0;
    try {
      const upcoming = db.prepare(
        `SELECT COALESCE(g.file_path, s.file_path) fp, s.file_key fk
           FROM generated_schedule g LEFT JOIN songs s ON s.id=g.song_id
          WHERE g.station_id=? AND g.deleted_at IS NULL AND (g.state IS NULL OR g.state IN ('pending','playing'))
            AND g.scheduled_at BETWEEN ? AND ? AND (g.content_class IS NULL OR g.content_class NOT IN ('JIN','SWP'))
          ORDER BY g.scheduled_at LIMIT 60`).all(sid, nowSec() - 300, nowSec() + 7200);
      lag = upcoming.filter(u => !exists(u.fp) && u.fk).length;   // R2-only, not yet materialized
    } catch { /* generated_schedule may vary */ }
    // (3) skipped this hour.
    const hr = Math.floor(nowSec() / 3600);
    const sc = skipCounts.get(sid); const skipped = (sc && sc.hour === hr) ? sc.n : 0;

    const elig = eligibility(db, sid);
    const name = (db.prepare("SELECT name FROM stations WHERE id=?").get(sid) || {}).name || String(sid);
    // Levels: yellow if any unresolvable / pool shrunk; red if skips climbing.
    const materialization = { resolvable, total, r2Only, dead };
    const materialLevel = dead > 0 ? 'red' : (r2Only > 0 ? 'yellow' : 'green');   // dead = truly unplayable
    const poolLevel = (total > 0 && spun.length / total < 0.7) ? 'yellow' : 'green';
    const skipLevel = skipped > 0 ? 'red' : 'green';
    const level = [materialLevel, poolLevel, skipLevel].includes('red') ? 'red'
                : [materialLevel, poolLevel].includes('yellow') ? 'yellow' : 'green';
    return {
      stationId: sid, name, level,
      materialization: { ...materialization, level: materialLevel },
      pool: { librarySize: total, spunPool24h: spun.length, topSpins24h: topSpins, level: poolLevel },
      skipped: { thisHour: skipped, level: skipLevel },
      prefetchLag: { upcomingUnmaterialized: lag },
      eligibility: elig.summary,
    };
  }

  const _lintSeen = new Set();   // rowIds already event-logged, so a violation is reported once
  function computeAll() {
    const db = getDb();
    const snap = { t: new Date().toISOString(), stations: [], lint: {} };
    for (const sid of stationIds(db)) {
      try {
        const st = computeStation(db, sid);
        const lint = lintUpcoming(db, sid);
        st.lintCount = lint.length;
        snap.lint[sid] = lint;
        // Emit a health event ONCE per violating row: "placement violates separation, N min early".
        for (const v of lint) {
          if (_lintSeen.has(v.rowId)) continue;
          _lintSeen.add(v.rowId);
          appendJsonl({ kind: 'queue-lint', stationId: sid, title: v.title, scheduledAt: v.scheduledAt, earlyBySec: v.violatesBySec, ruleKind: v.kind });
        }
        snap.stations.push(st);
      } catch (e) { /* one station never breaks the rest */ }
    }
    if (_lintSeen.size > 4000) _lintSeen.clear();   // bounded — old rows have long aired
    lastSnapshot = snap;
    appendJsonl({ kind: 'library-health', stations: snap.stations });
    try { broadcast('library-health', snap); } catch { /* no window yet */ }
    return snap;
  }

  // ── R2 PREFETCH — materialize absent+file_key upcoming rows to their file_path (background) ──
  async function fetchToPath(fileKey, targetPath) {
    const licenseKey = licenseKeyFn();
    if (!licenseKey) return { ok: false, error: 'no license' };
    try {
      const u = await fetch(`${backendUrl}/audio/download-url`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: licenseKey, file_key: fileKey }),
      });
      const d = await u.json().catch(() => ({}));
      if (!u.ok || !d.signed_url) throw new Error(d.error || d.detail || `sign HTTP ${u.status}`);
      const g = await fetch(d.signed_url);
      if (!g.ok) throw new Error(`GET HTTP ${g.status}`);
      const buf = Buffer.from(await g.arrayBuffer());
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const tmp = targetPath + '.tmp';
      fs.writeFileSync(tmp, buf); fs.renameSync(tmp, targetPath);
      return { ok: true, mb: buf.length / 1e6 };
    } catch (e) { try { fs.unlinkSync(targetPath + '.tmp'); } catch {} return { ok: false, error: e.message }; }
  }

  async function prefetchTick() {
    const db = getDb();
    const CONC = 3;
    let targets = [];
    for (const sid of stationIds(db)) {
      try {
        const rows = db.prepare(
          `SELECT DISTINCT COALESCE(g.file_path, s.file_path) fp, s.file_key fk, g.title
             FROM generated_schedule g LEFT JOIN songs s ON s.id=g.song_id
            WHERE g.station_id=? AND g.deleted_at IS NULL AND (g.state IS NULL OR g.state IN ('pending','playing'))
              AND g.scheduled_at BETWEEN ? AND ? AND (g.content_class IS NULL OR g.content_class NOT IN ('JIN','SWP'))
            ORDER BY g.scheduled_at LIMIT 40`).all(sid, nowSec() - 300, nowSec() + 7200);
        for (const r of rows) if (r.fp && r.fk && !exists(r.fp) && !inFlight.has(r.fk)) targets.push(r);
      } catch { /* skip station */ }
    }
    // De-dup by file_key, cap the batch so a tick is bounded.
    const seen = new Set(); targets = targets.filter(t => (seen.has(t.fk) ? false : seen.add(t.fk))).slice(0, 24);
    if (!targets.length) return;
    let i = 0;
    async function worker() {
      while (i < targets.length) {
        const t = targets[i++]; inFlight.add(t.fk);
        const r = await fetchToPath(t.fk, t.fp);
        inFlight.delete(t.fk);
        appendJsonl({ kind: 'prefetch', ok: r.ok, title: t.title, error: r.error || null });
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    computeAll();   // refresh senses after materializing
  }

  // ── public ──
  return {
    // Slice B feeds this from the daemon's loud skip events.
    noteSkip(stationId, title, reason) {
      const hr = Math.floor(nowSec() / 3600);
      const c = skipCounts.get(stationId);
      skipCounts.set(stationId, c && c.hour === hr ? { hour: hr, n: c.n + 1 } : { hour: hr, n: 1 });
      appendJsonl({ kind: 'load-skip', stationId, title, reason });
    },
    snapshot() { return lastSnapshot; },
    eligibilityRows(stationId) { try { return eligibility(getDb(), stationId).rows; } catch { return []; } },
    lintRows(stationId) { try { return lintUpcoming(getDb(), stationId); } catch { return []; } },
    computeAll,
    start() {
      // Senses + lint every 2 min (cheap indexed reads) so a separation violation is EVENTED within a
      // couple minutes of Generate placing it; prefetch every 45s (background, bounded).
      try { computeAll(); } catch {}
      const t1 = setInterval(() => { try { computeAll(); } catch {} }, 120 * 1000);
      const t2 = setInterval(() => { prefetchTick().catch(() => {}); }, 45 * 1000);
      setTimeout(() => { prefetchTick().catch(() => {}); }, 8000);   // one early pass after boot
      return () => { clearInterval(t1); clearInterval(t2); };
    },
  };
}

module.exports = { createLibraryHealth };

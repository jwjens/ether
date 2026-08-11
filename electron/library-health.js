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

// Module-level bridge: lets code OUTSIDE this factory (the songs delete path) emit a health event
// without threading the instance through every caller. Wired when the factory is constructed; a no-op
// before that (or in tests), so it can never block the operation it is reporting on.
let _appendEvent = null;
function noteEvent(kind, data) {
  try { if (_appendEvent) _appendEvent({ kind, ...(data || {}) }); } catch { /* never throw at a caller */ }
}

function createLibraryHealth(opts) {
  const { getDb, backendUrl, licenseKeyFn, broadcast, userDataDir } = opts;
  const jsonlPath = path.join(userDataDir, 'health-events.jsonl');
  const inFlight = new Set();          // file_key currently downloading (dedup)
  const skipCounts = new Map();        // stationId -> { hour: <epoch hour>, n }
  const lastGen = new Map();           // stationId -> last Generate run's relaxed/empty summary (item 2)
  let lastSnapshot = { stations: [], t: null };

  const nowSec = () => Math.floor(Date.now() / 1000);
  const exists = (fp) => { try { return !!fp && fs.existsSync(fp); } catch { return false; } };
  const appendJsonl = (rec) => { try { fs.appendFileSync(jsonlPath, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n'); } catch { /* best-effort */ } };
  _appendEvent = appendJsonl;          // wire the module-level bridge (see noteEvent above)

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

  // ── SCHEDULE DEPTH (per-clock-slot) — songs available per scheduled category vs slots asked per hour ──
  // "Feel Good: 37 songs for ~10 slots/hr". A programmer's fact: when a category the LIVE clock leans on
  // is thinner than the separation window demands (slots/hr × repeat-hours), Generate must repeat/relax
  // within it. Reads only LIVE (non-deleted) shows/clocks/slots — the same law Generate now obeys
  // (CLOCK IS LAW). Read-only; never throws. Surfaced on the Health Monitor so thinness is a visible fact.
  function depthCheck(db, sid) {
    try {
      const clockIds = db.prepare(
        `SELECT DISTINCT clock_id FROM shows WHERE station_id=? AND is_active=1 AND deleted_at IS NULL AND clock_id IS NOT NULL`
      ).all(sid).map(r => r.clock_id);
      if (!clockIds.length) return [];
      const ph = clockIds.map(() => '?').join(',');
      const slotRows = db.prepare(
        `SELECT category_id, COUNT(*) slots FROM clock_slots
           WHERE clock_id IN (${ph}) AND slot_type='music' AND category_id IS NOT NULL AND deleted_at IS NULL
           GROUP BY category_id`).all(...clockIds);
      if (!slotRows.length) return [];
      let repeatHrs = 3;
      try { const sr = db.prepare("SELECT value FROM separation_rules WHERE station_id=? AND rule_type='song_separation_min' AND is_active=1 LIMIT 1").get(sid); if (sr && sr.value) repeatHrs = Math.max(1, Math.round(sr.value / 60)); } catch {}
      const cnt = db.prepare(
        `SELECT COUNT(*) n FROM songs WHERE category_id=? AND deleted_at IS NULL
           AND (rotation_status IS NULL OR rotation_status != 'inactive')
           AND (content_class IS NULL OR content_class='MUSIC')`);
      const nameOf = db.prepare("SELECT code, name FROM categories WHERE id=?");
      const out = [];
      for (const r of slotRows) {
        const songs = cnt.get(r.category_id).n;
        const c = nameOf.get(r.category_id) || {};
        const needed = r.slots * repeatHrs;                 // plays demanded of this category over the window
        out.push({ categoryId: r.category_id, category: c.name || c.code || ('#' + r.category_id), songs, slotsPerHr: r.slots, needed, thin: songs < needed });
      }
      out.sort((a, b) => (a.songs - a.needed) - (b.songs - b.needed));   // tightest (most under-supplied) first
      return out;
    } catch { return []; }
  }

  // ── (4b) ROTATION GOALS vs CLOCK COMPOSITION — the Advisor (Phase 1, 2026-08-10) ──────────────
  // `categories.spins_per_hour` and `categories.priority` are set in the UI, carried by sync, and read
  // by NOTHING in any scheduling path. They are a GSelector-shaped goal sitting in a clock-driven
  // engine: today the clock alone decides the category mix, so the goal is inert.
  //
  // This sense does not change that, and deliberately changes nothing about what airs. It only states
  // the fact nobody can currently see: for each clock, how its music-slot composition compares to the
  // targets the PD has already declared. It is the first time the two are compared at all.
  //
  // Sibling of depthCheck above, NOT an extension of it: depthCheck aggregates slots across every
  // active clock (`clock_id IN (…) GROUP BY category_id`) to answer supply-vs-demand. A goal is a
  // PER-HOUR statement, and a clock is an hour, so this must count per clock or the comparison is
  // meaningless.
  //
  // Design: docs/goal-driven-scheduler-redesign-2026-08-10.md §4 Phase 1.
  function goalCheck(db, sid) {
    try {
      const clocks = db.prepare(
        `SELECT DISTINCT s.clock_id AS clockId, c.name AS clockName
           FROM shows s LEFT JOIN clocks c ON c.id = s.clock_id
          WHERE s.station_id=? AND s.is_active=1 AND s.deleted_at IS NULL AND s.clock_id IS NOT NULL`
      ).all(sid);
      if (!clocks.length) return null;

      // HONEST REPORT (requirement 6): a category with no target is not a mismatch, it is a category
      // whose rotation the PD has chosen not to declare. NULL and 0 both mean "no goal" and are
      // excluded here rather than being reported as "target 0, over by N".
      const goals = db.prepare(
        `SELECT id, code, name, spins_per_hour AS target, priority FROM categories
          WHERE station_id=? AND deleted_at IS NULL AND spins_per_hour IS NOT NULL AND spins_per_hour > 0`
      ).all(sid);
      const totalCats = (db.prepare(
        "SELECT COUNT(*) n FROM categories WHERE station_id=? AND deleted_at IS NULL").get(sid) || {}).n || 0;

      const slotsFor = db.prepare(
        `SELECT category_id, COUNT(*) n FROM clock_slots
          WHERE clock_id=? AND station_id=? AND slot_type='music' AND category_id IS NOT NULL AND deleted_at IS NULL
          GROUP BY category_id`);
      const nameOfCat = db.prepare("SELECT code, name FROM categories WHERE id=?");

      // NO TARGETS DECLARED — measured on real data 2026-08-10: every category on all four of Jeff's
      // stations has spins_per_hour 0 or NULL. The mismatch report is therefore correctly empty, which
      // would make this sense invisible on exactly the installs that need it most.
      //
      // So state the observable fact instead, and claim nothing: what the clock's music composition
      // ACTUALLY is. That is not a goal judgement — it is the number a PD needs in order to declare a
      // goal at all, and it is Phase 3's precondition (a goal-driven engine has nothing to aim at until
      // targets exist). Deliberately NOT auto-filling spins_per_hour from this: inferring intent from
      // geometry and writing it back would invent a decision nobody made.
      if (!goals.length) {
        const composition = [];
        for (const ck of clocks) {
          const counts = slotsFor.all(ck.clockId, sid);
          let musicSlots = 0; for (const r of counts) musicSlots += r.n;
          if (musicSlots === 0) continue;
          const top = counts
            .map(r => {
              const c = nameOfCat.get(r.category_id) || {};
              return { categoryId: r.category_id, category: c.name || c.code || ('#' + r.category_id),
                       slots: r.n, pct: Math.round((r.n / musicSlots) * 100) };
            })
            .sort((a, b) => b.slots - a.slots);
          composition.push({ clockId: ck.clockId, clock: ck.clockName || ('#' + ck.clockId), musicSlots, top });
        }
        if (!composition.length) return null;
        composition.sort((a, b) => (b.top[0]?.pct || 0) - (a.top[0]?.pct || 0));   // most lopsided first
        return { declared: 0, totalCats, mismatches: [], composition };
      }

      const out = [];
      for (const ck of clocks) {
        const counts = new Map(slotsFor.all(ck.clockId, sid).map(r => [r.category_id, r.n]));
        // A clock with NO music slots at all is a talk/specialty clock. Reporting "Gold under by 4"
        // against it would be true and useless — the noise that makes an advisory panel get ignored.
        let musicSlots = 0; for (const n of counts.values()) musicSlots += n;
        if (musicSlots === 0) continue;

        const rows = [];
        for (const g of goals) {
          const slots = counts.get(g.id) || 0;
          const delta = slots - g.target;              // negative = under, positive = over
          if (delta === 0) continue;                    // matched — nothing to say
          rows.push({
            categoryId: g.id,
            category: g.name || g.code || ('#' + g.id),
            target: g.target, slots, delta,
            priority: g.priority ?? 0,
            unused: slots === 0,                        // declared a goal, absent from this clock entirely
          });
        }
        if (!rows.length) continue;
        // Biggest miss first; a higher-priority category breaks a tie, since that is the one the PD
        // said matters more.
        rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (b.priority - a.priority));
        out.push({ clockId: ck.clockId, clock: ck.clockName || ('#' + ck.clockId), musicSlots, rows });
      }
      // Worst-offending clock first.
      out.sort((a, b) => {
        const worst = (x) => x.rows.reduce((m, r) => Math.max(m, Math.abs(r.delta)), 0);
        return worst(b) - worst(a);
      });
      return { declared: goals.length, totalCats, mismatches: out, composition: [] };
    } catch { return null; }
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
    // BATCHED (2026-07-22 main-loop-freeze fix): the previous version ran THREE play_log subqueries PER
    // SONG (last-play + last-artist + count) synchronously — over ~all songs ×3 stations every sweep,
    // that froze the main event loop (measured 17s). Replace with TWO set-based scans: one GROUP BY
    // file_path (last-play + count) and one GROUP BY artist (last-play), looked up in memory. Same output.
    const byPath = new Map();     // file_path -> { last, count }
    try {
      for (const r of db.prepare(
        `SELECT file_path, MAX(played_at) m, COUNT(*) c FROM play_log
           WHERE station_id=? AND deleted_at IS NULL AND file_path IS NOT NULL GROUP BY file_path`).all(sid))
        byPath.set(r.file_path, { last: r.m || 0, count: r.c || 0 });
    } catch { /* empty play_log */ }
    const byArtist = new Map();    // artist_id -> last-play (only needed when artist separation is on)
    if (artistSepSec) {
      try {
        for (const r of db.prepare(
          `SELECT s2.artist_id aid, MAX(pl.played_at) m FROM play_log pl JOIN songs s2 ON s2.file_path=pl.file_path
             WHERE pl.station_id=? AND pl.deleted_at IS NULL AND s2.artist_id IS NOT NULL GROUP BY s2.artist_id`).all(sid))
          byArtist.set(r.aid, r.m || 0);
      } catch { /* no artist plays */ }
    }
    const out = []; const sum = { eligible: 0, resting: 0, neverPlayed: 0, unresolvable: 0, total: songs.length };
    for (const s of songs) {
      const resolvable = exists(s.file_path) || !!s.file_key;
      const pe = s.file_path ? byPath.get(s.file_path) : null;
      const lp = pe ? pe.last : 0;
      const songRest = lp ? Math.max(0, (lp + (s.no_repeat_hours || 3) * 3600) - now) : 0;
      let artRest = 0;
      if (artistSepSec && s.artist_id) { const la = byArtist.get(s.artist_id) || 0; artRest = la ? Math.max(0, (la + artistSepSec) - now) : 0; }
      const rest = Math.max(songRest, artRest);
      let status;
      if (!resolvable) { status = 'UNRESOLVABLE'; sum.unresolvable++; }
      else if (!lp) { status = 'NEVER_PLAYED'; sum.neverPlayed++; }
      else if (rest > 0) { status = 'RESTING'; sum.resting++; }
      else { status = 'ELIGIBLE'; sum.eligible++; }
      const plays = pe ? pe.count : 0;
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
    const uncat = uncategorisedMusic(db);
    const runway = runwayOf(db, sid);
    const name = (db.prepare("SELECT name FROM stations WHERE id=?").get(sid) || {}).name || String(sid);
    // Levels: yellow if any unresolvable / pool shrunk; red if skips climbing.
    const materialization = { resolvable, total, r2Only, dead };
    const materialLevel = dead > 0 ? 'red' : (r2Only > 0 ? 'yellow' : 'green');   // dead = truly unplayable
    const poolLevel = (total > 0 && spun.length / total < 0.7) ? 'yellow' : 'green';
    const skipLevel = skipped > 0 ? 'red' : 'green';
    // A station about to run out of log is the most urgent thing this monitor can report — a dry log
    // on a flipped station is dead air — so runway drives the row colour like any other red.
    const level = [materialLevel, poolLevel, skipLevel, runway.level].includes('red') ? 'red'
                : [materialLevel, poolLevel, uncat.level, runway.level].includes('yellow') ? 'yellow' : 'green';
    return {
      stationId: sid, name, level,
      uncategorised: uncat,                       // music that can never air (2026-08-11 ruling)
      runway,                                     // fuel gauge — days to the first gap (see electron/runway.js)
      materialization: { ...materialization, level: materialLevel },
      pool: { librarySize: total, spunPool24h: spun.length, topSpins24h: topSpins, level: poolLevel },
      skipped: { thisHour: skipped, level: skipLevel },
      prefetchLag: { upcomingUnmaterialized: lag },
      eligibility: elig.summary,
      depth: depthCheck(db, sid),                 // per-clock-slot supply vs demand (item 3)
      goals: goalCheck(db, sid),                  // declared spins/hr vs clock composition (Advisor, Phase 1)
      lastGenerate: lastGen.get(sid) || null,     // last Generate run's relaxed/empty summary (item 2)
    };
  }

  // ── Runway / fuel gauge — how far ahead the log actually reaches ───────────────────────────────
  //
  // The question that started the whole scheduler arc: "how long until this station runs out of
  // log?" It has always been answerable and was never on screen.
  //
  // METRIC: first-gap, show-coverage-aware. See electron/runway.js for why MAX(scheduled_at) - now
  // was wrong and what replaced it. This calls the SAME function the auto-extend engine uses to
  // decide when to generate, so the gauge and the engine can never disagree about a station.
  //
  // Levels: green >= 5 days, yellow < 3, red < 1, grey when no active show.
  function runwayOf(db, sid) {
    try { return require('./runway').computeRunway(db, sid); }
    catch { return { metric: 'first-gap', days: null, hours: null, level: 'grey', reason: 'unavailable' }; }
  }

  // ── Uncategorised music — songs that CANNOT air ────────────────────────────────────────────────
  //
  // A MUSIC song with category_id NULL is in no category, and every on-format read derives its
  // universe from clock_slots.category_id — so it is dropped by all of them. It cannot be scheduled,
  // ever. That is not an error state, it is an UNFINISHED IMPORT, and the only reason it went
  // unnoticed for months is that nothing said so out loud.
  //
  // ACCOUNT-LEVEL, and reported as such: `songs` has no station_id (the library is shared) and a
  // song reaches a station through its CATEGORY — so an uncategorised song belongs to no station by
  // construction. The same figure therefore appears on every station's snapshot, with scope:'account'
  // so a reader is not misled into hunting for a per-station cause.
  //
  // JINGLES AND SPOTS ARE EXCLUDED, deliberately: they do not have categories and must not — they are
  // filed by jingle_category_id / spot_category_id. On the live install 64 of the 74 uncategorised
  // songs are JIN and 2 are SPOT; counting those would turn a correct state into a permanent fault.
  function uncategorisedMusic(db) {
    try {
      const r = db.prepare(`SELECT COUNT(*) n FROM songs
         WHERE category_id IS NULL AND deleted_at IS NULL
           AND (content_class IS NULL OR content_class = 'MUSIC')`).get();
      const n = (r && r.n) || 0;
      return { songs: n, scope: 'account', level: n > 0 ? 'yellow' : 'green' };
    } catch { return { songs: 0, scope: 'account', level: 'green' }; }
  }

  const _lintSeen = new Set();   // rowIds already event-logged, so a violation is reported once
  function computeAll() {
    const _sweepStart = Date.now();   // (2026-07-22) observe the sweep cost — a slow sweep freezes main
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
    snap.sweepMs = Date.now() - _sweepStart;        // (2026-07-22) how long this sweep held the main loop
    lastSnapshot = snap;
    appendJsonl({ kind: 'library-health', stations: snap.stations, sweepMs: snap.sweepMs });
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
    // Exposed for the bench (scripts/smoke-goal-advisor.js). Pure with respect to this closure — it
    // reads only (db, stationId) — so it can be exercised against a synthetic DB without a station,
    // a daemon or a sweep. The mismatch branch is otherwise untestable on real data today: no
    // category on any live station has a target set (measured 2026-08-10).
    goalCheck,
    // Slice B feeds this from the daemon's loud skip events.
    noteSkip(stationId, title, reason) {
      const hr = Math.floor(nowSec() / 3600);
      const c = skipCounts.get(stationId);
      skipCounts.set(stationId, c && c.hour === hr ? { hour: hr, n: c.n + 1 } : { hour: hr, n: 1 });
      appendJsonl({ kind: 'load-skip', stationId, title, reason });
    },
    // Item 2 — Generate reports its within-category relaxation (separation bent) + empty categories after
    // each run. LOUD: a health event per relaxed category + per empty category, and a per-station summary
    // the Health Monitor surfaces ("Feel Good: separation relaxed ×N"). The law being bent is now visible,
    // not buried in the calendar panel. relaxed = ctx.relaxed [{category_id,...}]; emptyCatIds = ids.
    noteGenerate(stationId, info) {
      try {
        const db = getDb();
        const nameOf = (id) => { const c = db.prepare("SELECT code, name FROM categories WHERE id=?").get(id) || {}; return c.name || c.code || ('#' + id); };
        const byCat = new Map();
        for (const r of (info && info.relaxed || [])) byCat.set(r.category_id, (byCat.get(r.category_id) || 0) + 1);
        const relaxed = [...byCat.entries()].map(([id, count]) => ({ categoryId: id, category: nameOf(id), count })).sort((a, b) => b.count - a.count);
        const emptyCats = (info && info.emptyCatIds || []).map(nameOf);
        // Anchor-fit (v4.4.84): breaks that still landed > tolerance off their minute — a visible honest
        // signal so an un-fittable anchor (e.g. a category of only long songs) surfaces, never silent.
        const breakDrift = (info && info.breakDrift || []);
        const driftSummary = breakDrift.length ? {
          count: breakDrift.length,
          worstSec: Math.max(0, ...breakDrift.map(b => Math.abs(b.driftSec || 0))),
          byMinute: [...breakDrift.reduce((m, b) => m.set(b.minute, (m.get(b.minute) || 0) + 1), new Map()).entries()]
            .map(([minute, n]) => ({ minute, n })).sort((a, b) => a.minute - b.minute),
        } : null;
        lastGen.set(stationId, { at: new Date().toISOString(), relaxed, emptyCats, relaxedTotal: (info && info.relaxed || []).length, breakDrift: driftSummary });
        for (const r of relaxed) appendJsonl({ kind: 'generate-relaxed', stationId, category: r.category, count: r.count });
        for (const nm of emptyCats) appendJsonl({ kind: 'generate-empty-category', stationId, category: nm });
        for (const b of breakDrift) appendJsonl({ kind: 'generate-break-drift', stationId, hour: b.hour, minute: b.minute, driftSec: b.driftSec, direction: b.direction });
      } catch { /* best-effort — never break Generate */ }
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

module.exports = { createLibraryHealth, noteEvent };

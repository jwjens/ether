// ── ROTATION ANALYTICS (Phase 4, 2026-08-10) ─────────────────────────────────────────────────────
//
// READ-ONLY. Every query here is a SELECT; nothing in this module writes, and nothing it returns
// feeds a scheduling decision. It answers the four questions a PD actually asks about rotation:
//
//   spins   — how often is each category airing, vs the target declared on it?
//   burn    — which artists are on too often, and how tightly spaced?
//   turnover— how much of the library is actually in play, and how stale is what airs?
//   why     — for one row: why THAT song?
//
// DATA SOURCE. The brief named scheduler-core-shadow.jsonl. That file is the PARITY ledger — it holds
// per-run aggregates and at most 25 divergence samples, not a per-row account — so it cannot answer
// any of the four. Everything below is computed from `generated_schedule` (what was scheduled) and
// `play_log` (what actually aired), which are complete. The `why` view reads the new pick_reason
// column, which starts populating from this build forward; rows generated before it are honestly
// reported as "not recorded" rather than guessed at.
//
// Design: docs/goal-driven-scheduler-redesign-2026-08-10.md §4 Phase 4
"use strict";

const DAY = 86400;

// Does this DB have the Phase 4 reason column yet? A build can be running against a database whose
// migrations have not been applied (the app has not restarted), and analytics must degrade to "no
// reasons recorded" rather than throwing — the standing rule is never to crash on our own DB, in any
// state a prior or future build left it. Cached per handle; schema does not change under us mid-run.
const _hasReason = new WeakMap();
function hasPickReason(db) {
  if (_hasReason.has(db)) return _hasReason.get(db);
  let ok = false;
  try { ok = db.prepare("PRAGMA table_info(generated_schedule)").all().some(c => c.name === "pick_reason"); } catch {}
  _hasReason.set(db, ok);
  return ok;
}

/** Local-day bucket expression for a unix-seconds column. */
const localHour = (col) => `strftime('%Y-%m-%d %H:00', datetime(${col},'unixepoch','localtime'))`;

// ── 1. Spins per category — actual vs target ─────────────────────────────────────────────────────
// Counted on generated_schedule.category_id (what the scheduler PLACED it as), not songs.category_id
// (what the song is filed under now). Those diverge after a re-categorisation, and the question here
// is what the scheduler did.
function categorySpins(db, stationId, fromTs, toTs) {
  const hoursSpan = Math.max(1, Math.round((toTs - fromTs) / 3600));
  const rows = db.prepare(`
    SELECT gs.category_id AS categoryId,
           COALESCE(c.name, c.code, '(uncategorised)') AS category,
           c.spins_per_hour AS target,
           COUNT(*) AS spins,
           COUNT(DISTINCT gs.song_id) AS distinctSongs
      FROM generated_schedule gs
      LEFT JOIN categories c ON c.id = gs.category_id
     WHERE gs.station_id = ? AND gs.deleted_at IS NULL
       AND (gs.content_class IS NULL OR gs.content_class = 'MUSIC')
       AND gs.scheduled_at >= ? AND gs.scheduled_at < ?
     GROUP BY gs.category_id
     ORDER BY spins DESC`).all(stationId, fromTs, toTs);

  const total = rows.reduce((a, r) => a + r.spins, 0);
  return rows.map(r => {
    const actualPerHour = r.spins / hoursSpan;
    // A target of 0/NULL means "no goal declared" — NOT "target zero". Reporting such a category as
    // infinitely over target would be the panel's first lie.
    const hasTarget = r.target != null && r.target > 0;
    return {
      ...r,
      hasTarget,
      target: hasTarget ? r.target : null,
      actualPerHour: Math.round(actualPerHour * 100) / 100,
      deltaPerHour: hasTarget ? Math.round((actualPerHour - r.target) * 100) / 100 : null,
      sharePct: total ? Math.round((r.spins / total) * 100) : 0,
    };
  });
}

// ── 2. Hourly grid — spins per category per hour ─────────────────────────────────────────────────
function hourlyGrid(db, stationId, fromTs, toTs) {
  return db.prepare(`
    SELECT ${localHour('gs.scheduled_at')} AS hour,
           COALESCE(c.name, c.code, '(uncategorised)') AS category,
           gs.category_id AS categoryId,
           COUNT(*) AS spins
      FROM generated_schedule gs
      LEFT JOIN categories c ON c.id = gs.category_id
     WHERE gs.station_id = ? AND gs.deleted_at IS NULL
       AND (gs.content_class IS NULL OR gs.content_class = 'MUSIC')
       AND gs.scheduled_at >= ? AND gs.scheduled_at < ?
     GROUP BY hour, gs.category_id
     ORDER BY hour, spins DESC`).all(stationId, fromTs, toTs);
}

// ── 3. Artist burn ───────────────────────────────────────────────────────────────────────────────
// Two facts per artist: how often they aired, and the TIGHTEST gap between two airings. A high spin
// count with comfortable spacing is a format; a low count with a 12-minute gap is a complaint.
// Measured against the station's artist separation rule so "too close" means the station's own rule,
// not an invented threshold.
function artistBurn(db, stationId, fromTs, toTs, limit = 40) {
  let sepMin = 60;
  try {
    const r = db.prepare("SELECT value FROM separation_rules WHERE station_id=? AND rule_type='artist_separation_min' AND is_active=1 LIMIT 1").get(stationId);
    if (r && r.value) sepMin = r.value;
  } catch {}

  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(gs.artist),''), '(unknown)') AS artist,
           COUNT(*) AS spins,
           MIN(gs.scheduled_at) AS firstAt,
           MAX(gs.scheduled_at) AS lastAt
      FROM generated_schedule gs
     WHERE gs.station_id = ? AND gs.deleted_at IS NULL
       AND (gs.content_class IS NULL OR gs.content_class = 'MUSIC')
       AND gs.scheduled_at >= ? AND gs.scheduled_at < ?
     GROUP BY artist HAVING spins > 1
     ORDER BY spins DESC LIMIT ?`).all(stationId, fromTs, toTs, limit);

  const times = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(gs.artist),''), '(unknown)') AS artist, gs.scheduled_at AS ts
      FROM generated_schedule gs
     WHERE gs.station_id = ? AND gs.deleted_at IS NULL
       AND (gs.content_class IS NULL OR gs.content_class = 'MUSIC')
       AND gs.scheduled_at >= ? AND gs.scheduled_at < ?
     ORDER BY artist, ts`).all(stationId, fromTs, toTs);

  const byArtist = new Map();
  for (const t of times) {
    if (!byArtist.has(t.artist)) byArtist.set(t.artist, []);
    byArtist.get(t.artist).push(t.ts);
  }
  return rows.map(r => {
    const ts = byArtist.get(r.artist) || [];
    let tightestSec = null;
    for (let i = 1; i < ts.length; i++) {
      const gap = ts[i] - ts[i - 1];
      if (tightestSec === null || gap < tightestSec) tightestSec = gap;
    }
    return {
      ...r,
      tightestGapMin: tightestSec === null ? null : Math.round(tightestSec / 60),
      separationRuleMin: sepMin,
      violatesRule: tightestSec !== null && tightestSec < sepMin * 60,
    };
  }).sort((a, b) => (b.violatesRule - a.violatesRule) || (b.spins - a.spins));
}

// ── 4. Turnover — how fresh is the rotation? ─────────────────────────────────────────────────────
// "Depth" (how many songs exist) is already covered by library-health's depthCheck. This is the other
// half: of the songs that COULD air, how many did, and how concentrated were the spins?
function turnover(db, stationId, fromTs, toTs) {
  const out = [];
  const cats = db.prepare(
    "SELECT id, COALESCE(name, code, '#'||id) AS name FROM categories WHERE station_id=? AND deleted_at IS NULL").all(stationId);
  const libStmt = db.prepare(`
    SELECT COUNT(*) n FROM songs
     WHERE category_id = ? AND deleted_at IS NULL
       AND (rotation_status IS NULL OR rotation_status != 'inactive')
       AND (content_class IS NULL OR content_class = 'MUSIC')`);
  const playedStmt = db.prepare(`
    SELECT COUNT(DISTINCT song_id) played, COUNT(*) spins
      FROM generated_schedule
     WHERE station_id = ? AND category_id = ? AND deleted_at IS NULL AND song_id IS NOT NULL
       AND scheduled_at >= ? AND scheduled_at < ?`);

  for (const c of cats) {
    const lib = libStmt.get(c.id).n;
    const p = playedStmt.get(stationId, c.id, fromTs, toTs);
    if (!lib && !p.spins) continue;
    // songsUsed can EXCEED librarySize, and that is information rather than an error: the log holds
    // songs that are no longer in this category — re-filed, deleted, or rotation-disabled since the
    // log was built. Reporting a bare "103% coverage" would just look broken, so the overflow is
    // surfaced as its own number and the percentage is clamped for display.
    const drift = Math.max(0, p.played - lib);
    out.push({
      categoryId: c.id, category: c.name,
      librarySize: lib,
      songsUsed: p.played,
      spins: p.spins,
      // Coverage: what fraction of the eligible library actually got an airing.
      coveragePct: lib ? Math.min(100, Math.round((p.played / lib) * 100)) : 0,
      driftSongs: drift,          // scheduled songs no longer in the category — >0 means the log is stale
      // Spins per used song: 1.0 = perfectly even; high = a few songs carrying the category.
      spinsPerSong: p.played ? Math.round((p.spins / p.played) * 100) / 100 : 0,
    });
  }
  return out.sort((a, b) => a.coveragePct - b.coveragePct);
}

// ── 5. Why was this row picked? ──────────────────────────────────────────────────────────────────
function explainRow(db, stationId, rowId) {
  const col = hasPickReason(db);
  const r = db.prepare(`
    SELECT gs.id, gs.scheduled_at, gs.title, gs.artist, gs.category_id, ${col ? "gs.pick_reason" : "NULL AS pick_reason"}, gs.state,
           gs.source, gs.content_class, COALESCE(c.name, c.code) AS category
      FROM generated_schedule gs LEFT JOIN categories c ON c.id = gs.category_id
     WHERE gs.id = ? AND gs.station_id = ?`).get(rowId, stationId);
  if (!r) return null;
  let parsed = null;
  if (r.pick_reason) { try { parsed = JSON.parse(r.pick_reason); } catch { parsed = null; } }
  return {
    ...r,
    reason: parsed,
    // Honest about absence: a row generated before pick_reason existed has no reason and cannot get
    // one — the losing candidates are gone. Say so rather than inventing a plausible sentence.
    reasonAvailable: !!parsed,
    reasonText: parsed ? renderReason(parsed, r.category) : null,
  };
}

function renderReason(p, categoryName) {
  const cat = categoryName || ("category " + p.cat);
  const vetoed = p.veto ? Object.entries(p.veto).filter(([, n]) => n > 0) : [];
  const bits = [];
  bits.push(`${cat}: chosen from a pool of ${p.pool}`);
  if (vetoed.length) bits.push(vetoed.map(([k, n]) => `${n} vetoed by ${k.replace(/_/g, " ")}`).join(", "));
  if (p.relax && p.relax.length) bits.push(`RELAXED: ${p.relax.join(" + ").replace(/_/g, " ")}`);
  else bits.push("all separation rules satisfied");
  if (p.g) bits.push(`goal: ${p.g.placed}/${p.g.target} placed, paced ${p.g.paced}`);
  return bits.join(" · ");
}

// ── Aggregate snapshot for the UI ────────────────────────────────────────────────────────────────
function snapshot(db, stationId, fromTs, toTs) {
  return {
    stationId, fromTs, toTs,
    spins: categorySpins(db, stationId, fromTs, toTs),
    hourly: hourlyGrid(db, stationId, fromTs, toTs),
    burn: artistBurn(db, stationId, fromTs, toTs),
    turnover: turnover(db, stationId, fromTs, toTs),
    reasonCoverage: reasonCoverage(db, stationId, fromTs, toTs),
  };
}

/** How much of the window can actually be explained — so the UI never implies more than it has. */
function reasonCoverage(db, stationId, fromTs, toTs) {
  const col = hasPickReason(db);
  const r = db.prepare(`
    SELECT COUNT(*) total${col ? ", SUM(CASE WHEN pick_reason IS NOT NULL THEN 1 ELSE 0 END) withReason" : ""}
      FROM generated_schedule
     WHERE station_id=? AND deleted_at IS NULL AND (content_class IS NULL OR content_class='MUSIC')
       AND scheduled_at >= ? AND scheduled_at < ?`).get(stationId, fromTs, toTs);
  const total = r.total || 0, withReason = col ? (r.withReason || 0) : 0;
  return { total, withReason, pct: total ? Math.round((withReason / total) * 100) : 0, columnPresent: col };
}

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────────
const csvCell = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
const csvRows = (header, rows) => [header.join(","), ...rows.map(r => r.map(csvCell).join(","))].join("\n");

function toCsv(kind, snap) {
  if (kind === "hourly") {
    return csvRows(["Hour", "Category", "Spins"], snap.hourly.map(r => [r.hour, r.category, r.spins]));
  }
  if (kind === "spins") {
    return csvRows(["Category", "Target/hr", "Actual/hr", "Delta/hr", "Spins", "Distinct songs", "Share %"],
      snap.spins.map(r => [r.category, r.hasTarget ? r.target : "(none)", r.actualPerHour, r.deltaPerHour ?? "", r.spins, r.distinctSongs, r.sharePct]));
  }
  if (kind === "burn") {
    return csvRows(["Artist", "Spins", "Tightest gap (min)", "Rule (min)", "Violates rule"],
      snap.burn.map(r => [r.artist, r.spins, r.tightestGapMin ?? "", r.separationRuleMin, r.violatesRule ? "YES" : ""]));
  }
  if (kind === "turnover") {
    return csvRows(["Category", "Library size", "Songs used", "Coverage %", "Off-category (stale)", "Spins", "Spins per song"],
      snap.turnover.map(r => [r.category, r.librarySize, r.songsUsed, r.coveragePct, r.driftSongs, r.spins, r.spinsPerSong]));
  }
  return "";
}

module.exports = { snapshot, categorySpins, hourlyGrid, artistBurn, turnover, explainRow, reasonCoverage, toCsv, renderReason, DAY };

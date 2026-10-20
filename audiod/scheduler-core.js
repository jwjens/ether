// audiod/scheduler-core.js — THE ONE PICK (docs/scheduler-rotation-playout-design.md §3.2, Phase 2; Jeff GO 2026-10-18).
//
// Every song Ether places or airs on its own is chosen here, and only here: Generate (every day, every hour, every slot,
// break mode included), the hour's regenerate, auto-extend, and the reader's fill for a short hour. Nothing else chooses.
//
//   THE RULES (Programming preferences, per station; a rule that is off is off — nothing is assumed in its place):
//     song   — the same recording (the stored file name) may not air again within the song separation, either side;
//     artist — no credited artist (split on the station's delimiters) within the artist separation, either side;
//     title  — no other song of the same normalised title AND the same length (to the second) within the title
//              separation, either side. Same name, different length = a different song (Jeff, 2026-10-19: "just because the
//              song has the same name look at the length they are not the same song");
//     per-song no-repeat hours — a song that carries a value may not air again within that many hours of itself.
//   They are measured against what AIRED on this station (play_log) plus what is ALREADY IN THE LOG on either side of
//   the slot, plus what this run has already placed. A gap equal to the rule passes; a shorter one does not.
//
//   THE PICK: among the slot category's songs that pass every rule, the one that has waited longest since it last aired
//   (or was last placed by this run). Never aired = waited longest. Random ONLY for an exact tie. Nothing else decides —
//   no score, no length fitting, no "closest to passing".
//
//   NOTHING PASSES (Jeff, 2026-10-19: "its [the rules] or least recently played … once all songs have been played you
//   start with the least recently played so that would be the first song again"): the station's own fallback category
//   is tried first if the user named one (none by default), under the same rules; then the slot gets the slot
//   category's LEAST RECENTLY PLAYED song (`leastRecent`), whatever the rules say, and the row says so. A slot is
//   UNSCHEDULED only when its category has no song at all.
//
// Pure over its inputs except `loadTimeline` / `poolFor` / `stationRules`, which read the database once and never write.
"use strict";

const DEFAULT_DELIMITERS = ["/", "&", ",", "feat.", "ft.", "f/", "x", "with"];

// ── identity ──────────────────────────────────────────────────────────────────────────────────────────────────────
function recordingKey(f) {
  if (!f) return null;
  const b = String(f).trim().split(/[\\/]/).pop();
  return b ? b.toLowerCase() : null;
}
function normaliseTitle(t) {
  if (!t) return null;
  let s = String(t).toLowerCase();
  s = s.replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*$/g, "");
  s = s.replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*$/g, "");
  s = s.replace(/\s+[-–—]\s+(from|feat\.?|ft\.?)\b.*$/i, "");
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return s || null;
}
/** The title rule's key: the normalised title plus the length to the second. No known length = the title alone. */
function titleKey(title, durationMs) {
  const t = normaliseTitle(title);
  if (!t) return null;
  const sec = Number(durationMs) > 0 ? Math.round(Number(durationMs) / 1000) : null;
  return sec != null ? `${t}|${sec}` : t;
}
function makeSplitter(delims = DEFAULT_DELIMITERS) {
  const esc = (d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(delims.map(d => /^[a-z]/i.test(d) ? `\\s+${esc(d)}(?=\\s)\\s*` : `\\s*${esc(d)}\\s*`).join("|"), "i");
  return (name) => name ? String(name).split(re).map(a => a.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean) : [];
}

// ── the timeline: every airing and placement, by each rule's key ──────────────────────────────────────────────────
class Timeline {
  constructor(split) { this.split = split || makeSplitter(); this.rec = new Map(); this.art = new Map(); this.tit = new Map(); }
  static _ins(m, k, ts) {
    if (!k) return;
    let a = m.get(k); if (!a) { a = []; m.set(k, a); }
    if (!a.length || a[a.length - 1] <= ts) a.push(ts);
    else { let i = a.length; while (i > 0 && a[i - 1] > ts) i--; a.splice(i, 0, ts); }
  }
  /** One airing or placement: {file, artist, title, durationMs} at ts. */
  add(item, ts) {
    const rec = recordingKey(item.file), title = titleKey(item.title, item.durationMs);
    Timeline._ins(this.rec, rec, ts);
    for (const a of this.split(item.artist)) Timeline._ins(this.art, a, ts);
    Timeline._ins(this.tit, title, ts);
  }
  static _del(m, k, ts) {
    const a = k && m.get(k); if (!a) return;
    const i = a.lastIndexOf(ts); if (i >= 0) a.splice(i, 1);
  }
  /** Take one placement back off the timeline (a row that will not air: past its hour's end). */
  remove(item, ts) {
    Timeline._del(this.rec, recordingKey(item.file), ts);
    for (const a of this.split(item.artist)) Timeline._del(this.art, a, ts);
    Timeline._del(this.tit, titleKey(item.title, item.durationMs), ts);
  }
  /** Nearest time with this key strictly before ts, and at-or-after ts. */
  static _near(arr, ts) {
    if (!arr || !arr.length) return [null, null];
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < ts) lo = m + 1; else hi = m; }
    return [lo > 0 ? arr[lo - 1] : null, lo < arr.length ? arr[lo] : null];
  }
  lastBefore(file, ts) { return Timeline._near(this.rec.get(recordingKey(file)), ts)[0]; }
}

/** The first rule this song breaks at ts (either side), or null. rules: {songMin, artistMin, titleMin} (null = off). */
function breach(tl, song, ts, rules) {
  const chk = (rule, min, arr, key) => {
    if (min == null || !key) return null;
    const lim = min * 60;
    const [b, a] = Timeline._near(arr, ts);
    if (b != null && ts - b < lim) return { rule, key, settingMin: min, measuredMin: +((ts - b) / 60).toFixed(1), side: "before" };
    if (a != null && a - ts < lim) return { rule, key, settingMin: min, measuredMin: +((a - ts) / 60).toFixed(1), side: "after" };
    return null;
  };
  const rec = recordingKey(song.file);
  let r = chk("song", rules.songMin, tl.rec.get(rec), rec);
  if (r) return r;
  for (const a of tl.split(song.artist)) { r = chk("artist", rules.artistMin, tl.art.get(a), a); if (r) return r; }
  const t = titleKey(song.title, song.duration_ms ?? song.durationMs);
  r = chk("title", rules.titleMin, tl.tit.get(t), t);
  if (r) return r;
  const nrMin = song.noRepeatHours != null && Number(song.noRepeatHours) > 0 ? Number(song.noRepeatHours) * 60 : null;
  if (nrMin != null && !(rules.songMin != null && rules.songMin >= nrMin)) {
    r = chk("no-repeat-hours", nrMin, tl.rec.get(rec), rec);
    if (r) return r;
  }
  return null;
}

/**
 * THE PICK. pool: [{id, title, artist, file, noRepeatHours, ...}] — the slot category's songs eligible at this hour.
 * Returns { song, lastAired } for the longest-waiting song that passes every rule, or { song: null, closest } naming the
 * songs that came closest and the rule that blocked each. `rand` breaks an exact tie (Math.random by default).
 */
// opts.spokenFor (the reader's fill only): Map recording → the time a song is already planned LATER in today's log. Such
// a song is spoken for — it will air then — so for "waited longest" it counts as aired at that planned time. Without it a
// fill takes the longest-waiting song now and the log airs it again an hour later while others have not aired at all.
function pick(pool, ts, tl, rules, rand = Math.random, opts = null) {
  let best = Infinity; const ties = []; const blocked = [];
  const spoken = opts && opts.spokenFor;
  for (const s of pool) {
    const b = breach(tl, s, ts, rules);
    if (b) { blocked.push({ s, b }); continue; }
    const last = tl.lastBefore(s.file, ts);
    let w = last == null ? -Infinity : last;
    if (spoken) { const at = spoken.get(recordingKey(s.file)); if (at != null && at > w) w = at; }
    if (w < best) { best = w; ties.length = 0; ties.push(s); }
    else if (w === best) ties.push(s);
  }
  if (ties.length) {
    const song = ties.length === 1 ? ties[0] : ties[Math.min(ties.length - 1, Math.floor(rand() * ties.length))];
    return { song, lastAired: best === -Infinity ? null : best, passing: pool.length - blocked.length, ties: ties.length };
  }
  // closest = the smallest shortfall against the rule that blocked it
  const closest = blocked.map(x => ({ title: x.s.title, artist: x.s.artist || "", rule: x.b.rule, measuredMin: x.b.measuredMin, settingMin: x.b.settingMin, shortMin: +(x.b.settingMin - x.b.measuredMin).toFixed(1) }))
    .sort((a, b) => a.shortMin - b.shortMin).slice(0, 3);
  return { song: null, closest, poolSize: pool.length };
}

/**
 * NOTHING PASSES → the pool's LEAST RECENTLY PLAYED song, rules set aside (Jeff, 2026-10-19). Same measure as the pick:
 * waited longest since it last aired or was placed (never aired = longest); random only for an exact tie. Returns
 * { song, lastAired, ties, broke } where `broke` is the rule this song breaks at ts (said on the row), or { song: null }
 * for an empty pool.
 */
function leastRecent(pool, ts, tl, rules, rand = Math.random, opts = null) {
  let best = Infinity; const ties = [];
  const spoken = opts && opts.spokenFor;
  for (const s of pool) {
    const last = tl.lastBefore(s.file, ts);
    let w = last == null ? -Infinity : last;
    if (spoken) { const at = spoken.get(recordingKey(s.file)); if (at != null && at > w) w = at; }
    if (w < best) { best = w; ties.length = 0; ties.push(s); }
    else if (w === best) ties.push(s);
  }
  if (!ties.length) return { song: null, poolSize: 0 };
  const song = ties.length === 1 ? ties[0] : ties[Math.min(ties.length - 1, Math.floor(rand() * ties.length))];
  return { song, lastAired: best === -Infinity ? null : best, ties: ties.length, broke: breach(tl, song, ts, rules) };
}

// ── what the database says (read once per run; never writes) ──────────────────────────────────────────────────────
/** The station's rules from Programming preferences: active rows only. Inactive or missing = off. */
function stationRules(db, stationId) {
  const r = { songMin: null, artistMin: null, titleMin: null };
  try {
    for (const x of db.prepare("SELECT rule_type, value FROM separation_rules WHERE station_id = ? AND is_active = 1 AND deleted_at IS NULL").all(stationId)) {
      const v = Number(x.value); if (!Number.isFinite(v) || v <= 0) continue;
      if (x.rule_type === "song_separation_min") r.songMin = v;
      if (x.rule_type === "artist_separation_min") r.artistMin = v;
      if (x.rule_type === "title_separation_min") r.titleMin = v;
    }
  } catch { /* no table: every rule off */ }
  return r;
}

/** The slot category's pool at an hour: in rotation, MUSIC, not deleted, with a file, daypart allows the hour (D3). */
function poolFor(db, categoryId, hour) {
  try {
    return db.prepare(
      `SELECT s.id, s.title, a.name AS artist, s.artist_id, s.duration_ms, s.no_repeat_hours AS noRepeatHours,
              COALESCE(s.file_path, s.file_key) AS file, s.file_path, s.category_id
         FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
        WHERE s.deleted_at IS NULL AND s.category_id = ? AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
          AND (s.content_class IS NULL OR s.content_class = 'MUSIC') AND (s.file_path IS NOT NULL OR s.file_key IS NOT NULL)
          AND (s.daypart_mask IS NULL OR ((s.daypart_mask >> ?) & 1) = 1)
        ORDER BY s.id`).all(categoryId, hour);
  } catch { return []; }
}

/**
 * The timeline for a run: every MUSIC play this station has on record before `beforeTs`, and every row of its log that
 * will still be there after the run — pending, didn't-play or refused rows anywhere, hand-placed rows, and pending rows
 * outside `replace` = [from, to) — from one day before the window on (rule 3, Jeff 2026-10-19).
 */
function loadTimeline(db, stationId, { beforeTs, replace, sinceTs, poolFiles } = {}) {
  const split = makeSplitter();
  const tl = new Timeline(split);
  const byFile = new Map();
  try { for (const s of db.prepare("SELECT s.file_path f, s.file_key k, s.title, a.name artist, s.duration_ms FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.deleted_at IS NULL").all()) {
    const k = recordingKey(s.f || s.k); if (k && !byFile.has(k)) byFile.set(k, s);
  } } catch {}
  try {
    // sinceTs (the reader's fill, on the air loop): only the plays inside the rules' reach, plus — for "waited longest" —
    // each candidate's one last airing before that. Generate reads the whole history once per run (main process).
    // Only plays that aired on THIS computer (and the old ones with no computer recorded) — audiod/plays-here.js.
    const here = require("./plays-here").playsHere(db, "");
    for (const p of db.prepare(`SELECT file_path, title, artist, played_at, duration_ms FROM play_log WHERE station_id = ? AND deleted_at IS NULL AND ${here} AND (content_class IS NULL OR content_class = 'MUSIC') AND played_at < ? AND played_at >= ? ORDER BY played_at`).all(stationId, beforeTs ?? 9e12, sinceTs ?? 0)) {
      const s = byFile.get(recordingKey(p.file_path));
      tl.add({ file: p.file_path, artist: s ? s.artist : p.artist, title: s ? s.title : p.title, durationMs: (s && s.duration_ms) || p.duration_ms }, p.played_at);
    }
    if (sinceTs && poolFiles && poolFiles.length) {
      // BY RECORDING, not by stored path: one recording can sit on two song rows under two paths (a duplicate), and it
      // aired under whichever path its row had. Matching paths missed the other row's airings and the duplicate looked
      // never aired (found in the gate: one recording twice in 68 min while 75 others waited 3½ h).
      const want = new Set(poolFiles.map(recordingKey).filter(Boolean));
      const last = new Map();
      for (const r of db.prepare(`SELECT file_path, MAX(played_at) t FROM play_log WHERE station_id = ? AND deleted_at IS NULL AND ${here} AND played_at < ? AND file_path IS NOT NULL GROUP BY file_path`).all(stationId, sinceTs)) {
        const k = recordingKey(r.file_path);
        if (k && want.has(k) && r.t != null && !(last.get(k) >= r.t)) last.set(k, r.t);
      }
      for (const [k, t] of last) Timeline._ins(tl.rec, k, t);
    }
  } catch {}
  try {
    // THE REPLACE WINDOW IS BY LOG HOUR (v66), exactly as Generate's delete (main.js _commitDayRows): every clock row is
    // placed, so an hour still on air keeps its extra rows timed past :00 — they are not replaced, so they ARE the log on
    // the other side of the picks that follow them.
    // The window being replaced holds only PENDING rows Generate placed (Jeff, 2026-10-19, rule 4: regenerate keeps what
    // played, is playing, didn't play or was placed by hand, and rebuilds every pending row from the end of the song on
    // air). Those are left off here — they are about to be rebuilt; everything else counts, inside the window too.
    let lk = "gs.scheduled_at";
    try {
      if (db.prepare("PRAGMA table_info(generated_schedule)").all().some(c => c.name === "log_hour_ts")) lk = "COALESCE(gs.log_hour_ts, gs.scheduled_at)";
    } catch {}
    // GENERATE SEES EVERY ROW BEFORE A SLOT (Jeff, 2026-10-19: "Generate sees every row before a slot, including the
    // previous hour's rows, so it never repeats a song the previous hour already has."). Every row of the log that is not
    // being replaced and that airs — still to air, timed in the past but pending, placed by hand — counts on the timeline,
    // the aired ones through play_log. Rows that never air (didn't-play, or timed past their hour's end) do not. It used to take only pending rows
    // timed after "now" and to skip every row past its hour's end, so the first slots of an hour could repeat a song the
    // hour before already held. Bounded to one day before the window (beyond any rule's reach).
    const lookFrom = Math.min(beforeTs ?? 0, replace ? replace[0] : (beforeTs ?? 0)) - 86400;
    const rows = db.prepare(`SELECT gs.scheduled_at, ${lk} AS lk, gs.state, gs.title, gs.source, COALESCE(gs.file_key, gs.file_path, s.file_path) f, s.title st, a.name sa, COALESCE(s.duration_ms, gs.duration_s * 1000) ms
        FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id LEFT JOIN artists a ON a.id = s.artist_id
       WHERE gs.station_id = ? AND gs.deleted_at IS NULL AND (gs.state IS NULL OR gs.state IN ('pending', 'missed', 'skipped')) AND gs.song_id IS NOT NULL
         AND (gs.content_class IS NULL OR gs.content_class = 'MUSIC') AND gs.scheduled_at >= ?`).all(stationId, lookFrom);
    const endOf = pieceEndFn(db, stationId);
    for (const r of rows) {
      const inWindow = replace && r.lk >= replace[0] && r.lk < replace[1];
      const operator = r.source && String(r.source).trim().toLowerCase() === "operator";
      const pending = r.state == null || r.state === "pending";
      if (inWindow && pending && !operator) continue;   // being rebuilt by this run
      // ONLY ROWS THAT AIR COUNT. A row marked didn't-play never aired, and an automatic row timed past its hour's end never
      // will (rule 1 marks it didn't-play at the hour's end) — nobody can hear it repeat. Counting them burned the songs
      // placed there: rotation went 131 → 236 on the gate's station 3 (docs/rotation-regression-2026-10-19.md).
      if (r.state === "missed" || r.state === "skipped") continue;
      if (!operator && r.scheduled_at >= endOf(r.lk)) continue;
      tl.add({ file: r.f, artist: r.sa, title: r.st || r.title, durationMs: r.ms }, r.scheduled_at);
    }
  } catch {}
  return tl;
}

/** lk (a piece's start) → that piece's end by the station's show schedule. */
function pieceEndFn(db, stationId) {
  const sw = require("./show-window.js");
  let shows = [];
  try { shows = db.prepare("SELECT * FROM shows WHERE station_id = ? AND is_active = 1 AND deleted_at IS NULL").all(stationId); } catch {}
  const cache = new Map();
  return (lk) => { if (!cache.has(lk)) cache.set(lk, sw.pieceAt(shows, lk).endTs); return cache.get(lk); };
}

/** The station's fallback category for an UNSCHEDULED slot (Jeff 3d): a category the user names, or null. */
function fallbackCategory(db, stationId) {
  try {
    const r = db.prepare("SELECT value FROM station_config_kv WHERE station_id = ? AND key = 'unscheduled_fallback_category_id' AND deleted_at IS NULL").get(stationId);
    const n = r && r.value != null && r.value !== "" ? Number(r.value) : null;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** Place a chosen song on the timeline (this run's placement counts as "last aired" from here on). */
function commit(tl, song, ts) { tl.add({ file: song.file, artist: song.artist, title: song.title, durationMs: song.duration_ms ?? song.durationMs }, ts); }
/** Take a placement back (the inverse of commit). */
function uncommit(tl, song, ts) { tl.remove({ file: song.file, artist: song.artist, title: song.title, durationMs: song.duration_ms ?? song.durationMs }, ts); }

module.exports = { pick, leastRecent, titleKey, breach, commit, uncommit, pieceEndFn, Timeline, loadTimeline, poolFor, stationRules, fallbackCategory, recordingKey, normaliseTitle, makeSplitter, DEFAULT_DELIMITERS };

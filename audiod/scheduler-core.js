// audiod/scheduler-core.js — THE ONE PICK (docs/scheduler-rotation-playout-design.md §3.2, Phase 2; Jeff GO 2026-10-18).
//
// Every song Ether places or airs on its own is chosen here, and only here: Generate (every day, every hour, every slot,
// break mode included), the hour's regenerate, auto-extend, and the reader's fill for a short hour. Nothing else chooses.
//
//   THE RULES (Programming preferences, per station; a rule that is off is off — nothing is assumed in its place):
//     song   — the same recording (the stored file name) may not air again within the song separation, either side;
//     artist — no credited artist (split on the station's delimiters) within the artist separation, either side;
//     title  — no normalised title within the title separation, either side;
//     per-song no-repeat hours — a song that carries a value may not air again within that many hours of itself.
//   They are measured against what AIRED on this station (play_log) plus what is ALREADY IN THE LOG on either side of
//   the slot, plus what this run has already placed. A gap equal to the rule passes; a shorter one does not.
//
//   THE PICK: among the slot category's songs that pass every rule, the one that has waited longest since it last aired
//   (or was last placed by this run). Never aired = waited longest. Random ONLY for an exact tie. Nothing else decides —
//   no score, no length fitting, no "closest to passing".
//
//   NOTHING PASSES: the slot is UNSCHEDULED, with the rule that blocked the closest songs. Only the station's own
//   fallback category (a setting the user names; none by default) may fill it, under the same rules and the same pick.
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
  /** One airing or placement: {file, artist, title} at ts. */
  add(item, ts) {
    const rec = recordingKey(item.file), title = normaliseTitle(item.title);
    Timeline._ins(this.rec, rec, ts);
    for (const a of this.split(item.artist)) Timeline._ins(this.art, a, ts);
    Timeline._ins(this.tit, title, ts);
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
  const t = normaliseTitle(song.title);
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
function pick(pool, ts, tl, rules, rand = Math.random) {
  let best = Infinity; const ties = []; const blocked = [];
  for (const s of pool) {
    const b = breach(tl, s, ts, rules);
    if (b) { blocked.push({ s, b }); continue; }
    const last = tl.lastBefore(s.file, ts);
    const w = last == null ? -Infinity : last;
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
 * The timeline for a run: every MUSIC play this station has on record before `beforeTs`, and every pending MUSIC row of
 * its log still to air (scheduled at or after `beforeTs`) that will still be there after the run (outside `replace` =
 * [from, to), or operator-owned inside it).
 */
function loadTimeline(db, stationId, { beforeTs, replace } = {}) {
  const split = makeSplitter();
  const tl = new Timeline(split);
  const byFile = new Map();
  try { for (const s of db.prepare("SELECT s.file_path f, s.file_key k, s.title, a.name artist FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.deleted_at IS NULL").all()) {
    const k = recordingKey(s.f || s.k); if (k && !byFile.has(k)) byFile.set(k, s);
  } } catch {}
  try {
    for (const p of db.prepare("SELECT file_path, title, artist, played_at FROM play_log WHERE station_id = ? AND deleted_at IS NULL AND (content_class IS NULL OR content_class = 'MUSIC') AND played_at < ? ORDER BY played_at").all(stationId, beforeTs ?? 9e12)) {
      const s = byFile.get(recordingKey(p.file_path));
      tl.add({ file: p.file_path, artist: s ? s.artist : p.artist, title: s ? s.title : p.title }, p.played_at);
    }
  } catch {}
  try {
    const rows = db.prepare(`SELECT gs.scheduled_at, gs.title, gs.source, COALESCE(gs.file_key, gs.file_path, s.file_path) f, s.title st, a.name sa
        FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id LEFT JOIN artists a ON a.id = s.artist_id
       WHERE gs.station_id = ? AND gs.deleted_at IS NULL AND (gs.state IS NULL OR gs.state = 'pending') AND gs.song_id IS NOT NULL
         AND (gs.content_class IS NULL OR gs.content_class = 'MUSIC') AND gs.scheduled_at >= ?`).all(stationId, beforeTs ?? 0);
    // "The log on either side" = rows still to air. A pending row whose slot has already passed will never air (the
    // reader retires it as missed); it is neither what aired nor what will.
    for (const r of rows) {
      const inWindow = replace && r.scheduled_at >= replace[0] && r.scheduled_at < replace[1];
      const operator = r.source && String(r.source).trim().toLowerCase() === "operator";
      if (inWindow && !operator) continue;
      tl.add({ file: r.f, artist: r.sa, title: r.st || r.title }, r.scheduled_at);
    }
  } catch {}
  return tl;
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
function commit(tl, song, ts) { tl.add({ file: song.file, artist: song.artist, title: song.title }, ts); }

module.exports = { pick, breach, commit, Timeline, loadTimeline, poolFor, stationRules, fallbackCategory, recordingKey, normaliseTitle, makeSplitter, DEFAULT_DELIMITERS };

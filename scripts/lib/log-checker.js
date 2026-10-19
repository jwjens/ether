// scripts/lib/log-checker.js — the INDEPENDENT checker for the scheduler release gate.
//
// Design: docs/scheduler-rotation-playout-design.md §4 ("a second, independent checker re-derives every
// rule from play_log + the log. It shares no code with scheduler-core, so a bug in the picker cannot
// hide itself").
//
// So this file requires NOTHING from electron/ or audiod/. Every rule here is written from the design's
// words, not from the picker's code:
//
//   THE RULES (§3.2, Programming preferences, per station): song, artist and title separation in
//   minutes, each on or off. Obeyed against what aired plus what is in the log on either side.
//     - song   = the recording (§3.5). Phase 0 keys a recording by its stored file name, lower case;
//                two song rows on one file are one song. (Content hash: UNVERIFIED coverage, Phase 2.)
//     - artist = every credited artist (§3.3), split on the station's delimiters.
//     - title  = the normalised title (§3.3): lower case, no bracketed or "- From ..." tail, no
//                punctuation.
//     - per-song "no repeat hours" (Jeff, 2026-10-18: KEEP): a song that carries it may not air again
//                within that many hours of itself, on either side. A song without it has no such rule.
//   A gap SHORTER than the setting breaks the rule; a gap equal to it passes.
//
//   THE PICK (§3.2): among the slot's category songs that pass every rule, the one that has waited
//   longest since it last aired. Never aired = waited longest. Random only for exact ties.
//
//   THE PROOF (§3.2.4, T3, decision D1): inside every category, highest aired count − lowest ≤ 1; a
//   spread above 1 passes only if every lower-count song was blocked by a named rule at that moment.
//
// Pure functions over plain objects. No database handle, no clock, no randomness.
"use strict";

const DEFAULT_DELIMITERS = ["/", "&", ",", "feat.", "ft.", "f/", "x", "with"];

// ── identity ──────────────────────────────────────────────────────────────────────────────────────
function recordingKey(fileRef) {
  if (!fileRef) return null;
  const s = String(fileRef).trim();
  if (!s) return null;
  const base = s.split(/[\\/]/).pop();
  return base ? base.toLowerCase() : null;
}

function normaliseTitle(title, { tailRule = true } = {}) {
  if (!title) return null;
  let t = String(title).toLowerCase();
  if (tailRule) {
    t = t.replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*$/g, "");          // trailing (…) [..] {..}
    t = t.replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*$/g, "");          // a second one, e.g. "(Live) [2010]"
    t = t.replace(/\s+[-–—]\s+(from|feat\.?|ft\.?)\b.*$/i, "");       // "– From The Nightmare …"
  }
  t = t.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return t || null;
}

function _escape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function artistSplitter(delimiters = DEFAULT_DELIMITERS) {
  // Symbol delimiters split anywhere; word delimiters ("x", "with", "feat.") only as whole words.
  const parts = delimiters.map(d => /^[a-z]/i.test(d)
    ? `\\s+${_escape(d)}(?=\\s)\\s*`
    : `\\s*${_escape(d)}\\s*`);
  const re = new RegExp(parts.join("|"), "i");
  return (name) => {
    if (!name) return [];
    return String(name).split(re).map(a => a.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean);
  };
}

// ── an airing or a planned placement ──────────────────────────────────────────────────────────────
// { ts, rec, artists[], title, kind: 'aired'|'log', ref } — ref identifies it (play id / row id).
// The title rule's key: the normalised title plus the length to the second (Jeff, 2026-10-19: same name, different length
// = a different song). No known length = the title alone. Same as audiod/scheduler-core.js titleKey.
function titleKey(title, durationMs) {
  const t = normaliseTitle(title);
  if (!t) return null;
  const sec = Number(durationMs) > 0 ? Math.round(Number(durationMs) / 1000) : null;
  return sec != null ? `${t}|${sec}` : t;
}

function makeEvent({ ts, file, artist, title, kind, ref, categoryId = null, songId = null, noRepeatHours = null, durationMs = null }, split) {
  return {
    ts, kind, ref, categoryId, songId,
    noRepeatMin: noRepeatHours != null && Number(noRepeatHours) > 0 ? Number(noRepeatHours) * 60 : null,
    rec: recordingKey(file),
    artists: split(artist),
    title: titleKey(title, durationMs),
  };
}

// A timeline: every airing and placement, indexed by each rule's key, so "nearest same key on either
// side" is a binary search, not a scan.
class Timeline {
  constructor() { this.byRec = new Map(); this.byArtist = new Map(); this.byTitle = new Map(); this.n = 0; }
  static _ins(map, key, ev) {
    if (!key) return;
    let a = map.get(key); if (!a) { a = []; map.set(key, a); }
    // keep sorted by ts (events usually arrive in order — append fast path)
    if (!a.length || a[a.length - 1].ts <= ev.ts) a.push(ev);
    else { let i = a.length; while (i > 0 && a[i - 1].ts > ev.ts) i--; a.splice(i, 0, ev); }
  }
  add(ev) {
    Timeline._ins(this.byRec, ev.rec, ev);
    for (const ar of ev.artists) Timeline._ins(this.byArtist, ar, ev);
    Timeline._ins(this.byTitle, ev.title, ev);
    this.n++;
    return this;
  }
  // take one event back off (a row past its hour's end, once the next hour is being judged)
  remove(ev) {
    const del = (map, key) => { const a = key && map.get(key); if (!a) return; const i = a.indexOf(ev); if (i >= 0) a.splice(i, 1); };
    del(this.byRec, ev.rec);
    for (const ar of ev.artists) del(this.byArtist, ar);
    del(this.byTitle, ev.title);
    this.n--;
    return this;
  }
  // nearest event with this key strictly before / at-or-after ts, skipping `self`
  static _near(arr, ts, self) {
    if (!arr || !arr.length) return { before: null, after: null };
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].ts < ts) lo = m + 1; else hi = m; }
    let b = lo - 1; while (b >= 0 && arr[b] === self) b--;
    let a = lo; while (a < arr.length && arr[a] === self) a++;
    return { before: b >= 0 ? arr[b] : null, after: a < arr.length ? arr[a] : null };
  }
  lastBefore(rec, ts) {
    const { before } = Timeline._near(this.byRec.get(rec), ts, null);
    return before ? before.ts : null;
  }
}

// rules: { songMin, artistMin, titleMin } — each a number of minutes, or null when the rule is off.
// Returns every rule this event breaks against the timeline (both sides), with the measured gap.
function breaches(tl, ev, rules, { sides = "both" } = {}) {
  const out = [];
  const check = (rule, minutes, arr, key) => {
    if (minutes == null || !key) return;
    const lim = minutes * 60;
    const { before, after } = Timeline._near(arr, ev.ts, ev);
    if (before && sides !== "after" && ev.ts - before.ts < lim) {
      out.push({ rule, key, settingMin: minutes, measuredMin: +((ev.ts - before.ts) / 60).toFixed(1), other: before, side: "before" });
    }
    if (after && sides !== "before" && after.ts - ev.ts < lim) {
      out.push({ rule, key, settingMin: minutes, measuredMin: +((after.ts - ev.ts) / 60).toFixed(1), other: after, side: "after" });
    }
  };
  check("song", rules.songMin, tl.byRec.get(ev.rec), ev.rec);
  for (const ar of ev.artists) check("artist", rules.artistMin, tl.byArtist.get(ar), ar);
  check("title", rules.titleMin, tl.byTitle.get(ev.title), ev.title);
  // the song's own no-repeat-hours, on the same recording key (it is a property of the song, not a station rule)
  if (ev.noRepeatMin != null && !(rules.songMin != null && rules.songMin >= ev.noRepeatMin)) {
    check("no-repeat-hours", ev.noRepeatMin, tl.byRec.get(ev.rec), ev.rec);
  }
  return out;
}

// ── the pick, re-derived ──────────────────────────────────────────────────────────────────────────
// pool: the slot category's songs eligible at this hour, as events-to-be ({ rec, artists, title, songId }).
// tl:   everything that had aired before the pick plus everything already in the log (both sides).
// Returns { passing: [...], longestWaiting: [...ties], lastTsOf(rec) }.
function rederivePick(tl, pool, ts, rules) {
  const passing = [];
  for (const s of pool) {
    const probe = { ...s, ts, kind: "probe", ref: null };
    if (!breaches(tl, probe, rules).length) passing.push(s);
  }
  // Nothing passes → the whole pool's least recently played (Jeff, 2026-10-19), rules set aside.
  const leastRecent = !passing.length;
  let best = Infinity; const ties = [];
  for (const s of (leastRecent ? pool : passing)) {
    const last = tl.lastBefore(s.rec, ts);
    const w = last == null ? -Infinity : last;
    if (w < best) { best = w; ties.length = 0; ties.push(s); }
    else if (w === best) ties.push(s);
  }
  return { passing, longestWaiting: ties, bestLastTs: best, leastRecent };
}

// ── the count proof (T3, D1) ──────────────────────────────────────────────────────────────────────
// Call onAir(categoryId, rec, ts, blockedFn) at each go-live, in time order. pools: Map catId → Set(rec).
// blockedFn(rec) → a named reason string if that song was blocked at ts (rule or daypart), else null.
class CountProof {
  constructor(pools) {
    this.pools = pools;
    this.counts = new Map();                // catId → Map(rec → n)
    for (const [c, set] of pools) { const m = new Map(); for (const r of set) m.set(r, 0); this.counts.set(c, m); }
    this.maxSpread = new Map(); this.failures = []; this.exceptions = [];
  }
  onAir(cat, rec, ts, blockedFn) {
    const m = this.counts.get(cat); if (!m || !m.has(rec)) return;
    const k = m.get(rec);
    let min = Infinity; for (const v of m.values()) if (v < min) min = v;
    m.set(rec, k + 1);
    let max = -Infinity, nmin = Infinity; for (const v of m.values()) { if (v > max) max = v; if (v < nmin) nmin = v; }
    const spread = max - nmin;
    if (spread > (this.maxSpread.get(cat) || 0)) this.maxSpread.set(cat, spread);
    if (spread > 1 && k > min) {
      const lower = [...m.entries()].filter(([r, v]) => r !== rec && v < k);
      const unblocked = [];
      const blocked = [];
      for (const [r] of lower) { const why = blockedFn(r); if (why) blocked.push({ rec: r, why }); else unblocked.push(r); }
      const rec0 = { cat, ts, aired: rec, countBefore: k, minCount: min, spread, lowerCount: lower.length };
      if (unblocked.length) this.failures.push({ ...rec0, passedOver: unblocked.slice(0, 5), passedOverCount: unblocked.length });
      else this.exceptions.push({ ...rec0, blocked: blocked.slice(0, 5) });
    }
  }
}

module.exports = {
  DEFAULT_DELIMITERS, recordingKey, normaliseTitle, titleKey, artistSplitter, makeEvent, Timeline, breaches, rederivePick, CountProof,
};

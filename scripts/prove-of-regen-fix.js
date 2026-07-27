// PROOF (on a DB copy — the live DB is never touched): after the deleted_at fix, regenerating Open
// Format produces rows ONLY in the live clock's categories [2,3,4,5,8], cat-1 = 0, and the §2.7 selector
// re-anchors. Faithfully ports Generate's music selection (selectMusic/_lrpFallback + song/artist/title
// separation + per-hour dedup) using the FIXED slot query (deleted_at IS NULL). Break TIMING is omitted
// (it shifts when music plays, not which CATEGORY) — categories + anchoring are what this proves.
const path = require("path");
const fs = require("fs");
const Database = require(path.join(process.cwd(), "node_modules", "better-sqlite3"));
const loggen = require(path.join(process.cwd(), "audiod", "loggen.js"));

function dbPath() {
  if (process.env.ETHER_DB_PATH) return process.env.ETHER_DB_PATH;
  const la = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
  return path.join(la, "Ether", "com.ether.radio", "openair.db");
}
const SID = 1; // Open Format
const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

(async () => {
  const copy = path.join(process.cwd(), "of-regen-copy.db");
  try { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(copy + s); } catch {} } } catch {}
  const live = new Database(dbPath(), { readonly: true, fileMustExist: true });
  await live.backup(copy);            // clean, WAL-consistent snapshot
  live.close();
  const db = new Database(copy);      // read-write COPY

  // separation rules (station-scoped) — matches _buildScheduleCtx defaults/lookups
  const rule = (t, d) => { try { const r = db.prepare("SELECT value FROM separation_rules WHERE rule_type=? AND is_active=1 LIMIT 1").get(t); return r ? r.value : d; } catch { return d; } };
  const songRepeatMin = rule("song_separation_min", 180), artistSepMin = rule("artist_separation_min", 60), titleSepMin = rule("title_separation_min", 120);

  // FIXED prepared statements (deleted_at IS NULL) — the exact fix under test
  const stmtShows = db.prepare(`SELECT id, start_hour, end_hour, clock_id FROM shows WHERE instr(days, ?) > 0 AND is_active = 1 AND station_id = ? AND deleted_at IS NULL`);
  const stmtSlots = db.prepare(`SELECT position, slot_type, category_id, duration_min FROM clock_slots WHERE clock_id = ? AND deleted_at IS NULL ORDER BY position`);
  const stmtCandidates = db.prepare(`SELECT s.id, s.title, a.name AS artist_name, s.artist_id, s.duration_ms, s.last_played_at, s.file_path FROM songs s LEFT JOIN artists a ON a.id=s.artist_id WHERE s.category_id=? AND (s.rotation_status IS NULL OR s.rotation_status!='inactive') AND (s.content_class IS NULL OR s.content_class='MUSIC') AND (s.daypart_mask IS NULL OR ((s.daypart_mask >> ?) & 1)=1) ORDER BY RANDOM()`);

  const songLastTs = new Map(), artistLastTs = new Map(), titleLastTs = new Map();
  const rows = [], relaxed = [], emptyCats = new Set();
  const lrpFallback = (c, used, lt) => { const lrp = s => lt.get(s.id) ?? (s.last_played_at || 0); const fresh = c.filter(s => !used.has(s.id)); const pool = fresh.length ? fresh : c; return pool.length ? pool.reduce((a, b) => (lrp(b) < lrp(a) ? b : a)) : null; };
  const selectMusic = (cat, ts, h, used) => {
    const cands = stmtCandidates.all(cat, h);
    if (!cands.length) { emptyCats.add(cat); return null; }
    let picked = null;
    for (const s of cands) {
      if (used.songs.has(s.id)) continue;
      if (ts - (songLastTs.get(s.id) ?? (s.last_played_at || 0)) < songRepeatMin * 60) continue;
      const tk = (s.title || "").trim().toLowerCase();
      if (tk && (used.titles.has(tk) || (ts - (titleLastTs.get(tk) ?? 0)) < titleSepMin * 60)) continue;
      const la = s.artist_id ? (artistLastTs.get(s.artist_id) || 0) : 0;
      if (!(used.artists.has(s.artist_id) || (s.artist_id && (ts - la) < artistSepMin * 60))) { picked = s; break; }
    }
    if (!picked) { picked = lrpFallback(cands, used.songs, songLastTs); if (picked) relaxed.push(cat); }
    return picked;
  };

  const now = Math.floor(Date.now() / 1000);
  const d0 = new Date(); d0.setHours(0, 0, 0, 0); const dayStart = Math.floor(d0.getTime() / 1000), dayEnd = dayStart + 86400;
  const effStart = Math.max(dayStart, Math.ceil(now / 3600) * 3600);
  for (let ts0 = effStart; ts0 < dayEnd; ts0 += 3600) {
    const sd = new Date(ts0 * 1000); const jsDay = sd.getDay(), h = sd.getHours();
    const shows = stmtShows.all(String(jsDay), SID);
    const show = shows.find(s => (s.end_hour === 0 || s.end_hour === s.start_hour) ? h >= s.start_hour : (s.end_hour > s.start_hour ? (h >= s.start_hour && h < s.end_hour) : (h >= s.start_hour || h < s.end_hour)));
    if (!show || !show.clock_id) continue;
    const musicSlots = stmtSlots.all(show.clock_id).filter(s => s.slot_type === "music" && s.category_id);
    if (!musicSlots.length) continue;
    const used = { songs: new Set(), artists: new Set(), titles: new Set() };
    let ts = ts0, idx = 0, guard = 0;
    while (ts < ts0 + 3600 && guard++ < 500) {
      const ms = musicSlots[idx++ % musicSlots.length];
      const picked = selectMusic(ms.category_id, ts, h, used);
      if (!picked) { ts += (ms.duration_min || 3.5) * 60; continue; }
      used.songs.add(picked.id); if (picked.artist_id) used.artists.add(picked.artist_id);
      const tk = (picked.title || "").trim().toLowerCase(); if (tk) { used.titles.add(tk); titleLastTs.set(tk, ts); }
      songLastTs.set(picked.id, ts); if (picked.artist_id) artistLastTs.set(picked.artist_id, ts);
      const dur = picked.duration_ms ? Math.round(picked.duration_ms / 1000) : Math.round((ms.duration_min || 3.5) * 60);
      rows.push({ scheduled_at: ts, song_id: picked.id, title: picked.title, artist: picked.artist_name || "", file_key: picked.file_path ? path.basename(picked.file_path) : "", duration_s: dur, category_id: ms.category_id, clock_id: show.clock_id });
      ts += dur;
    }
  }

  // apply the regenerate to the COPY (DELETE future + direct INSERT, state defaults to pending)
  db.prepare("DELETE FROM generated_schedule WHERE station_id=? AND scheduled_at>=? AND scheduled_at<?").run(SID, effStart, dayEnd);
  const crypto = require("crypto"); const nowIso = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO generated_schedule (scheduled_at, song_id, title, artist, file_key, duration_s, category_id, clock_id, content_class, station_id, uuid, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,'MUSIC',?,?,'pending',?,?)`);
  const tx = db.transaction(() => { for (const r of rows) ins.run(r.scheduled_at, r.song_id, r.title, r.artist, r.file_key, r.duration_s, r.category_id, r.clock_id, SID, crypto.randomUUID(), nowIso, nowIso); });
  tx();

  console.log(`REGENERATED OF ${hhmm(effStart)}→end-of-day: ${rows.length} music rows`);
  console.log(`relaxed (within-category, separation bent): ${relaxed.length} · empty categories: [${[...emptyCats].join(",") || "none"}]`);
  console.log("\n── regenerated rows by category (LIVE clock cats are [2,3,4,5,8]) ──");
  for (const r of db.prepare(`SELECT category_id cat, COUNT(*) n FROM generated_schedule WHERE station_id=? AND scheduled_at>=? AND scheduled_at<? AND deleted_at IS NULL GROUP BY category_id ORDER BY n DESC`).all(SID, effStart, dayEnd))
    console.log(`  cat ${r.cat}: ${r.n} rows`);
  const cat1 = db.prepare(`SELECT COUNT(*) n FROM generated_schedule gs JOIN songs s ON s.id=gs.song_id WHERE gs.station_id=? AND gs.scheduled_at>=? AND gs.scheduled_at<? AND gs.deleted_at IS NULL AND (gs.category_id=1 OR s.category_id=1)`).get(SID, effStart, dayEnd).n;
  console.log(`\n  >>> cat-1 (off-clock catch-all) rows after regen: ${cat1}  ${cat1 === 0 ? "✅ ZERO" : "❌"}`);

  console.log("\n── §2.7 selector on the regenerated copy (should anchor, small drift) ──");
  for (const off of [0, 1800, 5400, 10800]) {
    const t = now + off;
    const d = loggen.selectRowForNow(db, SID, t);
    console.log(`  at ${hhmm(t)}: ${d.playRow ? `row "${d.playRow.title}" @ ${hhmm(d.playRow.scheduled_at)} · drift ${Math.round(d.driftSec / 60)}m · mode ${d.mode}` : "(none) " + d.mode}`);
  }
  db.close();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(copy + s); } catch {} }
  console.log("\ncopy discarded — live DB untouched.");
})().catch(e => { console.error("PROOF ERROR:", e.message); process.exit(1); });

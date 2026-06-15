// One-time schedule rebuild for the active station. Mirrors electron/main.js
// schedule:generate (the corrected generator: random pick + artist/song/title
// separation), seeding separation maps from recent plays so the new log is
// continuous with what last aired. Run: npm run regen:schedule [days]
const path = require("path");
const Database = require("better-sqlite3");
const { generatedScheduleClearAll, generatedScheduleBulkCreate } = require("../electron/sync/handlers/generated_schedule");

const DAYS = parseInt(process.argv[2] || "14", 10);
const base = process.platform === "win32" && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Ether") : require("os").homedir();
const dbPath = path.join(base, "com.ether.radio", "openair.db");
console.log("[regen] DB:", dbPath, "| days:", DAYS);

const db = new Database(dbPath);
db.pragma("busy_timeout = 8000");

const SID = (db.prepare("SELECT id FROM stations WHERE is_active=1 LIMIT 1").get() || { id: 1 }).id;
console.log("[regen] active station:", SID);

// Separation rules
const rule = (t, d) => { const r = db.prepare("SELECT value FROM separation_rules WHERE rule_type=? AND is_active=1 LIMIT 1").get(t); return r ? r.value : d; };
const artistSepMin = rule("artist_separation_min", 60);
const songRepeatMin = rule("song_separation_min", 180);
const titleSepMin = rule("title_separation_min", 120);
console.log(`[regen] rules: artist=${artistSepMin}m song=${songRepeatMin}m title=${titleSepMin}m`);

// Prepared statements (mirror schedule:generate)
const stmtShows = db.prepare(`SELECT id, start_hour, end_hour, clock_id FROM shows WHERE instr(days, ?) > 0 AND is_active = 1 AND station_id = ? ORDER BY CASE WHEN end_hour = 0 AND start_hour > 0 THEN 24 - start_hour WHEN end_hour = 0 OR end_hour = start_hour THEN 24 WHEN end_hour > start_hour THEN end_hour - start_hour ELSE 24 - start_hour + end_hour END ASC`);
const stmtSlots = db.prepare(`SELECT cs.position, cs.slot_type, cs.category_id, cs.duration_min FROM clock_slots cs WHERE cs.clock_id = ? ORDER BY cs.position`);
const stmtCandidates = db.prepare(`SELECT s.id, s.title, a.name AS artist_name, s.artist_id, s.duration_ms, s.last_played_at, s.file_path FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.category_id = ? AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive') AND ((s.daypart_mask >> ?) & 1) = 1 ORDER BY RANDOM()`);

// Tracking maps — seed from recent plays so hour 1 continues the rotation cleanly
const songLastTs = new Map(), artistLastTs = new Map(), titleLastTs = new Map();
const nowTs = Math.floor(Date.now() / 1000);
for (const r of db.prepare("SELECT artist_id, MAX(last_played_at) m FROM songs WHERE last_played_at IS NOT NULL AND artist_id IS NOT NULL GROUP BY artist_id").all())
  if (r.m) artistLastTs.set(r.artist_id, r.m);
for (const r of db.prepare("SELECT lower(trim(title)) tk, MAX(last_played_at) m FROM songs WHERE last_played_at IS NOT NULL AND title IS NOT NULL GROUP BY lower(trim(title))").all())
  if (r.m && r.tk) titleLastTs.set(r.tk, r.m);

const generatedRows = [];
const now = new Date(); now.setMinutes(0, 0, 0);

for (let d = 0; d < DAYS; d++) {
  for (let h = 0; h < 24; h++) {
    const slotDate = new Date(now.getTime() + d * 86_400_000); slotDate.setHours(h, 0, 0, 0);
    const jsDay = slotDate.getDay();
    const hourStartTs = Math.floor(slotDate.getTime() / 1000);
    const shows = stmtShows.all(String(jsDay), SID);
    const show = shows.find(s => {
      if (s.end_hour === 0 || s.end_hour === s.start_hour) return h >= s.start_hour;
      if (s.end_hour > s.start_hour) return h >= s.start_hour && h < s.end_hour;
      return h >= s.start_hour || h < s.end_hour;
    });
    if (!show || !show.clock_id) continue;
    const slots = stmtSlots.all(show.clock_id);
    if (!slots.length) continue;

    const usedSongIds = new Set(), usedArtistIds = new Set(), usedTitles = new Set();
    const hourEnd = hourStartTs + 3600;
    let currentTs = hourStartTs, slotIdx = 0, slotGuard = 0;

    while (currentTs < hourEnd && slotGuard++ < 500) {
      const slot = slots[slotIdx % slots.length]; slotIdx++;
      const slotDurationS = (slot.duration_min || 4) * 60;
      if (slot.slot_type !== "music" || !slot.category_id) { currentTs += slotDurationS; continue; }

      const candidates = stmtCandidates.all(slot.category_id, h);
      let picked = null, softFallback = null;
      for (const song of candidates) {
        if (usedSongIds.has(song.id)) continue;
        const lastSongTs = songLastTs.get(song.id) ?? (song.last_played_at || 0);
        if (currentTs - lastSongTs < songRepeatMin * 60) continue;
        const titleKey = (song.title || "").trim().toLowerCase();
        if (titleKey) {
          const lastTitleTs = titleLastTs.get(titleKey) ?? 0;
          if (usedTitles.has(titleKey) || (currentTs - lastTitleTs) < titleSepMin * 60) continue;
        }
        const lastArtistTs = song.artist_id ? (artistLastTs.get(song.artist_id) || 0) : 0;
        const artistBlocked = usedArtistIds.has(song.artist_id) || (song.artist_id && (currentTs - lastArtistTs) < artistSepMin * 60);
        if (!artistBlocked) { picked = song; break; }
        if (!softFallback) softFallback = song;
      }
      if (!picked) picked = softFallback;
      if (!picked) picked = candidates.find(s => !usedSongIds.has(s.id)) ?? candidates[0] ?? null;

      if (picked) {
        usedSongIds.add(picked.id);
        if (picked.artist_id) usedArtistIds.add(picked.artist_id);
        const pk = (picked.title || "").trim().toLowerCase();
        if (pk) { usedTitles.add(pk); titleLastTs.set(pk, currentTs); }
        songLastTs.set(picked.id, currentTs);
        if (picked.artist_id) artistLastTs.set(picked.artist_id, currentTs);
        const durationS = picked.duration_ms ? Math.round(picked.duration_ms / 1000) : slotDurationS;
        generatedRows.push({
          scheduled_at: currentTs, song_id: picked.id, title: picked.title, artist: picked.artist_name || "",
          file_key: picked.file_path ? path.basename(picked.file_path) : "",
          duration_s: durationS, category_id: slot.category_id, clock_id: show.clock_id, generated_at: nowTs,
        });
        currentTs += durationS;
      } else { currentTs += slotDurationS; }
    }
  }
}

console.log(`[regen] generated ${generatedRows.length} rows. Clearing old schedule…`);
const cleared = generatedScheduleClearAll(db, SID);
console.log(`[regen] cleared ${cleared.cleared} old rows. Inserting…`);
generatedScheduleBulkCreate(db, SID, generatedRows);

// Verify: count back-to-back violations in the new log
const up = db.prepare(`SELECT gs.scheduled_at, gs.title, s.artist_id, gs.song_id FROM generated_schedule gs LEFT JOIN songs s ON s.id=gs.song_id WHERE gs.station_id=? AND gs.deleted_at IS NULL ORDER BY gs.scheduled_at LIMIT 200`).all(SID);
let viol = 0, pa = null, pt = null, ps = null;
for (const r of up) {
  if (r.artist_id != null && r.artist_id === pa) viol++;
  if (r.song_id != null && r.song_id === ps) viol++;
  if (r.title && r.title === pt) viol++;
  pa = r.artist_id; pt = r.title; ps = r.song_id;
}
console.log(`[regen] DONE. ${generatedRows.length} rows. back-to-back violations in first 200: ${viol}`);
console.log("[regen] first 12 of new log:");
up.slice(0, 12).forEach((r, i) => console.log(`  ${i + 1}. ${new Date(r.scheduled_at * 1000).toLocaleTimeString()}  ${r.title}`));
db.close();

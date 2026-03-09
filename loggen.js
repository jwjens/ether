const fs = require('fs');

console.log('\n  Ether — Log Generator (Clocks Drive Playback)\n');

// ============================================================
// 1. Create src/audio/loggen.ts — the automation brain
// ============================================================

fs.mkdirSync('src/audio', { recursive: true });
fs.writeFileSync('src/audio/loggen.ts', [
'import { query, queryOne, execute } from "../db/client";',
'import { engine } from "./engine";',
'',
'interface SlotDef {',
'  id: number; position: number; slot_type: string;',
'  category_id: number | null; duration_min: number;',
'}',
'',
'interface SongCandidate {',
'  id: number; title: string; file_path: string;',
'  artist_name: string | null; last_played_at: number | null;',
'  spins_total: number;',
'}',
'',
'// Get the clock assigned to the current day + hour',
'async function getClockForNow(): Promise<number | null> {',
'  const now = new Date();',
'  const day = now.getDay(); // 0=Sun',
'  const hour = now.getHours();',
'  const row = await queryOne<{ clock_id: number }>("SELECT clock_id FROM schedule_grid WHERE day_of_week = ? AND hour = ?", [day, hour]);',
'  return row ? row.clock_id : null;',
'}',
'',
'// Get slots for a clock',
'async function getClockSlots(clockId: number): Promise<SlotDef[]> {',
'  return query<SlotDef>("SELECT * FROM clock_slots WHERE clock_id = ? ORDER BY position", [clockId]);',
'}',
'',
'// Pick the best song from a category (least recently played, fewest spins)',
'async function pickSong(categoryId: number, avoid: number[]): Promise<SongCandidate | null> {',
'  const avoidStr = avoid.length > 0 ? " AND s.id NOT IN (" + avoid.join(",") + ")" : "";',
'  const rows = await query<SongCandidate>(',
'    "SELECT s.id, s.title, s.file_path, a.name as artist_name, s.last_played_at, s.spins_total " +',
'    "FROM songs s LEFT JOIN artists a ON a.id = s.artist_id " +',
'    "WHERE s.category_id = ? AND s.file_path IS NOT NULL AND s.rotation_status = \'active\'" + avoidStr + " " +',
'    "ORDER BY s.last_played_at ASC NULLS FIRST, s.spins_total ASC, RANDOM() LIMIT 1",',
'    [categoryId]',
'  );',
'  return rows.length > 0 ? rows[0] : null;',
'}',
'',
'// Pick a random song from any category (fallback)',
'async function pickAnySong(avoid: number[]): Promise<SongCandidate | null> {',
'  const avoidStr = avoid.length > 0 ? " AND s.id NOT IN (" + avoid.join(",") + ")" : "";',
'  const rows = await query<SongCandidate>(',
'    "SELECT s.id, s.title, s.file_path, a.name as artist_name, s.last_played_at, s.spins_total " +',
'    "FROM songs s LEFT JOIN artists a ON a.id = s.artist_id " +',
'    "WHERE s.file_path IS NOT NULL" + avoidStr + " " +',
'    "ORDER BY RANDOM() LIMIT 1"',
'  );',
'  return rows.length > 0 ? rows[0] : null;',
'}',
'',
'// Mark a song as played',
'async function markPlayed(songId: number): Promise<void> {',
'  await execute("UPDATE songs SET last_played_at = unixepoch(), spins_total = spins_total + 1, updated_at = unixepoch() WHERE id = ?", [songId]);',
'}',
'',
'// ============================================================',
'// MAIN: Generate a log hour from the current clock',
'// ============================================================',
'',
'export interface LogItem {',
'  slotType: string;',
'  songId: number | null;',
'  title: string;',
'  artist: string;',
'  filePath: string;',
'  categoryId: number | null;',
'}',
'',
'export async function generateLogHour(): Promise<LogItem[]> {',
'  const clockId = await getClockForNow();',
'  if (!clockId) {',
'    console.log("No clock assigned for current hour, falling back to random");',
'    return generateRandomHour();',
'  }',
'',
'  const slots = await getClockSlots(clockId);',
'  if (slots.length === 0) {',
'    console.log("Clock has no slots, falling back to random");',
'    return generateRandomHour();',
'  }',
'',
'  const log: LogItem[] = [];',
'  const usedIds: number[] = [];',
'',
'  for (const slot of slots) {',
'    if (slot.slot_type === "music" && slot.category_id) {',
'      const song = await pickSong(slot.category_id, usedIds);',
'      if (song) {',
'        log.push({',
'          slotType: "music",',
'          songId: song.id,',
'          title: song.title,',
'          artist: song.artist_name || "",',
'          filePath: song.file_path,',
'          categoryId: slot.category_id,',
'        });',
'        usedIds.push(song.id);',
'      } else {',
'        // Category empty, pick from any',
'        const any = await pickAnySong(usedIds);',
'        if (any) {',
'          log.push({ slotType: "music", songId: any.id, title: any.title, artist: any.artist_name || "", filePath: any.file_path, categoryId: null });',
'          usedIds.push(any.id);',
'        }',
'      }',
'    } else if (slot.slot_type === "spot_break") {',
'      log.push({ slotType: "spot_break", songId: null, title: "--- BREAK ---", artist: "", filePath: "", categoryId: null });',
'    } else if (slot.slot_type === "liner" || slot.slot_type === "sweeper" || slot.slot_type === "jingle") {',
'      log.push({ slotType: slot.slot_type, songId: null, title: "--- " + slot.slot_type.toUpperCase() + " ---", artist: "", filePath: "", categoryId: null });',
'    }',
'  }',
'',
'  return log;',
'}',
'',
'// Fallback: random songs when no clock is assigned',
'async function generateRandomHour(): Promise<LogItem[]> {',
'  const rows = await query<SongCandidate>(',
'    "SELECT s.id, s.title, s.file_path, a.name as artist_name, s.last_played_at, s.spins_total " +',
'    "FROM songs s LEFT JOIN artists a ON a.id = s.artist_id " +',
'    "WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 15"',
'  );',
'  return rows.map(s => ({ slotType: "music", songId: s.id, title: s.title, artist: s.artist_name || "", filePath: s.file_path, categoryId: null }));',
'}',
'',
'// ============================================================',
'// Fill the engine queue from a generated log',
'// ============================================================',
'',
'export async function fillQueueFromSchedule(): Promise<number> {',
'  const log = await generateLogHour();',
'  const musicItems = log.filter(l => l.slotType === "music" && l.filePath);',
'  engine.addToQueue(musicItems.map(l => ({ filePath: l.filePath, title: l.title, artist: l.artist })));',
'',
'  // Mark songs as played',
'  for (const item of musicItems) {',
'    if (item.songId) await markPlayed(item.songId);',
'  }',
'',
'  return musicItems.length;',
'}',
'',
'// Auto-refill: called by engine when queue runs dry in continuous mode',
'export async function refillFromSchedule(): Promise<{ filePath: string; title: string; artist: string }[]> {',
'  const log = await generateLogHour();',
'  const musicItems = log.filter(l => l.slotType === "music" && l.filePath);',
'  for (const item of musicItems) {',
'    if (item.songId) await markPlayed(item.songId);',
'  }',
'  return musicItems.map(l => ({ filePath: l.filePath, title: l.title, artist: l.artist }));',
'}',
].join('\n'), 'utf8');
console.log('  CREATED src/audio/loggen.ts');

// ============================================================
// 2. Update App.tsx to use log generator
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Add loggen import
if (!app.includes('loggen')) {
  app = app.replace(
    'import { engine, DeckState } from "./audio/engine";',
    'import { engine, DeckState } from "./audio/engine";\nimport { fillQueueFromSchedule, refillFromSchedule } from "./audio/loggen";'
  );

  // Replace the refill callback to use schedule-based generation
  if (app.includes('engine.setRefillCallback')) {
    app = app.replace(
      /engine\.setRefillCallback\(async \(\) => \{[^}]+\}\);/s,
      'engine.setRefillCallback(refillFromSchedule);'
    );
    console.log('  UPDATED refill callback to use schedule');
  }

  // Add "Generate Log" button to LivePanel
  app = app.replace(
    '<button onClick={toggleContinuous}',
    '<button onClick={async () => { const n = await fillQueueFromSchedule(); alert("Generated " + n + " tracks from current clock"); }} className="px-2.5 py-1 rounded text-[11px] font-bold bg-emerald-700 hover:bg-emerald-600 text-white">GEN LOG</button>\n          <button onClick={toggleContinuous}'
  );

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  UPDATED src/App.tsx (log generator button + schedule refill)');
} else {
  console.log('  SKIPPED — loggen already wired');
}

console.log('\n  Done! Restart: npm run tauri:dev');
console.log('');
console.log('  How it works now:');
console.log('');
console.log('  1. Build clocks in the Schedule tab');
console.log('     (add A, A, B, A, C, Break, A, B, D, A, Liner, A...)');
console.log('');
console.log('  2. Assign clocks to hours in the Schedule Grid');
console.log('     (Morning Drive clock at 6-10 AM, etc.)');
console.log('');
console.log('  3. Assign songs to categories in Library');
console.log('     (your hot songs = A, medium = B, classics = D)');
console.log('');
console.log('  4. Click GEN LOG in Live Assist');
console.log('     It reads the current hour, finds the clock,');
console.log('     picks the best song from each category slot,');
console.log('     and fills the queue. Hit play.');
console.log('');
console.log('  5. With AUTO + 24/7 on:');
console.log('     When the queue empties, it auto-generates');
console.log('     a new log hour from the schedule. Hands-free.');
console.log('');
console.log('  This is real broadcast automation.');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v0.5.0 log generator - clocks drive playback"');
console.log('    git push\n');

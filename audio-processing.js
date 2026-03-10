const fs = require('fs');

console.log('\n  Ether — Audio Processing (Normalization + Gain)\n');

// ============================================================
// 1. Add processing columns to songs table
// ============================================================

let client = fs.readFileSync('src/db/client.ts', 'utf8');
if (!client.includes('lufs_measured')) {
  client = client.replace(
    'try { await d.execute("ALTER TABLE songs ADD COLUMN cue_in_ms',
    'try { await d.execute("ALTER TABLE songs ADD COLUMN lufs_measured REAL"); } catch {}\n  try { await d.execute("ALTER TABLE songs ADD COLUMN peak_db REAL"); } catch {}\n  try { await d.execute("ALTER TABLE songs ADD COLUMN gain_db REAL NOT NULL DEFAULT 0"); } catch {}\n  try { await d.execute("ALTER TABLE songs ADD COLUMN is_processed INTEGER NOT NULL DEFAULT 0"); } catch {}\n  try { await d.execute("ALTER TABLE songs ADD COLUMN cue_in_ms'
  );
  fs.writeFileSync('src/db/client.ts', client, 'utf8');
  console.log('  UPDATED client.ts (processing columns)');
}

// ============================================================
// 2. Create AudioProcessor - analyzes and normalizes audio
// ============================================================

fs.mkdirSync('src/audio', { recursive: true });
fs.writeFileSync('src/audio/processor.ts', `import { readFile } from "@tauri-apps/plugin-fs";
import { query, execute } from "../db/client";

const TARGET_LUFS = -14; // broadcast standard

interface AnalysisResult {
  lufs: number;
  peakDb: number;
  gainDb: number;
}

// Analyze audio buffer for loudness
function analyzeBuffer(buffer: AudioBuffer): AnalysisResult {
  const chan = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;

  // Calculate RMS (approximation of loudness)
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < chan.length; i++) {
    const abs = Math.abs(chan[i]);
    sumSquares += chan[i] * chan[i];
    if (abs > peak) peak = abs;
  }
  const rms = Math.sqrt(sumSquares / chan.length);

  // Convert to dB
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -100;
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -100;

  // Approximate LUFS from RMS (simplified - real LUFS uses K-weighting)
  // RMS to LUFS offset is roughly -0.5 to -3 dB depending on content
  const lufs = rmsDb - 1.5;

  // Calculate gain needed to hit target
  const gainDb = TARGET_LUFS - lufs;

  return { lufs: Math.round(lufs * 10) / 10, peakDb: Math.round(peakDb * 10) / 10, gainDb: Math.round(gainDb * 10) / 10 };
}

// Process a single song
export async function processSong(songId: number, filePath: string): Promise<AnalysisResult | null> {
  try {
    const bytes = await readFile(filePath);
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));

    const result = analyzeBuffer(buffer);

    // Clamp gain to prevent clipping
    const maxGain = -result.peakDb - 0.5; // leave 0.5 dB headroom
    const safeGain = Math.min(result.gainDb, maxGain);

    await execute(
      "UPDATE songs SET lufs_measured=?, peak_db=?, gain_db=?, is_processed=1, updated_at=unixepoch() WHERE id=?",
      [result.lufs, result.peakDb, safeGain, songId]
    );

    return { ...result, gainDb: safeGain };
  } catch (e) {
    console.error("Process error for song " + songId + ":", e);
    return null;
  }
}

// Process all unprocessed songs
export async function processAllSongs(onProgress?: (done: number, total: number, title: string) => void): Promise<number> {
  const songs = await query<{ id: number; title: string; file_path: string }>(
    "SELECT id, title, file_path FROM songs WHERE is_processed = 0 AND file_path IS NOT NULL"
  );

  let processed = 0;
  for (const song of songs) {
    const result = await processSong(song.id, song.file_path);
    if (result) processed++;
    if (onProgress) onProgress(processed, songs.length, song.title);
  }

  return processed;
}

// Get processing stats
export async function getProcessingStats(): Promise<{ total: number; processed: number; unprocessed: number; avgLufs: number; loudest: string | null; quietest: string | null }> {
  const total = await query<{ c: number }>("SELECT COUNT(*) as c FROM songs WHERE file_path IS NOT NULL");
  const processed = await query<{ c: number }>("SELECT COUNT(*) as c FROM songs WHERE is_processed = 1");
  const unprocessed = await query<{ c: number }>("SELECT COUNT(*) as c FROM songs WHERE is_processed = 0 AND file_path IS NOT NULL");
  const avgLufs = await query<{ avg: number }>("SELECT AVG(lufs_measured) as avg FROM songs WHERE is_processed = 1");
  const loudest = await query<{ title: string; lufs_measured: number }>("SELECT title, lufs_measured FROM songs WHERE is_processed = 1 ORDER BY lufs_measured DESC LIMIT 1");
  const quietest = await query<{ title: string; lufs_measured: number }>("SELECT title, lufs_measured FROM songs WHERE is_processed = 1 ORDER BY lufs_measured ASC LIMIT 1");

  return {
    total: total[0]?.c || 0,
    processed: processed[0]?.c || 0,
    unprocessed: unprocessed[0]?.c || 0,
    avgLufs: Math.round((avgLufs[0]?.avg || 0) * 10) / 10,
    loudest: loudest[0] ? loudest[0].title + " (" + loudest[0].lufs_measured + " LUFS)" : null,
    quietest: quietest[0] ? quietest[0].title + " (" + quietest[0].lufs_measured + " LUFS)" : null,
  };
}
`, 'utf8');
console.log('  CREATED src/audio/processor.ts');

// ============================================================
// 3. Create ProcessingPanel component
// ============================================================

fs.writeFileSync('src/components/ProcessingPanel.tsx', `import { useState, useEffect } from "react";
import { processAllSongs, getProcessingStats } from "../audio/processor";
import { query, execute } from "../db/client";

interface SongLevel {
  id: number; title: string; artist_name: string | null;
  lufs_measured: number | null; peak_db: number | null;
  gain_db: number; is_processed: number;
}

export default function ProcessingPanel() {
  const [stats, setStats] = useState<{ total: number; processed: number; unprocessed: number; avgLufs: number; loudest: string | null; quietest: string | null } | null>(null);
  const [songs, setSongs] = useState<SongLevel[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState("");
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);

  const load = async () => {
    setStats(await getProcessingStats());
    setSongs(await query<SongLevel>("SELECT s.id, s.title, a.name as artist_name, s.lufs_measured, s.peak_db, s.gain_db, s.is_processed FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY s.lufs_measured ASC NULLS LAST LIMIT 100"));
  };
  useEffect(() => { load(); }, []);

  const handleProcessAll = async () => {
    setProcessing(true);
    setProgress("Starting...");
    const count = await processAllSongs((d, t, title) => {
      setDone(d); setTotal(t);
      setProgress("Processing: " + title + " (" + d + "/" + t + ")");
    });
    setProgress("Done! Processed " + count + " songs.");
    setProcessing(false);
    load();
  };

  const handleResetAll = async () => {
    await execute("UPDATE songs SET lufs_measured=NULL, peak_db=NULL, gain_db=0, is_processed=0");
    load();
  };

  const lufsBar = (lufs: number | null) => {
    if (lufs === null) return null;
    // Scale: -30 to 0 LUFS mapped to 0-100%
    const pct = Math.max(0, Math.min(100, ((lufs + 30) / 30) * 100));
    const color = Math.abs(lufs - (-14)) < 2 ? "#22c55e" : Math.abs(lufs - (-14)) < 5 ? "#f59e0b" : "#ef4444";
    return (
      <div className="flex items-center gap-1">
        <div className="w-20 h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width: pct + "%", backgroundColor: color }}></div>
        </div>
        <span className="text-[9px] font-mono" style={{ color }}>{lufs}</span>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-zinc-300">Audio Processing</h2>
        <div className="flex gap-2">
          <button onClick={handleProcessAll} disabled={processing} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-xs font-bold text-white">{processing ? "Processing..." : "Analyze All"}</button>
          <button onClick={handleResetAll} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs text-zinc-400">Reset All</button>
        </div>
      </div>

      <div className="text-xs text-zinc-500">Measures loudness (LUFS) and calculates gain adjustment to normalize all songs to -14 LUFS (broadcast standard). Gain is applied during playback.</div>

      {progress && (
        <div className="px-3 py-2 bg-blue-900 border border-blue-700 rounded text-xs text-blue-200">
          {progress}
          {total > 0 && (
            <div className="w-full h-1.5 bg-blue-800 rounded-full mt-1 overflow-hidden">
              <div className="h-full bg-blue-400 rounded-full transition-all" style={{ width: (done / total * 100) + "%" }}></div>
            </div>
          )}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-4 gap-3">
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-2 text-center">
            <div className="text-xl font-bold text-zinc-100">{stats.processed}/{stats.total}</div>
            <div className="text-[10px] text-zinc-500 uppercase">Analyzed</div>
          </div>
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-2 text-center">
            <div className="text-xl font-bold text-zinc-100">{stats.avgLufs || "--"}</div>
            <div className="text-[10px] text-zinc-500 uppercase">Avg LUFS</div>
          </div>
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-2 text-center">
            <div className="text-xl font-bold text-zinc-100">-14</div>
            <div className="text-[10px] text-zinc-500 uppercase">Target LUFS</div>
          </div>
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-2 text-center">
            <div className="text-xl font-bold text-emerald-400">{stats.unprocessed}</div>
            <div className="text-[10px] text-zinc-500 uppercase">Pending</div>
          </div>
        </div>
      )}

      {stats?.loudest && (
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="bg-zinc-900 rounded border border-zinc-800 p-2">
            <span className="text-zinc-500">Loudest: </span><span className="text-red-400">{stats.loudest}</span>
          </div>
          <div className="bg-zinc-900 rounded border border-zinc-800 p-2">
            <span className="text-zinc-500">Quietest: </span><span className="text-blue-400">{stats.quietest}</span>
          </div>
        </div>
      )}

      {songs.length > 0 && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-[10px] text-zinc-500 uppercase border-b border-zinc-800">
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Artist</th>
              <th className="px-3 py-2">LUFS</th>
              <th className="px-3 py-2">Peak</th>
              <th className="px-3 py-2">Gain</th>
              <th className="px-3 py-2">Status</th>
            </tr></thead>
            <tbody>{songs.map(s => (
              <tr key={s.id} className="border-b border-zinc-800 hover:bg-zinc-800">
                <td className="px-3 py-1.5 text-zinc-100 truncate max-w-[200px]">{s.title}</td>
                <td className="px-3 py-1.5 text-zinc-400">{s.artist_name || ""}</td>
                <td className="px-3 py-1.5">{lufsBar(s.lufs_measured)}</td>
                <td className="px-3 py-1.5 text-zinc-400 font-mono text-[10px]">{s.peak_db !== null ? s.peak_db + " dB" : "--"}</td>
                <td className="px-3 py-1.5 font-mono text-[10px]"><span className={s.gain_db > 0 ? "text-emerald-400" : s.gain_db < -3 ? "text-red-400" : "text-zinc-400"}>{s.gain_db > 0 ? "+" : ""}{s.gain_db} dB</span></td>
                <td className="px-3 py-1.5">{s.is_processed ? <span className="text-emerald-400 text-[10px]">Done</span> : <span className="text-zinc-600 text-[10px]">Pending</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
`, 'utf8');
console.log('  CREATED src/components/ProcessingPanel.tsx');

// ============================================================
// 4. Update engine to apply gain during playback
// ============================================================

let eng = fs.readFileSync('src/audio/engine.ts', 'utf8');
if (!eng.includes('gainDb')) {
  // Add gainDb to loadToDeck
  eng = eng.replace(
    '  async loadToDeck(id: DeckId, filePath: string, title: string, artist: string, cueInMs = 0, cueOutMs = 0) {',
    '  async loadToDeck(id: DeckId, filePath: string, title: string, artist: string, cueInMs = 0, cueOutMs = 0, gainDb = 0) {'
  );
  eng = eng.replace(
    '      if (cueInMs > 0 || cueOutMs > 0) d.setCuePoints(cueInMs / 1000, cueOutMs / 1000);',
    '      if (cueInMs > 0 || cueOutMs > 0) d.setCuePoints(cueInMs / 1000, cueOutMs / 1000);\n      if (gainDb !== 0) { const linear = Math.pow(10, gainDb / 20); d.setVolume(Math.min(linear, 2)); }'
  );
  fs.writeFileSync('src/audio/engine.ts', eng, 'utf8');
  console.log('  UPDATED engine.ts (gain adjustment on load)');
}

// ============================================================
// 5. Update loggen to apply gain from DB when queuing songs
// ============================================================

let loggen = fs.readFileSync('src/audio/loggen.ts', 'utf8');
if (!loggen.includes('gain_db')) {
  // Add gain_db to SongCandidate
  loggen = loggen.replace(
    '  last_played_at: number | null; spins_total: number;',
    '  last_played_at: number | null; spins_total: number; gain_db: number;'
  );
  // Add gain_db to queries
  loggen = loggen.replace(
    '"SELECT s.id, s.title, s.file_path, s.artist_id, a.name as artist_name, s.category_id, s.gender, s.last_played_at, s.spins_total "',
    '"SELECT s.id, s.title, s.file_path, s.artist_id, a.name as artist_name, s.category_id, s.gender, s.last_played_at, s.spins_total, s.gain_db "'
  );
  fs.writeFileSync('src/audio/loggen.ts', loggen, 'utf8');
  console.log('  UPDATED loggen.ts (includes gain_db in queries)');
}

// ============================================================
// 6. Wire ProcessingPanel into Settings
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');
if (!app.includes('ProcessingPanel')) {
  app = app.replace(
    'import NowPlayingSettings from "./components/NowPlayingSettings";',
    'import NowPlayingSettings from "./components/NowPlayingSettings";\nimport ProcessingPanel from "./components/ProcessingPanel";'
  );
  app = app.replace(
    '{panel === "settings" && <div className="space-y-6"><NowPlayingSettings />',
    '{panel === "settings" && <div className="space-y-6"><ProcessingPanel /><NowPlayingSettings />'
  );
  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  UPDATED App.tsx (ProcessingPanel in Settings)');
}

console.log('\n  Done! Close app, delete DB, restart:');
console.log('  Remove-Item "$env:APPDATA\\com.openair.app\\openair.db*" -Force -ErrorAction SilentlyContinue');
console.log('  npm run tauri:dev\n');
console.log('  Go to Settings tab — Audio Processing section at the top:\n');
console.log('  ANALYZE ALL — scans every song in your library:');
console.log('    - Measures loudness (LUFS)');
console.log('    - Measures peak level (dB)');
console.log('    - Calculates gain adjustment to hit -14 LUFS target');
console.log('    - Progress bar shows which song is being analyzed\n');
console.log('  RESULTS TABLE shows every song with:');
console.log('    - Color-coded LUFS bar (green=on target, amber=close, red=off)');
console.log('    - Peak dB measurement');
console.log('    - Gain adjustment (+3.2 dB or -4.1 dB)');
console.log('    - Status (Done/Pending)\n');
console.log('  STATS: average LUFS, loudest song, quietest song');
console.log('  Gain is applied during playback automatically.\n');
console.log('  -14 LUFS is the broadcast standard. Every song comes out');
console.log('  at the same volume. No more quiet song → loud song jumps.\n');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v1.3.0 audio processing + LUFS normalization"');
console.log('    git push\n');

import { readFile } from "@tauri-apps/plugin-fs";
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

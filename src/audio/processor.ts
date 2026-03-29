// src/audio/processor.ts
// Audio processing utilities — LUFS measurement and ReplayGain normalization

import { query, execute } from "../db/client";
import { readFile } from "@tauri-apps/plugin-fs";

export interface ProcessingStats {
  total: number;
  processed: number;
  unprocessed: number;
  avgLufs: number | null;
  loudest: string | null;
  quietest: string | null;
}

export async function getProcessingStats(): Promise<ProcessingStats> {
  try {
    const rows = await query<{
      total: number; processed: number;
      avg_lufs: number | null; loudest: string | null; quietest: string | null;
    }>(
      `SELECT
        COUNT(*) as total,
        COUNT(lufs_measured) as processed,
        ROUND(AVG(lufs_measured), 1) as avg_lufs,
        (SELECT title FROM songs WHERE lufs_measured IS NOT NULL ORDER BY lufs_measured DESC LIMIT 1) as loudest,
        (SELECT title FROM songs WHERE lufs_measured IS NOT NULL ORDER BY lufs_measured ASC LIMIT 1) as quietest
       FROM songs WHERE file_path IS NOT NULL`
    );
    const r = rows[0] ?? { total: 0, processed: 0, avg_lufs: null, loudest: null, quietest: null };
    return {
      total: r.total,
      processed: r.processed,
      unprocessed: r.total - r.processed,
      avgLufs: r.avg_lufs,
      loudest: r.loudest,
      quietest: r.quietest,
    };
  } catch {
    return { total: 0, processed: 0, unprocessed: 0, avgLufs: null, loudest: null, quietest: null };
  }
}

export async function processAllSongs(
  onProgress?: (done: number, total: number, title: string) => void
): Promise<number> {
  const songs = await query<{ id: number; title: string; file_path: string }>(
    "SELECT id, title, file_path FROM songs WHERE file_path IS NOT NULL AND lufs_measured IS NULL LIMIT 500"
  );

  let done = 0;
  for (const song of songs) {
    try {
      onProgress?.(done, songs.length, song.title);
      const { lufs, peak, gain } = await measureLufs(song.file_path);
      await execute(
        "UPDATE songs SET lufs_measured=?, peak_db=?, gain_db=? WHERE id=?",
        [lufs, peak, gain, song.id]
      );
      done++;
    } catch {
      done++;
    }
  }
  return done;
}

async function measureLufs(filePath: string): Promise<{ lufs: number; peak: number; gain: number }> {
  const TARGET_LUFS = -14;
  try {
    const bytes = await readFile(filePath);
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const buf = await ctx.decodeAudioData(bytes.buffer as ArrayBuffer);

    // RMS-based LUFS approximation
    const data = buf.getChannelData(0);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      sumSq += data[i] * data[i];
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(sumSq / data.length);
    const lufs = rms > 0 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -70;
    const peakDb = peak > 0 ? Math.round(20 * Math.log10(peak) * 10) / 10 : -70;
    const gain = Math.round((TARGET_LUFS - lufs) * 10) / 10;

    return { lufs, peak: peakDb, gain };
  } catch {
    return { lufs: -14, peak: -1, gain: 0 };
  }
}

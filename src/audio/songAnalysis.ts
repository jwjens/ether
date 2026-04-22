// src/audio/songAnalysis.ts
//
// Replaces processor.ts and songAnalyzer.ts entirely.
// All heavy DSP now runs in Rust (audio_engine.rs):
//   - EBU R128 loudness (real K-weighted filter, not RMS approximation)
//   - BPM detection (onset + autocorrelation, more accurate)
//   - Energy + spectral centroid (brightness measurement)
//   - Cue point detection (silence analysis, intro/outro)
//
// This file is just a thin TypeScript wrapper around invoke() calls.
// No Web Audio API, no fetch(), works from any window.

const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);
import { execute, query } from "../db/client";
import { getActiveStationIdSync } from "../hooks/useActiveStation";

// ── Types (mirror Rust structs) ───────────────────────────────

export interface LoudnessResult {
  lufs_integrated: number;  // EBU R128 integrated LUFS
  lufs_short_term: number;  // worst short-term window
  peak_db: number;          // true peak dBFS
  gain_db: number;          // gain to reach -14 LUFS broadcast standard
  dynamic_range: number;    // LRA in LU
}

export interface BpmResult {
  bpm: number;              // detected BPM (0 = not detected)
  confidence: number;       // 0–1
  tempo_stable: boolean;    // consistent tempo throughout
}

export interface EnergyResult {
  energy: number;           // 0–1 normalized
  label: "low" | "medium" | "high";
  spectral_centroid: number; // brightness in Hz
  dynamic_range_db: number;  // between quiet and loud sections
}

export interface CuePoints {
  cue_in: number;           // seconds
  intro_end: number;        // seconds — where music starts
  outro_start: number;      // seconds — where outro begins
  cue_out: number;          // seconds
}

export interface FullSongAnalysis {
  loudness: LoudnessResult;
  bpm: BpmResult;
  energy: EnergyResult;
  cue_points: CuePoints;
  duration_secs: number;
  sample_rate: number;
}

// ── Single song analysis ──────────────────────────────────────

export async function analyzeSong(filePath: string): Promise<FullSongAnalysis | null> {
  try {
    return await invoke<FullSongAnalysis>("analyze_song", { filePath });
  } catch (e) {
    console.error("[songAnalysis] analyze_song failed:", e);
    return null;
  }
}

export async function measureLoudness(filePath: string): Promise<LoudnessResult | null> {
  try {
    return await invoke<LoudnessResult>("measure_song_loudness", { filePath });
  } catch (e) {
    console.error("[songAnalysis] measure_song_loudness failed:", e);
    return null;
  }
}

export async function detectBpm(filePath: string): Promise<BpmResult | null> {
  try {
    return await invoke<BpmResult>("detect_song_bpm", { filePath });
  } catch (e) {
    console.error("[songAnalysis] detect_song_bpm failed:", e);
    return null;
  }
}

export async function detectCuePoints(filePath: string): Promise<CuePoints | null> {
  try {
    return await invoke<CuePoints>("detect_song_cue_points", { filePath });
  } catch (e) {
    console.error("[songAnalysis] detect_song_cue_points failed:", e);
    return null;
  }
}

// ── Save analysis to DB ───────────────────────────────────────

export async function analyzeAndSave(songId: number, filePath: string): Promise<FullSongAnalysis | null> {
  const result = await analyzeSong(filePath);
  if (!result) return null;

  try {
    const stationId = getActiveStationIdSync();
    await execute(
      `UPDATE songs SET
        lufs_measured = ?,
        peak_db       = ?,
        gain_db       = ?,
        bpm           = ?,
        energy        = ?,
        intro_end     = CASE WHEN intro_end IS NULL OR intro_end = 0 THEN ? ELSE intro_end END,
        outro_start   = CASE WHEN outro_start IS NULL THEN ? ELSE outro_start END,
        duration_ms   = ?,
        is_processed  = 1,
        updated_at    = unixepoch()
       WHERE id = ? AND station_id = ?`,
      [
        result.loudness.lufs_integrated,
        result.loudness.peak_db,
        result.loudness.gain_db,
        result.bpm.bpm || null,
        result.energy.energy,
        result.cue_points.intro_end,
        result.cue_points.outro_start,
        Math.round(result.duration_secs * 1000),
        songId,
        stationId,
      ]
    );
  } catch (e) {
    console.error("[songAnalysis] DB save failed:", e);
  }

  return result;
}

// ── Batch process entire library ──────────────────────────────
// Replaces processAllSongs() in processor.ts and analyzeLibrary() in songAnalyzer.ts.
// Runs songs in parallel batches of 4 for speed.

export async function processLibrary(
  onProgress?: (done: number, total: number, title: string, result?: FullSongAnalysis) => void,
  options: { force?: boolean; batchSize?: number } = {}
): Promise<{ processed: number; failed: number; skipped: number }> {
  const { force = false, batchSize = 4 } = options;
  const stationId = getActiveStationIdSync();

  const whereClause = force
    ? "file_path IS NOT NULL AND station_id = ?"
    : "file_path IS NOT NULL AND station_id = ? AND (is_processed = 0 OR bpm IS NULL OR lufs_measured IS NULL)";

  const songs = await query<{ id: number; title: string; file_path: string }>(
    `SELECT id, title, file_path FROM songs WHERE ${whereClause} ORDER BY id`,
    [stationId]
  );

  let processed = 0;
  let failed    = 0;
  let skipped   = 0;
  const total   = songs.length;

  // Process in batches
  for (let i = 0; i < total; i += batchSize) {
    const batch = songs.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.map(song => analyzeAndSave(song.id, song.file_path)
        .then(r => ({ song, result: r }))
      )
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.result) {
        processed++;
        onProgress?.(processed + failed + skipped, total, r.value.song.title, r.value.result);
      } else if (r.status === "fulfilled" && !r.value.result) {
        failed++;
        onProgress?.(processed + failed + skipped, total, r.value.song.title);
      } else {
        failed++;
      }
    }

    // Small pause between batches to keep UI responsive
    if (i + batchSize < total) {
      await new Promise(r => setTimeout(r, 20));
    }
  }

  return { processed, failed, skipped };
}

// ── Processing stats (same API as processor.ts getProcessingStats) ──

export async function getProcessingStats() {
  const stationId = getActiveStationIdSync();
  const [total, processed, unprocessed, avgLufs, loudest, quietest] = await Promise.all([
    query<{ c: number }>("SELECT COUNT(*) as c FROM songs WHERE file_path IS NOT NULL AND station_id = ?", [stationId]),
    query<{ c: number }>("SELECT COUNT(*) as c FROM songs WHERE is_processed = 1 AND station_id = ?", [stationId]),
    query<{ c: number }>("SELECT COUNT(*) as c FROM songs WHERE is_processed = 0 AND file_path IS NOT NULL AND station_id = ?", [stationId]),
    query<{ avg: number }>("SELECT AVG(lufs_measured) as avg FROM songs WHERE is_processed = 1 AND station_id = ?", [stationId]),
    query<{ title: string; lufs_measured: number }>("SELECT title, lufs_measured FROM songs WHERE is_processed = 1 AND station_id = ? ORDER BY lufs_measured DESC LIMIT 1", [stationId]),
    query<{ title: string; lufs_measured: number }>("SELECT title, lufs_measured FROM songs WHERE is_processed = 1 AND station_id = ? ORDER BY lufs_measured ASC LIMIT 1", [stationId]),
  ]);

  return {
    total:       total[0]?.c ?? 0,
    processed:   processed[0]?.c ?? 0,
    unprocessed: unprocessed[0]?.c ?? 0,
    avgLufs:     Math.round((avgLufs[0]?.avg ?? 0) * 10) / 10,
    loudest:     loudest[0]  ? `${loudest[0].title} (${loudest[0].lufs_measured} LUFS)` : null,
    quietest:    quietest[0] ? `${quietest[0].title} (${quietest[0].lufs_measured} LUFS)` : null,
  };
}

// ── Auto-cue on import ────────────────────────────────────────
// Call this right after adding a song to the library.
// Sets intro_end and outro_start automatically if not already set.

export async function autoCueSong(songId: number, filePath: string): Promise<void> {
  try {
    const cues = await detectCuePoints(filePath);
    if (!cues) return;

    // Only apply if the auto-detected values are meaningful
    if (cues.intro_end > 0.3 || cues.outro_start < 9999) {
      const stationId = getActiveStationIdSync();
      await execute(
        `UPDATE songs SET
           intro_end   = COALESCE(NULLIF(intro_end, 0), ?),
           outro_start = COALESCE(outro_start, ?)
         WHERE id = ? AND station_id = ?`,
        [cues.intro_end, cues.outro_start, songId, stationId]
      );
    }
  } catch (e) {
    console.error("[songAnalysis] autoCueSong failed:", e);
  }
}

// ── Energy label helpers (matching loggen.ts usage) ───────────

export function energyToLabel(energy: number): "low" | "medium" | "high" {
  if (energy > 0.55) return "high";
  if (energy > 0.25) return "medium";
  return "low";
}

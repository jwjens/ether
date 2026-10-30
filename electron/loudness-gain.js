// LIBRARY → NORMALIZE: NO MADE-UP GAIN (Jeff, 2026-10-30: "if the analysis fails, say it failed and change nothing.
// No made-up gain.")
//
// The engine's analyze_lufs returns the gain to -14 LUFS, but on ANY failure (file missing, cannot decode, silent file)
// it returns exactly -14.0 (native/src/lib.rs analyze_lufs: unwrap_or(-14.0)) — indistinguishable from a real answer,
// so a failed analysis quietly wrote gain_db = -14 and turned a song down 14 dB. A real -14.0 would mean a song measured
// at exactly 0 LUFS. So when the answer is exactly -14, this asks the engine's second, independent measurement
// (measure_song_loudness), which reports its failure as an error: failure → { ok: false }, nothing is written.
// Every other answer passes through unchanged.
const FAILURE_SENTINEL = -14;

/**
 * @param analyze  (filePath) → number            the engine's analyze_lufs
 * @param measure  (filePath) → string (JSON)      the engine's measure_song_loudness: a result, or {"error": "..."}
 * @returns { ok: true, gain } | { ok: false, error }
 */
function gainFor(filePath, { analyze, measure }) {
  if (!filePath) return { ok: false, error: "no file" };
  let gain;
  try { gain = analyze(filePath); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  if (typeof gain !== "number" || !Number.isFinite(gain)) return { ok: false, error: "no result" };
  if (gain !== FAILURE_SENTINEL) return { ok: true, gain };
  let m;
  try { m = JSON.parse(measure(filePath)); } catch (e) { return { ok: false, error: "the file could not be measured" }; }
  if (!m || m.error) return { ok: false, error: (m && m.error) || "the file could not be measured" };
  return { ok: true, gain };
}

module.exports = { gainFor, FAILURE_SENTINEL };

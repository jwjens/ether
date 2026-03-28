// ── AutoCue.tsx ───────────────────────────────────────────────
// Reads Promo Only TXXX intro/outro tags from MP3 files and
// writes them to the songs DB. Falls back to audio energy
// analysis when tags aren't present.

import { useState, useEffect } from "react";
import { execute, query } from "../db/client";

interface SongCue {
  id: number;
  title: string;
  artist_name: string | null;
  file_path: string;
  duration_ms: number;
  intro_end: number | null;
  outro_start: number | null;
  cue_in: number | null;
  bpm: number | null;
}

interface CueResult {
  songId: number;
  title: string;
  introEnd: number | null;
  outroStart: number | null;
  bpm: number | null;
  source: "id3-promo" | "id3-standard" | "analyzed" | "skipped";
}

// ── Parse Promo Only ID3 TXXX tags ───────────────────────────
// Promo Only embeds:
//   TXXX:Intro  = "0:08" or "8" (seconds into vocal)
//   TXXX:Outro  = "3:22" or "202" (seconds where outro starts)
//   TXXX:BPM or TBPM = tempo
//   COMM = general comment with cue info

function parseTimeStr(s: string): number | null {
  if (!s || !s.trim()) return null;
  const t = s.trim();
  // "3:22" format
  if (t.includes(":")) {
    const [m, sec] = t.split(":").map(Number);
    if (!isNaN(m) && !isNaN(sec)) return m * 60 + sec;
  }
  // Plain seconds "202" or "8"
  const n = parseFloat(t);
  if (!isNaN(n) && n > 0) return n;
  return null;
}

function readID3Cues(bytes: Uint8Array): {
  introEnd: number | null;
  outroStart: number | null;
  bpm: number | null;
  source: "id3-promo" | "id3-standard" | null;
} {
  const result = { introEnd: null as number | null, outroStart: null as number | null, bpm: null as number | null, source: null as "id3-promo" | "id3-standard" | null };

  try {
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return result;
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    let pos = 10;
    const end = Math.min(pos + size, bytes.length);
    const dec = new TextDecoder("utf-8", { fatal: false });
    const dec16 = new TextDecoder("utf-16le", { fatal: false });

    while (pos < end - 10) {
      const frameId = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
      const frameSize = (bytes[pos+4] << 24) | (bytes[pos+5] << 16) | (bytes[pos+6] << 8) | bytes[pos+7];
      pos += 10;
      if (frameSize <= 0 || frameSize > 100000) { pos += Math.max(0, frameSize); continue; }

      const frameBytes = bytes.slice(pos, pos + frameSize);

      // TBPM — standard BPM tag
      if (frameId === "TBPM" && frameBytes.length > 1) {
        const enc = frameBytes[0];
        const txt = enc === 1 ? dec16.decode(frameBytes.slice(1)) : dec.decode(frameBytes.slice(1));
        const b = parseFloat(txt.replace(/\0/g, "").trim());
        if (!isNaN(b) && b > 0) result.bpm = Math.round(b);
      }

      // TXXX — user-defined text (Promo Only uses these)
      if (frameId === "TXXX" && frameBytes.length > 2) {
        const enc = frameBytes[0];
        const rest = frameBytes.slice(1);
        // Split on null byte to get description + value
        let nullPos = rest.indexOf(0);
        if (enc === 1) {
          // UTF-16 — null is 2 bytes
          for (let i = 0; i < rest.length - 1; i += 2) {
            if (rest[i] === 0 && rest[i+1] === 0) { nullPos = i; break; }
          }
        }
        if (nullPos < 0) { pos += frameSize; continue; }
        const descBytes = rest.slice(0, nullPos);
        const valBytes = rest.slice(nullPos + (enc === 1 ? 2 : 1));
        const desc = (enc === 1 ? dec16.decode(descBytes) : dec.decode(descBytes)).replace(/\0/g, "").trim().toLowerCase();
        const val = (enc === 1 ? dec16.decode(valBytes) : dec.decode(valBytes)).replace(/\0/g, "").trim();

        if (desc === "intro" || desc === "intro_end" || desc === "intro end" || desc === "hook") {
          result.introEnd = parseTimeStr(val);
          result.source = "id3-promo";
        } else if (desc === "outro" || desc === "outro_start" || desc === "outro start" || desc === "fade") {
          result.outroStart = parseTimeStr(val);
          result.source = "id3-promo";
        } else if (desc === "bpm" && !result.bpm) {
          const b = parseFloat(val);
          if (!isNaN(b) && b > 0) result.bpm = Math.round(b);
        }
      }

      // COMM — comment tag, some pools embed cue info here
      if (frameId === "COMM" && frameBytes.length > 4) {
        const txt = dec.decode(frameBytes.slice(4)).replace(/\0/g, " ").toLowerCase();
        // Look for patterns like "intro:8" or "intro: 0:08"
        const introMatch = txt.match(/intro[:\s]+(\d+:\d+|\d+)/);
        const outroMatch = txt.match(/outro[:\s]+(\d+:\d+|\d+)/);
        if (introMatch && !result.introEnd) {
          result.introEnd = parseTimeStr(introMatch[1]);
          result.source = result.source || "id3-standard";
        }
        if (outroMatch && !result.outroStart) {
          result.outroStart = parseTimeStr(outroMatch[1]);
          result.source = result.source || "id3-standard";
        }
      }

      pos += frameSize;
    }
  } catch {}
  return result;
}

// ── Energy analysis fallback ─────────────────────────────────
// Uses Web Audio API to detect where vocals start (energy spike)
// and where the track starts fading (energy drop)

async function analyzeAudioCues(filePath: string, durationMs: number): Promise<{
  introEnd: number;
  outroStart: number;
  bpm: number | null;
}> {
  const durationSec = durationMs / 1000;

  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const url = convertFileSrc(filePath);
    const ctx = new AudioContext();
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    const data = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const windowSec = 0.5;
    const windowSamples = Math.floor(windowSec * sampleRate);
    const numWindows = Math.floor(data.length / windowSamples);

    // Calculate RMS energy for each window
    const energies: number[] = [];
    for (let w = 0; w < numWindows; w++) {
      let sum = 0;
      const start = w * windowSamples;
      for (let i = start; i < start + windowSamples; i++) {
        sum += data[i] * data[i];
      }
      energies.push(Math.sqrt(sum / windowSamples));
    }

    const maxEnergy = Math.max(...energies);
    const threshold = maxEnergy * 0.25;

    // Intro end — first sustained energy spike after initial quiet
    let introEnd = 8; // default 8 seconds
    let sustained = 0;
    for (let w = 2; w < Math.min(numWindows, 60); w++) {
      if (energies[w] > threshold) {
        sustained++;
        if (sustained >= 3) {
          introEnd = (w - 2) * windowSec;
          break;
        }
      } else {
        sustained = 0;
      }
    }

    // Outro start — where energy starts sustained drop in last 40%
    let outroStart = durationSec * 0.75; // default 75%
    const outroWindow = Math.floor(numWindows * 0.6);
    for (let w = outroWindow; w < numWindows - 6; w++) {
      const avg = energies.slice(w, w + 6).reduce((a, b) => a + b, 0) / 6;
      if (avg < threshold * 0.7) {
        outroStart = w * windowSec;
        break;
      }
    }

    ctx.close();
    return {
      introEnd: Math.round(introEnd * 10) / 10,
      outroStart: Math.round(outroStart * 10) / 10,
      bpm: null,
    };
  } catch {
    // Safe defaults based on typical pop song structure
    return {
      introEnd: 8,
      outroStart: Math.round(durationMs / 1000 * 0.82 * 10) / 10,
      bpm: null,
    };
  }
}

// ── Main AutoCue component ────────────────────────────────────

export default function AutoCue({ onClose }: { onClose: () => void }) {
  const [songs, setSongs] = useState<SongCue[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const [results, setResults] = useState<CueResult[]>([]);
  const [current, setCurrent] = useState("");
  const [progress, setProgress] = useState(0);
  const [mode, setMode] = useState<"id3-only" | "analyze-all" | "missing-only">("missing-only");

  useEffect(() => {
    query<SongCue>(
      "SELECT id, title, artist_name, file_path, duration_ms, intro_end, outro_start, cue_in, bpm FROM songs WHERE file_path IS NOT NULL ORDER BY title"
    ).then(setSongs).catch(() => {});
  }, []);

  const uncued = songs.filter(s => !s.intro_end && !s.outro_start).length;
  const cued = songs.filter(s => s.intro_end || s.outro_start).length;

  const run = async () => {
    setStatus("running");
    setResults([]);
    const toProcess = mode === "missing-only"
      ? songs.filter(s => !s.intro_end && !s.outro_start)
      : songs;

    const newResults: CueResult[] = [];

    for (let i = 0; i < toProcess.length; i++) {
      const song = toProcess[i];
      setCurrent(`${song.title} — ${song.artist_name || ""}`);
      setProgress(Math.round((i / toProcess.length) * 100));

      let introEnd: number | null = null;
      let outroStart: number | null = null;
      let bpm: number | null = null;
      let source: CueResult["source"] = "skipped";

      try {
        if (mode !== "analyze-all") {
          // Try ID3 tags first
          const { readFile } = await import("@tauri-apps/plugin-fs");
          const bytes = await readFile(song.file_path);
          const cues = readID3Cues(bytes);
          introEnd = cues.introEnd;
          outroStart = cues.outroStart;
          bpm = cues.bpm;
          if (cues.source) source = cues.source;
        }

        // Fall back to audio analysis if no ID3 cues found
        if ((!introEnd && !outroStart) && mode !== "id3-only") {
          const analyzed = await analyzeAudioCues(song.file_path, song.duration_ms);
          introEnd = analyzed.introEnd;
          outroStart = analyzed.outroStart;
          bpm = analyzed.bpm ?? bpm;
          source = "analyzed";
        }

        if (introEnd || outroStart) {
          await execute(
            "UPDATE songs SET intro_end=?, outro_start=?, bpm=COALESCE(?, bpm) WHERE id=?",
            [introEnd ?? null, outroStart ?? null, bpm ?? null, song.id]
          );
        }
      } catch {
        source = "skipped";
      }

      newResults.push({ songId: song.id, title: song.title, introEnd, outroStart, bpm, source });
      setResults([...newResults]);
    }

    setProgress(100);
    setCurrent("");
    setStatus("done");
  };

  const fmtSec = (s: number | null) => {
    if (!s) return "—";
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}.${sec.split(".")[1]}`;
  };

  const sourceLabel = (s: CueResult["source"]) => ({
    "id3-promo": { label: "Promo Only", color: "#34d399" },
    "id3-standard": { label: "ID3 Tag", color: "#38bdf8" },
    "analyzed": { label: "Analyzed", color: "#fbbf24" },
    "skipped": { label: "Skipped", color: "#64748b" },
  }[s]);

  const promoCount = results.filter(r => r.source === "id3-promo").length;
  const analyzedCount = results.filter(r => r.source === "analyzed").length;
  const id3Count = results.filter(r => r.source === "id3-standard").length;

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column" as const,
      fontFamily: "'Inter', system-ui, sans-serif",
      background: "var(--bg-primary)",
    }}>
      {/* Header */}
      <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, fontFamily: "'Syne', sans-serif", letterSpacing: "-0.03em", color: "var(--text-primary)" }}>
            Auto-Cue
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18 }}>✕</button>
        </div>
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-tertiary)" }}>
          Reads intro/outro timing from Promo Only ID3 tags. Falls back to audio analysis for untagged files.
        </p>
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: 12, padding: "16px 24px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        {[
          { label: "Total Songs", value: songs.length, color: "var(--accent-cyan)" },
          { label: "Already Cued", value: cued, color: "var(--accent-green)" },
          { label: "Need Cues", value: uncued, color: "var(--accent-amber)" },
        ].map(s => (
          <div key={s.label} style={{ flex: 1, padding: "10px 14px", borderRadius: 10, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color, fontFamily: "'DM Mono', monospace" }}>{s.value}</div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Mode selector */}
      {status === "idle" && (
        <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", marginBottom: 10, textTransform: "uppercase" as const }}>Mode</div>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
            {([
              ["missing-only", "Cue uncued songs only", `${uncued} songs — fastest`],
              ["id3-only", "Read ID3 tags only (no analysis)", "Best for Promo Only libraries"],
              ["analyze-all", "Analyze all songs with audio AI", `${songs.length} songs — thorough but slow`],
            ] as const).map(([val, label, sub]) => (
              <label key={val} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderRadius: 10, border: `1px solid ${mode === val ? "var(--accent-cyan)" : "var(--border-primary)"}`, background: mode === val ? "rgba(56,189,248,0.06)" : "var(--bg-secondary)", cursor: "pointer" }}>
                <input type="radio" name="mode" value={val} checked={mode === val} onChange={() => setMode(val)} style={{ marginTop: 2, accentColor: "var(--accent-cyan)" }} />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{label}</div>
                  <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 1 }}>{sub}</div>
                </div>
              </label>
            ))}
          </div>

          <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: "rgba(56,189,248,0.06)", border: "1px solid rgba(56,189,248,0.2)" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--accent-cyan)", marginBottom: 4, letterSpacing: "0.08em" }}>PROMO ONLY USERS</div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              Promo Only files embed <code style={{ background: "var(--bg-tertiary)", padding: "1px 4px", borderRadius: 3, fontSize: 10 }}>TXXX:Intro</code> and <code style={{ background: "var(--bg-tertiary)", padding: "1px 4px", borderRadius: 3, fontSize: 10 }}>TXXX:Outro</code> ID3 tags with exact timing.
              Use <strong>"Read ID3 tags only"</strong> for instant cue detection with zero audio processing.
            </div>
          </div>

          <button
            onClick={run}
            style={{ width: "100%", marginTop: 14, padding: "12px", borderRadius: 10, background: "var(--accent-cyan)", border: "none", color: "#000", fontSize: 13, fontWeight: 800, cursor: "pointer", letterSpacing: "0.02em" }}
          >
            ▶ Start Auto-Cue
          </button>
        </div>
      )}

      {/* Progress */}
      {status === "running" && (
        <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>Processing...</span>
            <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>{progress}%</span>
          </div>
          <div style={{ height: 6, background: "var(--bg-tertiary)", borderRadius: 3, overflow: "hidden", marginBottom: 8 }}>
            <div style={{ height: "100%", width: progress + "%", background: "var(--accent-cyan)", borderRadius: 3, transition: "width 0.3s" }} />
          </div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{current}</div>
        </div>
      )}

      {/* Done summary */}
      {status === "done" && (
        <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {promoCount > 0 && <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: "rgba(52,211,153,0.15)", color: "#34d399" }}>✓ {promoCount} Promo Only tags</span>}
            {id3Count > 0 && <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: "rgba(56,189,248,0.15)", color: "var(--accent-cyan)" }}>✓ {id3Count} ID3 tags</span>}
            {analyzedCount > 0 && <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: "rgba(251,191,36,0.15)", color: "#fbbf24" }}>✓ {analyzedCount} analyzed</span>}
          </div>
          <button onClick={() => { setStatus("idle"); setResults([]); setProgress(0); }}
            style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer" }}>
            Run Again
          </button>
        </div>
      )}

      {/* Results list */}
      <div style={{ flex: 1, overflowY: "auto" as const }}>
        {results.length > 0 && (
          <div style={{ padding: "8px 24px" }}>
            {results.map(r => {
              const sl = sourceLabel(r.source);
              return (
                <div key={r.songId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--border-primary)" }}>
                  <span style={{ fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: sl.color + "20", color: sl.color, flexShrink: 0, letterSpacing: "0.06em" }}>{sl.label}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{r.title}</div>
                  </div>
                  {r.introEnd && (
                    <span style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: "#34d399", flexShrink: 0 }}>
                      ▶ {fmtSec(r.introEnd)}
                    </span>
                  )}
                  {r.outroStart && (
                    <span style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: "#fb923c", flexShrink: 0 }}>
                      ◀ {fmtSec(r.outroStart)}
                    </span>
                  )}
                  {r.bpm && (
                    <span style={{ fontSize: 9, color: "var(--text-tertiary)", flexShrink: 0 }}>{r.bpm} BPM</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {status === "idle" && results.length === 0 && (
          <div style={{ padding: "32px 24px", textAlign: "center" as const }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🎵</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>Ready to cue {songs.length} songs</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
              Intro/outro timing will be used automatically<br/>for the countdown, album art reveal, and crossfade
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

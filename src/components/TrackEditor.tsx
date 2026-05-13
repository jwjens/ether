import { useState, useEffect, useRef, useCallback } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
const invoke = <T = any>(cmd: string, args?: any): Promise<T> => (window as any).ether.invoke(cmd, args);
import WaveformGL from "./WaveformGL";

interface Song {
  id: number;
  title: string;
  artist_name: string | null;
  file_path: string;
  duration_ms: number;
  cue_in?: number;      // seconds
  cue_out?: number;     // seconds
  intro_end?: number;   // seconds
  outro_start?: number; // seconds
  is_explicit?: number; // 1 = explicit, 0 = clean
}

interface Props {
  song?: Song | null;
  filePath?: string | null;   // open directly by path — looks up song from DB
  onClose?: () => void;
  onSaved?: (song: Song) => void;
}

const HANDLE_W = 8;
const COLORS = {
  cueIn:     "#22d3ee",
  cueOut:    "#f87171",
  introEnd:  "#34d399",
  outroStart:"#fb923c",
};

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00.0";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${m}:${String(s).padStart(2,"0")}.${ms}`;
}

// ── Import Panel ──────────────────────────────────────────────

interface ImportPanelProps {
  onImported: (song: Song) => void;
}

const SUPPORTED = [".mp3", ".flac", ".wav", ".aac", ".m4a", ".ogg", ".opus", ".aiff"];

function ImportPanel({ onImported }: ImportPanelProps) {
  const { stationId } = useActiveStation();
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ file: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<Song[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importFile = async (filePath: string): Promise<Song | null> => {
    try {
      let title = filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "Unknown";
      let artistName = "Unknown Artist";
      let durationMs = 0;

      try {
        const meta = await invoke<any>("read_track_metadata", { path: filePath });
        if (meta.title) title = meta.title;
        if (meta.artist) artistName = meta.artist;
      } catch {}

      // Get duration via Web Audio
      try {
        const bytes1 = await invoke<number[]>("read_audio_file", { filePath });
        const buf1 = new Uint8Array(bytes1).buffer;
        const ctx = new AudioContext();
        const decoded = await ctx.decodeAudioData(buf1);
        durationMs = Math.round(decoded.duration * 1000);
        ctx.close();
      } catch {}

      // Upsert artist
      const artistRes = await (window as any).ether.artists.findOrCreateByName(artistName);
      const artistId = artistRes.row?.id ?? 1;

      // Upsert song — check first to replicate OR IGNORE semantics
      const existingByPath = await (window as any).ether.db.query(
        "SELECT id FROM songs WHERE file_path = ? AND deleted_at IS NULL", [filePath]
      );
      if (!existingByPath?.data?.length) {
        await (window as any).ether.songs.create({ title, artist_id: artistId, file_path: filePath, duration_ms: durationMs });
      }
      const [songRow] = await queryScoped<Song>(
        "SELECT s.id, s.title, a.name as artist_name, s.file_path, s.duration_ms FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path = ?",
        [filePath],
        stationId,
        { skipScoping: true }
      ) ?? [];
      return songRow ?? null;
    } catch (e) {
      console.error("Import error:", e);
      return null;
    }
  };

  const handleFiles = async (files: File[]) => {
    const audioFiles = files.filter(f => SUPPORTED.some(ext => f.name.toLowerCase().endsWith(ext)));
    if (audioFiles.length === 0) { setError("No supported audio files found. Supported: MP3, FLAC, WAV, AAC, M4A, OGG, OPUS, AIFF"); return; }

    setImporting(true);
    setError(null);
    const results: Song[] = [];

    for (let i = 0; i < audioFiles.length; i++) {
      const f = audioFiles[i];
      setProgress({ file: f.name, done: i, total: audioFiles.length });
      const filePath = (f as any).path || f.name;
      const song = await importFile(filePath);
      if (song) results.push(song);
    }

    setProgress(null);
    setImporting(false);
    setImported(results);
    if (results.length === 1) onImported(results[0]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  };

  const handleBrowse = async () => {
    try {
      const open = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
      const selected = await open({
        multiple: true,
        filters: [{ name: "Audio", extensions: ["mp3","flac","wav","aac","m4a","ogg","opus","aiff"] }],
        title: "Import Audio Files",
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      setImporting(true);
      setError(null);
      const results: Song[] = [];
      for (let i = 0; i < paths.length; i++) {
        setProgress({ file: paths[i].split(/[\\/]/).pop() || "", done: i, total: paths.length });
        const song = await importFile(paths[i]);
        if (song) results.push(song);
      }
      setProgress(null);
      setImporting(false);
      setImported(results);
      if (results.length === 1) onImported(results[0]);
    } catch (e: any) {
      setError(String(e));
      setImporting(false);
    }
  };

  const handleFolderScan = async () => {
    try {
      const open = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
      const folder = await open({ directory: true, title: "Scan Music Folder" });
      if (!folder || typeof folder !== "string") return;
      setImporting(true);
      setError(null);
      const files: string[] = await invoke<string[]>("scan_audio_folder", { path: folder }).catch(() => []);
      const results: Song[] = [];
      for (let i = 0; i < files.length; i++) {
        setProgress({ file: files[i].split(/[\\/]/).pop() || "", done: i, total: files.length });
        const song = await importFile(files[i]);
        if (song) results.push(song);
      }
      setProgress(null);
      setImporting(false);
      setImported(results);
    } catch (e: any) {
      setError(String(e));
      setImporting(false);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-primary)", fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ padding: "24px 32px 20px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "var(--accent-cyan)", textTransform: "uppercase", marginBottom: 6 }}>Cue Editor</div>
        <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)", fontFamily: "'Syne', sans-serif", marginBottom: 6 }}>Import Tracks</div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Add audio files to your library, then set cue points, intro, and outro markers</div>
      </div>

      <div style={{ flex: 1, padding: "28px 32px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 20 }}>

        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          style={{
            borderRadius: 0,
            border: `2px dashed ${dragOver ? "var(--accent-cyan)" : "var(--border-primary)"}`,
            background: dragOver ? "rgba(34,211,238,0.04)" : "var(--bg-secondary)",
            padding: "48px 32px",
            textAlign: "center",
            transition: "all 0.15s",
            cursor: "default",
            flexShrink: 0,
          }}
        >
          {importing && progress ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", border: "3px solid var(--accent-cyan)", borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} />
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{progress.file}</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{progress.done + 1} of {progress.total}</div>
              <div style={{ width: 200, height: 4, borderRadius: 0, background: "var(--bg-tertiary)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${((progress.done + 1) / progress.total) * 100}%`, background: "var(--accent-cyan)", borderRadius: 0, transition: "width 0.3s" }} />
              </div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 40, marginBottom: 14 }}>🎵</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
                {dragOver ? "Drop to import" : "Drop audio files here"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 20 }}>
                MP3, FLAC, WAV, AAC, M4A, OGG, AIFF
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                <button onClick={handleBrowse} style={{
                  padding: "9px 22px", borderRadius: 0,
                  background: "var(--accent-cyan)", border: "none",
                  color: "#000", fontSize: 12, fontWeight: 700,
                  cursor: "pointer", letterSpacing: "0.02em",
                }}>Browse Files</button>
                <button onClick={handleFolderScan} style={{
                  padding: "9px 22px", borderRadius: 0,
                  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
                  color: "var(--text-secondary)", fontSize: 12, fontWeight: 600,
                  cursor: "pointer",
                }}>Scan Folder</button>
              </div>
            </>
          )}
        </div>

        {/* Error */}
        {error && (
          <div style={{ padding: "12px 16px", borderRadius: 0, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", fontSize: 12, color: "#ef4444" }}>
            {error}
          </div>
        )}

        {/* Imported results */}
        {imported.length > 1 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
              {imported.length} tracks imported — click one to edit cue points
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {imported.map(s => (
                <div key={s.id} onClick={() => onImported(s)} style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 14px", borderRadius: 0,
                  background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
                  cursor: "pointer", transition: "all 0.12s",
                }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-cyan)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-primary)"; }}
                >
                  <div style={{ width: 32, height: 32, borderRadius: 0, background: "var(--accent-cyan)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 14 }}>🎵</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                    <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{s.artist_name}</div>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--accent-cyan)", fontWeight: 600 }}>Edit cues →</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Help */}
        {imported.length === 0 && !importing && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            {[
              { icon: "⏮", label: "Cue In", desc: "Where playback starts — skip silence at the start" },
              { icon: "🎙", label: "Intro End", desc: "When the vocals kick in — for voice-over timing" },
              { icon: "🎵", label: "Outro Start", desc: "When to start fading or crossfading to next track" },
            ].map(item => (
              <div key={item.label} style={{ padding: "14px 16px", borderRadius: 0, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
                <div style={{ fontSize: 20, marginBottom: 8 }}>{item.icon}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>{item.label}</div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.5 }}>{item.desc}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default function TrackEditor({ song: songProp, filePath: filePathProp, onClose, onSaved }: Props) {
  const { stationId } = useActiveStation();
  const [song, setSong] = useState<Song | null | undefined>(songProp);

  // If opened by filePath, look up the song from DB with timeout fallback
  useEffect(() => {
    if (filePathProp && !songProp) {
      const fallback: Song = { id: 0, title: filePathProp.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "Unknown", artist_name: "", file_path: filePathProp, duration_ms: 0 };
      Promise.race([
        queryScoped<Song>(
          "SELECT s.id, s.title, a.name as artist_name, s.file_path, s.duration_ms, s.cue_in, s.cue_out, s.intro_end, s.outro_start, s.is_explicit FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path = ? LIMIT 1",
          [filePathProp],
          stationId,
          { skipScoping: true }
        ),
        new Promise<Song[]>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000))
      ]).then((rows: Song[]) => {
        setSong(rows.length > 0 ? rows[0] : fallback);
      }).catch(() => setSong(fallback));
    } else {
      setSong(songProp);
    }
  }, [songProp, filePathProp]);

  const waveformDivRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef<number>(0);

  // FIX #2: Playhead stored in ref for RAF loop — avoids 60fps React re-renders.
  // A separate throttled state drives the UI display only.
  const playheadRef = useRef(0);
  const [playhead, setPlayhead] = useState(0);
  const rafFrameCount = useRef(0);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  const [playStartTime, setPlayStartTime] = useState(0);
  const [playStartOffset, setPlayStartOffset] = useState(0);
  const [duration, setDuration] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [viewOffset, setViewOffset] = useState(0);
  const targetZoomRef   = useRef(1);
  const targetOffsetRef = useRef(0);

  // Cue output device — separate from main stream output
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [cueDeviceId, setCueDeviceId] = useState<string>(() => {
    try { return localStorage.getItem("ether_cue_device") || ""; } catch { return ""; }
  });

  // Load available output devices
  useEffect(() => {
    const loadDevices = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
        const devices = await navigator.mediaDevices.enumerateDevices();
        setOutputDevices(devices.filter(d => d.kind === "audiooutput"));
      } catch {}
    };
    loadDevices();
    navigator.mediaDevices.addEventListener?.("devicechange", loadDevices);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", loadDevices);
  }, []);

  // When device changes, update the AudioContext sink
  useEffect(() => {
    try { localStorage.setItem("ether_cue_device", cueDeviceId); } catch {}
    const ctx = audioCtxRef.current;
    if (ctx && (ctx as any).setSinkId) {
      (ctx as any).setSinkId(cueDeviceId || "").catch(() => {});
    }
  }, [cueDeviceId]);

  // Cue points in seconds
  const [cueIn, setCueIn] = useState(0);
  const [cueOut, setCueOut] = useState(0);
  const [introEnd, setIntroEnd] = useState(0);
  const [outroStart, setOutroStart] = useState(0);

  const [dragging, setDragging] = useState<string | null>(null);
  const draggingRef = useRef<string | null>(null);

  const setDraggingSync = (val: string | null) => {
    draggingRef.current = val;
    setDragging(val);
  };
  const [saved, setSaved] = useState(false);
  const [isExplicit, setIsExplicit] = useState(0);
  const [mbStatus, setMbStatus] = useState<string | null>(null);
  const [waveformData, setWaveformData] = useState<Float32Array | null>(null);
  const [dragRegionGL, setDragRegionGL] = useState<{ start: number; end: number; type: "intro" | "outro" } | null>(null);
  const [hoverSec, setHoverSec] = useState<number | null>(null);

  // Active tool mode — "intro" or "outro" means click+drag paints that region
  const [activeMode, setActiveMode] = useState<"intro" | "outro" | null>(null);
  const activeModeRef = useRef<"intro" | "outro" | null>(null);
  const dragStartSec = useRef<number | null>(null);

  // Sync helper — updates ref immediately so mousedown sees correct mode
  const setActiveModeSync = (val: "intro" | "outro" | null) => {
    activeModeRef.current = val;
    setActiveMode(val);
  };

  const durRef = useRef(0);
  const cueInRef = useRef(0);
  const cueOutRef = useRef(0);
  const introEndRef = useRef(0);
  const outroStartRef = useRef(0);
  const zoomRef = useRef(1);
  const viewOffsetRef = useRef(0);
  const hoverSecRef  = useRef<number | null>(null);

  // FIX #4: Declare the missing hoverXForZoom ref that handleWheel was referencing.
  const hoverXForZoom = useRef(0.5);

  // Keep refs in sync with state
  useEffect(() => { durRef.current = duration; }, [duration]);
  useEffect(() => { cueInRef.current = cueIn; }, [cueIn]);
  useEffect(() => { cueOutRef.current = cueOut; }, [cueOut]);
  useEffect(() => { introEndRef.current = introEnd; }, [introEnd]);
  useEffect(() => { outroStartRef.current = outroStart; }, [outroStart]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { viewOffsetRef.current = viewOffset; }, [viewOffset]);

  // Load audio on song change
  useEffect(() => {
    if (!song?.file_path) return;
    setLoading(true);
    setLoadError("");
    setPlaying(false);
    playheadRef.current = 0;
    setPlayhead(0);
    setZoom(1);
    setViewOffset(0);

    // Load existing cue points
    setCueIn(song.cue_in || 0);
    setCueOut(song.cue_out || 0);
    setIntroEnd(song.intro_end || 0);
    setOutroStart(song.outro_start || 0);
    setIsExplicit(song.is_explicit || 0);

    const load = async () => {
      try {
        // FIX #7: Close the previous AudioContext before creating a new one
        // to prevent context leaks when switching songs rapidly.
        if (audioCtxRef.current) {
          await audioCtxRef.current.close().catch(() => {});
          audioCtxRef.current = null;
        }

        const bytes2 = await invoke<number[]>("read_audio_file", { filePath: song.file_path });
        const arrayBuf = new Uint8Array(bytes2).buffer;
        const ctx = new AudioContext();

        // Route to cue output device if selected
        if (cueDeviceId && (ctx as any).setSinkId) {
          await (ctx as any).setSinkId(cueDeviceId).catch(() => {});
        }
        audioCtxRef.current = ctx;
        const buf = await ctx.decodeAudioData(arrayBuf);
        audioBufferRef.current = buf;
        const dur = buf.duration;
        setDuration(dur);
        durRef.current = dur;

        // Set defaults if no cue points saved
        if (!song.cue_out || song.cue_out === 0) setCueOut(dur);
        if (!song.outro_start || song.outro_start === 0) setOutroStart(dur * 0.9);

        // Build waveform peaks from Web Audio (fast fallback)
        const ch = buf.getChannelData(0);
        const peaks = 3000;
        const blockSize = Math.floor(ch.length / peaks);
        const data = new Float32Array(peaks);
        let globalMax = 0;
        for (let i = 0; i < peaks; i++) {
          let max = 0;
          const start = i * blockSize;
          for (let j = 0; j < blockSize; j++) {
            const v = Math.abs(ch[start + j] || 0);
            if (v > max) max = v;
          }
          data[i] = max;
          if (max > globalMax) globalMax = max;
        }
        if (globalMax > 0) {
          for (let i = 0; i < peaks; i++) data[i] /= globalMax;
        }
        setWaveformData(data);
        setLoading(false);

        // FIX #1: Try to upgrade to high-quality Rust mipmap after initial render.
        // waveformData is set either way — the flag that was always false is removed.
        try {
          const mipmap = await invoke<{ levels: number[][] }>("build_peak_mipmap", { filePath: song.file_path });
          if (mipmap?.levels?.[0]) {
            setWaveformData(new Float32Array(mipmap.levels[0]));
          }
        } catch {
          // Rust command not available yet — keep Web Audio peaks above
        }
      } catch (e) {
        setLoadError("Could not load audio: " + String(e));
        setLoading(false);
      }
    };
    load();

    return () => {
      sourceRef.current?.stop();
      audioCtxRef.current?.close();
    };
  }, [song?.id]);

  // FIX #2: RAF loop writes to ref every frame but only calls setPlayhead every 4 frames.
  // This reduces React re-renders from 60/s to 15/s while keeping the GL playhead smooth
  // (WaveformGL reads playheadRef directly via the prop computed below).
  useEffect(() => {
    if (!playing) return;
    rafFrameCount.current = 0;
    const tick = () => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const elapsed = ctx.currentTime - playStartTime;
      const pos = playStartOffset + elapsed;
      const dur = durRef.current;

      if (pos >= (cueOutRef.current || dur)) {
        playheadRef.current = cueOutRef.current || dur;
        setPlayhead(playheadRef.current);
        setPlaying(false);
        return;
      }

      playheadRef.current = pos;

      // Throttle: only flush to React state every 4 frames (~15fps for display)
      rafFrameCount.current++;
      if (rafFrameCount.current % 4 === 0) {
        setPlayhead(pos);
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, playStartTime, playStartOffset]);

  const play = useCallback((fromSec?: number) => {
    const ctx = audioCtxRef.current;
    const buf = audioBufferRef.current;
    if (!ctx || !buf) return;
    sourceRef.current?.stop();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const offset = fromSec !== undefined ? fromSec : (cueInRef.current || 0);
    src.start(0, offset);
    src.onended = () => setPlaying(false);
    sourceRef.current = src;
    setPlayStartTime(ctx.currentTime);
    setPlayStartOffset(offset);
    setPlaying(true);
  }, []);

  const pause = useCallback(() => {
    sourceRef.current?.stop();
    setPlaying(false);
  }, []);

  // Instant zoom anchored to mouse position
  const applyZoom = useCallback((newZoom: number, pivotRatio?: number) => {
    const dur    = durRef.current;
    const curZ   = zoomRef.current;
    const curO   = viewOffsetRef.current;
    const ratio  = pivotRatio ?? 0.5;
    const clampZ = Math.max(1, Math.min(64, newZoom));
    const pivot  = curO + (dur / curZ) * ratio;
    const newVis = dur / clampZ;
    const newOff = Math.max(0, Math.min(dur - newVis, pivot - newVis * ratio));
    targetZoomRef.current   = clampZ;
    targetOffsetRef.current = newOff;
    setZoom(clampZ);
    setViewOffset(newOff);
  }, []);

  const togglePlay = () => playing ? pause() : play(playheadRef.current);

  // Capture spacebar — stop propagation so Live Assist doesn't receive it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === document.body) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (playingRef.current) pause();
        else play(playheadRef.current);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [play, pause]);

  // Mouse interaction
  const getHandleAt = (x: number, canvasW: number): string | null => {
    const dur = durRef.current;
    const visibleDur = dur / zoomRef.current;
    const secToX = (s: number) => ((s - viewOffsetRef.current) / visibleDur) * canvasW;
    const handles = [
      { name: "cueIn",      sec: cueInRef.current },
      { name: "cueOut",     sec: cueOutRef.current || dur },
      { name: "introEnd",   sec: introEndRef.current },
      { name: "outroStart", sec: outroStartRef.current || dur },
    ];
    for (const h of handles) {
      if (Math.abs(x - secToX(h.sec)) < 20) return h.name;
    }
    return null;
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const canvas = waveformDivRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const dur = durRef.current;
    const visibleDur = dur / zoomRef.current;
    const sec = Math.max(0, Math.min(dur, viewOffsetRef.current + (x / rect.width) * visibleDur));

    const mode = activeModeRef.current;
    if (mode === "intro" || mode === "outro") {
      dragStartSec.current = sec;
      setDraggingSync(mode);
      return;
    }

    const handle = getHandleAt(x, rect.width);
    if (handle) {
      setDraggingSync(handle);
    } else {
      playheadRef.current = sec;
      setPlayhead(sec);
      if (playingRef.current) play(sec);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const canvas = waveformDivRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const dur = durRef.current;
    const visibleDur = dur / zoomRef.current;
    const sec = Math.max(0, Math.min(dur, viewOffsetRef.current + (x / rect.width) * visibleDur));

    setHoverSec(sec);
    hoverSecRef.current = sec;

    const drag = draggingRef.current;
    if (!drag) return;
    if (drag === "cueIn")      setCueIn(Math.min(sec, cueOutRef.current - 0.5));
    if (drag === "cueOut")     setCueOut(Math.max(sec, cueInRef.current + 0.5));
    if (drag === "introEnd")   setIntroEnd(Math.max(0, Math.min(sec, (cueOutRef.current || durRef.current) - 0.5)));
    if (drag === "outroStart") setOutroStart(Math.max(0.5, Math.min(sec, (cueOutRef.current || durRef.current))));

    // Region drag — show visual overlay only, commit on mouseUp
    if ((drag === "intro" || drag === "outro") && dragStartSec.current !== null) {
      const a = Math.min(dragStartSec.current, sec);
      const b = Math.max(dragStartSec.current, sec);
      const d = durRef.current || 1;
      setDragRegionGL({ start: a/d, end: b/d, type: drag as "intro" | "outro" });
    }
  };

  // Shared commit logic used by both mouseUp and mouseLeave
  const commitDrag = useCallback(() => {
    const drag = draggingRef.current;
    if ((drag === "intro" || drag === "outro") && dragStartSec.current !== null) {
      const sec = hoverSecRef.current ?? dragStartSec.current;
      const a = Math.min(dragStartSec.current, sec);
      const b = Math.max(dragStartSec.current, sec);
      if (drag === "intro") {
        setCueIn(Math.max(0, a));
        setIntroEnd(b);
        introEndRef.current = b;
      } else {
        setOutroStart(a);
        outroStartRef.current = a;
        setCueOut(Math.min(b, durRef.current));
      }
      setActiveModeSync(null);
      dragStartSec.current = null;
    }
    setDraggingSync(null);
    setDragRegionGL(null);
  }, []);

  const handleMouseUp = () => commitDrag();

  // FIX #6: mouseLeave now commits in-progress drag instead of silently dropping it.
  const handleMouseLeave = () => {
    commitDrag();
    setHoverSec(null);
    hoverSecRef.current = null;
  };

  // FIX #3: Native wheel listener with passive:false so we can preventDefault on
  // Ctrl+scroll — React's synthetic onWheel cannot do this, causing the browser
  // window to zoom simultaneously with the waveform.
  useEffect(() => {
    const el = waveformDivRef.current;
    if (!el) return;

    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const dur = durRef.current;
      const rect = el.getBoundingClientRect();
      const mouseRatio = (e.clientX - rect.left) / rect.width;
      hoverXForZoom.current = mouseRatio;

      if (e.ctrlKey || e.metaKey) {
        // Pinch-to-zoom or Ctrl+scroll
        const factor = e.deltaY < 0 ? 1.06 : 0.94;
        applyZoom(targetZoomRef.current * factor, mouseRatio);
      } else if (e.altKey) {
        // Alt+scroll — fast zoom
        const factor = e.deltaY < 0 ? 1.15 : 0.87;
        applyZoom(targetZoomRef.current * factor, mouseRatio);
      } else {
        // Pan — smooth, proportional to zoom level
        const visibleDur = dur / zoomRef.current;
        const delta      = (e.deltaX || e.deltaY) / 300 * visibleDur;
        const newOff     = Math.max(0, Math.min(dur - visibleDur, targetOffsetRef.current + delta));
        targetOffsetRef.current = newOff;
        setViewOffset(newOff);
      }
    };

    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [applyZoom]);

  const save = async () => {
    if (!song) return;
    try {
      await (window as any).ether.songs.updateById(song.id, {
        cue_in:      cueIn,
        cue_out:     cueOut,
        intro_end:   introEnd,
        outro_start: outroStart,
        is_explicit: isExplicit,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved?.({ ...song, cue_in: cueIn, cue_out: cueOut, intro_end: introEnd, outro_start: outroStart, is_explicit: isExplicit });
    } catch (e) { console.error("Save cue points:", e); }
  };

  // ── MusicBrainz per-song lookup ───────────────────────────────
  const lookupMusicBrainz = async () => {
    if (!song) return;
    setMbStatus("Searching MusicBrainz…");
    try {
      const title = encodeURIComponent(`"${song.title}"`);
      const artist = song.artist_name ? encodeURIComponent(`"${song.artist_name}"`) : "";
      const q = artist ? `recording:${title} AND artist:${artist}` : `recording:${title}`;
      const res = await fetch(
        `https://musicbrainz.org/ws/2/recording?query=${q}&inc=tags&fmt=json&limit=5`,
        { headers: { "User-Agent": "OpenAir/1.0 (radio automation)" } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rec = (data.recordings || []).find((r: any) => r.score >= 85);
      if (!rec) {
        setMbStatus("No match found (score < 85)");
        setTimeout(() => setMbStatus(null), 4000);
        return;
      }
      const tags: string[] = (rec.tags || []).map((t: any) => (t.name || "").toLowerCase());
      const explicit = tags.some(t => t === "explicit" || t === "explicit content" || t === "parental advisory") ? 1 : 0;
      setIsExplicit(explicit);
      await (window as any).ether.songs.updateById(song.id, { is_explicit: explicit });
      const label = explicit ? "Marked EXPLICIT" : "Marked clean";
      setMbStatus(`${label} (score: ${rec.score}, tags: ${tags.length ? tags.join(", ") : "none"})`);
      console.log(`[mb] "${song.title}": ${label} — tags: [${tags.join(", ")}]`);
      setTimeout(() => setMbStatus(null), 6000);
    } catch (e) {
      setMbStatus(`Lookup failed: ${String(e)}`);
      console.warn("[mb] lookup error:", e);
      setTimeout(() => setMbStatus(null), 5000);
    }
  };

  const reset = () => {
    if (!duration) return;
    setCueIn(0);
    setCueOut(duration);
    setIntroEnd(0);
    setOutroStart(duration * 0.9);
  };

  if (!song) return (
    <ImportPanel onImported={(s) => {
      queryScoped<Song>(`SELECT s.id, s.title, a.name as artist_name, s.file_path, s.duration_ms, s.cue_in, s.cue_out, s.intro_end, s.outro_start, s.is_explicit FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.id = ?`, [s.id], stationId, { skipScoping: true })
        .then(([full]) => { if (full && onSaved) onSaved(full); })
        .catch(() => {});
    }} />
  );

  const fmtSmpte = (s: number) => {
    const m   = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms  = Math.floor((s % 1) * 10);
    return `${m}:${String(sec).padStart(2,"0")}.${ms}`;
  };

  const remaining = Math.max(0, (cueOut || duration) - playhead);

  const Btn = ({
    onClick, children, color, active, title, shortcut, danger
  }: {
    onClick: () => void; children: React.ReactNode;
    color?: string; active?: boolean; title?: string;
    shortcut?: string; danger?: boolean;
  }) => (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "flex", alignItems: "center", gap: 5,
        height: 34, padding: "0 14px", borderRadius: 0,
        fontSize: 10, fontWeight: 700, letterSpacing: "0.07em",
        cursor: "pointer", flexShrink: 0, position: "relative" as const,
        transition: "all 0.12s",
        background: active
          ? (color || "var(--accent-blue)")
          : danger
          ? "rgba(239,68,68,0.08)"
          : color
          ? color + "15"
          : "var(--bg-tertiary)",
        color: active ? "#000" : danger ? "#ef4444" : color || "var(--text-secondary)",
        border: active
          ? `1.5px solid ${color || "var(--accent-blue)"}`
          : danger
          ? "1px solid rgba(239,68,68,0.25)"
          : `1px solid ${color ? color + "30" : "var(--border-primary)"}`,
        boxShadow: active ? `0 0 16px ${(color || "#0ea5e9")}44` : "none",
      }}
      onMouseDown={e => { (e.currentTarget as HTMLElement).style.transform = "scale(0.96)"; }}
      onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
    >
      {children}
      {shortcut && (
        <span style={{
          fontSize: 8, opacity: 0.5, fontWeight: 400,
          fontFamily: "'DM Mono', monospace", letterSpacing: 0,
        }}>[{shortcut}]</span>
      )}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-primary)", fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* ── Top bar: title + actions ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 16px 10px 20px",
        background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border-primary)",
        flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
            {song.title}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 1 }}>
            {song.artist_name || "Unknown Artist"}
            <span style={{ marginLeft: 8, opacity: 0.5 }}>·</span>
            <span style={{ marginLeft: 8, fontFamily: "'DM Mono', monospace" }}>{fmt(duration)}</span>
          </div>
        </div>

        {/* Cue output device */}
        {outputDevices.length > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.1em", color: "#22d3ee", opacity: 0.8 }}>🎧</span>
            <select value={cueDeviceId} onChange={e => setCueDeviceId(e.target.value)} style={{
              padding: "4px 8px", borderRadius: 0, fontSize: 10,
              background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
              color: "var(--text-secondary)", cursor: "pointer", outline: "none", maxWidth: 160,
            }}>
              <option value="">Default Output</option>
              {outputDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0,12)}</option>)}
            </select>
          </div>
        )}

        {/* Explicit toggle */}
        <button
          onClick={() => setIsExplicit(v => v ? 0 : 1)}
          title="Toggle explicit flag — affects content filtering and rotation rules"
          style={{
            height: 34, padding: "0 12px", borderRadius: 0, fontSize: 10, fontWeight: 800,
            letterSpacing: "0.08em", cursor: "pointer", flexShrink: 0,
            background: isExplicit ? "rgba(239,68,68,0.15)" : "var(--bg-tertiary)",
            color: isExplicit ? "#ef4444" : "var(--text-tertiary)",
            border: isExplicit ? "1.5px solid rgba(239,68,68,0.4)" : "1px solid var(--border-primary)",
            transition: "all 0.15s",
          }}
        >
          {isExplicit ? "🔞 EXPLICIT" : "E"}
        </button>

        {/* MusicBrainz per-song lookup */}
        <button
          onClick={lookupMusicBrainz}
          title="Look up this song on MusicBrainz and auto-detect explicit tag"
          style={{
            height: 34, padding: "0 12px", borderRadius: 0, fontSize: 10, fontWeight: 700,
            cursor: "pointer", flexShrink: 0,
            background: "var(--bg-tertiary)", color: "var(--text-tertiary)",
            border: "1px solid var(--border-primary)", transition: "all 0.12s",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-cyan)"; (e.currentTarget as HTMLElement).style.color = "var(--accent-cyan)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-primary)"; (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
        >MB Lookup</button>

        <Btn onClick={reset} title="Reset all cue points">Reset</Btn>
        <button
          onClick={save}
          style={{
            height: 34, padding: "0 18px", borderRadius: 0, fontSize: 11, fontWeight: 700,
            background: saved ? "#34d399" : "var(--accent-blue)",
            color: "#fff", border: "none", cursor: "pointer", flexShrink: 0,
            boxShadow: saved ? "0 0 16px rgba(52,211,153,0.4)" : "0 2px 12px rgba(14,165,233,0.35)",
            transition: "all 0.2s",
            letterSpacing: "0.03em",
          }}
          onMouseDown={e => { (e.currentTarget as HTMLElement).style.transform = "scale(0.97)"; }}
          onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
        >
          {saved ? "✓ Saved" : "Save Cue Points"}
        </button>
        {onClose && (
          <button onClick={onClose} style={{
            width: 30, height: 30, borderRadius: 0, display: "flex", alignItems: "center", justifyContent: "center",
            background: "transparent", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)",
            cursor: "pointer", fontSize: 14, flexShrink: 0, transition: "all 0.1s",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.1)"; (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
          >✕</button>
        )}
      </div>

      {/* ── MusicBrainz status bar ── */}
      {mbStatus && (
        <div style={{ padding: "6px 20px", background: "rgba(56,189,248,0.06)", borderBottom: "1px solid rgba(56,189,248,0.15)", fontSize: 11, color: "var(--accent-cyan)", flexShrink: 0 }}>
          {mbStatus}
        </div>
      )}

      {/* ── Cue points strip ── */}
      <div style={{ display: "flex", background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        {([
          { label: "CUE IN",      value: cueIn,             color: COLORS.cueIn,      desc: "Playback start",   key: "I" },
          { label: "INTRO END",   value: introEnd,           color: COLORS.introEnd,   desc: "Music starts",     key: "N" },
          { label: "OUTRO START", value: outroStart,         color: COLORS.outroStart, desc: "Begin fade",       key: "O" },
          { label: "CUE OUT",     value: cueOut || duration, color: COLORS.cueOut,     desc: "Playback end",     key: "U" },
        ] as const).map(({ label, value, color, desc, key }) => (
          <div
            key={label}
            onClick={() => {
              playheadRef.current = value;
              setPlayhead(value);
              if (playingRef.current) play(value);
            }}
            style={{
              flex: 1, padding: "8px 14px", borderRight: "1px solid var(--border-primary)",
              cursor: "pointer", transition: "background 0.1s", position: "relative" as const,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = color + "0d"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.14em", color }}>{label}</span>
              <span style={{ fontSize: 8, fontFamily: "'DM Mono', monospace", color: color + "60", fontWeight: 400 }}>[{key}]</span>
            </div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 22, fontWeight: 300, color: "var(--text-primary)", letterSpacing: "-0.03em", lineHeight: 1 }}>
              {fmtSmpte(value)}
            </div>
            <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 3 }}>{desc}</div>
            <div style={{ position: "absolute" as const, bottom: 0, left: 0, right: 0, height: 2, background: color + "50", borderRadius: 0 }} />
          </div>
        ))}

        {/* Big SMPTE position counter */}
        <div style={{
          padding: "8px 20px", minWidth: 160, display: "flex", flexDirection: "column" as const, justifyContent: "center",
          borderLeft: "1px solid var(--border-primary)", background: "rgba(0,0,0,0.15)",
        }}>
          <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.14em", color: playing ? "#34d399" : "var(--text-tertiary)", marginBottom: 3, transition: "color 0.2s" }}>
            {playing ? "● PLAYING" : "◼ POSITION"}
          </div>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: 28, fontWeight: 300,
            color: playing ? "#34d399" : "var(--text-primary)",
            letterSpacing: "-0.03em", lineHeight: 1,
            transition: "color 0.2s",
          }}>
            {fmtSmpte(playhead)}
          </div>
          <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 3, fontFamily: "'DM Mono', monospace" }}>
            −{fmtSmpte(remaining)} remain
          </div>
        </div>
      </div>

      {/* ── Waveform ── */}
      <div
        style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", cursor: dragging ? "col-resize" : "text" }}
        tabIndex={-1}
        onKeyDown={e => {
          if (e.code === "Space") { e.preventDefault(); e.stopPropagation(); playing ? pause() : play(playheadRef.current); }
        }}
      >
        {loading && (
          <div style={{ position: "absolute" as const, inset: 0, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", gap: 10, zIndex: 5 }}>
            <div style={{ width: 40, height: 40, border: "2px solid var(--border-primary)", borderTopColor: "var(--accent-blue)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Decoding audio...</span>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
        {loadError && (
          <div style={{ position: "absolute" as const, inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13, zIndex: 5 }}>
            {loadError}
          </div>
        )}
        {activeMode && (
          <div style={{
            position: "absolute" as const, top: 10, left: "50%", transform: "translateX(-50%)",
            zIndex: 10, pointerEvents: "none",
            background: activeMode === "intro" ? "rgba(34,211,238,0.9)" : "rgba(251,146,60,0.9)",
            borderRadius: 0, padding: "4px 16px",
            fontSize: 10, fontWeight: 800, letterSpacing: "0.1em", color: "#000",
          }}>
            ● DRAG TO MARK {activeMode.toUpperCase()}
          </div>
        )}

        {/* FIX #1 & #2: WebGL waveform — always rendered (no dead useWebGL flag).
            Playhead prop uses the ref value so the GL canvas updates every frame
            without waiting for the throttled React state. */}
        <div
          ref={waveformDivRef}
          style={{ position: "absolute" as const, inset: 0 }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          // FIX #3: onWheel removed — native listener with passive:false is
          // attached in useEffect above so Ctrl+scroll doesn't zoom the browser.
        >
          <WaveformGL
            peaks={waveformData}
            viewStart={viewOffset / (durRef.current || 1)}
            viewEnd={(viewOffset + (durRef.current || 1) / zoom) / (durRef.current || 1)}
            cueIn={cueIn / (duration || 1)}
            cueOut={(cueOut || duration) / (duration || 1)}
            introEnd={introEnd / (duration || 1)}
            outroStart={(outroStart || duration) / (duration || 1)}
            playhead={playheadRef.current / (duration || 1)}
            hoverPos={hoverSec !== null ? hoverSec / (duration || 1) : null}
            dragRegion={dragRegionGL}
          />
        </div>
      </div>

      {/* ── Transport bar ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 16px",
        background: "var(--bg-secondary)",
        borderTop: "1px solid var(--border-primary)",
        flexShrink: 0,
      }}>

        {/* Play/Stop */}
        <button
          onClick={togglePlay}
          style={{
            width: 42, height: 42, borderRadius: 0, flexShrink: 0,
            background: playing ? "#34d399" : "var(--accent-blue)",
            border: "none", color: "#000", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: playing ? "0 0 20px rgba(52,211,153,0.5)" : "0 0 16px rgba(14,165,233,0.4)",
            transition: "all 0.15s",
          }}
          onMouseDown={e => { (e.currentTarget as HTMLElement).style.transform = "scale(0.93)"; }}
          onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
        >
          {playing
            ? <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor"><rect x="1" y="0" width="4" height="13" rx="2"/><rect x="8" y="0" width="4" height="13" rx="2"/></svg>
            : <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor"><polygon points="1,0 13,6.5 1,13"/></svg>
          }
        </button>

        {/* Divider */}
        <div style={{ width: 1, height: 28, background: "var(--border-primary)", flexShrink: 0 }} />

        {/* Play from IN */}
        <Btn onClick={() => { playheadRef.current = cueIn; setPlayhead(cueIn); play(cueIn); }} color={COLORS.cueIn} shortcut="I" title="Play from Cue In">▶ FROM IN</Btn>

        {/* INTRO tool */}
        <button
          onClick={() => setActiveModeSync(activeModeRef.current === "intro" ? null : "intro")}
          title="Paint intro region — click then drag on waveform"
          style={{
            height: 34, padding: "0 14px", borderRadius: 0,
            fontSize: 10, fontWeight: 700, letterSpacing: "0.07em",
            cursor: "pointer", flexShrink: 0, transition: "all 0.12s",
            background: activeMode === "intro" ? "#22d3ee" : "#22d3ee18",
            color:      activeMode === "intro" ? "#000" : "#22d3ee",
            border:     activeMode === "intro" ? "1.5px solid #22d3ee" : "1px solid #22d3ee35",
            boxShadow:  activeMode === "intro" ? "0 0 16px #22d3ee44" : "none",
          }}
        >INTRO</button>

        {/* OUTRO tool */}
        <button
          onClick={() => setActiveModeSync(activeModeRef.current === "outro" ? null : "outro")}
          title="Paint outro region — click then drag on waveform"
          style={{
            height: 34, padding: "0 14px", borderRadius: 0,
            fontSize: 10, fontWeight: 700, letterSpacing: "0.07em",
            cursor: "pointer", flexShrink: 0, transition: "all 0.12s",
            background: activeMode === "outro" ? "#fb923c" : "#fb923c18",
            color:      activeMode === "outro" ? "#000" : "#fb923c",
            border:     activeMode === "outro" ? "1.5px solid #fb923c" : "1px solid #fb923c35",
            boxShadow:  activeMode === "outro" ? "0 0 16px #fb923c44" : "none",
          }}
        >OUTRO</button>

        <div style={{ flex: 1 }} />

        {/* Zoom controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 9, color: "var(--text-tertiary)", letterSpacing: "0.1em", fontWeight: 700, marginRight: 2 }}>ZOOM</span>
          {[
            { label: "−−", factor: 0.5,  title: "Zoom out a lot" },
            { label: "−",  factor: 0.75, title: "Zoom out" },
            { label: "+",  factor: 1.33, title: "Zoom in" },
            { label: "++", factor: 2.0,  title: "Zoom in a lot" },
          ].map(({ label, factor, title }) => (
            <button
              key={label}
              title={title}
              onClick={() => applyZoom(targetZoomRef.current * factor, 0.5)}
              style={{
                width: label.length > 1 ? 30 : 26, height: 26, borderRadius: 0,
                background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
                color: "var(--text-secondary)", cursor: "pointer", fontSize: label.length > 1 ? 9 : 14,
                fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all 0.1s", letterSpacing: label.length > 1 ? "0.05em" : 0,
              }}
              onMouseDown={e => { (e.currentTarget as HTMLElement).style.transform = "scale(0.9)"; }}
              onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-primary)"; (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-blue)"; (e.currentTarget as HTMLElement).style.color = "var(--accent-blue)"; }}
            >{label}</button>
          ))}
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "var(--text-secondary)", minWidth: 34, textAlign: "center" as const }}>{zoom.toFixed(1)}×</span>
          <button
            onClick={() => applyZoom(1, 0.5)}
            title="Fit entire track"
            style={{
              height: 26, padding: "0 10px", borderRadius: 0,
              background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
              color: "var(--text-tertiary)", cursor: "pointer", fontSize: 9,
              fontWeight: 800, letterSpacing: "0.06em", transition: "all 0.1s",
            }}
            onMouseDown={e => { (e.currentTarget as HTMLElement).style.transform = "scale(0.95)"; }}
            onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
          >FIT</button>
        </div>

        {/* Keyboard hints */}
        <div style={{ fontSize: 9, color: "var(--text-tertiary)", opacity: 0.45, letterSpacing: "0.03em", flexShrink: 0 }}>
          Space · Scroll to pan · Ctrl+scroll zoom
        </div>
      </div>
    </div>
  );
}

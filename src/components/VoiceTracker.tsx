import { useState, useEffect, useRef } from "react";
import { query, execute } from "../db/client";
import { engine } from "../audio/engine";
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";

interface VoiceTrack {
  id: number; title: string; file_path: string;
  show_id: number | null; duration_ms: number;
  recorded_by: string | null; recorded_at: number;
}

interface Show {
  id: number; name: string;
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function fmtDate(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString();
}

export default function VoiceTracker() {
  const [tracks, setTracks] = useState<VoiceTrack[]>([]);
  const [shows, setShows] = useState<Show[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [djName, setDjName] = useState("DJ");
  const [selectedShow, setSelectedShow] = useState<number | null>(null);
  const [trackTitle, setTrackTitle] = useState("");
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<any>(null);
  const startTimeRef = useRef(0);

  const load = async () => {
    setTracks(await query<VoiceTrack>("SELECT * FROM voice_tracks ORDER BY recorded_at DESC LIMIT 50"));
    setShows(await query<Show>("SELECT id, name FROM shows ORDER BY start_hour"));
  };
  useEffect(() => { load(); }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(100);
      mediaRecRef.current = mr;
      startTimeRef.current = Date.now();
      setRecording(true);
      setRecordTime(0);
      timerRef.current = setInterval(() => {
        setRecordTime(Date.now() - startTimeRef.current);
      }, 100);
    } catch (e) {
      console.error("Mic access error:", e);
      alert("Could not access microphone. Check browser permissions.");
    }
  };

  const stopRecording = async () => {
    const mr = mediaRecRef.current;
    if (!mr) return;

    return new Promise<void>((resolve) => {
      mr.onstop = async () => {
        if (timerRef.current) clearInterval(timerRef.current);
        setRecording(false);

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const durMs = Date.now() - startTimeRef.current;
        const title = trackTitle.trim() || ("Voice Track " + new Date().toLocaleTimeString());

        // Convert to base64 and store as data URL
        // In production this would save to filesystem
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          await execute(
            "INSERT INTO voice_tracks (title, file_path, show_id, duration_ms, recorded_by) VALUES (?,?,?,?,?)",
            [title, dataUrl, selectedShow, durMs, djName]
          );
          setTrackTitle("");
          load();
        };
        reader.readAsDataURL(blob);

        // Stop all tracks
        mr.stream.getTracks().forEach(t => t.stop());
        resolve();
      };
      mr.stop();
    });
  };

  const playTrack = async (track: VoiceTrack) => {
    try {
      const audio = new Audio(track.file_path);
      audio.play();
    } catch (e) {
      console.error("Play error:", e);
    }
  };

  const queueTrack = (track: VoiceTrack) => {
    engine.addToQueue([{
      filePath: track.file_path,
      title: "[VT] " + track.title,
      artist: track.recorded_by || "DJ"
    }]);
  };

  const deleteTrack = async (id: number) => {
    await execute("DELETE FROM voice_tracks WHERE id = ?", [id]);
    load();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Voice Tracking</h1>
      </div>

      <div className="text-xs text-zinc-500 bg-zinc-900 rounded p-2 border border-zinc-800">
        Record DJ breaks to insert between songs. "Hey it's Mike, that was Drake, coming up next we've got..." Pre-record an entire show and let automation handle the rest.
      </div>

      {/* Recording controls */}
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
        <div className="grid grid-cols-4 gap-2 mb-3">
          <input className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="DJ Name" value={djName} onChange={e => setDjName(e.target.value)} />
          <input className="col-span-2 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Track title (optional)" value={trackTitle} onChange={e => setTrackTitle(e.target.value)} />
          <select className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={selectedShow || ""} onChange={e => setSelectedShow(e.target.value ? parseInt(e.target.value) : null)}>
            <option value="">Any show</option>
            {shows.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        <div className="flex items-center gap-4">
          {!recording ? (
            <button onClick={startRecording} className="px-6 py-3 bg-red-600 hover:bg-red-500 rounded-lg text-sm font-bold text-white flex items-center gap-2">
              <span className="w-3 h-3 bg-white rounded-full"></span> RECORD
            </button>
          ) : (
            <button onClick={stopRecording} className="px-6 py-3 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm font-bold text-white">STOP</button>
          )}

          {recording && (
            <div className="flex items-center gap-3">
              <span className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></span>
              <span className="text-lg font-mono font-bold text-red-400">{fmtMs(recordTime)}</span>
              <span className="text-xs text-zinc-500">Recording...</span>
            </div>
          )}
        </div>
      </div>

      {/* Voice track list */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-zinc-300">Recorded Tracks ({tracks.length})</h2>
      </div>

      {tracks.length === 0 ? (
        <div className="text-center py-8">
          <div className="text-zinc-400 text-lg mb-2">No voice tracks yet</div>
          <div className="text-zinc-600 text-xs">Hit RECORD above to create your first DJ break.</div>
        </div>
      ) : (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-[10px] text-zinc-500 uppercase border-b border-zinc-800">
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">DJ</th>
              <th className="px-3 py-2">Duration</th>
              <th className="px-3 py-2">Recorded</th>
              <th className="px-3 py-2 text-right w-32">Actions</th>
            </tr></thead>
            <tbody>{tracks.map(t => (
              <tr key={t.id} className="border-b border-zinc-800 hover:bg-zinc-800">
                <td className="px-3 py-1.5 text-zinc-100">{t.title}</td>
                <td className="px-3 py-1.5 text-zinc-400">{t.recorded_by || "—"}</td>
                <td className="px-3 py-1.5 text-zinc-400 font-mono">{fmtMs(t.duration_ms)}</td>
                <td className="px-3 py-1.5 text-zinc-500">{fmtDate(t.recorded_at)}</td>
                <td className="px-3 py-1.5 text-right">
                  <button onClick={() => playTrack(t)} className="px-1.5 py-0.5 bg-emerald-700 hover:bg-emerald-600 rounded text-[9px] font-bold text-white mr-0.5">Play</button>
                  <button onClick={() => queueTrack(t)} className="px-1.5 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[9px] font-bold text-white mr-0.5">Q</button>
                  <button onClick={() => deleteTrack(t.id)} className="px-1.5 py-0.5 bg-zinc-800 hover:bg-red-900 rounded text-[9px] font-bold text-zinc-500">Del</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
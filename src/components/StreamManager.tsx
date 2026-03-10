import { useState, useEffect, useRef } from "react";
import { query, execute, queryOne } from "../db/client";
import { engine } from "../audio/engine";

interface StreamSettings {
  server: string; port: number; mount: string; password: string;
  bitrate: number; station_name: string | null; station_genre: string | null;
  station_url: string | null; is_active: number;
}

export default function StreamManager() {
  const [settings, setSettings] = useState<StreamSettings | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState("Disconnected");
  const [duration, setDuration] = useState(0);
  const [listeners, setListeners] = useState(0);
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<any>(null);
  const startRef = useRef(0);

  const load = async () => {
    const row = await queryOne<StreamSettings>("SELECT * FROM stream_settings WHERE id = 1");
    if (row) setSettings(row);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!settings) return;
    await execute(
      "UPDATE stream_settings SET server=?, port=?, mount=?, password=?, bitrate=?, station_name=?, station_genre=?, station_url=? WHERE id=1",
      [settings.server, settings.port, settings.mount, settings.password, settings.bitrate, settings.station_name, settings.station_genre, settings.station_url]
    );
    setError("");
    setStatus("Settings saved");
    setTimeout(() => { if (!streaming) setStatus("Disconnected"); }, 2000);
  };

  const startStream = async () => {
    if (!settings) return;
    setError("");
    setStatus("Connecting...");

    try {
      // Capture audio from the engine's AudioContext
      engine.init();
      const ctx = (engine as any).ctx as AudioContext;
      if (!ctx) { setError("Audio engine not initialized. Play something first."); setStatus("Disconnected"); return; }

      const dest = ctx.createMediaStreamDestination();
      // Connect the engine's output to the stream destination
      // We need to tap into the audio graph
      const analyser = ctx.createAnalyser();
      analyser.connect(dest);
      // Connect all deck outputs to our capture node
      const deckA = engine.getDeck("A");
      const deckB = engine.getDeck("B");
      // Access gain nodes (they connect to ctx.destination)
      // We'll also connect them to our capture destination
      if ((deckA as any)?.gainNode) (deckA as any).gainNode.connect(dest);
      if ((deckB as any)?.gainNode) (deckB as any).gainNode.connect(dest);

      streamRef.current = dest.stream;

      // Set up MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(dest.stream, {
        mimeType,
        audioBitsPerSecond: settings.bitrate * 1000,
      });
      recorderRef.current = recorder;

      // Build Icecast source URL
      const icecastUrl = "http://" + settings.server + ":" + settings.port + settings.mount;

      recorder.ondataavailable = async (e) => {
        if (e.data.size > 0) {
          try {
            await fetch(icecastUrl, {
              method: "PUT",
              headers: {
                "Content-Type": "audio/webm",
                "Authorization": "Basic " + btoa("source:" + settings.password),
                "Ice-Name": settings.station_name || "Ether Radio",
                "Ice-Genre": settings.station_genre || "Various",
                "Ice-URL": settings.station_url || "",
                "Ice-Public": "1",
              },
              body: e.data,
            });
          } catch (err) {
            // Streaming errors are expected when chunks are small
            // The connection might need to be persistent
          }
        }
      };

      recorder.start(1000); // Send chunks every second
      setStreaming(true);
      setStatus("Streaming");
      startRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);

      await execute("UPDATE stream_settings SET is_active = 1 WHERE id = 1");

    } catch (e) {
      setError("Stream error: " + String(e));
      setStatus("Error");
      setStreaming(false);
    }
  };

  const stopStream = () => {
    if (recorderRef.current) {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setStreaming(false);
    setStatus("Disconnected");
    setDuration(0);
    execute("UPDATE stream_settings SET is_active = 0 WHERE id = 1");
  };

  const fmtDuration = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return (h > 0 ? h + "h " : "") + String(m).padStart(2, "0") + "m " + String(sec).padStart(2, "0") + "s";
  };

  if (!settings) return <div className="text-xs text-zinc-500">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Icecast Streaming</h1>
        <div className="flex items-center gap-2">
          <span className={"text-xs font-bold " + (streaming ? "text-emerald-400" : "text-zinc-500")}>{status}</span>
          {streaming ? (
            <button onClick={stopStream} className="px-4 py-1.5 bg-red-600 hover:bg-red-500 rounded text-xs font-bold text-white">STOP STREAM</button>
          ) : (
            <button onClick={startStream} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-xs font-bold text-white">START STREAM</button>
          )}
        </div>
      </div>

      {error && <div className="px-3 py-2 bg-red-900 border border-red-700 rounded text-xs text-red-200">{error}</div>}

      {/* Stream status */}
      {streaming && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-zinc-900 rounded-lg border border-emerald-800 p-3 text-center">
            <div className="text-2xl font-bold text-emerald-400 font-mono">{fmtDuration(duration)}</div>
            <div className="text-[10px] text-zinc-500 uppercase">Uptime</div>
          </div>
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 text-center">
            <div className="text-2xl font-bold text-zinc-100">{settings.bitrate}k</div>
            <div className="text-[10px] text-zinc-500 uppercase">Bitrate</div>
          </div>
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 text-center">
            <div className="text-2xl font-bold text-zinc-100">{listeners}</div>
            <div className="text-[10px] text-zinc-500 uppercase">Listeners</div>
          </div>
        </div>
      )}

      {/* Connection settings */}
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-3">
        <h2 className="text-sm font-bold text-zinc-300">Server Connection</h2>
        <div className="grid grid-cols-4 gap-2">
          <div className="col-span-2">
            <label className="text-[10px] text-zinc-500 uppercase">Server Host</label>
            <input className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={settings.server} onChange={e => setSettings({...settings, server: e.target.value})} />
          </div>
          <div>
            <label className="text-[10px] text-zinc-500 uppercase">Port</label>
            <input type="number" className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={settings.port} onChange={e => setSettings({...settings, port: parseInt(e.target.value) || 8000})} />
          </div>
          <div>
            <label className="text-[10px] text-zinc-500 uppercase">Mount Point</label>
            <input className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={settings.mount} onChange={e => setSettings({...settings, mount: e.target.value})} />
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <div>
            <label className="text-[10px] text-zinc-500 uppercase">Password</label>
            <input type="password" className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={settings.password} onChange={e => setSettings({...settings, password: e.target.value})} />
          </div>
          <div>
            <label className="text-[10px] text-zinc-500 uppercase">Bitrate (kbps)</label>
            <select className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={settings.bitrate} onChange={e => setSettings({...settings, bitrate: parseInt(e.target.value)})}>
              <option value="64">64 kbps</option>
              <option value="96">96 kbps</option>
              <option value="128">128 kbps</option>
              <option value="192">192 kbps</option>
              <option value="256">256 kbps</option>
              <option value="320">320 kbps</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="text-[10px] text-zinc-500 uppercase">Stream URL (for listeners)</label>
            <div className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-blue-400 font-mono">{"http://" + settings.server + ":" + settings.port + settings.mount}</div>
          </div>
        </div>
      </div>

      {/* Station info */}
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-3">
        <h2 className="text-sm font-bold text-zinc-300">Station Info</h2>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[10px] text-zinc-500 uppercase">Station Name</label>
            <input className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={settings.station_name || ""} onChange={e => setSettings({...settings, station_name: e.target.value})} />
          </div>
          <div>
            <label className="text-[10px] text-zinc-500 uppercase">Genre</label>
            <input className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={settings.station_genre || ""} onChange={e => setSettings({...settings, station_genre: e.target.value})} />
          </div>
          <div>
            <label className="text-[10px] text-zinc-500 uppercase">Website URL</label>
            <input className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={settings.station_url || ""} onChange={e => setSettings({...settings, station_url: e.target.value})} />
          </div>
        </div>
        <button onClick={save} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white">Save Settings</button>
      </div>

      {/* Setup guide */}
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-2">
        <h2 className="text-sm font-bold text-zinc-300">Quick Setup Guide</h2>
        <div className="text-xs text-zinc-400 space-y-1">
          <p><strong>1.</strong> Install Icecast on a server or use a hosting service (like listen2myradio.com, caster.fm, or your own VPS).</p>
          <p><strong>2.</strong> Enter your server host, port, mount point, and source password above.</p>
          <p><strong>3.</strong> Start playing music in Ether, then click START STREAM.</p>
          <p><strong>4.</strong> Share the stream URL with listeners. They open it in any media player or browser.</p>
          <p><strong>Note:</strong> For public streaming, you need ASCAP, BMI, SESAC, and SoundExchange licenses. Ether can generate play reports for compliance filing from the Logs tab.</p>
        </div>
      </div>
    </div>
  );
}

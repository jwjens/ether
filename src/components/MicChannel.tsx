import { useState, useRef, useEffect } from "react";
import ConsoleStrip from "./ConsoleStrip";

// Self-contained mic channel — one per mic-assigned deck slot, fully independent.
// Each owns its own input device (saved per slot), its own capture + meter, and its
// own output gate (gain = on ? volume : 0). Up to 6 of these can run at once, each on
// a different physical input. Browser DSP (AEC/AGC/NS) is OFF — see fix(mic).

export default function MicChannel({ slot, label }: { slot: string; label: string }) {
  const deviceKey = `ether_mic_device_${slot}`;
  const [deviceId, setDeviceId] = useState<string>(() => { try { return localStorage.getItem(deviceKey) || ""; } catch { return ""; } });
  const [isOn, setIsOn]       = useState(false);
  const [volume, setVolume]   = useState(1);
  const [level, setLevel]     = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [pfl, setPfl]         = useState(false);   // pre-fade listen → cue output

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef    = useRef<AudioContext | null>(null);
  const gainRef   = useRef<GainNode | null>(null);
  const cueCtxRef = useRef<AudioContext | null>(null);
  const rafRef    = useRef(0);
  const isOnRef   = useRef(isOn);   const volRef = useRef(volume);
  useEffect(() => { isOnRef.current = isOn; }, [isOn]);
  useEffect(() => { volRef.current = volume; }, [volume]);

  // Enumerate input devices (labels available once any capture has been granted).
  useEffect(() => {
    const load = () => navigator.mediaDevices.enumerateDevices().then(ds => setDevices(ds.filter(d => d.kind === "audioinput"))).catch(() => {});
    load();
    navigator.mediaDevices.addEventListener?.("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", load);
  }, []);

  // Capture the selected device — independent stream + AudioContext per slot.
  useEffect(() => {
    if (!deviceId) { setLevel(0); return; }
    let cancelled = false;
    navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    }).then(stream => {
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
      streamRef.current = stream;
      const ctx = new AudioContext(); ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
      const gain = ctx.createGain(); gainRef.current = gain;
      gain.gain.value = isOnRef.current ? volRef.current : 0;
      src.connect(analyser);          // pre-fader meter — always shows the mic
      src.connect(gain);
      gain.connect(ctx.destination);  // mic → output; gain gates on/off + volume
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((s, v) => s + v, 0) / data.length / 255;
        setLevel(Math.min(1, avg * 3));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }).catch(e => console.error(`[MicChannel ${slot}] capture failed:`, e));
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null;
      ctxRef.current?.close().catch(() => {}); ctxRef.current = null; gainRef.current = null;
      setLevel(0);
    };
  }, [deviceId, slot]);

  // On/off + fader → output gain.
  useEffect(() => { if (gainRef.current) gainRef.current.gain.value = isOn ? volume : 0; }, [isOn, volume]);

  // PFL (pre-fade listen) → route the raw mic stream to the CUE output device, in a
  // separate AudioContext (setSinkId to the cue headphones), independent of on/off + fader.
  useEffect(() => {
    if (!pfl || !streamRef.current) {
      cueCtxRef.current?.close().catch(() => {}); cueCtxRef.current = null;
      return;
    }
    let cancelled = false;
    let cueDevice = ""; try { cueDevice = localStorage.getItem("ether_cue_device") || ""; } catch { /* ignore */ }
    const ctx = new AudioContext(); cueCtxRef.current = ctx;
    (async () => {
      try { if (cueDevice && (ctx as any).setSinkId) await (ctx as any).setSinkId(cueDevice); }
      catch (e) { console.warn(`[MicChannel ${slot}] cue setSinkId failed:`, e); }
      if (cancelled || !streamRef.current) return;
      ctx.createMediaStreamSource(streamRef.current).connect(ctx.destination);
    })();
    return () => { cancelled = true; ctx.close().catch(() => {}); cueCtxRef.current = null; };
  }, [pfl, deviceId, slot]);

  const pickDevice = (id: string) => { setDeviceId(id); setShowPicker(false); try { localStorage.setItem(deviceKey, id); } catch { /* ignore */ } };
  const deviceLabel = devices.find(d => d.deviceId === deviceId)?.label || (deviceId ? "Mic input" : "Pick input ▾");

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      {/* Per-slot device picker */}
      <div style={{ position: "relative", padding: "4px 4px 0", flexShrink: 0 }}>
        <button onClick={() => setShowPicker(s => !s)} title="Choose this mic's input device"
          style={{ width: "100%", height: 22, fontSize: 9, fontWeight: 700, padding: "0 6px", borderRadius: 0,
            background: "var(--bg-tertiary)", border: `1px solid ${deviceId ? "var(--border-primary)" : "#fb923c"}`,
            color: deviceId ? "var(--text-secondary)" : "#fb923c", cursor: "pointer",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          🎙 {deviceLabel}
        </button>
        {showPicker && (
          <div style={{ position: "absolute", top: 24, left: 4, right: 4, zIndex: 50, background: "var(--bg-secondary)",
            border: "1px solid var(--border-primary)", maxHeight: 220, overflowY: "auto", boxShadow: "0 6px 18px rgba(0,0,0,0.5)" }}>
            {devices.length === 0 ? <div style={{ padding: 8, fontSize: 10, color: "var(--text-tertiary)" }}>No inputs found</div> :
              devices.map(d => (
                <button key={d.deviceId} onClick={() => pickDevice(d.deviceId)}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 9px", fontSize: 10,
                    background: d.deviceId === deviceId ? "rgba(239,68,68,0.15)" : "transparent", border: "none",
                    color: d.deviceId === deviceId ? "#ef4444" : "var(--text-secondary)", cursor: "pointer",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.label || d.deviceId.slice(0, 20)}
                </button>
              ))}
          </div>
        )}
      </div>
      <div style={{ flex: 1, display: "flex", minWidth: 0 }}>
        <ConsoleStrip
          label={label}
          color="#ef4444"
          volume={volume}
          level={isOn ? level : level * 0.35}
          isPlaying={isOn && level > 0.02}
          isOn={isOn}
          onVolumeChange={setVolume}
          onToggleOn={() => setIsOn(v => !v)}
          onPfl={() => setPfl(p => !p)}
        />
      </div>
    </div>
  );
}

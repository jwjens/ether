import React from "react";
import { engine } from "../audio/engine-rodio";
import VUMeter from "./VUMeter";

export interface MixerChannelStripProps {
  label: string;
  color: string;
  deck: any;
  deckSlot?: string;
  isMic: boolean;
  deviceId: string;
  setDeviceId: (id: string) => void;
  audioDevices: MediaDeviceInfo[];
  guestStatus?: "waiting" | "connecting" | "connected" | "dropped";
  isLast: boolean;
  vertical?: boolean;
}

export default function MixerChannelStrip({
  label, color, deck, deckSlot, isMic, deviceId, setDeviceId,
  audioDevices, guestStatus, isLast, vertical,
}: MixerChannelStripProps) {
  const [level, setLevel] = React.useState(0);
  const [levelR, setLevelR] = React.useState(0);
  const [peakHold, setPeakHold] = React.useState(0);
  const [peakHoldR, setPeakHoldR] = React.useState(0);
  const [muted, setMuted] = React.useState(false);
  const [fader, setFader] = React.useState(100);
  const animRef = React.useRef<number>(0);
  const micAnimRef = React.useRef<number>(0);
  const streamRef = React.useRef<MediaStream | null>(null);
  const gainNodeRef = React.useRef<GainNode | null>(null);
  const [showPicker, setShowPicker] = React.useState(false);
  const [pickerRect, setPickerRect] = React.useState<DOMRect | null>(null);
  const pickerBtnRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!isMic) return;
    if (!deviceId) return;
    let cancelled = false;
    const audioConstraint: any = { deviceId: { exact: deviceId } };
    navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false }).then(stream => {
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
      streamRef.current = stream;
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const gainNode = ctx.createGain();
      gainNode.gain.value = fader / 100;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(gainNode);
      gainNode.connect(analyser);
      analyser.connect(ctx.destination);
      gainNodeRef.current = gainNode;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((s, v) => s + v, 0) / data.length / 255;
        const v = Math.min(1, avg * 3);
        setLevel(v);
        setPeakHold(p => Math.max(p * 0.992, v));
        micAnimRef.current = requestAnimationFrame(tick);
      };
      micAnimRef.current = requestAnimationFrame(tick);
    }).catch(() => {
      const tick = () => {
        const v = Math.random() * 0.06;
        setLevel(v);
        micAnimRef.current = requestAnimationFrame(tick);
      };
      micAnimRef.current = requestAnimationFrame(tick);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(micAnimRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      gainNodeRef.current = null;
    };
  }, [isMic, deviceId]);

  React.useEffect(() => {
    if (!isMic) return;
    const update = () => {
      if (gainNodeRef.current) {
        const master = (window as any).__etherMasterVol ?? 1;
        gainNodeRef.current.gain.value = (fader / 100) * master;
      }
    };
    update();
    const interval = setInterval(update, 100);
    return () => clearInterval(interval);
  }, [isMic, fader]);

  React.useEffect(() => {
    if (isMic) return;
    if (deck?.status === "playing") {
      let smoothedL = 0, smoothedR = 0;
      let targetL = 0.4, targetR = 0.38;
      let targetTimer = 0;
      const tick = () => {
        targetTimer++;
        if (targetTimer % 12 === 0) {
          targetL = 0.25 + Math.random() * 0.6;
          targetR = 0.25 + Math.random() * 0.6;
        }
        smoothedL += (targetL - smoothedL) * 0.15;
        smoothedR += (targetR - smoothedR) * 0.15;
        const vL = Math.min(1, Math.max(0, smoothedL + Math.sin(Date.now() / 80) * 0.04));
        const vR = Math.min(1, Math.max(0, smoothedR + Math.sin(Date.now() / 95 + 1) * 0.04));
        setLevel(vL);
        setLevelR(vR);
        setPeakHold(p => Math.max(p * 0.994, vL));
        setPeakHoldR(p => Math.max(p * 0.994, vR));
        animRef.current = requestAnimationFrame(tick);
      };
      animRef.current = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(animRef.current);
    } else {
      let decaying = true;
      const decay = () => {
        setLevel(l => { const n = l * 0.82; if (n < 0.002) return 0; decaying && requestAnimationFrame(decay); return n; });
        setLevelR(l => l * 0.82);
        setPeakHold(p => p * 0.93);
        setPeakHoldR(p => p * 0.93);
      };
      requestAnimationFrame(decay);
      return () => { decaying = false; };
    }
  }, [deck?.status, isMic]);

  const openPicker = () => {
    if (pickerBtnRef.current) setPickerRect(pickerBtnRef.current.getBoundingClientRect());
    setShowPicker(p => !p);
  };

  const isActive = isMic ? level > 0.05 : deck?.status === "playing";
  const displayName = isMic ? "Host" : (deck?.title ? deck.title.replace(/\s*[-–]\s*([\d]{4}\s*)?remaster.*/gi, '').trim() : "No source");
  const displaySub = isMic
    ? (audioDevices.find(d => d.deviceId === deviceId)?.label || "Default Microphone")
    : (deck?.artist || (guestStatus === "waiting" ? "Waiting for guest..." : "No guest"));
  const dbVal = level > 0.001 ? Math.round(20 * Math.log10(level)) : null;
  const NUM_SEGS = 20;

  const statusColor = guestStatus === "connected" ? "var(--accent-green)"
    : guestStatus === "connecting" ? "var(--accent-amber)"
    : guestStatus === "dropped" ? "var(--accent-red)"
    : isActive ? color : "var(--text-tertiary)";

  if (vertical) {
    const remaining = deck?.remaining ?? 0;
    const duration  = deck?.duration ?? 0;
    const timeStr   = remaining > 0
      ? `-${Math.floor(remaining/60)}:${String(Math.floor(remaining%60)).padStart(2,'0')}`
      : '0:00';
    const pct = duration > 0 ? Math.max(0, Math.min(1, (duration - remaining) / duration)) : 0;

    const VUBar = ({ lv, pk, mono }: { lv: number; pk: number; mono?: boolean }) => (
      <div style={{ flex: mono ? 2 : 1, position: 'relative', borderRadius: 0, overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          height: `${Math.min(100, lv * 100)}%`,
          background: lv > 0.85 ? '#ef4444' : lv > 0.65 ? '#fbbf24' : color,
          borderRadius: 0,
          transition: 'height 0.06s ease-out',
        }} />
        {pk > 0.05 && (
          <div style={{
            position: 'absolute', left: 0, right: 0,
            bottom: `${Math.min(98, pk * 100)}%`,
            height: 2,
            background: pk > 0.85 ? '#ef4444' : pk > 0.65 ? '#fbbf24' : color,
          }} />
        )}
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} style={{
            position: 'absolute', left: 0, right: 0,
            bottom: `${(i+1) * 10}%`, height: 1,
            background: 'var(--bg-secondary)', opacity: 0.5,
          }} />
        ))}
      </div>
    );

    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        background: isActive ? `${color}12` : 'var(--bg-secondary)',
        border: `1px solid ${isActive ? color+'80' : 'var(--border-primary)'}`,
        boxShadow: isActive ? `0 0 0 1px ${color}30, inset 0 0 12px ${color}08` : 'none',
        borderRadius: 0, overflow: 'hidden',
        transition: 'border-color 0.2s, background 0.2s',
      }}>
        <div style={{ padding: '4px 6px 3px', flexShrink: 0, borderBottom: '1px solid var(--border-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.1em', color: isActive ? color : 'var(--text-tertiary)', textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
          {isActive && <div style={{ fontSize: 7, fontWeight: 800, color: '#fff', background: color, padding: '1px 5px', borderRadius: 0, flexShrink: 0, animation: 'mic-blink 2s ease-in-out infinite', letterSpacing: '0.05em' }}>ON AIR</div>}
        </div>
        {!isMic && (
          <div style={{ padding: '3px 6px', flexShrink: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
            {deck?.artist && <div style={{ fontSize: 7, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{deck.artist}</div>}
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <VUMeter
            deckId={isMic ? "mic" : (deckSlot || "A")}
            isPlaying={isActive}
            hasTrack={isActive}
            externalLevel={isMic ? (muted ? 0 : level) : undefined}
          />
        </div>
        {!isMic && deck && (
          <div style={{ textAlign: 'center', fontSize: 13, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontWeight: 700, color: remaining < 10 && remaining > 0 ? '#ef4444' : 'var(--text-tertiary)', flexShrink: 0, padding: '1px 0' }}>
            {isActive ? timeStr : '—'}
          </div>
        )}
        {!isMic && (
          <div style={{ height: 2, background: 'var(--bg-tertiary)', flexShrink: 0, margin: '0 6px' }}>
            <div style={{ height: '100%', width: `${pct*100}%`, background: 'var(--accent-cyan)', borderRadius: 0, transition: 'width 0.5s linear' }} />
          </div>
        )}
        <div style={{ textAlign: 'center', fontSize: 12, fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: dbVal !== null && dbVal > -3 ? '#ef4444' : 'var(--text-tertiary)', flexShrink: 0, padding: '1px 0' }}>
          {dbVal !== null ? `${dbVal}dB` : '—'}
        </div>
        <div style={{ padding: '1px 6px 3px', flexShrink: 0 }}>
          <input type="range" min={0} max={100} value={fader}
            onChange={e => {
              const v = Number(e.target.value);
              setFader(v);
              const master = (window as any).__etherMasterVol ?? 1;
              if (isMic) {
                if (gainNodeRef.current) gainNodeRef.current.gain.value = (v / 100) * master;
              } else if (deckSlot) {
                engine.getDeck(deckSlot)?.setVolume((v / 100) * master);
              }
            }}
            style={{ width: '100%', accentColor: color, cursor: 'pointer', height: 10 }}
          />
        </div>
        <div style={{ padding: '2px 4px 5px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {!isMic ? (
            <div style={{ display: 'flex', gap: 3 }}>
              <button
                onClick={() => deck?.status === 'playing' ? engine.getDeck(deckSlot!)?.pause() : engine.getDeck(deckSlot!)?.play()}
                style={{ flex: 1, padding: '5px 0', borderRadius: 0, border: 'none', background: deck?.status === 'playing' ? color : 'var(--bg-tertiary)', color: deck?.status === 'playing' ? '#000' : 'var(--text-secondary)', fontSize: 13, fontWeight: 800, cursor: 'pointer', transition: 'all 0.15s' }}>
                {deck?.status === 'playing' ? '❚❚' : '▶'}
              </button>
              <button onClick={() => engine.getDeck(deckSlot!)?.stop()}
                style={{ width: 24, padding: '5px 0', borderRadius: 0, border: 'none', background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', fontSize: 13, cursor: 'pointer' }}>■</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 3 }}>
              <button onClick={() => setMuted(m => !m)} style={{
                flex: 1, padding: '5px 0', borderRadius: 0, border: 'none',
                background: muted ? '#ef444430' : 'var(--bg-tertiary)',
                color: muted ? '#ef4444' : 'var(--text-tertiary)',
                fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', cursor: 'pointer',
                outline: muted ? '1px solid #ef444450' : 'none',
              }}>
                {muted ? 'MUTED' : 'MUTE'}
              </button>
              <div style={{
                width: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 0, background: isActive && !muted ? `${color}20` : 'var(--bg-tertiary)',
              }}>
                <div style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: isActive && !muted ? color : 'var(--text-tertiary)',
                  boxShadow: isActive && !muted ? `0 0 6px ${color}` : 'none',
                  animation: isActive && !muted ? 'mic-blink 1.5s ease-in-out infinite' : 'none',
                }} />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      borderBottom: isLast ? "none" : "1px solid var(--border-primary)",
      padding: "12px 14px",
      background: isActive ? `${color}06` : "transparent",
      transition: "background 0.3s",
      position: "relative" as const,
    }}>
      <div style={{
        position: "absolute" as const, left: 0, top: 0, bottom: 0, width: 3,
        background: isActive ? color : "transparent",
        boxShadow: isActive ? `2px 0 8px ${color}60` : "none",
        transition: "all 0.3s",
      }} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: isActive ? color : "var(--text-secondary)", letterSpacing: "0.06em", textTransform: "uppercase" as const }}>{label}</span>
          {guestStatus && (
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor, boxShadow: guestStatus === "connected" ? `0 0 5px ${statusColor}` : "none", animation: guestStatus === "connecting" ? "mic-blink 0.8s ease-in-out infinite" : "none" }} />
          )}
          {isActive && !guestStatus && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 7px", borderRadius: 0, background: `${color}15`, border: `1px solid ${color}25` }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: color, animation: "mic-blink 1.5s ease-in-out infinite" }} />
              <span style={{ fontSize: 12, fontWeight: 800, color, letterSpacing: "0.08em" }}>LIVE</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontWeight: 500, color: dbVal !== null && dbVal > -3 ? "#ef4444" : "var(--text-tertiary)", minWidth: 36, textAlign: "right" as const }}>
            {dbVal !== null ? `${dbVal}dB` : "—"}
          </span>
          <button onClick={() => setMuted(m => !m)} style={{ padding: "2px 8px", borderRadius: 0, background: muted ? `${color}20` : "var(--bg-tertiary)", border: `1px solid ${muted ? color + "40" : "var(--border-primary)"}`, color: muted ? color : "var(--text-tertiary)", fontSize: 13, fontWeight: 800, cursor: "pointer", letterSpacing: "0.06em" }}>
            {muted ? "MUTED" : "MUTE"}
          </button>
        </div>
      </div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, marginBottom: 2 }}>{displayName}</div>
        <button ref={pickerBtnRef} onClick={openPicker} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 0, cursor: "pointer", width: "100%" }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, opacity: 0.7 }}>
            <path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7"/>
          </svg>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1, textAlign: "left" as const }}>{displaySub}</span>
          {(isMic || audioDevices.length > 0) && <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>}
        </button>
      </div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", gap: 1.5, height: 14, alignItems: "flex-end" }}>
          {Array.from({ length: NUM_SEGS }).map((_, i) => {
            const threshold = i / NUM_SEGS;
            const lit = !muted && level > threshold;
            const isPeak = peakHold > 0.05 && Math.abs(peakHold - threshold) < 1.5 / NUM_SEGS;
            const segColor = i >= NUM_SEGS - 2 ? "#ef4444" : i >= NUM_SEGS - 5 ? "#fbbf24" : color;
            const segHeight = i < 8 ? 8 : i < 14 ? 10 : 14;
            return (
              <div key={i} style={{
                flex: 1,
                height: segHeight,
                borderRadius: 0,
                background: lit ? segColor : isPeak ? segColor + "90" : "var(--bg-tertiary)",
                opacity: lit ? 1 : isPeak ? 0.8 : 0.25,
                boxShadow: lit && i >= NUM_SEGS - 2 ? `0 0 4px ${segColor}` : "none",
                transition: "opacity 0.04s, background 0.04s",
                alignSelf: "flex-end",
              }} />
            );
          })}
        </div>
      </div>
      <input
        type="range" min={0} max={100} value={fader}
        onChange={e => {
          const v = Number(e.target.value);
          setFader(v);
          const master = (window as any).__etherMasterVol ?? 1;
          if (isMic) {
            if (gainNodeRef.current) gainNodeRef.current.gain.value = (v / 100) * master;
          } else if (deckSlot) {
            engine.getDeck(deckSlot)?.setVolume((v / 100) * master);
          }
        }}
        style={{ width: "100%", accentColor: color, cursor: "pointer", height: 3, display: "block" }}
      />
      {showPicker && audioDevices.length > 0 && pickerRect && (
        <>
          <div onClick={() => setShowPicker(false)} style={{ position: "fixed" as const, inset: 0, zIndex: 9000 }} />
          <div style={{
            position: "fixed" as const,
            bottom: window.innerHeight - pickerRect.top + 6,
            left: Math.max(8, pickerRect.left - 10),
            zIndex: 9001,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-secondary)",
            borderRadius: 0, padding: "8px 6px",
            boxShadow: "0 -4px 32px rgba(0,0,0,0.4)",
            minWidth: 260, maxWidth: 340,
          }}>
            <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.14em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, padding: "2px 10px 8px" }}>
              Audio Input — {label}
            </div>
            {audioDevices.map((dev, i) => {
              const name = dev.label || `Microphone ${i + 1}`;
              const active = dev.deviceId === deviceId || (!deviceId && dev.deviceId === "default");
              return (
                <button key={dev.deviceId} onClick={() => { setDeviceId(dev.deviceId); setShowPicker(false); }} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  width: "100%", textAlign: "left" as const,
                  padding: "8px 10px", borderRadius: 0, border: "none", cursor: "pointer",
                  background: active ? `${color}18` : "none",
                  color: active ? color : "var(--text-primary)",
                  fontSize: 12, fontWeight: active ? 700 : 400,
                  transition: "background 0.1s",
                }}
                  onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
                  onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "none"; }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, opacity: 0.5 }}>
                    <path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                    <path d="M19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7"/>
                  </svg>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{name}</span>
                  {active && <span style={{ flexShrink: 0 }}>✓</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

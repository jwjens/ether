import React, { useState, useEffect, useRef, useCallback } from "react";
import { query as dbQuery, execute as dbExec } from "../db/client";

const BG0  = "#0d0d0f";
const BG1  = "#111114";
const BG2  = "#16161a";
const BG3  = "#1e1e24";
const BOR  = "#2a2a35";
const TXT  = "#e8e8f0";
const TXT2 = "#6060a0";
const TEAL = "#00c8a8";
const RED  = "#ef4444";

type FormatId = "landscape" | "vertical" | "square";
interface Format      { id: FormatId; label: string; sublabel: string; w: number; h: number; }
interface Device      { label: string; w: number; h: number; }
interface DeviceGroup { label: string; devices: Device[]; }

const FORMATS: Format[] = [
  { id: "landscape", label: "16:9 Landscape", sublabel: "Broadcast / YouTube / Twitch", w: 1920, h: 1080 },
  { id: "vertical",  label: "9:16 Vertical",  sublabel: "TikTok / Reels / Shorts",      w: 1080, h: 1920 },
  { id: "square",    label: "1:1 Square",      sublabel: "Instagram / Facebook",         w: 1080, h: 1080 },
];

const DEVICE_GROUPS: DeviceGroup[] = [
  {
    label: "Mobile — Vertical",
    devices: [
      { label: "iPhone 17 Pro Max",        w: 1320, h: 2868 },
      { label: "iPhone 17 Pro",            w: 1206, h: 2622 },
      { label: "iPhone 17 Air",            w: 1179, h: 2556 },
      { label: "iPhone 17",                w: 1179, h: 2556 },
      { label: "iPhone 16 Pro Max",        w: 1320, h: 2868 },
      { label: "iPhone 16 Pro",            w: 1206, h: 2622 },
      { label: "iPhone 16 Plus",           w: 1290, h: 2796 },
      { label: "iPhone 16",                w: 1179, h: 2556 },
      { label: "iPhone 15 Pro Max",        w: 1290, h: 2796 },
      { label: "iPhone 15 / 14",           w: 1170, h: 2532 },
      { label: "iPhone SE",                w: 750,  h: 1334 },
      { label: "Samsung Galaxy S24 Ultra", w: 1440, h: 3088 },
      { label: "Samsung Galaxy S24",       w: 1080, h: 2340 },
      { label: "Google Pixel 8 Pro",       w: 1344, h: 2992 },
      { label: "Google Pixel 8",           w: 1080, h: 2400 },
      { label: "OnePlus 12",               w: 1440, h: 3168 },
    ],
  },
  {
    label: "Tablets — Landscape & Portrait",
    devices: [
      { label: 'iPad Pro 12.9"',              w: 2048, h: 2732 },
      { label: 'iPad Pro 11"',                w: 1668, h: 2388 },
      { label: "iPad Air",                    w: 1640, h: 2360 },
      { label: "iPad Mini",                   w: 1488, h: 2266 },
      { label: "Samsung Galaxy Tab S9 Ultra", w: 1848, h: 2960 },
      { label: "Samsung Galaxy Tab S9",       w: 1080, h: 2340 },
    ],
  },
  {
    label: "Social Media Optimized",
    devices: [
      { label: "TikTok",           w: 1080, h: 1920 },
      { label: "Instagram Reels",  w: 1080, h: 1920 },
      { label: "YouTube Shorts",   w: 1080, h: 1920 },
      { label: "Instagram Post",   w: 1080, h: 1080 },
      { label: "Instagram Story",  w: 1080, h: 1920 },
      { label: "Twitter/X Video",  w: 1280, h: 720  },
      { label: "Facebook Video",   w: 1280, h: 720  },
      { label: "LinkedIn Video",   w: 1920, h: 1080 },
    ],
  },
];

function getFormatId(w: number, h: number): FormatId {
  const ar = w / h;
  if (ar > 1.2) return "landscape";
  if (ar < 0.85) return "vertical";
  return "square";
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function AspectThumb({ w, h, size = 18, active = false }: { w: number; h: number; size?: number; active?: boolean }) {
  const ar = w / h;
  let tw: number, th: number;
  if (ar >= 1) { tw = size; th = Math.max(Math.round(size / ar), 3); }
  else         { th = size; tw = Math.max(Math.round(size * ar), 3); }
  return (
    <div style={{
      width: tw, height: th, flexShrink: 0,
      border: `1px solid ${active ? TEAL : "#404060"}`,
      background: active ? "rgba(0,200,168,0.15)" : "rgba(255,255,255,0.04)",
    }} />
  );
}

function FormatCard({ fmt, selected, disabled, onSelect }: {
  fmt: Format; selected: boolean; disabled: boolean; onSelect: () => void;
}) {
  const ar = fmt.w / fmt.h;
  let pw: number, ph: number;
  if (ar >= 1) { pw = 56; ph = Math.round(56 / ar); }
  else         { ph = 48; pw = Math.round(48 * ar); }
  return (
    <div
      onClick={disabled ? undefined : onSelect}
      style={{
        padding: "8px 10px",
        background: selected ? "rgba(0,200,168,0.07)" : BG2,
        border: `1.5px solid ${selected ? TEAL : BOR}`,
        cursor: disabled ? "not-allowed" : "pointer",
        display: "flex", alignItems: "center", gap: 10,
        boxShadow: selected ? "0 0 10px rgba(0,200,168,0.18)" : "none",
        opacity: disabled ? 0.5 : 1,
        transition: "border-color 0.1s, box-shadow 0.1s",
      }}
    >
      <div style={{ width: 56, height: 48, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <div style={{ width: pw, height: ph, border: `2px solid ${selected ? TEAL : "#303048"}`, background: selected ? "rgba(0,200,168,0.1)" : BG0 }} />
      </div>
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: selected ? TEAL : TXT, letterSpacing: "0.03em" }}>{fmt.label}</div>
        <div style={{ fontSize: 10, color: TXT2, marginTop: 2 }}>{fmt.sublabel}</div>
        <div style={{ fontSize: 9, color: "#404060", marginTop: 2, fontFamily: "ui-monospace, monospace" }}>{fmt.w}×{fmt.h}</div>
      </div>
    </div>
  );
}

function DeviceRow({ dev, selected, disabled, onSelect }: {
  dev: Device; selected: boolean; disabled: boolean; onSelect: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={disabled ? undefined : onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: "5px 12px",
        display: "flex", alignItems: "center", gap: 9,
        background: selected ? "rgba(0,200,168,0.07)" : hover && !disabled ? BG3 : "transparent",
        borderLeft: `2px solid ${selected ? TEAL : "transparent"}`,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 0.08s",
      }}
    >
      <AspectThumb w={dev.w} h={dev.h} size={18} active={selected} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: selected ? TEAL : TXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
          {dev.label}
        </div>
        <div style={{ fontSize: 9, color: TXT2, fontFamily: "ui-monospace, monospace" }}>{dev.w}×{dev.h}</div>
      </div>
    </div>
  );
}

export default function ClipEditor() {
  const [formatId, setFormatId]             = useState<FormatId>("landscape");
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [isRecording, setIsRecording]       = useState(false);
  const [recSeconds, setRecSeconds]         = useState(0);
  const [cameraReady, setCameraReady]       = useState(false);
  const [cameraError, setCameraError]       = useState<string | null>(null);
  const [clipUrl, setClipUrl]               = useState<string | null>(null);
  const [showPlayback, setShowPlayback]     = useState(false);
  const [saving, setSaving]                 = useState(false);

  const videoRef    = useRef<HTMLVideoElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const rafRef      = useRef<number>(0);
  const chunksRef   = useRef<Blob[]>([]);
  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const recStartRef = useRef<number>(0);
  const mimeRef     = useRef("video/webm");

  const baseFmt = FORMATS.find(f => f.id === formatId)!;
  const recW = selectedDevice?.w ?? baseFmt.w;
  const recH = selectedDevice?.h ?? baseFmt.h;

  // ── Persistence ──────────────────────────────────────────────────────────
  useEffect(() => {
    dbQuery<{ value: string }>("SELECT value FROM station_config_kv WHERE key='clipeditor_format'")
      .then(rows => {
        if (!rows[0]) return;
        try {
          const s = JSON.parse(rows[0].value);
          if (s.formatId) setFormatId(s.formatId);
          if (s.device)   setSelectedDevice(s.device);
        } catch {}
      }).catch(() => {});
  }, []);

  const persist = useCallback((fid: FormatId, dev: Device | null) => {
    dbExec("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('clipeditor_format',?)",
      [JSON.stringify({ formatId: fid, device: dev })]).catch(() => {});
  }, []);

  // ── Camera ───────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    setCameraError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: "user" },
        audio: true,
      });
      streamRef.current = s;
      if (videoRef.current) videoRef.current.srcObject = s;
      setCameraReady(true);
    } catch (e: any) {
      setCameraError(e?.message ?? "Camera access denied");
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      cancelAnimationFrame(rafRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [startCamera]);

  // Re-attach stream whenever the camera <video> remounts (e.g. after playback view)
  useEffect(() => {
    if (!showPlayback && cameraReady && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [showPlayback, cameraReady]);

  // ── Canvas draw loop ─────────────────────────────────────────────────────
  const startLoop = useCallback(() => {
    const canvas = canvasRef.current;
    const video  = videoRef.current;
    if (!canvas || !video) return;
    canvas.width  = recW;
    canvas.height = recH;
    const ctx = canvas.getContext("2d")!;
    const draw = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const srcAr = video.videoWidth / video.videoHeight;
        const dstAr = recW / recH;
        let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight;
        if (srcAr > dstAr) { sw = sh * dstAr; sx = (video.videoWidth  - sw) / 2; }
        else               { sh = sw / dstAr; sy = (video.videoHeight - sh) / 2; }
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, recW, recH);
      } else {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, recW, recH);
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    draw();
  }, [recW, recH]);

  // ── Record ────────────────────────────────────────────────────────────────
  const startRecord = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || !streamRef.current) return;
    chunksRef.current = [];
    setClipUrl(null);
    setShowPlayback(false);
    startLoop();

    const canvas      = canvasRef.current;
    const canvasStream = canvas.captureStream(30);
    const combined    = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...streamRef.current.getAudioTracks(),
    ]);

    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      .find(m => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
    mimeRef.current = mime;

    const rec = new MediaRecorder(combined, { mimeType: mime });
    rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      cancelAnimationFrame(rafRef.current);
      const blob = new Blob(chunksRef.current, { type: mimeRef.current });
      setClipUrl(URL.createObjectURL(blob));
      setShowPlayback(true);
    };
    rec.start(100);
    recorderRef.current = rec;
    recStartRef.current = Date.now();
    setIsRecording(true);
    setRecSeconds(0);
    timerRef.current = setInterval(() => {
      setRecSeconds(Math.floor((Date.now() - recStartRef.current) / 1000));
    }, 500);
  }, [startLoop]);

  const stopRecord = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setIsRecording(false);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  // ── Download (browser) ───────────────────────────────────────────────────
  const downloadClip = useCallback(() => {
    if (!clipUrl) return;
    const fmtLabel = formatId === "landscape" ? "16x9" : formatId === "vertical" ? "9x16" : "1x1";
    const devSlug  = selectedDevice?.label.replace(/[^a-z0-9]/gi, "-").toLowerCase() ?? "";
    const name     = `clip-${fmtLabel}${devSlug ? `-${devSlug}` : ""}-${Date.now()}.webm`;
    const a = document.createElement("a");
    a.href = clipUrl; a.download = name; a.click();
  }, [clipUrl, formatId, selectedDevice]);

  // ── Save to disk via Electron save dialog ────────────────────────────────
  const saveClipToDisk = useCallback(async () => {
    if (!clipUrl || saving) return;
    setSaving(true);
    try {
      const fmtLabel = formatId === "landscape" ? "16x9" : formatId === "vertical" ? "9x16" : "1x1";
      const devSlug  = selectedDevice?.label.replace(/[^a-z0-9]/gi, "-").toLowerCase() ?? "";
      const suggested = `clip-${fmtLabel}${devSlug ? `-${devSlug}` : ""}-${Date.now()}.webm`;
      const filePath = await (window as any).ether.invoke("dialog:saveFile", {
        defaultPath: suggested,
        filters: [{ name: "WebM Video", extensions: ["webm"] }],
      });
      if (!filePath) return;
      const resp = await fetch(clipUrl);
      const buf  = await resp.arrayBuffer();
      await (window as any).ether.invoke("voxpro:writeAudio", {
        data: Array.from(new Uint8Array(buf)),
        filePath,
      });
    } catch (e) {
      console.error("save clip:", e);
    } finally {
      setSaving(false);
    }
  }, [clipUrl, formatId, selectedDevice, saving]);

  const discardClip = useCallback(() => {
    if (clipUrl && clipUrl.startsWith("blob:")) URL.revokeObjectURL(clipUrl);
    setClipUrl(null);
    setShowPlayback(false);
  }, [clipUrl]);

  // ── Open existing video file ──────────────────────────────────────────────
  const openVideoFile = useCallback(async () => {
    const paths = await (window as any).ether.invoke("dialog:openFile", {
      filters: [{ name: "Video", extensions: ["webm", "mp4", "mov", "mkv", "avi", "m4v"] }],
    });
    if (!paths?.[0]) return;
    const fileUrl = "file:///" + paths[0].replace(/\\/g, "/");
    setClipUrl(fileUrl);
    setShowPlayback(true);
  }, []);

  // ── Selection ─────────────────────────────────────────────────────────────
  const selectFormat = useCallback((fid: FormatId) => {
    if (isRecording) return;
    setFormatId(fid); setSelectedDevice(null); persist(fid, null);
  }, [isRecording, persist]);

  const selectDevice = useCallback((dev: Device) => {
    if (isRecording) return;
    const fid = getFormatId(dev.w, dev.h);
    setFormatId(fid); setSelectedDevice(dev); persist(fid, dev);
  }, [isRecording, persist]);

  const displayLabel = selectedDevice
    ? `${selectedDevice.label} — ${recW}×${recH}`
    : `${baseFmt.label} — ${recW}×${recH}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", background: BG0, color: TXT, fontFamily: "Inter, system-ui, sans-serif", overflow: "hidden" }}>

      <canvas ref={canvasRef} style={{ display: "none" }} />

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div style={{ height: 46, display: "flex", alignItems: "center", gap: 10, padding: "0 14px", borderBottom: `1px solid ${BOR}`, flexShrink: 0, background: BG1 }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: TXT2 }}>CLIP EDITOR</span>
        <div style={{ width: 1, height: 18, background: BOR }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px", background: BG3, border: `1px solid ${BOR}`, fontSize: 11, color: TXT2 }}>
          <AspectThumb w={recW} h={recH} size={12} active />
          <span>{displayLabel}</span>
        </div>
        <button
          onClick={openVideoFile}
          style={{ padding: "5px 12px", background: BG3, border: `1px solid ${BOR}`, color: TXT2, fontSize: 11, cursor: "pointer" }}
        >📂 Open Video…</button>

        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 9, color: TXT2, fontFamily: "ui-monospace, monospace", letterSpacing: "0.06em" }}>{recW}×{recH}</span>

        {!isRecording ? (
          <button
            onClick={startRecord}
            disabled={!cameraReady}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "5px 16px",
              background: cameraReady ? RED : BG3, border: "none",
              color: "#fff", fontSize: 12, fontWeight: 700, letterSpacing: "0.06em",
              cursor: cameraReady ? "pointer" : "not-allowed", opacity: cameraReady ? 1 : 0.45,
            }}
          >⏺ Record</button>
        ) : (
          <button
            onClick={stopRecord}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "5px 16px",
              background: BG3, border: `1px solid ${RED}`, color: RED,
              fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", cursor: "pointer",
            }}
          >
            <span style={{ width: 8, height: 8, background: RED, display: "inline-block", animation: "clip-pulse 1s ease-in-out infinite" }} />
            ⏹ Stop — {fmtTime(recSeconds)}
          </button>
        )}

        <button
          onClick={saveClipToDisk}
          disabled={!clipUrl || saving}
          title="Save clip to disk"
          style={{
            padding: "5px 12px", background: clipUrl ? BG3 : BG3,
            border: `1px solid ${clipUrl ? TEAL : BOR}`,
            color: clipUrl ? TEAL : TXT2,
            fontSize: 11, cursor: clipUrl ? "pointer" : "not-allowed",
            opacity: clipUrl ? 1 : 0.45,
          }}
        >{saving ? "Saving…" : "📤 Save to Disk"}</button>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>

        {/* ── Left panel ─────────────────────────────────────────────── */}
        <div style={{ width: 272, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${BOR}`, background: BG1, overflow: "hidden" }}>
          <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6, borderBottom: `1px solid ${BOR}`, flexShrink: 0 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: TXT2, letterSpacing: "0.12em", marginBottom: 2 }}>FORMAT</div>
            {FORMATS.map(fmt => (
              <FormatCard
                key={fmt.id}
                fmt={fmt}
                selected={formatId === fmt.id && selectedDevice === null}
                disabled={isRecording}
                onSelect={() => selectFormat(fmt.id)}
              />
            ))}
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 0 10px" }}>
            <div style={{ padding: "8px 12px 4px", fontSize: 9, fontWeight: 700, color: TXT2, letterSpacing: "0.12em" }}>DEVICE PRESETS</div>
            {DEVICE_GROUPS.map(group => (
              <div key={group.label}>
                <div style={{ padding: "8px 12px 3px 12px", fontSize: 9, fontWeight: 700, color: "#404060", letterSpacing: "0.1em", textTransform: "uppercase" as const }}>
                  {group.label}
                </div>
                {group.devices.map(dev => {
                  const isSel = selectedDevice?.label === dev.label && selectedDevice?.w === dev.w;
                  return (
                    <DeviceRow
                      key={`${dev.label}-${dev.w}`}
                      dev={dev}
                      selected={isSel}
                      disabled={isRecording}
                      onSelect={() => selectDevice(dev)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* ── Preview / Playback ──────────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#040406", overflow: "hidden", position: "relative" as const }}>

          {isRecording && (
            <div style={{ position: "absolute", top: 12, left: 12, zIndex: 10, display: "flex", alignItems: "center", gap: 7, padding: "4px 10px", background: "rgba(239,68,68,0.92)" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff", animation: "clip-pulse 1s ease-in-out infinite" }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", letterSpacing: "0.08em" }}>REC {fmtTime(recSeconds)}</span>
            </div>
          )}

          {!showPlayback ? (
            <div style={{
              aspectRatio: `${recW} / ${recH}`,
              maxWidth: "90%", maxHeight: "90%",
              position: "relative" as const, overflow: "hidden",
              background: "#0a0a0c",
              border: `1px solid ${isRecording ? RED : BOR}`,
              boxShadow: isRecording ? "0 0 20px rgba(239,68,68,0.25)" : "none",
              flexShrink: 0,
            }}>
              {cameraError ? (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 20 }}>
                  <span style={{ fontSize: 13, color: RED }}>Camera unavailable</span>
                  <span style={{ fontSize: 11, color: TXT2, textAlign: "center" as const }}>{cameraError}</span>
                  <button onClick={startCamera} style={{ padding: "5px 16px", background: BG3, border: `1px solid ${BOR}`, color: TXT, cursor: "pointer", fontSize: 11 }}>Retry</button>
                </div>
              ) : !cameraReady ? (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ fontSize: 12, color: TXT2 }}>Starting camera…</span>
                </div>
              ) : null}
              <video
                ref={videoRef}
                autoPlay playsInline muted
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
              <div style={{ position: "absolute", bottom: 8, right: 8, padding: "2px 6px", background: "rgba(0,0,0,0.65)", fontSize: 9, fontWeight: 700, color: TXT2, fontFamily: "ui-monospace, monospace", letterSpacing: "0.08em" }}>
                {recW}×{recH}
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, width: "90%", maxWidth: 700, padding: 10 }}>
              <div style={{
                aspectRatio: `${recW} / ${recH}`,
                maxWidth: "100%", maxHeight: "65vh",
                overflow: "hidden",
                border: `1.5px solid ${TEAL}`,
                boxShadow: "0 0 16px rgba(0,200,168,0.18)",
                flexShrink: 0,
                width: recW >= recH ? "100%" : "auto",
              }}>
                <video
                  src={clipUrl ?? undefined}
                  controls
                  style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", background: "#000" }}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={downloadClip}
                  style={{ padding: "7px 20px", background: TEAL, border: "none", color: "#000", fontSize: 12, fontWeight: 700, cursor: "pointer", letterSpacing: "0.06em" }}
                >⬇ Download</button>
                <button
                  onClick={saveClipToDisk}
                  disabled={saving}
                  style={{ padding: "7px 20px", background: BG3, border: `1px solid ${TEAL}`, color: TEAL, fontSize: 12, fontWeight: 700, cursor: "pointer", letterSpacing: "0.06em", opacity: saving ? 0.6 : 1 }}
                >{saving ? "Saving…" : "📤 Save to Disk"}</button>
                <button
                  onClick={() => setShowPlayback(false)}
                  style={{ padding: "7px 14px", background: BG3, border: `1px solid ${BOR}`, color: TXT2, fontSize: 12, cursor: "pointer" }}
                >↩ Back to Camera</button>
                <button
                  onClick={discardClip}
                  style={{ padding: "7px 14px", background: BG3, border: `1px solid ${RED}`, color: RED, fontSize: 12, cursor: "pointer" }}
                >✕ Discard</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes clip-pulse { 0%,100%{opacity:1;} 50%{opacity:0.25;} }`}</style>
    </div>
  );
}

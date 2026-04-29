/**
 * PublishEpisode.tsx — One-tap Episode Publish
 *
 * Drop into: C:\openair\src\components\PublishEpisode.tsx
 *
 * Launch from App.tsx Tools menu:
 *   import PublishEpisode from "./components/PublishEpisode";
 *   {showPublish && <PublishEpisode onClose={() => setShowPublish(false)} episodeTitle={nowPlayingTitle} />}
 *
 * And add to the tools menu Item:
 *   <Item label="Publish Episode..." onClick={() => { setShowPublish(true); close(); }} />
 *
 *   - ./db/client (query, execute, queryOne)
 *
 * What it does:
 *   1. Collects episode metadata (title, desc, show name, cover art, season/ep#)
 *   2. Picks an audio file to publish (or uses currently playing)
 *   3. Generates a podcast-compliant RSS XML item and appends it to feed.xml
 *   4. Copies the audio to a /podcast-export/ subfolder
 *   5. Shows a shareable "Published" screen with the RSS feed path
 *
 * The RSS feed is written locally. For distribution, point your podcast host
 * (Buzzsprout, RSS.com, Anchor, etc.) to the feed file, or host it yourself.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);
const open = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
const save = (opts?: any) => (window as any).ether.dialog.saveFile(opts);
import { query, execute, queryOne } from "../db/client";
import { queryScoped, executeScopedInsert } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";

// ─── Types ─────────────────────────────────────────────────────────────────

interface EpisodeMeta {
  title: string;
  description: string;
  showName: string;
  showDescription: string;
  authorName: string;
  email: string;
  audioPath: string;
  coverArtPath: string;
  seasonNumber: string;
  episodeNumber: string;
  episodeType: "full" | "trailer" | "bonus";
  explicit: boolean;
  language: string;
  category: string;
  feedPath: string;
}

interface PublishedEpisode {
  id: number;
  title: string;
  published_at: string;
  audio_path: string;
  feed_path: string;
  duration_sec: number;
}

interface Props {
  onClose: () => void;
  episodeTitle?: string;
  episodeArtist?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function hhmmss(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function nowRfc822(): string {
  return new Date().toUTCString();
}

function slug(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── Step indicators ──────────────────────────────────────────────────────

const STEPS = ["Episode", "Details", "Publish", "Done"];

function StepBar({ current }: { current: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, padding: "0 32px", marginBottom: 28 }}>
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <React.Fragment key={i}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <div style={{
                width: 28, height: 28, borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontWeight: 800,
                background: done ? "var(--accent-green)" : active ? "var(--accent-cyan)" : "var(--bg-tertiary)",
                color: done || active ? "#000" : "var(--text-tertiary)",
                border: active ? "2px solid var(--accent-cyan)" : "none",
                transition: "all 0.3s",
                boxShadow: active ? "0 0 12px rgba(56,189,248,0.4)" : "none",
              }}>
                {done ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                    <path d="M1.5 6.5L4.5 9.5L10.5 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none"/>
                  </svg>
                ) : (i + 1)}
              </div>
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
                color: active ? "var(--accent-cyan)" : done ? "var(--accent-green)" : "var(--text-tertiary)",
                textTransform: "uppercase",
              }}>{label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{
                flex: 1, height: 2, marginBottom: 20,
                background: done ? "var(--accent-green)" : "var(--border-primary)",
                transition: "background 0.4s",
              }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Field component ──────────────────────────────────────────────────────

function Field({
  label, value, onChange, placeholder, multiline, hint, required,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; multiline?: boolean; hint?: string; required?: boolean;
}) {
  const baseStyle: React.CSSProperties = {
    width: "100%", padding: "10px 13px",
    background: "var(--bg-tertiary)",
    border: "1px solid var(--border-primary)",
    borderRadius: 0, color: "var(--text-primary)",
    fontSize: 13, outline: "none", resize: "none",
    fontFamily: "'Inter', system-ui, sans-serif",
    transition: "border-color 0.2s",
    boxSizing: "border-box",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" }}>
        {label}{required && <span style={{ color: "var(--accent-red)", marginLeft: 3 }}>*</span>}
      </label>
      {multiline ? (
        <textarea
          value={value} onChange={e => onChange(e.target.value)}
          placeholder={placeholder} rows={3}
          style={baseStyle}
          onFocus={e => (e.target.style.borderColor = "var(--accent-cyan)")}
          onBlur={e => (e.target.style.borderColor = "var(--border-primary)")}
        />
      ) : (
        <input
          value={value} onChange={e => onChange(e.target.value)}
          placeholder={placeholder} type="text"
          style={baseStyle}
          onFocus={e => (e.target.style.borderColor = "var(--accent-cyan)")}
          onBlur={e => (e.target.style.borderColor = "var(--border-primary)")}
        />
      )}
      {hint && <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 1 }}>{hint}</span>}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────

export default function PublishEpisode({ onClose, episodeTitle = "", episodeArtist = "" }: Props) {
  const { stationId, isReady } = useActiveStation();
  const [step, setStep] = useState(0);
  const [meta, setMeta] = useState<EpisodeMeta>({
    title: episodeTitle || "",
    description: episodeArtist ? `Featuring: ${episodeArtist}` : "",
    showName: "",
    showDescription: "",
    authorName: "",
    email: "",
    audioPath: "",
    coverArtPath: "",
    seasonNumber: "",
    episodeNumber: "",
    episodeType: "full",
    explicit: false,
    language: "en",
    category: "Music",
    feedPath: "",
  });

  const [audioDuration, setAudioDuration] = useState(0);
  const [audioFileSize, setAudioFileSize] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [publishLog, setPublishLog] = useState<string[]>([]);
  const [publishedPath, setPublishedPath] = useState("");
  const [history, setHistory] = useState<PublishedEpisode[]>([]);
  const [stationName, setStationName] = useState("");
  const [err, setErr] = useState("");

  // Load saved station info + episode history
  useEffect(() => {
    (async () => {
      try {
        const rows = await query<{ key: string; value: string }>(
          "SELECT key, value FROM station_config_kv WHERE key IN ('station_name','podcast_author','podcast_email','podcast_category','podcast_feed_path','podcast_cover_path','podcast_description')"
        );
        const kv: Record<string, string> = {};
        rows.forEach(r => { kv[r.key] = r.value; });

        setStationName(kv["station_name"] || "");
        setMeta(prev => ({
          ...prev,
          showName:        kv["station_name"] || prev.showName,
          showDescription: kv["podcast_description"] || prev.showDescription,
          authorName:      kv["podcast_author"] || prev.authorName,
          email:           kv["podcast_email"] || prev.email,
          category:        kv["podcast_category"] || prev.category,
          feedPath:        kv["podcast_feed_path"] || prev.feedPath,
          coverArtPath:    kv["podcast_cover_path"] || prev.coverArtPath,
        }));
      } catch { /* fresh station */ }

      try {
        // Create episodes table if not present
        await execute(
          `CREATE TABLE IF NOT EXISTS published_episodes (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             title TEXT NOT NULL,
             published_at TEXT NOT NULL,
             audio_path TEXT,
             feed_path TEXT,
             duration_sec REAL DEFAULT 0
           )`, []
        );
        const eps = await queryScoped<PublishedEpisode>(
          "SELECT * FROM published_episodes ORDER BY id DESC LIMIT 20",
          [], stationId
        );
        setHistory(eps);
      } catch { /* first run */ }
    })();
  }, [isReady]);

  const set = (k: keyof EpisodeMeta, v: string | boolean) =>
    setMeta(prev => ({ ...prev, [k]: v }));

  // ── Step 0: Pick audio ────────────────────────────────────────────────

  const pickAudio = async () => {
    const file = await open({
      title: "Select episode audio",
      filters: [{ name: "Audio", extensions: ["mp3", "m4a", "flac", "ogg", "wav", "aac"] }],
    });
    if (!file) return;
    const path = file as string;
    set("audioPath", path);

    // Get duration via IPC
    try {
      const dur = await invoke<number>("get_file_duration", { filePath: path });
      setAudioDuration(dur);
    } catch { setAudioDuration(0); }

    // Auto-fill title from filename if empty
    if (!meta.title) {
      const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "";
      set("title", name.replace(/[_-]/g, " ").replace(/^\d+\.\s*/, ""));
    }
  };

  const pickCoverArt = async () => {
    const file = await open({
      title: "Select cover art (JPG or PNG, min 1400x1400)",
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (file) set("coverArtPath", file as string);
  };

  const pickFeedPath = async () => {
    const file = await save({
      title: "Save RSS feed as...",
      defaultPath: "feed.xml",
      filters: [{ name: "RSS Feed", extensions: ["xml"] }],
    });
    if (file) set("feedPath", file as string);
  };

  // ── Validation ──────────────────────────────────────────────────────

  const canAdvance = (): boolean => {
    if (step === 0) return !!meta.audioPath && !!meta.title;
    if (step === 1) return !!meta.showName && !!meta.feedPath;
    return true;
  };

  // ── RSS Generation + Publish ─────────────────────────────────────────

  const doPublish = useCallback(async () => {
    setPublishing(true);
    setPublishLog([]);
    const log = (msg: string) => setPublishLog(prev => [...prev, msg]);

    try {
      // 1. Validate audio exists
      log("📂 Validating audio file...");
      const audioExists = await invoke<boolean>("plugin:fs|exists", { path: meta.audioPath }).catch(() => true);

      // 2. Copy audio to export folder alongside feed
      const feedDir = meta.feedPath.replace(/[\\/][^\\/]+$/, "");
      const audioExt = meta.audioPath.split(".").pop() || "mp3";
      const safeSlug = slug(meta.title) || "episode";
      const epNum = meta.episodeNumber ? `ep${meta.episodeNumber.padStart(3, "0")}-` : "";
      const exportAudioName = `${epNum}${safeSlug}.${audioExt}`;
      const exportAudioPath = `${feedDir}/${exportAudioName}`;

      log(`📋 Preparing episode: "${meta.title}"`);

      // Copy audio file to feed directory
      try {
        await invoke("backup_db", { srcPath: meta.audioPath, destPath: exportAudioPath });
        log(`✅ Audio copied → ${exportAudioName}`);
      } catch {
        // If custom copy command not available, we proceed — user can copy manually
        log(`⚠️  Audio copy skipped (copy manually to feed directory)`);
      }

      // 3. Build RSS item
      log("🗒  Building RSS item...");
      const pubDate = nowRfc822();
      const audioUrl = exportAudioName; // relative — user updates base URL later
      const durationFmt = hhmmss(audioDuration || 0);
      const sizeBytes = audioFileSize || 0;

      const guid = `ether-${Date.now()}-${safeSlug}`;

      const item = `
  <item>
    <title>${xmlEsc(meta.title)}</title>
    <description><![CDATA[${meta.description || meta.title}]]></description>
    <pubDate>${pubDate}</pubDate>
    <enclosure url="${xmlEsc(audioUrl)}" length="${sizeBytes}" type="audio/${audioExt === "mp3" ? "mpeg" : audioExt}"/>
    <guid isPermaLink="false">${guid}</guid>
    <itunes:title>${xmlEsc(meta.title)}</itunes:title>
    <itunes:summary>${xmlEsc(meta.description || meta.title)}</itunes:summary>
    <itunes:duration>${durationFmt}</itunes:duration>
    <itunes:episodeType>${meta.episodeType}</itunes:episodeType>
    <itunes:explicit>${meta.explicit ? "true" : "false"}</itunes:explicit>${meta.seasonNumber ? `\n    <itunes:season>${meta.seasonNumber}</itunes:season>` : ""}${meta.episodeNumber ? `\n    <itunes:episode>${meta.episodeNumber}</itunes:episode>` : ""}
  </item>`;

      // 4. Read existing feed or create new one
      log("📡 Updating RSS feed...");

      let feedXml = "";
      let feedExists = false;
      try {
        const readTextFile = (p: string) => (window as any).ether.fs.readFile(p).then((r: any) => new TextDecoder().decode(new Uint8Array(r.data ?? r)));
        feedXml = await readTextFile(meta.feedPath);
        feedExists = true;
      } catch {
        feedExists = false;
      }

      if (feedExists && feedXml.includes("</channel>")) {
        // Inject item before closing </channel>
        feedXml = feedXml.replace("</channel>", `${item}\n</channel>`);
      } else {
        // Create brand-new feed
        feedXml = buildFeedXml(meta, item, pubDate);
        log("🆕 Created new RSS feed");
      }

      // 5. Write feed
      const writeTextFile = (p: string, data: string) => (window as any).ether.fs.writeFile(p, data);
      await writeTextFile(meta.feedPath, feedXml);
      log(`✅ Feed updated → ${meta.feedPath}`);

      // 6. Persist station config for next time
      const kvUpdates: Array<[string, string]> = [
        ["podcast_author",      meta.authorName],
        ["podcast_email",       meta.email],
        ["podcast_category",    meta.category],
        ["podcast_feed_path",   meta.feedPath],
        ["podcast_cover_path",  meta.coverArtPath],
        ["podcast_description", meta.showDescription],
      ];
      for (const [k, v] of kvUpdates) {
        await execute(
          "INSERT INTO station_config_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          [k, v]
        );
      }

      // 7. Log to DB
      await executeScopedInsert(
        "INSERT INTO published_episodes (title, published_at, audio_path, feed_path, duration_sec) VALUES (?, ?, ?, ?, ?)",
        [meta.title, new Date().toISOString(), meta.audioPath, meta.feedPath, audioDuration || 0], stationId
      );

      log("🎉 Episode published successfully!");
      setPublishedPath(meta.feedPath);

      // Refresh history
      const eps = await queryScoped<PublishedEpisode>("SELECT * FROM published_episodes ORDER BY id DESC LIMIT 20", [], stationId);
      setHistory(eps);

      setStep(3);
    } catch (e: any) {
      log(`❌ Error: ${String(e)}`);
      setErr(String(e));
    } finally {
      setPublishing(false);
    }
  }, [meta, audioDuration, audioFileSize]);

  function buildFeedXml(m: EpisodeMeta, item: string, pubDate: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/modules/content/"
  xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>${xmlEsc(m.showName)}</title>
    <description>${xmlEsc(m.showDescription || m.showName)}</description>
    <language>${m.language}</language>
    <pubDate>${pubDate}</pubDate>
    <lastBuildDate>${pubDate}</lastBuildDate>
    <itunes:author>${xmlEsc(m.authorName || m.showName)}</itunes:author>
    <itunes:summary>${xmlEsc(m.showDescription || m.showName)}</itunes:summary>
    <itunes:explicit>${m.explicit ? "true" : "false"}</itunes:explicit>
    <itunes:category text="${xmlEsc(m.category)}"/>
    ${m.email ? `<itunes:owner><itunes:name>${xmlEsc(m.authorName)}</itunes:name><itunes:email>${xmlEsc(m.email)}</itunes:email></itunes:owner>` : ""}
    ${m.coverArtPath ? `<itunes:image href="${xmlEsc(m.coverArtPath)}"/>` : ""}
${item}
  </channel>
</rss>`;
  }

  // ── Copy to clipboard ────────────────────────────────────────────────

  const copyFeedPath = () => {
    navigator.clipboard.writeText(meta.feedPath).catch(() => {});
  };

  // ── UI ────────────────────────────────────────────────────────────────

  const modalOverlay: React.CSSProperties = {
    position: "fixed", inset: 0, zIndex: 9500,
    background: "rgba(0,0,0,0.75)",
    backdropFilter: "blur(6px)",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 24,
  };

  const modal: React.CSSProperties = {
    background: "var(--bg-primary)",
    border: "1px solid var(--border-secondary)",
    borderRadius: 0,
    width: "100%", maxWidth: 680,
    maxHeight: "90vh",
    display: "flex", flexDirection: "column",
    boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
    overflow: "hidden",
    fontFamily: "'Inter', system-ui, sans-serif",
  };

  const btnPrimary: React.CSSProperties = {
    height: 40, padding: "0 24px", borderRadius: 0,
    background: "var(--accent-cyan)", border: "none",
    color: "#000", fontSize: 12, fontWeight: 800,
    letterSpacing: "0.06em", cursor: "pointer",
    display: "flex", alignItems: "center", gap: 7,
    transition: "all 0.15s",
  };

  const btnSecondary: React.CSSProperties = {
    height: 40, padding: "0 20px", borderRadius: 0,
    background: "var(--bg-tertiary)",
    border: "1px solid var(--border-primary)",
    color: "var(--text-secondary)", fontSize: 12,
    fontWeight: 600, cursor: "pointer",
    transition: "all 0.15s",
  };

  return (
    <div style={modalOverlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>

        {/* Header */}
        <div style={{
          padding: "20px 28px 16px",
          borderBottom: "1px solid var(--border-primary)",
          flexShrink: 0,
          background: "var(--bg-secondary)",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 0,
                background: "linear-gradient(135deg, rgba(56,189,248,0.2), rgba(167,139,250,0.2))",
                border: "1px solid rgba(56,189,248,0.3)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" strokeWidth="2" strokeLinecap="round">
                  <polygon points="23 7 16 12 23 17 23 7"/>
                  <rect x="1" y="5" width="15" height="14" rx="2"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)" }}>
                  Publish Episode
                </div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 1 }}>
                  {stationName ? `${stationName} · ` : ""}Generate RSS &amp; export audio
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              style={{ width: 32, height: 32, borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}
            >×</button>
          </div>
          <StepBar current={step} />
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>

          {/* ── Step 0: Episode audio + title ── */}
          {step === 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>
                Choose the audio file for this episode, then set its title.
              </div>

              {/* Audio file picker */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>
                  Audio File <span style={{ color: "var(--accent-red)" }}>*</span>
                </div>
                <button
                  onClick={pickAudio}
                  style={{
                    width: "100%", padding: "18px 16px", borderRadius: 0,
                    background: meta.audioPath ? "rgba(56,189,248,0.06)" : "var(--bg-tertiary)",
                    border: `2px dashed ${meta.audioPath ? "rgba(56,189,248,0.4)" : "var(--border-primary)"}`,
                    color: meta.audioPath ? "var(--accent-cyan)" : "var(--text-tertiary)",
                    cursor: "pointer", textAlign: "left",
                    transition: "all 0.2s",
                    display: "flex", alignItems: "center", gap: 14,
                  }}
                >
                  <div style={{
                    width: 40, height: 40, borderRadius: 0, flexShrink: 0,
                    background: meta.audioPath ? "rgba(56,189,248,0.1)" : "var(--bg-secondary)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                    </svg>
                  </div>
                  <div>
                    {meta.audioPath ? (
                      <>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{meta.audioPath.split(/[\\/]/).pop()}</div>
                        <div style={{ fontSize: 11, marginTop: 3, opacity: 0.7 }}>
                          {audioDuration > 0 ? fmtDur(audioDuration) : "Click to change"}
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>Click to choose audio file</div>
                        <div style={{ fontSize: 11, marginTop: 3 }}>MP3, M4A, FLAC, OGG, WAV, AAC</div>
                      </>
                    )}
                  </div>
                </button>
              </div>

              <Field
                label="Episode Title" required
                value={meta.title}
                onChange={v => set("title", v)}
                placeholder="e.g. The Best Hits of Summer 2024"
              />

              <Field
                label="Episode Description"
                value={meta.description}
                onChange={v => set("description", v)}
                placeholder="What's in this episode? Tell your listeners..."
                multiline
              />

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 6 }}>Season</div>
                  <input
                    type="number" min="1" value={meta.seasonNumber}
                    onChange={e => set("seasonNumber", e.target.value)}
                    placeholder="—"
                    style={{ width: "100%", padding: "10px 13px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 0, color: "var(--text-primary)", fontSize: 13, outline: "none", boxSizing: "border-box" }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 6 }}>Episode #</div>
                  <input
                    type="number" min="1" value={meta.episodeNumber}
                    onChange={e => set("episodeNumber", e.target.value)}
                    placeholder="—"
                    style={{ width: "100%", padding: "10px 13px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 0, color: "var(--text-primary)", fontSize: 13, outline: "none", boxSizing: "border-box" }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 6 }}>Type</div>
                  <select
                    value={meta.episodeType}
                    onChange={e => set("episodeType", e.target.value as any)}
                    style={{ width: "100%", padding: "10px 13px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 0, color: "var(--text-primary)", fontSize: 13, outline: "none", cursor: "pointer", boxSizing: "border-box" }}
                  >
                    <option value="full">Full</option>
                    <option value="trailer">Trailer</option>
                    <option value="bonus">Bonus</option>
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  type="checkbox" id="explicit"
                  checked={meta.explicit}
                  onChange={e => set("explicit", e.target.checked)}
                  style={{ width: 16, height: 16, cursor: "pointer", accentColor: "var(--accent-red)" }}
                />
                <label htmlFor="explicit" style={{ fontSize: 12, color: "var(--text-secondary)", cursor: "pointer", userSelect: "none" }}>
                  Mark as explicit
                </label>
              </div>
            </div>
          )}

          {/* ── Step 1: Show details + feed path ── */}
          {step === 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>
                Configure your show details. These are saved and reused for future episodes.
              </div>

              <Field
                label="Show / Podcast Name" required
                value={meta.showName}
                onChange={v => set("showName", v)}
                placeholder="My Radio Show"
              />

              <Field
                label="Show Description"
                value={meta.showDescription}
                onChange={v => set("showDescription", v)}
                placeholder="A short blurb about your show..."
                multiline
                hint="Shown in Apple Podcasts, Spotify, etc."
              />

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field
                  label="Author / Host Name"
                  value={meta.authorName}
                  onChange={v => set("authorName", v)}
                  placeholder="DJ Jane Smith"
                />
                <Field
                  label="Contact Email"
                  value={meta.email}
                  onChange={v => set("email", v)}
                  placeholder="host@mystation.com"
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 6 }}>Category</div>
                  <select
                    value={meta.category}
                    onChange={e => set("category", e.target.value)}
                    style={{ width: "100%", padding: "10px 13px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 0, color: "var(--text-primary)", fontSize: 13, outline: "none", cursor: "pointer", boxSizing: "border-box" }}
                  >
                    {["Music","Arts","Comedy","Education","News","Sports","Technology","Business","Health & Fitness","Society & Culture","True Crime","Religion & Spirituality"].map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 6 }}>Language</div>
                  <select
                    value={meta.language}
                    onChange={e => set("language", e.target.value)}
                    style={{ width: "100%", padding: "10px 13px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 0, color: "var(--text-primary)", fontSize: 13, outline: "none", cursor: "pointer", boxSizing: "border-box" }}
                  >
                    {[["en","English"],["es","Spanish"],["fr","French"],["de","German"],["pt","Portuguese"],["ja","Japanese"],["ko","Korean"],["zh","Chinese"]].map(([code, name]) => (
                      <option key={code} value={code}>{name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Cover art */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>Cover Art</div>
                <button
                  onClick={pickCoverArt}
                  style={{
                    width: "100%", padding: "14px 16px", borderRadius: 0,
                    background: meta.coverArtPath ? "rgba(52,211,153,0.06)" : "var(--bg-tertiary)",
                    border: `1px dashed ${meta.coverArtPath ? "rgba(52,211,153,0.4)" : "var(--border-primary)"}`,
                    color: meta.coverArtPath ? "var(--accent-green)" : "var(--text-tertiary)",
                    cursor: "pointer", textAlign: "left",
                    display: "flex", alignItems: "center", gap: 10,
                    transition: "all 0.15s",
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                  </svg>
                  <span style={{ fontSize: 12 }}>
                    {meta.coverArtPath ? meta.coverArtPath.split(/[\\/]/).pop() : "Choose cover image (JPG/PNG, 1400×1400 recommended)"}
                  </span>
                </button>
              </div>

              {/* RSS feed path */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 6 }}>
                  RSS Feed File <span style={{ color: "var(--accent-red)" }}>*</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={meta.feedPath}
                    onChange={e => set("feedPath", e.target.value)}
                    placeholder="C:\mystation\feed.xml"
                    style={{ flex: 1, padding: "10px 13px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 0, color: "var(--text-primary)", fontSize: 12, outline: "none", fontFamily: "monospace" }}
                    onFocus={e => (e.target.style.borderColor = "var(--accent-cyan)")}
                    onBlur={e => (e.target.style.borderColor = "var(--border-primary)")}
                  />
                  <button
                    onClick={pickFeedPath}
                    style={{ height: 42, padding: "0 16px", borderRadius: 0, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}
                  >Browse...</button>
                </div>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 5 }}>
                  Episodes are appended here. Point your podcast host (Buzzsprout, RSS.com, etc.) to this file.
                </div>
              </div>
            </div>
          )}

          {/* ── Step 2: Confirm + publish ── */}
          {step === 2 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {/* Summary card */}
              <div style={{
                background: "var(--bg-secondary)", borderRadius: 0,
                border: "1px solid var(--border-primary)", overflow: "hidden",
              }}>
                <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-primary)", display: "flex", alignItems: "center", gap: 10 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" strokeWidth="2" strokeLinecap="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                  </svg>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "var(--text-secondary)" }}>EPISODE SUMMARY</span>
                </div>
                <div style={{ padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 24px" }}>
                  {[
                    ["Title", meta.title],
                    ["Show", meta.showName],
                    ["Duration", fmtDur(audioDuration || 0)],
                    ["Type", meta.episodeType.charAt(0).toUpperCase() + meta.episodeType.slice(1)],
                    ...(meta.seasonNumber ? [["Season", meta.seasonNumber]] : []),
                    ...(meta.episodeNumber ? [["Episode #", meta.episodeNumber]] : []),
                    ["Explicit", meta.explicit ? "Yes" : "No"],
                    ["Category", meta.category],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 3 }}>{k}</div>
                      <div style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 500 }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Audio path */}
              <div style={{ background: "rgba(56,189,248,0.05)", border: "1px solid rgba(56,189,248,0.15)", borderRadius: 0, padding: "12px 16px" }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--accent-cyan)", textTransform: "uppercase", marginBottom: 4 }}>Audio</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "monospace", wordBreak: "break-all" }}>{meta.audioPath}</div>
              </div>

              {/* Feed path */}
              <div style={{ background: "rgba(52,211,153,0.05)", border: "1px solid rgba(52,211,153,0.15)", borderRadius: 0, padding: "12px 16px" }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--accent-green)", textTransform: "uppercase", marginBottom: 4 }}>RSS Feed</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "monospace", wordBreak: "break-all" }}>{meta.feedPath}</div>
              </div>

              {/* Publish log */}
              {publishLog.length > 0 && (
                <div style={{ background: "var(--bg-secondary)", borderRadius: 0, border: "1px solid var(--border-primary)", padding: "12px 16px" }}>
                  {publishLog.map((line, i) => (
                    <div key={i} style={{ fontSize: 11, color: line.startsWith("❌") ? "var(--accent-red)" : line.startsWith("✅") ? "var(--accent-green)" : "var(--text-secondary)", padding: "2px 0", fontFamily: "monospace" }}>{line}</div>
                  ))}
                  {publishing && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent-cyan)", animation: "mic-blink 1s ease-in-out infinite" }} />
                      <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Publishing...</span>
                    </div>
                  )}
                </div>
              )}

              {err && (
                <div style={{ padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 0, fontSize: 12, color: "var(--accent-red)" }}>
                  {err}
                </div>
              )}
            </div>
          )}

          {/* ── Step 3: Done ── */}
          {step === 3 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24, alignItems: "center", textAlign: "center", padding: "8px 0" }}>
              {/* Success icon */}
              <div style={{
                width: 72, height: 72, borderRadius: "50%",
                background: "rgba(52,211,153,0.12)",
                border: "2px solid rgba(52,211,153,0.3)",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "0 0 40px rgba(52,211,153,0.15)",
              }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                  <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
              </div>

              <div>
                <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", marginBottom: 8 }}>
                  Episode Published!
                </div>
                <div style={{ fontSize: 13, color: "var(--text-tertiary)", maxWidth: 400 }}>
                  "{meta.title}" has been added to your RSS feed. Share the feed URL with your podcast host to distribute it.
                </div>
              </div>

              {/* Feed path copyable */}
              <div style={{
                width: "100%", background: "var(--bg-secondary)",
                border: "1px solid var(--border-primary)", borderRadius: 0,
                padding: "14px 18px",
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>RSS Feed Location</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, fontSize: 12, color: "var(--accent-cyan)", fontFamily: "monospace", wordBreak: "break-all", textAlign: "left" }}>
                    {publishedPath || meta.feedPath}
                  </div>
                  <button
                    onClick={copyFeedPath}
                    style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
                  >Copy</button>
                </div>
              </div>

              {/* Episode history */}
              {history.length > 0 && (
                <div style={{ width: "100%", textAlign: "left" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 10 }}>
                    Published Episodes ({history.length})
                  </div>
                  <div style={{ background: "var(--bg-secondary)", borderRadius: 0, border: "1px solid var(--border-primary)", overflow: "hidden" }}>
                    {history.slice(0, 8).map((ep, i) => (
                      <div key={ep.id} style={{
                        padding: "10px 16px",
                        borderBottom: i < Math.min(history.length, 8) - 1 ? "1px solid var(--border-primary)" : "none",
                        display: "flex", alignItems: "center", gap: 12,
                      }}>
                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: i === 0 ? "var(--accent-green)" : "var(--text-tertiary)", flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ep.title}</div>
                          <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>
                            {new Date(ep.published_at).toLocaleDateString()} · {ep.duration_sec > 0 ? fmtDur(ep.duration_sec) : ""}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "16px 28px",
          borderTop: "1px solid var(--border-primary)",
          background: "var(--bg-secondary)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 0 && step < 3 && (
              <button onClick={() => setStep(s => s - 1)} style={btnSecondary}>
                ← Back
              </button>
            )}
            {step === 3 && (
              <button
                onClick={() => { setStep(0); setMeta(prev => ({ ...prev, title: "", description: "", audioPath: "", episodeNumber: "" })); setPublishLog([]); setErr(""); }}
                style={btnSecondary}
              >
                Publish Another
              </button>
            )}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            {step < 2 && (
              <button
                onClick={() => { if (canAdvance()) setStep(s => s + 1); }}
                disabled={!canAdvance()}
                style={{
                  ...btnPrimary,
                  opacity: canAdvance() ? 1 : 0.45,
                  cursor: canAdvance() ? "pointer" : "not-allowed",
                }}
              >
                Continue
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </button>
            )}
            {step === 2 && !publishing && publishLog.length === 0 && (
              <button onClick={doPublish} style={btnPrimary}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2z"/>
                </svg>
                Publish Episode
              </button>
            )}
            {step === 3 && (
              <button onClick={onClose} style={btnPrimary}>
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

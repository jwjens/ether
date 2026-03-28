// src/audio/zettaBridge.ts
//
// Zetta Bridge Export — the "Universal Bridge"
//
// Packages the Producer Desk storyboard + voice tracks into a
// standard folder format that Zetta, NexGen, and WideOrbit can ingest.
//
// Output structure:
//   EtherExport_[timestamp]/
//     manifest.xml          ← Standard automation XML (Zetta/NexGen compatible)
//     show_notes.txt        ← Plain text prep notes (pasteable into any system)
//     voice_track_[n].wav   ← Voice tracks (if any)
//     assets/               ← Linked audio files (copies)
//
// This is what makes the standalone Producer Desk subscription viable:
// a jock at a Zetta station can prep in Ether, export, and hand
// the folder to their engineer.

import { invoke } from "@tauri-apps/api/core";
import { writeFile, mkdir, copyFile } from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";

// ── Types ─────────────────────────────────────────────────────

export interface DeskCard {
  id: string;
  type: "song" | "talk-break" | "note" | "link";
  songTitle?: string;
  songArtist?: string;
  durationMs?: number;
  introMs?: number;
  outroMs?: number;
  filePath?: string;
  breakTitle?: string;
  estimatedSec?: number;
  text?: string;
  aiContent?: {
    mode: "standard" | "ministry";
    trivia?: string;
    scripture?: string;
    talkingPoints?: string[];
  };
}

export interface ExportOptions {
  stationName: string;
  showTitle: string;
  hostName: string;
  airDate: string;  // YYYY-MM-DD
  cards: DeskCard[];
  voiceTrackPaths?: string[];  // paths to recorded .wav files
}

export interface ExportResult {
  success: boolean;
  outputPath: string;
  fileCount: number;
  message: string;
}

// ── XML Builder ───────────────────────────────────────────────
// Produces a standard "Show Log" XML compatible with:
// - Zetta (RCS) import format
// - NexGen (WideOrbit) log format
// - Generic automation XML (readable by any major system)

function buildManifestXML(opts: ExportOptions): string {
  const now = new Date();
  const timestamp = now.toISOString();
  const airDate = opts.airDate || now.toISOString().split("T")[0];

  const songCards = opts.cards.filter(c => c.type === "song");
  const breakCards = opts.cards.filter(c => c.type === "talk-break");

  // Build log entries — ordered by card position
  const entries = opts.cards
    .filter(c => c.type === "song" || c.type === "talk-break")
    .map((card, i) => {
      if (card.type === "song") {
        const intro = card.introMs ? (card.introMs / 1000).toFixed(1) : "0.0";
        const outro = card.outroMs ? (card.outroMs / 1000).toFixed(1) : "0.0";
        const dur   = card.durationMs ? (card.durationMs / 1000).toFixed(1) : "0.0";
        const prep  = card.aiContent?.talkingPoints?.join(" | ") || "";
        const trivia = card.aiContent?.trivia || card.aiContent?.scripture || "";

        return `    <LogEntry position="${i + 1}" type="SONG">
      <Title><![CDATA[${card.songTitle || ""}]]></Title>
      <Artist><![CDATA[${card.songArtist || ""}]]></Artist>
      <Duration>${dur}</Duration>
      <IntroPoint>${intro}</IntroPoint>
      <OutroPoint>${outro}</OutroPoint>
      <FilePath><![CDATA[${card.filePath || ""}]]></FilePath>
      <PrepNotes><![CDATA[${prep}]]></PrepNotes>
      <Trivia><![CDATA[${trivia}]]></Trivia>
    </LogEntry>`;
      } else {
        const dur = card.estimatedSec ? String(card.estimatedSec) : "90";
        const points = card.aiContent?.talkingPoints?.join("\n") || card.text || "";
        return `    <LogEntry position="${i + 1}" type="BREAK">
      <Title><![CDATA[${card.breakTitle || "Talk Break"}]]></Title>
      <Duration>${dur}</Duration>
      <Script><![CDATA[${points}]]></Script>
    </LogEntry>`;
      }
    })
    .join("\n\n");

  // Voice tracks
  const voiceTracks = (opts.voiceTrackPaths || [])
    .map((p, i) => `    <VoiceTrack index="${i + 1}" file="voice_track_${i + 1}.wav"><![CDATA[${p}]]></VoiceTrack>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Ether Broadcast Platform — Show Export
  Compatible with: Zetta (RCS), NexGen (WideOrbit), Selector, and generic automation
  Generated: ${timestamp}
-->
<EtherShowExport version="1.0">

  <ShowInfo>
    <Station><![CDATA[${opts.stationName}]]></Station>
    <Title><![CDATA[${opts.showTitle}]]></Title>
    <Host><![CDATA[${opts.hostName}]]></Host>
    <AirDate>${airDate}</AirDate>
    <ExportedAt>${timestamp}</ExportedAt>
    <SongCount>${songCards.length}</SongCount>
    <BreakCount>${breakCards.length}</BreakCount>
  </ShowInfo>

  <Log>
${entries}
  </Log>

  <VoiceTracks>
${voiceTracks}
  </VoiceTracks>

</EtherShowExport>
`;
}

// ── Plain text show notes ─────────────────────────────────────
// Formatted for easy pasting into Zetta's "Memo" field or
// any other system's notes area.

function buildShowNotes(opts: ExportOptions): string {
  const lines: string[] = [
    `ETHER SHOW NOTES — ${opts.showTitle.toUpperCase()}`,
    `${opts.stationName} | ${opts.hostName} | ${opts.airDate}`,
    "═".repeat(60),
    "",
  ];

  opts.cards.forEach((card, i) => {
    if (card.type === "song") {
      lines.push(`[${i + 1}] SONG: ${card.songTitle} — ${card.songArtist}`);
      if (card.durationMs) lines.push(`     Duration: ${Math.floor(card.durationMs / 60000)}:${Math.floor((card.durationMs % 60000) / 1000).toString().padStart(2, "0")}`);
      if (card.aiContent?.trivia) lines.push(`     Trivia: ${card.aiContent.trivia}`);
      if (card.aiContent?.scripture) lines.push(`     Scripture: ${card.aiContent.scripture}`);
      if (card.aiContent?.talkingPoints?.length) {
        lines.push("     Talking Points:");
        card.aiContent.talkingPoints.forEach(pt => lines.push(`       • ${pt}`));
      }
    } else if (card.type === "talk-break") {
      lines.push(`[${i + 1}] BREAK: ${card.breakTitle || "Talk Break"} (~${card.estimatedSec || 90}s)`);
      if (card.aiContent?.talkingPoints?.length) {
        card.aiContent.talkingPoints.forEach(pt => lines.push(`       • ${pt}`));
      }
      if (card.text) lines.push(`     Notes: ${card.text}`);
    } else if (card.type === "note" && card.text) {
      lines.push(`[${i + 1}] NOTE: ${card.text.substring(0, 120)}`);
    }
    lines.push("");
  });

  lines.push("═".repeat(60));
  lines.push("Generated by Ether Broadcast Platform — etherfm.io");

  return lines.join("\n");
}

// ── Main export function ───────────────────────────────────────

export async function exportToZettaBridge(opts: ExportOptions): Promise<ExportResult> {
  try {
    // Ask user where to save
    const outputDir = await save({
      title: "Export Show for Automation System",
      defaultPath: `EtherExport_${opts.airDate}_${opts.showTitle.replace(/\s+/g, "_")}`,
      filters: [{ name: "Folder", extensions: [""] }],
    });

    if (!outputDir) {
      return { success: false, outputPath: "", fileCount: 0, message: "Export cancelled" };
    }

    const dir = outputDir.endsWith("/") ? outputDir.slice(0, -1) : outputDir;

    // Create directory structure
    await mkdir(dir, { recursive: true });
    await mkdir(`${dir}/assets`, { recursive: true });

    let fileCount = 0;

    // Write manifest XML
    const xml = buildManifestXML(opts);
    await writeFile(`${dir}/manifest.xml`, new TextEncoder().encode(xml));
    fileCount++;

    // Write show notes
    const notes = buildShowNotes(opts);
    await writeFile(`${dir}/show_notes.txt`, new TextEncoder().encode(notes));
    fileCount++;

    // Copy audio files for songs that have paths
    const songCards = opts.cards.filter(c => c.type === "song" && c.filePath);
    for (const card of songCards) {
      if (!card.filePath) continue;
      const filename = card.filePath.split(/[\\/]/).pop() || "audio.mp3";
      try {
        await copyFile(card.filePath, `${dir}/assets/${filename}`);
        fileCount++;
      } catch {
        // File may not be accessible — skip, path is in XML
      }
    }

    // Copy voice tracks
    if (opts.voiceTrackPaths) {
      for (let i = 0; i < opts.voiceTrackPaths.length; i++) {
        try {
          await copyFile(opts.voiceTrackPaths[i], `${dir}/voice_track_${i + 1}.wav`);
          fileCount++;
        } catch {
          // Voice track may not exist yet
        }
      }
    }

    return {
      success: true,
      outputPath: dir,
      fileCount,
      message: `Exported ${fileCount} files. Open in Zetta: File → Import Log → manifest.xml`,
    };
  } catch (e) {
    return {
      success: false,
      outputPath: "",
      fileCount: 0,
      message: `Export failed: ${e}`,
    };
  }
}

// ── Quick export button component ─────────────────────────────
// Drop this anywhere in the Producer Desk to add a one-click export.

import React, { useState } from "react";

interface ExportButtonProps {
  cards: DeskCard[];
  stationName?: string;
  showTitle?: string;
  hostName?: string;
}

export function ZettaExportButton({ cards, stationName = "My Station", showTitle = "My Show", hostName = "Host" }: ExportButtonProps) {
  const [status, setStatus] = useState<"idle" | "exporting" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  const handleExport = async () => {
    setStatus("exporting");
    setMessage("Building export…");

    const result = await exportToZettaBridge({
      stationName,
      showTitle,
      hostName,
      airDate: new Date().toISOString().split("T")[0],
      cards,
    });

    if (result.success) {
      setStatus("done");
      setMessage(result.message);
    } else {
      setStatus("error");
      setMessage(result.message);
    }

    setTimeout(() => {
      setStatus("idle");
      setMessage("");
    }, 4000);
  };

  const bg = {
    idle:      "rgba(56,189,248,0.08)",
    exporting: "rgba(251,191,36,0.08)",
    done:      "rgba(52,211,153,0.1)",
    error:     "rgba(239,68,68,0.1)",
  }[status];

  const color = {
    idle:      "#7dd3fc",
    exporting: "#fbbf24",
    done:      "#34d399",
    error:     "#ef4444",
  }[status];

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
      <button
        onClick={handleExport}
        disabled={status === "exporting"}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "5px 12px", borderRadius: 7,
          background: bg,
          border: `1px solid ${color}44`,
          color, fontSize: 10, fontWeight: 700,
          cursor: status === "exporting" ? "wait" : "pointer",
          transition: "all 0.2s",
          letterSpacing: "0.06em",
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        {status === "idle"      && "Export to Zetta / NexGen"}
        {status === "exporting" && "Exporting…"}
        {status === "done"      && "✓ Exported"}
        {status === "error"     && "Export Failed"}
      </button>
      {message && (
        <div style={{ fontSize: 9, color, paddingLeft: 4, maxWidth: 280, lineHeight: 1.4 }}>
          {message}
        </div>
      )}
    </div>
  );
}

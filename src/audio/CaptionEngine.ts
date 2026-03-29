// src/audio/CaptionEngine.ts
// Stub — replace with real implementation when Web Speech API integration is ready

export interface CaptionEntry {
  id: string;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  selected: boolean;
}

export interface InterimCaption {
  text: string;
}

export class LiveCaptionEngine {
  private captions: CaptionEntry[] = [];
  private callback: ((caps: CaptionEntry[], interim: InterimCaption | null) => void) | null = null;
  private running = false;

  isSupported(): boolean {
    return typeof window !== "undefined" && "webkitSpeechRecognition" in window;
  }

  clearCaptions(): void {
    this.captions = [];
  }

  onCaptions(cb: (caps: CaptionEntry[], interim: InterimCaption | null) => void): void {
    this.callback = cb;
  }

  start(_speaker?: string): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  toTranscriptEntries(): CaptionEntry[] {
    return this.captions;
  }
}

export function toSRT(entries: CaptionEntry[]): string {
  return entries.map((e, i) => {
    const fmt = (ms: number) => {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      const ms2 = ms % 1000;
      return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms2).padStart(3,"0")}`;
    };
    return `${i+1}\n${fmt(e.startMs)} --> ${fmt(e.endMs)}\n${e.text}\n`;
  }).join("\n");
}

export function toVTT(entries: CaptionEntry[]): string {
  return "WEBVTT\n\n" + entries.map(e => {
    const fmt = (ms: number) => {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      const ms2 = ms % 1000;
      return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(ms2).padStart(3,"0")}`;
    };
    return `${fmt(e.startMs)} --> ${fmt(e.endMs)}\n${e.text}\n`;
  }).join("\n");
}

export function toPlainText(entries: CaptionEntry[]): string {
  return entries.map(e => `[${e.speaker}]: ${e.text}`).join("\n");
}

export function transcriptToCaptions(entries: CaptionEntry[]): CaptionEntry[] {
  return entries;
}

export function downloadCaption(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// src/audio/CaptionEngine.ts
// Real-time captions + SRT/VTT/TXT export

export interface Caption {
  id: string; speaker: string; text: string;
  startMs: number; endMs: number; confidence: number; final: boolean;
}

type CaptionCallback = (caption: Caption, interim: boolean) => void;

export class LiveCaptionEngine {
  private recognition: any = null;
  private isRunning = false;
  private startTime = 0;
  private speaker = "Host";
  private captionId = 0;
  private onCaption?: CaptionCallback;
  private onError?: (err: string) => void;
  private restartTimer: any = null;

  constructor(speaker = "Host") { this.speaker = speaker; }
  setSpeaker(name: string) { this.speaker = name; }
  onCaptionUpdate(cb: CaptionCallback) { this.onCaption = cb; }
  onCaptionError(cb: (e: string) => void) { this.onError = cb; }

  start(recordingStartMs: number): boolean {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { this.onError?.("Speech recognition not supported"); return false; }
    this.startTime = recordingStartMs; this.isRunning = true;
    this.recognition = new SR();
    const r = this.recognition;
    r.continuous = true; r.interimResults = true; r.maxAlternatives = 1; r.lang = "en-US";
    r.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;
        const now = Date.now() - this.startTime;
        const interim = !result.isFinal;
        this.onCaption?.({
          id: `c-${++this.captionId}`, speaker: this.speaker, text,
          startMs: Math.max(0, now - text.split(" ").length * 400),
          endMs: now, confidence: result[0].confidence || 0.8, final: !interim,
        }, interim);
      }
    };
    r.onerror = (event: any) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      this.onError?.(event.error);
    };
    r.onend = () => {
      if (this.isRunning) {
        this.restartTimer = setTimeout(() => { if (this.isRunning) { try { r.start(); } catch {} } }, 300);
      }
    };
    try { r.start(); return true; } catch (e) { this.onError?.(`${e}`); return false; }
  }

  stop() {
    this.isRunning = false;
    clearTimeout(this.restartTimer);
    try { this.recognition?.stop(); } catch {}
    this.recognition = null;
  }

  static isSupported(): boolean {
    return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }
}

// ── Formatters ────────────────────────────────────────────────

function pad(n: number, len = 2) { return String(n).padStart(len, "0"); }

function msToSRT(ms: number) {
  return `${pad(Math.floor(ms/3600000))}:${pad(Math.floor((ms%3600000)/60000))}:${pad(Math.floor((ms%60000)/1000))},${pad(ms%1000,3)}`;
}
function msToVTT(ms: number) {
  return `${pad(Math.floor(ms/3600000))}:${pad(Math.floor((ms%3600000)/60000))}:${pad(Math.floor((ms%60000)/1000))}.${pad(ms%1000,3)}`;
}
function msToReadable(ms: number) {
  return `${Math.floor(ms/60000)}:${pad(Math.floor((ms%60000)/1000))}`;
}

export function toSRT(captions: Caption[]): string {
  return captions.filter(c => c.final).sort((a,b) => a.startMs-b.startMs).map((c,i) =>
    `${i+1}\n${msToSRT(c.startMs)} --> ${msToSRT(c.endMs)}\n${c.speaker ? `[${c.speaker}] ` : ""}${c.text}\n`
  ).join("\n");
}

export function toVTT(captions: Caption[]): string {
  const items = captions.filter(c => c.final).sort((a,b) => a.startMs-b.startMs).map(c =>
    `${msToVTT(c.startMs)} --> ${msToVTT(c.endMs)}\n<v ${c.speaker}>${c.text}`
  ).join("\n\n");
  return `WEBVTT\n\n${items}`;
}

export function toPlainText(captions: Caption[]): string {
  return captions.filter(c => c.final).sort((a,b) => a.startMs-b.startMs).map(c =>
    `[${msToReadable(c.startMs)}] ${c.speaker}: ${c.text}`
  ).join("\n");
}

export function transcriptToCaptions(entries: any[]): Caption[] {
  return entries.map((e,i) => ({
    id: e.id||String(i), speaker: e.speaker||"Speaker", text: e.text||"",
    startMs: e.startMs||0, endMs: e.endMs||0, confidence: 0.9, final: true,
  }));
}

export function downloadCaption(content: string, filename: string, mime: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename; a.click();
}

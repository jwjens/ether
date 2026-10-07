// src/audio/localOutput.ts — THE LOCAL OUTPUT STAGE, renderer half (2026-10-07, docs/monitor-bypass-diagnosis.md).
//
// Jeff's rule: the MONITOR fader is the local master output. Every sound that reaches a local output device passes
// the monitor gain stage; nothing bypasses it. The ONE exception is PFL routed to a dedicated cue device (an engine
// path; nothing here).
//
// The engine half (native/src/localout.rs) scales the main device and the AUX ring. Sound a WINDOW makes never goes
// near the engine: Chromium plays it to the system output directly. So it is scaled HERE, by the same MONITOR level
// main remembers from the fader (electron/main.js "local:monitor-level"). This module is the ONLY place in src/ that
// may connect to an AudioContext's destination, create an audio element, or speak TTS:
//   • Web Audio graphs:   node.connect(localDestination(ctx))        instead of ctx.destination
//   • media elements:     localAudio(src) / bindLocalMedia(el, base)   instead of new Audio() / an unmuted <audio>/<video>
//   • TTS:                speakLocal(utterance)                       instead of speechSynthesis.speak
// scripts/test-local-playback-guard.js fails the build on any other playback in src/.
//
// The gain is applied live: moving MONITOR changes what is already playing. Offline renders (OfflineAudioContext)
// make no sound and keep their own destination.

type Listener = (level: number) => void;

let level = 1;
const listeners = new Set<Listener>();
let wired = false;

function ether(): any { return (window as any).ether; }

function setLevel(v: unknown) {
  const n = Number(v);
  if (!Number.isFinite(n)) return;
  level = Math.max(0, Math.min(1, n));
  listeners.forEach(l => { try { l(level); } catch { /* one bad listener never stops the others */ } });
}

/** Subscribe to main's MONITOR level once per window, and ask for the current value (a window opened later). */
function wire() {
  if (wired) return;
  wired = true;
  try { ether()?.on?.("local:monitor-level", (v: number) => setLevel(v)); } catch { /* no bridge (tests) */ }
  try { Promise.resolve(ether()?.invoke?.("local:monitor-level")).then(setLevel).catch(() => {}); } catch { /* no bridge */ }
}

/** The current MONITOR level, 0..1. */
export function monitorLevel(): number { wire(); return level; }

/** Called when MONITOR moves. Returns an unsubscribe. */
export function onMonitorLevel(l: Listener): () => void { wire(); listeners.add(l); return () => { listeners.delete(l); }; }

// ── Web Audio ──────────────────────────────────────────────────────────────────────────────────────────────────────
const gains = new WeakMap<BaseAudioContext, GainNode>();

/** The node a live AudioContext's sound must connect to: a MONITOR gain in front of ctx.destination (one per context).
 *  An OfflineAudioContext is a render, not a speaker — its own destination is returned unchanged. */
export function localDestination(ctx: BaseAudioContext): AudioNode {
  if (typeof OfflineAudioContext !== "undefined" && ctx instanceof OfflineAudioContext) return ctx.destination;
  let g = gains.get(ctx);
  if (!g) {
    g = ctx.createGain();
    g.gain.value = monitorLevel();
    g.connect(ctx.destination);   // the ONE connection to a speaker in a live context
    gains.set(ctx, g);
    const node = g;
    onMonitorLevel(v => { try { node.gain.setTargetAtTime(v, ctx.currentTime, 0.015); } catch { node.gain.value = v; } });
  }
  return g;
}

// ── Media elements ─────────────────────────────────────────────────────────────────────────────────────────────────
const bound = new WeakMap<HTMLMediaElement, { base: number; off: () => void }>();

/** Make a media element obey MONITOR: its volume = base × MONITOR, kept current. Safe to call again (updates base). */
export function bindLocalMedia(el: HTMLMediaElement | null, base = 1): void {
  if (!el) return;
  const b = Math.max(0, Math.min(1, Number.isFinite(base) ? base : 1));
  const prev = bound.get(el);
  if (prev) { prev.base = b; el.volume = b * monitorLevel(); return; }
  const entry = { base: b, off: () => {} };
  el.volume = b * monitorLevel();
  entry.off = onMonitorLevel(v => { el.volume = entry.base * v; });
  bound.set(el, entry);
  el.addEventListener("emptied", () => { /* element reused: keep binding */ });
}

/** A ref callback for JSX audio/video elements that make sound: ref={localMediaRef} */
export const localMediaRef = (el: HTMLMediaElement | null) => bindLocalMedia(el, 1);

/** new Audio(src), bound to MONITOR. */
export function localAudio(src?: string): HTMLAudioElement {
  const el = src === undefined ? new Audio() : new Audio(src);   // local-out: the one creator of audio elements
  bindLocalMedia(el, 1);
  return el;
}

// ── TTS ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** speechSynthesis.speak, at the utterance's own volume × MONITOR. */
export function speakLocal(u: SpeechSynthesisUtterance): void {
  const base = Number.isFinite(u.volume) ? u.volume : 1;
  u.volume = Math.max(0, Math.min(1, base * monitorLevel()));
  window.speechSynthesis.speak(u);   // local-out: the one TTS output
}

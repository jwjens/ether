// Tiny synthesized UI "click" for tactile button feedback. Lazily creates one shared
// WebAudio context and plays a short low tick on the renderer's default output — it's
// a local UI sound only, never routed to the broadcast/Icecast path (that's the Rust
// engine). No audio asset needed.
let _ctx: AudioContext | null = null;

export function playClick(volume = 0.05): void {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    _ctx = _ctx || new AC();
    if (_ctx.state === "suspended") _ctx.resume();
    const t = _ctx.currentTime;
    const osc = _ctx.createOscillator();
    const gain = _ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(200, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.025);
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(gain);
    gain.connect(_ctx.destination);
    osc.start(t);
    osc.stop(t + 0.06);
  } catch { /* audio unavailable — silent */ }
}

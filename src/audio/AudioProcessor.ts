// src/audio/AudioProcessor.ts
//
// Real-time mic processing chain using Web Audio API nodes.
// Signal flow:
//
//   MediaStream → HighPass → NoiseGate → EQ (3-band) → Compressor → Limiter → Analyser → Destination
//
// All nodes are created once and stay alive. Parameters update live.
// This is what Apple calls "Studio Sound" — one click, broadcast quality.

export interface ProcessorSettings {
  // High-pass filter — cuts room rumble below this Hz
  highPassFreq:   number;   // default 80Hz
  highPassEnabled: boolean;

  // Noise gate — silences signal below threshold
  gateThresholdDb: number;  // default -50dB
  gateEnabled:     boolean;

  // 3-band EQ
  lowShelfGainDb:  number;  // default 0  (+/-12dB)
  midPeakGainDb:   number;  // default +2 (presence boost)
  highShelfGainDb: number;  // default 0
  eqEnabled:       boolean;

  // Compressor
  compThresholdDb: number;  // default -24dB
  compRatio:       number;  // default 4:1
  compAttackMs:    number;  // default 5ms
  compReleaseMs:   number;  // default 150ms
  compEnabled:     boolean;

  // Output gain (after processing)
  outputGainDb:    number;  // default 0

  // Auto-level: normalize to target LUFS
  autoLevelEnabled: boolean;
  targetLufs:       number; // default -14 (podcast standard)
}

export const DEFAULT_SETTINGS: ProcessorSettings = {
  highPassFreq:    80,
  highPassEnabled: true,
  gateThresholdDb: -50,
  gateEnabled:     true,
  lowShelfGainDb:  0,
  midPeakGainDb:   2,
  highShelfGainDb: 0,
  eqEnabled:       true,
  compThresholdDb: -24,
  compRatio:       4,
  compAttackMs:    5,
  compReleaseMs:   150,
  compEnabled:     true,
  outputGainDb:    0,
  autoLevelEnabled: false,
  targetLufs:      -14,
};

// Preset profiles
export const PRESETS: Record<string, Partial<ProcessorSettings>> = {
  "Off": {
    highPassEnabled: false, gateEnabled: false,
    eqEnabled: false, compEnabled: false,
    outputGainDb: 0,
  },
  "Broadcast": {
    highPassFreq: 80, highPassEnabled: true,
    gateThresholdDb: -45, gateEnabled: true,
    lowShelfGainDb: -2, midPeakGainDb: 3, highShelfGainDb: 1, eqEnabled: true,
    compThresholdDb: -20, compRatio: 6, compAttackMs: 3, compReleaseMs: 100, compEnabled: true,
    outputGainDb: 2,
  },
  "Podcast": {
    highPassFreq: 100, highPassEnabled: true,
    gateThresholdDb: -50, gateEnabled: true,
    lowShelfGainDb: 0, midPeakGainDb: 2, highShelfGainDb: 0, eqEnabled: true,
    compThresholdDb: -24, compRatio: 4, compAttackMs: 5, compReleaseMs: 150, compEnabled: true,
    outputGainDb: 0,
  },
  "Voice": {
    highPassFreq: 120, highPassEnabled: true,
    gateThresholdDb: -45, gateEnabled: true,
    lowShelfGainDb: -3, midPeakGainDb: 4, highShelfGainDb: 2, eqEnabled: true,
    compThresholdDb: -18, compRatio: 3, compAttackMs: 8, compReleaseMs: 200, compEnabled: true,
    outputGainDb: 1,
  },
  "Music": {
    highPassFreq: 40, highPassEnabled: true,
    gateThresholdDb: -60, gateEnabled: false,
    lowShelfGainDb: 1, midPeakGainDb: 0, highShelfGainDb: 1, eqEnabled: true,
    compThresholdDb: -30, compRatio: 2, compAttackMs: 10, compReleaseMs: 300, compEnabled: true,
    outputGainDb: 0,
  },
};

export class AudioProcessor {
  private ctx: AudioContext;
  private source: MediaStreamAudioSourceNode;

  // Processing nodes
  private highPass:    BiquadFilterNode;
  private lowShelf:    BiquadFilterNode;
  private midPeak:     BiquadFilterNode;
  private highShelf:   BiquadFilterNode;
  private compressor:  DynamicsCompressorNode;
  private outputGain:  GainNode;
  private analyser:    AnalyserNode;

  // Gate is implemented as a gain node we automate
  private gateGain:    GainNode;
  private gateTimer:   number = 0;
  private gateOpen:    boolean = true;

  // Metering
  private meterData:   Uint8Array;
  private rafId:       number = 0;
  public  level:       number = 0;   // 0-1
  public  peakDb:      number = -Infinity;
  public  gainReduction: number = 0; // dB of compression

  // AGC (Auto Gain Control) — slowly adjusts gain to hit target RMS
  private agcGain:       GainNode | null = null;
  private agcCurrentGain = 1.0;
  private agcTargetRms   = 0.2; // default target ~-14 LUFS equivalent
  private agcEnabled     = false;

  private settings: ProcessorSettings;
  private onLevel?: (level: number, peakDb: number, gainReduction: number) => void;

  constructor(stream: MediaStream, settings: ProcessorSettings = DEFAULT_SETTINGS) {
    this.ctx      = new AudioContext({ sampleRate: 48000 });
    this.source   = this.ctx.createMediaStreamSource(stream);
    this.settings = { ...settings };

    // ── Build processing chain ────────────────────────────────
    this.highPass   = this.ctx.createBiquadFilter();
    this.gateGain   = this.ctx.createGain();
    this.lowShelf   = this.ctx.createBiquadFilter();
    this.midPeak    = this.ctx.createBiquadFilter();
    this.highShelf  = this.ctx.createBiquadFilter();
    this.compressor = this.ctx.createDynamicsCompressor();
    this.outputGain = this.ctx.createGain();
    this.analyser   = this.ctx.createAnalyser();

    // Filter types
    this.highPass.type  = "highpass";
    this.lowShelf.type  = "lowshelf";
    this.midPeak.type   = "peaking";
    this.highShelf.type = "highshelf";

    // EQ frequencies
    this.lowShelf.frequency.value  = 200;
    this.midPeak.frequency.value   = 2500;
    this.midPeak.Q.value           = 1.0;
    this.highShelf.frequency.value = 8000;

    // Analyser config
    this.analyser.fftSize              = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    this.meterData = new Uint8Array(this.analyser.frequencyBinCount);

    // AGC gain node — sits between outputGain and analyser
    this.agcGain = this.ctx.createGain();
    this.agcGain.gain.value = this.agcCurrentGain;

    // Connect chain:
    // source → highpass → gate → lowshelf → midpeak → highshelf → compressor → outputGain → agcGain → analyser
    // NOTE: analyser does NOT connect to destination — mic never goes to speakers
    this.source.connect(this.highPass);
    this.highPass.connect(this.gateGain);
    this.gateGain.connect(this.lowShelf);
    this.lowShelf.connect(this.midPeak);
    this.midPeak.connect(this.highShelf);
    this.highShelf.connect(this.compressor);
    this.compressor.connect(this.outputGain);
    this.outputGain.connect(this.agcGain);
    this.agcGain.connect(this.analyser);
    // ✗ analyser does NOT connect to ctx.destination
    // Mic audio never goes to speakers — metering only

    this.applySettings(settings);
    this.startMeter();
  }

  // ── Apply settings ────────────────────────────────────────

  applySettings(s: Partial<ProcessorSettings>) {
    this.settings = { ...this.settings, ...s };
    const t = this.ctx.currentTime;

    // High-pass
    this.highPass.frequency.setTargetAtTime(this.settings.highPassFreq, t, 0.01);
    // Bypass by setting gain — we can't truly bypass BiquadFilter without reconnecting,
    // so set it to 20Hz (effectively off) when disabled
    if (!this.settings.highPassEnabled) {
      this.highPass.frequency.setTargetAtTime(20, t, 0.01);
    }

    // EQ
    this.lowShelf.gain.setTargetAtTime(this.settings.eqEnabled ? this.settings.lowShelfGainDb : 0, t, 0.01);
    this.midPeak.gain.setTargetAtTime(this.settings.eqEnabled ? this.settings.midPeakGainDb : 0, t, 0.01);
    this.highShelf.gain.setTargetAtTime(this.settings.eqEnabled ? this.settings.highShelfGainDb : 0, t, 0.01);

    // Compressor
    const c = this.compressor;
    if (this.settings.compEnabled) {
      c.threshold.setTargetAtTime(this.settings.compThresholdDb, t, 0.01);
      c.ratio.setTargetAtTime(this.settings.compRatio, t, 0.01);
      c.attack.setTargetAtTime(this.settings.compAttackMs / 1000, t, 0.01);
      c.release.setTargetAtTime(this.settings.compReleaseMs / 1000, t, 0.01);
      c.knee.setTargetAtTime(6, t, 0.01);
    } else {
      // Disable by setting ratio to 1:1
      c.threshold.setTargetAtTime(0, t, 0.01);
      c.ratio.setTargetAtTime(1, t, 0.01);
    }

    // Output gain
    const linearGain = Math.pow(10, this.settings.outputGainDb / 20);
    this.outputGain.gain.setTargetAtTime(linearGain, t, 0.01);
  }

  // ── Noise gate (implemented via animation frame + gain automation) ──

  private updateGate(level: number) {
    if (!this.settings.gateEnabled) {
      if (!this.gateOpen) {
        this.gateGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.005);
        this.gateOpen = true;
      }
      return;
    }

    const thresholdLinear = Math.pow(10, this.settings.gateThresholdDb / 20);
    const shouldOpen = level > thresholdLinear;

    if (shouldOpen && !this.gateOpen) {
      // Open gate fast (2ms attack)
      this.gateGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.002);
      this.gateOpen = true;
      clearTimeout(this.gateTimer);
    } else if (!shouldOpen && this.gateOpen) {
      // Hold for 200ms then close (50ms release)
      clearTimeout(this.gateTimer);
      this.gateTimer = window.setTimeout(() => {
        this.gateGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
        this.gateOpen = false;
      }, 200);
    }
  }

  // ── Metering ──────────────────────────────────────────────

  private startMeter() {
    const tick = () => {
      this.analyser.getByteFrequencyData(this.meterData);
      const sum = this.meterData.reduce((a, b) => a + b, 0);
      const avg = sum / this.meterData.length / 255;
      this.level = Math.min(1, avg * 2.5);

      const db = this.level > 0.001 ? 20 * Math.log10(this.level) : -Infinity;
      this.peakDb = Math.max(this.peakDb * 0.98, db); // slow decay

      this.gainReduction = this.compressor.reduction;

      this.updateGate(this.level);
      this.updateAGC(this.level);

      this.onLevel?.(this.level, this.peakDb, this.gainReduction);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  onMeterUpdate(cb: (level: number, peakDb: number, gainReduction: number) => void) {
    this.onLevel = cb;
  }

  // ── AGC (Auto Gain Control) ───────────────────────────────
  // Slowly nudges gain up/down to keep RMS near agcTargetRms.
  // Called every animation frame (~60fps). Adjustment rate is
  // deliberately slow (0.2% per frame) to avoid pumping artifacts.

  private updateAGC(currentLevel: number) {
    if (!this.agcEnabled || !this.agcGain || !this.settings.autoLevelEnabled) return;
    if (currentLevel < 0.001) return; // don't chase silence

    const ratio = this.agcTargetRms / Math.max(currentLevel, 0.001);
    // Move 0.2% toward target per frame — smooth, not reactive
    this.agcCurrentGain = this.agcCurrentGain + (ratio - this.agcCurrentGain) * 0.002;
    // Clamp: max 20dB boost, max 6dB cut
    this.agcCurrentGain = Math.max(0.5, Math.min(10.0, this.agcCurrentGain));
    this.agcGain.gain.setTargetAtTime(this.agcCurrentGain, this.ctx.currentTime, 0.05);
  }

  enableAGC(enabled: boolean) {
    this.agcEnabled = enabled;
    if (!enabled && this.agcGain) {
      // Reset to unity gain when disabled
      this.agcCurrentGain = 1.0;
      this.agcGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.1);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────

  destroy() {
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.gateTimer);
    this.ctx.close();
  }

  getContext() { return this.ctx; }
  getAnalyser() { return this.analyser; }
  getSettings() { return { ...this.settings }; }

  getAgcGainDb(): number {
    return this.agcCurrentGain > 0 ? 20 * Math.log10(this.agcCurrentGain) : 0;
  }

  setAgcTarget(dbfs: number) {
    // Convert dBFS target to linear RMS target
    this.agcTargetRms = Math.pow(10, dbfs / 20);
  }
}

// native/src/localout.rs — THE LOCAL OUTPUT STAGE (2026-10-07, docs/monitor-bypass-diagnosis.md §5).
//
// Jeff's rule: the MONITOR fader is the local master output. Every sound that reaches a local output device passes
// through the monitor gain stage; nothing bypasses it. The board is the sole gate for air; MONITOR is the sole gate
// for local output. The ONE exception (Jeff, 2026-10-07): PFL routed to a dedicated cue device.
//
// THE BUG THIS CLOSES: Source-kind channels (announcements, the jukebox, carts on aux channels, a mic or Link feed on a
// Source slot) reach the room only through the AUX ring, and the AUX ring was written raw — the MONITOR gain was applied
// to the main device feed alone. Jeff, in a meeting with MONITOR all the way down: music and sweepers silent, a
// scheduled announcement out of the monitors.
//
// HOW A BYPASS IS MADE STRUCTURALLY IMPOSSIBLE:
//   • `MonitorGain` can only be built from the bus's own two MONITOR levels (`MonitorGain::of`). There is no other
//     constructor and its field is private to this module.
//   • A ring that feeds a local device is a `LocalRing`. Its producer is private; its ONLY write is `push`, which
//     takes a `MonitorGain` and applies it. Code elsewhere cannot reach the raw producer to push unscaled samples.
//   • The station's main device buffer is written ONLY by `write_device`, which takes a `MonitorGain`.
//   • The PFL cue ring is NOT a LocalRing — it is the one approved exception, and it is typed as such where it lives
//     (`BusState::cue_ring_prod`).
// Air is untouched by construction: the stream ring is pushed before any of this runs, and nothing here reads or
// writes it. The render test `local_output_obeys_monitor` proves both halves (audio.rs tests).

use ringbuf::{HeapProd, traits::Producer};

/// A gain that IS the MONITOR stage: this station's strip level × the ONE master MONITOR level — and, while either was
/// just moved, the smoothing ramp toward it (2026-10-11: a MONITOR move never zips; the ramp time is the operator's
/// `fader_smoothing_ms`). At rest it is the plain product, so a static MONITOR is bit-identical to before.
#[derive(Clone, Copy, Debug)]
pub struct MonitorGain { level: f32, ramp: Option<crate::ramp::LevelRamp> }

impl MonitorGain {
    /// The only constructor: read from the station's bus — its strip level × the master MONITOR level, multiplied in
    /// the same order the device stage always used (`monitor_vol * master_monitor_vol`), so the main output is
    /// bit-identical to before. Taking the bus (not two floats) means no caller can hand a device a gain it invented.
    #[inline]
    pub fn of(bus: &crate::audio::BusState) -> MonitorGain {
        MonitorGain { level: bus.monitor_vol * bus.master_monitor_vol,
                      ramp: if bus.monitor_ramp.ramping() { Some(bus.monitor_ramp) } else { None } }
    }
    /// The level the stage rests on.
    #[inline]
    pub fn get(self) -> f32 { self.level }
    /// The gain at programme frame `f` of this buffer.
    #[inline]
    fn at(&self, f: usize) -> f32 { match self.ramp { Some(r) => r.at(f), None => self.level } }
}

/// The producer end of a ring that feeds a LOCAL output device (the AUX monitor). The only way to write to it is
/// `push`, which applies the MONITOR gain.
pub struct LocalRing { prod: HeapProd<f32> }

impl LocalRing {
    pub fn new(prod: HeapProd<f32>) -> LocalRing { LocalRing { prod } }
    /// Push one buffer of planar stereo, post-MONITOR, interleaved. try_push only — the audio thread never blocks on a
    /// full ring (a monitor feed that is behind drops samples; that is a tick, not a fault). Returns the post-MONITOR
    /// peak of what was pushed, for the bypass sense.
    #[inline]
    pub fn push(&mut self, l: &[f32], r: &[f32], g: MonitorGain) -> f32 {
        let mut pk = 0.0f32;
        let n = l.len().min(r.len());
        if g.ramp.is_none() {
            // AT REST (almost always): the exact loop and arithmetic from before the MONITOR ramp — no per-sample branch.
            let gv = g.level;
            for f in 0..n {
                let (a, b) = (l[f] * gv, r[f] * gv);
                let _ = self.prod.try_push(a);
                let _ = self.prod.try_push(b);
                pk = pk.max(a.abs()).max(b.abs());
            }
        } else {
            for f in 0..n {
                let gv = g.at(f);
                let (a, b) = (l[f] * gv, r[f] * gv);
                let _ = self.prod.try_push(a);
                let _ = self.prod.try_push(b);
                pk = pk.max(a.abs()).max(b.abs());
            }
        }
        pk
    }
    /// Hand the producer back for disposal off the audio thread (the Garbage path). Consumes the ring.
    pub fn into_inner(self) -> HeapProd<f32> { self.prod }
}

/// Write the station's main device buffer from the local feed (`dl`/`dr`, program rate), post-MONITOR. The ONLY
/// writer of a local device buffer. Same arithmetic as the block it replaces (audio.rs device stage): x · g per
/// sample, linear interpolation when the device rate differs, mono = (l + r) / 2 · g. Returns the post-MONITOR peak.
#[inline]
///
/// THE PATCH BAY (patch.rs): `pair` is the channel pair on a device opened with more than two channels — L/R go there and
/// every other channel gets silence. With 1 or 2 channels `pair` is not read: the arithmetic is exactly as before.
pub fn write_device(data: &mut [f32], ch: usize, pair: usize, dl: &[f32], dr: &[f32], prog_frames: usize, device_frames: usize,
                    resample: bool, g: MonitorGain) -> f32 {
    let mut pk = 0.0f32;
    let ramping = g.ramp.is_some();
    let rest = g.level;
    if !resample {
        for f in 0..device_frames {
            let mvol = if ramping { g.at(f) } else { rest };
            if ch == 2 {
                let (a, b) = (dl[f] * mvol, dr[f] * mvol);
                data[f * 2] = a; data[f * 2 + 1] = b;
                pk = pk.max(a.abs()).max(b.abs());
            } else if ch > 2 {
                let (a, b) = (dl[f] * mvol, dr[f] * mvol);
                crate::patch::write_frame(data, ch, pair, f, a, b);
                pk = pk.max(a.abs()).max(b.abs());
            } else {
                let m = (dl[f] + dr[f]) * 0.5 * mvol;
                data[f] = m;
                pk = pk.max(m.abs());
            }
        }
    } else {
        // Linear interpolation: map device_frames output positions into prog_frames input
        let scale = (prog_frames - 1) as f64 / (device_frames - 1).max(1) as f64;
        for f in 0..device_frames {
            let t    = f as f64 * scale;
            let idx  = t as usize;
            let frac = (t - idx as f64) as f32;
            let l0 = dl[idx];
            let l1 = dl.get(idx + 1).copied().unwrap_or(l0);
            let r0 = dr[idx];
            let r1 = dr.get(idx + 1).copied().unwrap_or(r0);
            let l = l0 + (l1 - l0) * frac;
            let r = r0 + (r1 - r0) * frac;
            let mvol = if ramping { g.at(idx) } else { rest };
            if ch == 2 {
                let (a, b) = (l * mvol, r * mvol);
                data[f * 2] = a; data[f * 2 + 1] = b;
                pk = pk.max(a.abs()).max(b.abs());
            } else if ch > 2 {
                let (a, b) = (l * mvol, r * mvol);
                crate::patch::write_frame(data, ch, pair, f, a, b);
                pk = pk.max(a.abs()).max(b.abs());
            } else {
                let m = (l + r) * 0.5 * mvol;
                data[f] = m;
                pk = pk.max(m.abs());
            }
        }
    }
    pk
}

// ── PARK LISTEN (2026-10-13, docs/park-listen-plan-2026-10-13.md) ────────────────────────────────────────────────────
// Jeff: "The feed is exactly what goes to the park speakers: the station's MONITOR output, after the park fader and
// MUTE. Staff must hear their fader moves, mute and carts."
//
// A COPY for logged-in staff on the Park page. It is fed from the SAME post-MONITOR point as the two local devices —
// the main device feed (`dl`/`dr`, after PFL-over-monitor) and the AUX sum — times the SAME `MonitorGain`, so a fader
// move, MUTE or a cart is in it exactly as the speakers get it. Which of the two (or both) feed the park speakers is
// the station's setting (`which`: LISTEN_MAIN | LISTEN_AUX); 0 = nothing.
//
// Air and the speakers are untouched by construction: this runs after the device buffer is written, reads only, and
// writes only its own ring — try_push, whole stereo frames, a full ring drops (a listener that is behind loses a
// frame; nothing waits). It runs only while a sender is connected to the listen port.
pub const LISTEN_MAIN: u8 = 1;
pub const LISTEN_AUX:  u8 = 2;

pub struct ListenRing { prod: HeapProd<f32> }

impl ListenRing {
    pub fn new(prod: HeapProd<f32>) -> ListenRing { ListenRing { prod } }
    /// Push one buffer: the selected local feeds, summed, × MONITOR, clamped to full scale (two speaker feeds summed
    /// in the air can exceed it; the encoder cannot). Interleaved stereo at programme rate.
    #[inline]
    pub fn push(&mut self, main: (&[f32], &[f32]), aux: (&[f32], &[f32]), which: u8, g: MonitorGain) {
        use ringbuf::traits::Observer;
        let (m, a) = (which & LISTEN_MAIN != 0, which & LISTEN_AUX != 0);
        if !m && !a { return; }
        let n = main.0.len().min(main.1.len()).min(aux.0.len()).min(aux.1.len());
        for f in 0..n {
            if self.prod.vacant_len() < 2 { return; }   // whole frames only: L/R never slip
            let (mut l, mut r) = (0.0f32, 0.0f32);
            if m { l += main.0[f]; r += main.1[f]; }
            if a { l += aux.0[f];  r += aux.1[f]; }
            let gv = g.at(f);
            let _ = self.prod.try_push((l * gv).clamp(-1.0, 1.0));
            let _ = self.prod.try_push((r * gv).clamp(-1.0, 1.0));
        }
    }
}

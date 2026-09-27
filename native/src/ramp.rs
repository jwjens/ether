// ramp.rs — SLICE 7: the fader level ramp (docs/dsp-show-presets.md, Jeff's ruling 4).
//
// Every level the ENGINE applies (a drag, a Take, TAKE NOW, a restore) reaches the audio as a 20 ms raised-cosine
// ramp instead of a step at a buffer boundary, which clicks. A level that does not change never ramps: the callback
// then takes its existing arithmetic, so a render at static levels is bit-identical to the build before this.
//
// A ramp only runs while its channel is actually producing audio. A level set on a silent channel (stopped, paused,
// nothing loaded; or the whole programme silent, for the master) SNAPS — nothing can click, and a cold restart that
// restores the faders before anything plays renders exactly like faders set by hand.
//
// Plain Copy state, no allocation, computed on the audio thread from the level it adopted.

/// 20 ms at the programme rate — the channel rack's crossfade length (chdsp::EQ_XFADE_FRAMES).
pub const LEVEL_RAMP_FRAMES: u32 = crate::chdsp::EQ_XFADE_FRAMES as u32;

#[derive(Clone, Copy, Debug)]
pub struct LevelRamp {
    from: f32,
    to: f32,
    /// Frames of this ramp already played; `>= len` = at rest on `to`.
    pos: u32,
    /// The ramp length. The product uses LEVEL_RAMP_FRAMES; the no-click test's twin uses 0 (a hard step) to prove
    /// the test can see a click.
    len: u32,
    /// False until the first level is seen: the first level is where the channel starts, never a move.
    primed: bool,
}

impl Default for LevelRamp {
    fn default() -> Self { LevelRamp::with_len(LEVEL_RAMP_FRAMES) }
}

impl LevelRamp {
    pub const fn with_len(len: u32) -> Self { LevelRamp { from: 1.0, to: 1.0, pos: u32::MAX, len, primed: false } }

    /// Track the adopted level. `sounding` = this channel is producing audio this buffer.
    #[inline]
    pub fn follow(&mut self, target: f32, sounding: bool) {
        if !self.primed || !sounding || self.len == 0 {
            self.snap(target);
            return;
        }
        if target != self.to {
            // Mid-ramp, continue from where the gain IS, so a second move never jumps.
            self.from = self.at(0);
            self.to = target;
            self.pos = 0;
        }
    }

    #[inline]
    pub fn snap(&mut self, target: f32) {
        self.from = target;
        self.to = target;
        self.pos = u32::MAX;
        self.primed = true;
    }

    /// Is a ramp in progress this buffer? False = the caller uses the static level (today's arithmetic).
    #[inline]
    pub fn ramping(&self) -> bool { self.pos < self.len }

    /// The gain at frame `f` of this buffer.
    #[inline]
    pub fn at(&self, f: usize) -> f32 {
        let k = (self.pos as u64).saturating_add(f as u64);
        if k >= self.len as u64 { return self.to; }
        // raised cosine 0 → 1 over len frames: continuous in value and slope at both ends
        let w = 0.5 - 0.5 * (std::f64::consts::PI * k as f64 / self.len as f64).cos();
        (self.from as f64 + (self.to as f64 - self.from as f64) * w) as f32
    }

    #[inline]
    pub fn advance(&mut self, frames: usize) {
        if self.pos < self.len { self.pos = self.pos.saturating_add(frames as u32).min(self.len); }
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ramp_runs_20_ms_from_the_old_level_to_the_new_and_then_rests() {
        let mut r = LevelRamp::default();
        r.follow(1.0, true);                 // first level: a start, never a move
        assert!(!r.ramping());
        r.follow(0.25, true);
        assert!(r.ramping());
        assert_eq!(r.at(0), 1.0);
        let mid = r.at(LEVEL_RAMP_FRAMES as usize / 2);
        assert!((mid - 0.625).abs() < 1e-3, "midpoint {mid}");
        r.advance(LEVEL_RAMP_FRAMES as usize);
        assert!(!r.ramping());
        assert_eq!(r.at(0), 0.25);
    }

    #[test]
    fn a_level_set_on_a_silent_channel_snaps() {
        let mut r = LevelRamp::default();
        r.follow(1.0, true);
        r.follow(0.4, false);
        assert!(!r.ramping());
        assert_eq!(r.at(0), 0.4);
    }

    #[test]
    fn a_second_move_mid_ramp_continues_from_where_the_gain_is() {
        let mut r = LevelRamp::default();
        r.follow(1.0, true);
        r.follow(0.0, true);
        r.advance(300);
        let here = r.at(0);
        r.follow(1.0, true);
        assert_eq!(r.at(0), here);
    }
}

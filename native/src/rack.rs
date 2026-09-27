// ── SLICE 4 — THE RACK (docs/dsp-rack-framework.md) ──────────────────────────────────────────────────
//
// A rack is an ordered, fixed-capacity list of slots; each slot holds one module (or nothing) and an IN
// switch. The master rack has a PGM section (pre-split: the GEQ) and two BRANCH sections (LOCAL, STREAM:
// ride → limiter). Channel racks (slices 5–6) are the same shape with a different module set.
//
// THE TYPE RULE (spec §4 rule 6, "loudness normalization stays at program level"): a loudness module is
// UNREPRESENTABLE in a channel rack. There is no `Ride` variant in `ChannelModule`, so no code — and no
// parsed document — can put one there. Two proofs, both run by `npm run test:rust`:
//   · compile-time — the `compile_fail` doctest on `ChannelModule` (it must NOT compile), beside a doctest
//     of the same shape on `BranchModule` that MUST compile, so the failure cannot be a typo'd path;
//   · parse-time — `a_loudness_module_in_a_channel_rack_is_refused_at_parse` (serde refuses the document).
//
// The engine gets a rack as part of the ONE Params block (rt.rs) — typed, fixed-size, Copy — through the
// Slice 1 command path. The JSON document the daemon stores (station_config_kv `rack_master`) is parsed and
// validated here, with the same clamps the legacy commands always applied.

use serde::Deserialize;

/// Slots per master section, and per channel rack (the spec's Trim → Filters → Gate → EQ → Comp, + 1 spare).
pub const MASTER_SLOTS: usize = 4;
pub const CHANNEL_SLOTS: usize = 6;

/// Branch indices of MasterRack::branch (the processor's LOCAL / STREAM instances).
pub const BRANCH_LOCAL: usize = 0;
pub const BRANCH_STREAM: usize = 1;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GeqParams { pub bands: [f32; 10] }

/// Module 1 — the loudness ride (program_processor.rs LoudnessRide). A LOUDNESS module: branch racks only.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RideParams { pub target: f32, pub rate: f32, pub clamp: f32 }

/// Module 2 — the true-peak limiter (program_processor.rs TruePeakLimiter).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LimiterParams { pub ceiling: f32, pub release: f32 }

/// What a master PGM (pre-split) slot can hold.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PgmModule { Geq(GeqParams) }

/// What a master BRANCH slot can hold — the only place a loudness module exists.
///
/// ```
/// use ether_audio::rack::{BranchModule, RideParams};
/// let _ride = BranchModule::Ride(RideParams { target: -14.0, rate: 1.5, clamp: 12.0 });
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BranchModule { Ride(RideParams), Limiter(LimiterParams) }

/// What a CHANNEL rack slot can hold (slices 5–6 add Filters, Peq, Gate, Comp). There is no Ride variant —
/// a loudness module cannot be written, constructed or parsed into a channel rack:
///
/// ```compile_fail,E0599
/// use ether_audio::rack::{ChannelModule, RideParams};
/// // A loudness module is unrepresentable in a channel rack. If this ever compiles, the type rule is gone.
/// let _ride = ChannelModule::Ride(RideParams { target: -14.0, rate: 1.5, clamp: 12.0 });
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ChannelModule {
    /// SLICE 5 — HPF + LPF, each a 24 dB/oct Butterworth with its own IN (docs/dsp-channel-rack-eq.md §1.1).
    Filters(FilterParams),
    /// SLICE 5 — the 4-band parametric EQ; bands 1 and 4 can be shelves. The slot's IN is the PEQ's IN.
    Peq(PeqParams),
    /// SLICE 6 — the downward expander / gate (docs/dsp-channel-dynamics.md §1).
    Gate(GateParams),
    /// SLICE 6 — the feed-forward, soft-knee, RMS compressor. Channel DYNAMICS — never a loudness module.
    Comp(CompParams),
}

/// SLICE 6 — the expander/gate. `ratio` is the expansion ratio 1:ratio (1…5; 1:3–1:5 gates). `attack` = open time,
/// `release` = close time, `hold` keeps it open between words, `hysteresis` = how far below the threshold it must
/// fall before it closes (so it does not chatter). dB / ms.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateParams { pub threshold: f32, pub ratio: f32, pub depth: f32, pub attack: f32, pub hold: f32, pub release: f32, pub hysteresis: f32 }

/// SLICE 6 — the compressor. dB / ms. Knee = the width of the soft knee, centred on the threshold.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompParams { pub threshold: f32, pub ratio: f32, pub attack: f32, pub release: f32, pub makeup: f32, pub knee: f32 }

/// One filter of the Filters module: its own IN and its corner frequency.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilterStage { #[serde(rename = "in")] pub on: bool, pub freq: f32 }

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilterParams { pub hpf: FilterStage, pub lpf: FilterStage }

/// One PEQ band. `width` is in OCTAVES (Wheatstone's unit); `shelf` is honoured on bands 1 and 4 only.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PeqBand { pub freq: f32, pub gain: f32, pub width: f32, #[serde(default)] pub shelf: bool }

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PeqParams { pub bands: [PeqBand; 4] }

/// One slot: a module or nothing, and its IN switch.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slot<M: Copy> { pub module: Option<M>, pub input: bool }
impl<M: Copy> Default for Slot<M> { fn default() -> Self { Slot { module: None, input: true } } }

/// The master rack, as the callback runs it. Copy and fixed-size: it rides the boxed Params block.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MasterRack {
    /// MONITOR and STREAM carry identical modules (today's proc_split = false). The document parser mirrors
    /// LOCAL into STREAM when linked, so the engine always runs `branch` as given.
    pub link: bool,
    pub pgm: [Slot<PgmModule>; MASTER_SLOTS],
    pub branch: [[Slot<BranchModule>; MASTER_SLOTS]; 2],
    /// The GEQ's coefficient-recompute trigger (bumped by the dispatch thread when bands change), exactly
    /// the role Params::eq_version had.
    pub eq_version: u64,
}

/// A channel rack, one per fader (docs/dsp-channel-rack-eq.md). Default: empty — the harness nulls and nothing
/// changes on air until an operator adds a module (Jeff's ruling).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChannelRack { pub slots: [Slot<ChannelModule>; CHANNEL_SLOTS] }
impl Default for ChannelRack { fn default() -> Self { ChannelRack { slots: [Slot::default(); CHANNEL_SLOTS] } } }

// ── The shipped chain: "Ether v1 (shipped)" — the exact constants ProgramProcessor::new, the daemon and the
//    Processor panel have always used. A station with nothing stored runs this.
pub const SHIPPED_RIDE: RideParams = RideParams { target: -14.0, rate: 1.5, clamp: 12.0 };
pub const SHIPPED_LIMITER: LimiterParams = LimiterParams { ceiling: -1.0, release: 120.0 };

impl MasterRack {
    pub fn shipped() -> MasterRack {
        let mut pgm = [Slot::default(); MASTER_SLOTS];
        pgm[0] = Slot { module: Some(PgmModule::Geq(GeqParams { bands: [0.0; 10] })), input: true };
        let mut b = [Slot::default(); MASTER_SLOTS];
        b[0] = Slot { module: Some(BranchModule::Ride(SHIPPED_RIDE)), input: true };
        b[1] = Slot { module: Some(BranchModule::Limiter(SHIPPED_LIMITER)), input: true };
        MasterRack { link: true, pgm, branch: [b, b], eq_version: 0 }
    }
    fn find_ride(&self, br: usize) -> Option<usize> {
        self.branch[br].iter().position(|s| matches!(s.module, Some(BranchModule::Ride(_))))
    }
    fn find_limiter(&self, br: usize) -> Option<usize> {
        self.branch[br].iter().position(|s| matches!(s.module, Some(BranchModule::Limiter(_))))
    }
    /// The branch's ride (every valid rack has exactly one) and its IN.
    pub fn ride(&self, br: usize) -> (RideParams, bool) {
        match self.find_ride(br).map(|i| self.branch[br][i]) {
            Some(Slot { module: Some(BranchModule::Ride(p)), input }) => (p, input),
            _ => (SHIPPED_RIDE, true),
        }
    }
    pub fn limiter(&self, br: usize) -> (LimiterParams, bool) {
        match self.find_limiter(br).map(|i| self.branch[br][i]) {
            Some(Slot { module: Some(BranchModule::Limiter(p)), input }) => (p, input),
            _ => (SHIPPED_LIMITER, true),
        }
    }
    /// Edit the branch's ride in place (the legacy SetProcessorParams / SetProcessing commands land here).
    pub fn set_ride(&mut self, br: usize, p: RideParams) {
        if let Some(i) = self.find_ride(br) { let inp = self.branch[br][i].input; self.branch[br][i] = Slot { module: Some(BranchModule::Ride(p)), input: inp }; }
    }
    pub fn set_limiter(&mut self, br: usize, p: LimiterParams) {
        if let Some(i) = self.find_limiter(br) { let inp = self.branch[br][i].input; self.branch[br][i] = Slot { module: Some(BranchModule::Limiter(p)), input: inp }; }
    }
    /// The live-only bypasses (Jeff's 2026-09-07 ruling): IN of the ride / limiter slots.
    pub fn set_branch_in(&mut self, br: usize, ride_in: bool, limiter_in: bool) {
        if let Some(i) = self.find_ride(br) { self.branch[br][i].input = ride_in; }
        if let Some(i) = self.find_limiter(br) { self.branch[br][i].input = limiter_in; }
    }
    /// The GEQ's bands and whether it runs (present AND in). None bands when the GEQ was removed.
    pub fn geq(&self) -> (Option<[f32; 10]>, bool) {
        for s in self.pgm.iter() {
            if let Some(PgmModule::Geq(g)) = s.module { return (Some(g.bands), s.input); }
        }
        (None, false)
    }
    /// The legacy SetEq: new bands on the GEQ (adding it back at the first free slot if it was removed).
    pub fn set_geq_bands(&mut self, bands: [f32; 10]) {
        if let Some(s) = self.pgm.iter_mut().find(|s| matches!(s.module, Some(PgmModule::Geq(_)))) {
            s.module = Some(PgmModule::Geq(GeqParams { bands }));
        } else if let Some(s) = self.pgm.iter_mut().find(|s| s.module.is_none()) {
            *s = Slot { module: Some(PgmModule::Geq(GeqParams { bands })), input: true };
        }
    }
}

// ── The stored document (station_config_kv `rack_master`) — docs/dsp-rack-framework.md §1.1 ─────────────

fn yes() -> bool { true }

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlotDoc<M> {
    #[serde(default)] pub id: Option<String>,
    pub module: Option<M>,
    #[serde(rename = "in", default = "yes")] pub input: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MasterSectionsDoc {
    pub pgm: Vec<SlotDoc<PgmModule>>,
    pub local: Vec<SlotDoc<BranchModule>>,
    #[serde(default)] pub stream: Vec<SlotDoc<BranchModule>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MasterRackDoc { pub v: u32, pub link: bool, pub sections: MasterSectionsDoc }

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelSectionsDoc { pub ch: Vec<SlotDoc<ChannelModule>> }

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelRackDoc { pub v: u32, pub sections: ChannelSectionsDoc }

/// The edge clamps the legacy commands have always applied (SetProcessorParams / SetProcessing). Every value
/// between them is an operator's choice.
pub(crate) fn clamp_ride(p: RideParams) -> RideParams {
    RideParams { target: p.target.clamp(-30.0, -6.0), rate: p.rate.clamp(0.1, 12.0), clamp: p.clamp.clamp(0.0, 24.0) }
}
pub(crate) fn clamp_limiter(p: LimiterParams) -> LimiterParams {
    // The ceiling never reaches 0 dBTP (above about −0.3 the encoder makes inter-sample overs).
    LimiterParams { ceiling: p.ceiling.clamp(-12.0, -0.1), release: p.release.clamp(5.0, 2000.0) }
}
fn clean_bands(b: [f32; 10]) -> [f32; 10] { b.map(|g| if g.is_finite() { g } else { 0.0 }) }

fn branch_from(doc: &[SlotDoc<BranchModule>], name: &str) -> Result<[Slot<BranchModule>; MASTER_SLOTS], String> {
    if doc.len() > MASTER_SLOTS { return Err(format!("{}: {} slots (the rack holds {})", name, doc.len(), MASTER_SLOTS)); }
    let mut out = [Slot::default(); MASTER_SLOTS];
    let (mut rides, mut lims, mut last_lim, mut last_mod) = (0, 0, None, None);
    for (i, s) in doc.iter().enumerate() {
        out[i] = Slot {
            module: s.module.map(|m| match m {
                BranchModule::Ride(p) => BranchModule::Ride(clamp_ride(p)),
                BranchModule::Limiter(p) => BranchModule::Limiter(clamp_limiter(p)),
            }),
            input: s.input,
        };
        match s.module {
            Some(BranchModule::Ride(_)) => { rides += 1; last_mod = Some(i); }
            Some(BranchModule::Limiter(_)) => { lims += 1; last_lim = Some(i); last_mod = Some(i); }
            None => {}
        }
    }
    if rides != 1 || lims != 1 {
        return Err(format!("{}: a branch holds exactly one ride and one limiter (found {} and {}) — they cannot be removed", name, rides, lims));
    }
    if last_lim != last_mod {
        return Err(format!("{}: the limiter must be the last module in a branch — it is the ceiling guarantee", name));
    }
    Ok(out)
}

impl MasterRack {
    /// Parse and validate a stored document. Errors name what is wrong, for the operator.
    pub fn from_doc_json(json: &str) -> Result<MasterRack, String> {
        let doc: MasterRackDoc = serde_json::from_str(json).map_err(|e| format!("rack document: {}", e))?;
        if doc.v != 1 { return Err(format!("rack document version {} is not understood by this engine", doc.v)); }
        let s = &doc.sections;
        if s.pgm.len() > MASTER_SLOTS { return Err(format!("pgm: {} slots (the rack holds {})", s.pgm.len(), MASTER_SLOTS)); }
        let mut pgm = [Slot::default(); MASTER_SLOTS];
        let mut geqs = 0;
        for (i, d) in s.pgm.iter().enumerate() {
            pgm[i] = Slot { module: d.module.map(|PgmModule::Geq(g)| { geqs += 1; PgmModule::Geq(GeqParams { bands: clean_bands(g.bands) }) }), input: d.input };
        }
        if geqs > 1 { return Err("pgm: the master GEQ is one instance (it drives the air and room EQ pair)".into()); }
        let local = branch_from(&s.local, "local")?;
        let stream = if doc.link { local } else { branch_from(&s.stream, "stream")? };
        Ok(MasterRack { link: doc.link, pgm, branch: [local, stream], eq_version: 0 })
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// SLICE 5 — the channel rack document, its clamps, and the DSP PLAN the engine runs
// (docs/dsp-channel-rack-eq.md §1). Coefficients are computed HERE — on the dispatch thread, in f64 — and
// delivered in the Params block. The audio thread only ever runs biquads.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════

/// Ranges (spec §2, Wheatstone E-6 family values — "not confirmed Strata specs").
pub const HPF_HZ: (f32, f32) = (16.1, 500.0);
pub const LPF_HZ: (f32, f32) = (1_000.0, 20_200.0);
pub const PEQ_HZ: (f32, f32) = (16.1, 20_200.0);
pub const PEQ_GAIN_DB: f32 = 14.0;
pub const PEQ_WIDTH_OCT: (f32, f32) = (0.2, 3.0);
/// Centres and corners above this fraction of the sample rate are clamped (a biquad cannot sit AT Nyquist).
pub const NYQUIST_FRACTION: f64 = 0.45;

/// SLICE 6 ranges (spec §2, Jeff's rulings: makeup 0–24, knee 0–12, hysteresis 0–10, hold 0–500).
pub const COMP_THRESHOLD_DB: (f32, f32) = (-40.0, 10.0);
pub const COMP_RATIO: (f32, f32) = (1.0, 20.0);
pub const COMP_ATTACK_MS: (f32, f32) = (0.1, 330.0);
pub const COMP_RELEASE_MS: (f32, f32) = (50.0, 3000.0);
pub const COMP_MAKEUP_DB: (f32, f32) = (0.0, 24.0);
pub const COMP_KNEE_DB: (f32, f32) = (0.0, 12.0);
pub const GATE_THRESHOLD_DB: (f32, f32) = (-80.0, 0.0);
pub const GATE_RATIO: (f32, f32) = (1.0, 5.0);
pub const GATE_DEPTH_DB: (f32, f32) = (0.0, 40.0);
pub const GATE_ATTACK_MS: (f32, f32) = (0.1, 50.0);
pub const GATE_HOLD_MS: (f32, f32) = (0.0, 500.0);
pub const GATE_RELEASE_MS: (f32, f32) = (50.0, 3000.0);
pub const GATE_HYSTERESIS_DB: (f32, f32) = (0.0, 10.0);
/// The compressor's RMS window and the gate's detector (docs/dsp-channel-dynamics.md §1, ruling 1).
pub const COMP_RMS_MS: f64 = 5.0;
pub const GATE_DET_ATTACK_MS: f64 = 1.0;
pub const GATE_DET_DECAY_MS: f64 = 50.0;
/// The gain is recomputed every DYN_BLOCK samples and interpolated between (ruling 3).
pub const DYN_BLOCK: u32 = 4;

fn clamp_channel_module(m: ChannelModule) -> ChannelModule {
    let fin = |v: f32, d: f32| if v.is_finite() { v } else { d };
    let c = |v: f32, d: f32, r: (f32, f32)| fin(v, d).clamp(r.0, r.1);
    match m {
        ChannelModule::Gate(g) => ChannelModule::Gate(GateParams {
            threshold: c(g.threshold, -45.0, GATE_THRESHOLD_DB), ratio: c(g.ratio, 4.0, GATE_RATIO),
            depth: c(g.depth, 15.0, GATE_DEPTH_DB), attack: c(g.attack, 1.0, GATE_ATTACK_MS),
            hold: c(g.hold, 100.0, GATE_HOLD_MS), release: c(g.release, 150.0, GATE_RELEASE_MS),
            hysteresis: c(g.hysteresis, 3.0, GATE_HYSTERESIS_DB),
        }),
        ChannelModule::Comp(p) => ChannelModule::Comp(CompParams {
            threshold: c(p.threshold, -20.0, COMP_THRESHOLD_DB), ratio: c(p.ratio, 3.0, COMP_RATIO),
            attack: c(p.attack, 10.0, COMP_ATTACK_MS), release: c(p.release, 150.0, COMP_RELEASE_MS),
            makeup: c(p.makeup, 0.0, COMP_MAKEUP_DB), knee: c(p.knee, 6.0, COMP_KNEE_DB),
        }),
        ChannelModule::Filters(f) => ChannelModule::Filters(FilterParams {
            hpf: FilterStage { on: f.hpf.on, freq: fin(f.hpf.freq, 100.0).clamp(HPF_HZ.0, HPF_HZ.1) },
            lpf: FilterStage { on: f.lpf.on, freq: fin(f.lpf.freq, 10_000.0).clamp(LPF_HZ.0, LPF_HZ.1) },
        }),
        ChannelModule::Peq(p) => ChannelModule::Peq(PeqParams { bands: std::array::from_fn(|i| {
            let b = p.bands[i];
            PeqBand {
                freq: fin(b.freq, 1_000.0).clamp(PEQ_HZ.0, PEQ_HZ.1),
                gain: fin(b.gain, 0.0).clamp(-PEQ_GAIN_DB, PEQ_GAIN_DB),
                width: fin(b.width, 1.0).clamp(PEQ_WIDTH_OCT.0, PEQ_WIDTH_OCT.1),
                shelf: b.shelf && (i == 0 || i == 3),
            }
        }) }),
    }
}

impl ChannelRack {
    /// Parse and validate a stored channel document (`rack_ch_<slot>`). At most one Filters and one PEQ.
    pub fn from_doc_json(json: &str) -> Result<ChannelRack, String> {
        let doc: ChannelRackDoc = serde_json::from_str(json).map_err(|e| format!("channel rack document: {}", e))?;
        if doc.v != 1 { return Err(format!("channel rack document version {} is not understood by this engine", doc.v)); }
        if doc.sections.ch.len() > CHANNEL_SLOTS { return Err(format!("{} slots (a channel rack holds {})", doc.sections.ch.len(), CHANNEL_SLOTS)); }
        let mut r = ChannelRack::default();
        let (mut f, mut q, mut g, mut c) = (0, 0, 0, 0);
        for (i, d) in doc.sections.ch.iter().enumerate() {
            match d.module {
                Some(ChannelModule::Filters(_)) => f += 1, Some(ChannelModule::Peq(_)) => q += 1,
                Some(ChannelModule::Gate(_)) => g += 1, Some(ChannelModule::Comp(_)) => c += 1, None => {}
            }
            r.slots[i] = Slot { module: d.module.map(clamp_channel_module), input: d.input };
        }
        if f > 1 || q > 1 || g > 1 || c > 1 { return Err("a channel rack holds one each of Filters, Gate, PEQ and Compressor".into()); }
        Ok(r)
    }
    /// The DSP plan: the active biquads in slot order (HPF sections, LPF sections, PEQ bands), each with its
    /// stable stage id. An empty plan = nothing runs (the callback keeps today's exact arithmetic).
    pub fn plan(&self, fs: f64) -> ChainSpec {
        let mut c = ChainSpec::default();
        for s in self.slots.iter() {
            if !s.input { continue; }
            match s.module {
                Some(ChannelModule::Filters(f)) => {
                    if f.hpf.on { for (k, b) in butter4(f.hpf.freq as f64, fs, true).iter().enumerate() { c.push(STAGE_HPF + k as u8, *b); } }
                    if f.lpf.on { for (k, b) in butter4(f.lpf.freq as f64, fs, false).iter().enumerate() { c.push(STAGE_LPF + k as u8, *b); } }
                }
                Some(ChannelModule::Peq(p)) => {
                    for (k, b) in p.bands.iter().enumerate() {
                        if b.gain.abs() < 1e-6 { continue; }   // a 0 dB band is an exact identity: skipped
                        let bq = if b.shelf && k == 0 { rbj_low_shelf(b.freq as f64, b.gain as f64, b.width as f64, fs) }
                                 else if b.shelf && k == 3 { rbj_high_shelf(b.freq as f64, b.gain as f64, b.width as f64, fs) }
                                 else { rbj_peak(b.freq as f64, b.gain as f64, b.width as f64, fs) };
                        c.push(STAGE_PEQ + k as u8, bq);
                    }
                }
                Some(ChannelModule::Gate(g)) => c.push_dyn(STAGE_GATE, KIND_GATE, DynCoef::gate(&g, fs)),
                Some(ChannelModule::Comp(p)) => c.push_dyn(STAGE_COMP, KIND_COMP, DynCoef::comp(&p, fs)),
                None => {}
            }
        }
        c
    }
}

/// A normalized biquad (a0 = 1), f64.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Biquad { pub b0: f64, pub b1: f64, pub b2: f64, pub a1: f64, pub a2: f64 }
impl Biquad {
    fn norm(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Biquad {
        Biquad { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }
    /// |H(e^{jω})| in dB at `f` — the analytic response (tests, and the TS curve's parity fixture).
    pub fn mag_db(&self, f: f64, fs: f64) -> f64 {
        let w = 2.0 * std::f64::consts::PI * f / fs;
        let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
        let (nr, ni) = (self.b0 + self.b1 * c1 + self.b2 * c2, -(self.b1 * s1 + self.b2 * s2));
        let (dr, di) = (1.0 + self.a1 * c1 + self.a2 * c2, -(self.a1 * s1 + self.a2 * s2));
        10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10()
    }
}

/// Stage ids — stable across a change, so a crossfade can seed the new chain's state from the old one.
pub const STAGE_HPF: u8 = 0;   // 0, 1
pub const STAGE_LPF: u8 = 2;   // 2, 3
pub const STAGE_PEQ: u8 = 4;   // 4..7
pub const STAGE_GATE: u8 = 8;  // SLICE 6
pub const STAGE_COMP: u8 = 9;  // SLICE 6
pub const CHAIN_MAX: usize = 10;
/// What a stage is: a biquad, or a dynamics block (SLICE 6).
pub const KIND_BQ: u8 = 0;
pub const KIND_GATE: u8 = 1;
pub const KIND_COMP: u8 = 2;

/// The stages a channel runs, in order. Copy and fixed-size: it rides the Params block. A biquad stage uses `bq`,
/// a dynamics stage `dy`; `kind` says which.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChainSpec { pub n: usize, pub id: [u8; CHAIN_MAX], pub kind: [u8; CHAIN_MAX], pub bq: [Biquad; CHAIN_MAX], pub dy: [DynCoef; CHAIN_MAX] }
impl ChainSpec {
    fn push(&mut self, id: u8, bq: Biquad) {
        if self.n < CHAIN_MAX { self.id[self.n] = id; self.kind[self.n] = KIND_BQ; self.bq[self.n] = bq; self.n += 1; }
    }
    fn push_dyn(&mut self, id: u8, kind: u8, dy: DynCoef) {
        if self.n < CHAIN_MAX { self.id[self.n] = id; self.kind[self.n] = kind; self.dy[self.n] = dy; self.n += 1; }
    }
}

// ── SLICE 6 — the dynamics coefficients (dispatch thread, f64) and the static gain computers ─────────────────
/// Everything a dynamics stage needs at run time, computed here so the audio thread does no exp() for timing.
/// `atk` / `rel` are one-pole coefficients PER CONTROL BLOCK (DYN_BLOCK samples) on the gain reduction in dB.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DynCoef {
    pub det_a: f64, pub det_d: f64,
    pub atk: f64, pub rel: f64,
    pub thr: f64, pub ratio: f64, pub knee: f64, pub makeup: f64,
    pub depth: f64, pub hyst: f64, pub hold_blocks: u32,
}
fn one_pole(ms: f64, samples_per_step: f64, fs: f64) -> f64 { 1.0 - (-samples_per_step / (ms.max(1e-3) * 1e-3 * fs)).exp() }
impl DynCoef {
    pub fn comp(p: &CompParams, fs: f64) -> DynCoef {
        let b = DYN_BLOCK as f64;
        DynCoef {
            det_a: one_pole(COMP_RMS_MS, 1.0, fs), det_d: 0.0,
            atk: one_pole(p.attack as f64, b, fs), rel: one_pole(p.release as f64, b, fs),
            thr: p.threshold as f64, ratio: p.ratio as f64, knee: p.knee as f64, makeup: p.makeup as f64,
            ..DynCoef::default()
        }
    }
    pub fn gate(g: &GateParams, fs: f64) -> DynCoef {
        let b = DYN_BLOCK as f64;
        DynCoef {
            det_a: one_pole(GATE_DET_ATTACK_MS, 1.0, fs), det_d: one_pole(GATE_DET_DECAY_MS, 1.0, fs),
            atk: one_pole(g.attack as f64, b, fs), rel: one_pole(g.release as f64, b, fs),
            thr: g.threshold as f64, ratio: g.ratio as f64, depth: g.depth as f64, hyst: g.hysteresis as f64,
            hold_blocks: ((g.hold as f64) * 1e-3 * fs / b).round() as u32,
            ..DynCoef::default()
        }
    }
}
/// The compressor's static curve: gain reduction (dB, ≥ 0) at input level `x` dB — threshold `t`, ratio `r`, soft
/// knee `w` dB wide centred on `t` (Giannoulis–Massberg–Reiss). The TS transfer graph is pinned to this.
pub fn comp_gr_db(x: f64, t: f64, r: f64, w: f64) -> f64 {
    let d = x - t;
    let y = if w > 0.0 && 2.0 * d.abs() <= w { x + (1.0 / r - 1.0) * (d + w / 2.0).powi(2) / (2.0 * w) }
            else if 2.0 * d > w { t + d / r }
            else { x };
    x - y
}
/// The expander's static curve below threshold: (t − x)(r − 1) dB of reduction, capped at `depth`.
pub fn gate_gr_db(x: f64, t: f64, r: f64, depth: f64) -> f64 { if x >= t { 0.0 } else { ((t - x) * (r - 1.0)).min(depth) } }

fn w0(f: f64, fs: f64) -> f64 { 2.0 * std::f64::consts::PI * f.min(fs * NYQUIST_FRACTION) / fs }
/// Width in octaves → Q (the RBJ cookbook's bandwidth relation): Q = √(2^BW) / (2^BW − 1).
pub fn width_to_q(bw_oct: f64) -> f64 { let p = 2f64.powf(bw_oct); p.sqrt() / (p - 1.0) }

/// RBJ peaking EQ.
pub fn rbj_peak(f: f64, gain_db: f64, bw_oct: f64, fs: f64) -> Biquad {
    let a = 10f64.powf(gain_db / 40.0); let w = w0(f, fs); let al = w.sin() / (2.0 * width_to_q(bw_oct)); let c = w.cos();
    Biquad::norm(1.0 + al * a, -2.0 * c, 1.0 - al * a, 1.0 + al / a, -2.0 * c, 1.0 - al / a)
}
/// RBJ low shelf, with the band's Q.
pub fn rbj_low_shelf(f: f64, gain_db: f64, bw_oct: f64, fs: f64) -> Biquad {
    let a = 10f64.powf(gain_db / 40.0); let w = w0(f, fs); let c = w.cos(); let al = w.sin() / (2.0 * width_to_q(bw_oct));
    let t = 2.0 * a.sqrt() * al;
    Biquad::norm(a * ((a + 1.0) - (a - 1.0) * c + t), 2.0 * a * ((a - 1.0) - (a + 1.0) * c), a * ((a + 1.0) - (a - 1.0) * c - t),
                 (a + 1.0) + (a - 1.0) * c + t, -2.0 * ((a - 1.0) + (a + 1.0) * c), (a + 1.0) + (a - 1.0) * c - t)
}
/// RBJ high shelf, with the band's Q.
pub fn rbj_high_shelf(f: f64, gain_db: f64, bw_oct: f64, fs: f64) -> Biquad {
    let a = 10f64.powf(gain_db / 40.0); let w = w0(f, fs); let c = w.cos(); let al = w.sin() / (2.0 * width_to_q(bw_oct));
    let t = 2.0 * a.sqrt() * al;
    Biquad::norm(a * ((a + 1.0) + (a - 1.0) * c + t), -2.0 * a * ((a - 1.0) + (a + 1.0) * c), a * ((a + 1.0) + (a - 1.0) * c - t),
                 (a + 1.0) - (a - 1.0) * c + t, 2.0 * ((a - 1.0) - (a + 1.0) * c), (a + 1.0) - (a - 1.0) * c - t)
}
/// RBJ 2nd-order high-pass / low-pass section.
pub fn rbj_pass(f: f64, q: f64, fs: f64, high: bool) -> Biquad {
    let w = w0(f, fs); let c = w.cos(); let al = w.sin() / (2.0 * q);
    if high { Biquad::norm((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0, 1.0 + al, -2.0 * c, 1.0 - al) }
    else    { Biquad::norm((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0, 1.0 + al, -2.0 * c, 1.0 - al) }
}
/// 4th-order Butterworth = two cascaded sections, Q = 1/(2 cos π/8) and 1/(2 cos 3π/8).
pub fn butter4(f: f64, fs: f64, high: bool) -> [Biquad; 2] {
    let q1 = 1.0 / (2.0 * (std::f64::consts::PI / 8.0).cos());
    let q2 = 1.0 / (2.0 * (3.0 * std::f64::consts::PI / 8.0).cos());
    [rbj_pass(f, q1, fs, high), rbj_pass(f, q2, fs, high)]
}

/// A channel rack as the Params block carries it: the rack (echo), its plan (what runs) and a version the
/// callback adopts on change.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChannelRackParams { pub rack: ChannelRack, pub plan: ChainSpec, pub version: u64 }

#[cfg(test)]
mod tests {
    use super::*;

    fn chan_doc(on: bool) -> String {
        format!(r#"{{"v":1,"sections":{{"ch":[
            {{"id":"s-flt","module":{{"type":"filters","hpf":{{"in":true,"freq":100}},"lpf":{{"in":false,"freq":10000}}}},"in":{on}}},
            {{"id":"s-peq","module":{{"type":"peq","bands":[
                {{"freq":100,"gain":0,"width":1,"shelf":false}},{{"freq":1000,"gain":6,"width":1}},
                {{"freq":3000,"gain":0,"width":1}},{{"freq":8000,"gain":0,"width":1,"shelf":false}}]}},"in":{on}}}]}}}}"#)
    }

    #[test]
    fn channel_filters_and_peq_measure_the_computed_values() {
        let fs = 44_100.0;
        // HPF 100 Hz, 24 dB/oct Butterworth — the values computed for the proposal (§5)
        let h = butter4(100.0, fs, true);
        let hm = |f: f64| h[0].mag_db(f, fs) + h[1].mag_db(f, fs);
        println!("[ch-eq] HPF4 100 Hz: 100 Hz {:.3} dB · 50 Hz {:.3} dB · 25 Hz {:.3} dB", hm(100.0), hm(50.0), hm(25.0));
        assert!((hm(100.0) + 3.010).abs() < 0.001 && (hm(50.0) + 24.100).abs() < 0.001 && (hm(25.0) + 48.165).abs() < 0.001);
        // PEQ 1 kHz +6 dB, 1 octave
        let b = rbj_peak(1000.0, 6.0, 1.0, fs);
        println!("[ch-eq] PEQ 1 kHz +6 dB 1 oct: 1 kHz {:.4} · 100 Hz {:.4} · 10 kHz {:.4}", b.mag_db(1000.0, fs), b.mag_db(100.0, fs), b.mag_db(10_000.0, fs));
        assert!((b.mag_db(1000.0, fs) - 6.0).abs() < 1e-9);
        assert!((b.mag_db(100.0, fs) - 0.0328).abs() < 0.0005 && (b.mag_db(10_000.0, fs) - 0.0224).abs() < 0.0005);
        // LPF 10 kHz mirrors the HPF
        // LPF mirrors the HPF one octave up from a corner well below Nyquist. (At a 10 kHz corner, 20 kHz is
        // near Nyquist and the bilinear transform's warping makes it far steeper: −71.7 dB, not −24.1 — the
        // proposal's LPF bar was wrong for a digital filter and is corrected here.)
        let l = butter4(2_000.0, fs, false);
        let lm = |f: f64| l[0].mag_db(f, fs) + l[1].mag_db(f, fs);
        let l10 = butter4(10_000.0, fs, false);
        println!("[ch-eq] LPF4 2 kHz: 2 kHz {:.3} dB · 4 kHz {:.3} dB   (LPF4 10 kHz at 20 kHz: {:.1} dB, bilinear warping near Nyquist)",
                 lm(2_000.0), lm(4_000.0), l10[0].mag_db(20_000.0, fs) + l10[1].mag_db(20_000.0, fs));
        assert!((lm(2_000.0) + 3.010).abs() < 0.01);
        assert!((lm(4_000.0) + 24.819).abs() < 0.001, "the computed digital value (warping adds 0.7 dB to the analog 24.1)");
        assert!((width_to_q(0.2) - 7.21).abs() < 0.01 && (width_to_q(3.0) - 0.404).abs() < 0.001);
        // Shelves reach their gain away from the corner and are flat on the other side. The shelf uses the band's
        // width → Q; above Q 0.707 (a width under ~1.9 octaves) an RBJ shelf BUMPS near its corner — the
        // cookbook's own behaviour, drawn by the curve. At width 2.0 oct (Q 0.667) there is no bump:
        let ls = rbj_low_shelf(200.0, 6.0, 2.0, fs);
        let bump = rbj_low_shelf(200.0, 6.0, 1.0, fs);
        println!("[ch-eq] low shelf 200 Hz +6, width 2 oct (Q {:.3}): 40 Hz {:.3} · 4 kHz {:.3} · (width 1 oct, Q {:.3}: 40 Hz {:.3} — the bump)",
                 width_to_q(2.0), ls.mag_db(40.0, fs), ls.mag_db(4000.0, fs), width_to_q(1.0), bump.mag_db(40.0, fs));
        assert!((ls.mag_db(40.0, fs) - 6.0).abs() < 0.1 && ls.mag_db(4000.0, fs).abs() < 0.1);
        let hs = rbj_high_shelf(4000.0, -6.0, 2.0, fs);
        println!("[ch-eq] high shelf 4 kHz −6, width 2 oct: 16 kHz {:.3} · 200 Hz {:.3}", hs.mag_db(16_000.0, fs), hs.mag_db(200.0, fs));
        assert!((hs.mag_db(16_000.0, fs) + 6.0).abs() < 0.15 && hs.mag_db(200.0, fs).abs() < 0.1);
    }

    #[test]
    fn a_channel_plan_runs_only_what_is_in() {
        let on = ChannelRack::from_doc_json(&chan_doc(true)).unwrap();
        let p = on.plan(44_100.0);
        assert_eq!(p.n, 3, "HPF (2 sections) + one non-zero PEQ band; LPF off, 0 dB bands skipped");
        assert_eq!(&p.id[..3], &[STAGE_HPF, STAGE_HPF + 1, STAGE_PEQ + 1]);
        let off = ChannelRack::from_doc_json(&chan_doc(false)).unwrap();
        assert_eq!(off.plan(44_100.0).n, 0, "modules present but OUT run nothing");
        assert_eq!(ChannelRack::default().plan(44_100.0).n, 0);
        // clamps: the Wheatstone ranges
        let wild = chan_doc(true).replace(r#""freq":100}"#, r#""freq":5}"#).replace(r#""gain":6"#, r#""gain":40"#);
        let r = ChannelRack::from_doc_json(&wild).unwrap();
        match (r.slots[0].module, r.slots[1].module) {
            (Some(ChannelModule::Filters(f)), Some(ChannelModule::Peq(q))) => { assert_eq!(f.hpf.freq, 16.1); assert_eq!(q.bands[1].gain, 14.0); }
            x => panic!("{:?}", x),
        }
    }

    fn shipped_json() -> String {
        r#"{"v":1,"link":true,"sections":{
            "pgm":[{"id":"s-geq","module":{"type":"geq","bands":[0,0,0,0,0,0,0,0,0,0]},"in":true}],
            "local":[{"id":"s-ride","module":{"type":"ride","target":-14,"rate":1.5,"clamp":12},"in":true},
                     {"id":"s-lim","module":{"type":"limiter","ceiling":-1.0,"release":120},"in":true}],
            "stream":[]}}"#.to_string()
    }

    #[test]
    fn the_shipped_document_parses_to_the_shipped_rack() {
        let r = MasterRack::from_doc_json(&shipped_json()).unwrap();
        assert_eq!(r, MasterRack::shipped());
    }

    #[test]
    fn a_loudness_module_in_a_channel_rack_is_refused_at_parse() {
        let doc = r#"{"v":1,"sections":{"ch":[{"module":{"type":"ride","target":-14,"rate":1.5,"clamp":12},"in":true}]}}"#;
        let e = serde_json::from_str::<ChannelRackDoc>(doc).unwrap_err().to_string();
        println!("[type-rule] channel rack with a ride → {}", e);
        assert!(e.contains("unknown variant `ride`"), "{}", e);
        // and the PGM section cannot hold one either (loudness is per branch)
        let pgm = shipped_json().replace(r#"{"type":"geq","bands":[0,0,0,0,0,0,0,0,0,0]}"#, r#"{"type":"ride","target":-14,"rate":1.5,"clamp":12}"#);
        let e2 = MasterRack::from_doc_json(&pgm).unwrap_err();
        println!("[type-rule] PGM section with a ride → {}", e2);
        assert!(e2.contains("unknown variant `ride`"), "{}", e2);
        // an empty channel rack is fine, and so are the slice 5 modules
        assert!(serde_json::from_str::<ChannelRackDoc>(r#"{"v":1,"sections":{"ch":[{"module":null}]}}"#).is_ok());
        assert!(ChannelRack::from_doc_json(&chan_doc(true)).is_ok());
    }

    #[test]
    fn the_limiter_is_pinned_last_and_neither_module_can_be_removed() {
        let swapped = shipped_json().replace(
            r#"{"id":"s-ride","module":{"type":"ride","target":-14,"rate":1.5,"clamp":12},"in":true},
                     {"id":"s-lim","module":{"type":"limiter","ceiling":-1.0,"release":120},"in":true}"#,
            r#"{"id":"s-lim","module":{"type":"limiter","ceiling":-1.0,"release":120},"in":true},
                     {"id":"s-ride","module":{"type":"ride","target":-14,"rate":1.5,"clamp":12},"in":true}"#);
        let e = MasterRack::from_doc_json(&swapped).unwrap_err();
        assert!(e.contains("must be the last module"), "{}", e);
        let no_lim = shipped_json().replace(r#",
                     {"id":"s-lim","module":{"type":"limiter","ceiling":-1.0,"release":120},"in":true}"#, "");
        let e = MasterRack::from_doc_json(&no_lim).unwrap_err();
        assert!(e.contains("exactly one ride and one limiter"), "{}", e);
    }

    #[test]
    fn clamps_are_the_legacy_commands_clamps_and_link_mirrors() {
        let j = shipped_json().replace(r#""target":-14"#, r#""target":-99"#).replace(r#""ceiling":-1.0"#, r#""ceiling":0.5"#);
        let r = MasterRack::from_doc_json(&j).unwrap();
        assert_eq!(r.ride(BRANCH_LOCAL).0.target, -30.0);
        assert_eq!(r.limiter(BRANCH_LOCAL).0.ceiling, -0.1);
        assert_eq!(r.branch[BRANCH_STREAM], r.branch[BRANCH_LOCAL], "linked: stream mirrors local");
    }
}

#[cfg(test)]
mod geq_slot_tests {
    #[test]
    fn a_bypassed_geq_is_bit_identical_to_a_flat_one() {
        let flat = crate::eq::new_shared_eq(44_100.0);
        let byp = crate::eq::new_shared_eq(44_100.0);
        {
            let mut b = byp.lock().unwrap();
            b.set_bands(&[4.0, 4.0, 0.0, 0.0, 0.0, -3.0, 0.0, 0.0, 2.0, 0.0]);
            b.bypass = true;
        }
        let (mut f, mut b) = (flat.lock().unwrap(), byp.lock().unwrap());
        let mut same = true;
        for i in 0..441_000usize {
            let x = 0.5 * (i as f32 * 0.0137).sin() + 0.2 * (i as f32 * 0.31).sin();
            let (fl, fr) = f.process_stereo(x, -x);
            let (bl, br) = b.process_stereo(x, -x);
            same &= fl.to_bits() == bl.to_bits() && fr.to_bits() == br.to_bits();
        }
        println!("[geq-slot] non-flat GEQ with its slot OUT vs a flat GEQ, 10 s: bit-identical = {}", same);
        assert!(same);
    }
}

// ── SLICE 5 — THE TS CURVE = THE ENGINE (docs/dsp-channel-rack-eq.md §5) ─────────────────────────────────
// The EQ curve the operator sees is drawn from a TS port of the coefficient functions above
// (src/components/rack/eqMath.ts). This pins the two together through ONE committed fixture: 50 deterministic
// parameter sets and the engine's coefficients for each. Here the fixture must equal what Rust computes,
// bit for bit; in vitest (eqMath.test.ts) TS must match it to 1e-9 relative. Regenerate only on purpose:
//   ETHER_WRITE_EQ_FIXTURE=1 cargo test --release --lib rack::ts_parity
#[cfg(test)]
mod ts_parity {
    use super::*;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/components/rack/eqCoeffs.fixture.json");

    fn cases() -> serde_json::Value {
        let fs = 44_100.0;
        let mut s: u64 = 0x2545_F491_4F6C_DD1D;
        let mut rnd = move || { s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (s >> 11) as f64 / (1u64 << 53) as f64 };
        let kinds = ["peak", "low_shelf", "high_shelf", "hpf", "lpf"];
        let mut out = Vec::new();
        for i in 0..50 {
            let kind = kinds[i % 5];
            // log-uniform 16.1 Hz … 21 kHz (past the 0.45·fs clamp on purpose), gain ±14 dB, width 0.2…3 oct
            let f = 16.1 * (21_000.0f64 / 16.1).powf(rnd());
            let g = -14.0 + 28.0 * rnd();
            let w = 0.2 + 2.8 * rnd();
            let bq: Vec<Biquad> = match kind {
                "peak" => vec![rbj_peak(f, g, w, fs)],
                "low_shelf" => vec![rbj_low_shelf(f, g, w, fs)],
                "high_shelf" => vec![rbj_high_shelf(f, g, w, fs)],
                "hpf" => butter4(f, fs, true).to_vec(),
                _ => butter4(f, fs, false).to_vec(),
            };
            let resp: Vec<f64> = [31.5, 100.0, 1000.0, 10_000.0].iter().map(|&x| bq.iter().map(|b| b.mag_db(x, fs)).sum()).collect();
            out.push(serde_json::json!({
                "kind": kind, "f": f, "g": g, "w": w, "fs": fs,
                "bq": bq.iter().map(|b| [b.b0, b.b1, b.b2, b.a1, b.a2]).collect::<Vec<_>>(),
                "magDb": { "at": [31.5, 100.0, 1000.0, 10000.0], "db": resp },
            }));
        }
        serde_json::json!({
            "about": "SLICE 5 — the engine's channel-EQ coefficients (native/src/rack.rs) for 50 parameter sets. \
                      Generated by rack::ts_parity; the TS port (eqMath.ts) must match to 1e-9 relative. Do not edit by hand.",
            "cases": out,
        })
    }

    #[test]
    fn the_ts_curve_fixture_is_the_engines_coefficients() {
        let want = cases();
        if std::env::var("ETHER_WRITE_EQ_FIXTURE").ok().as_deref() == Some("1") {
            std::fs::write(FIXTURE, serde_json::to_string_pretty(&want).unwrap() + "\n").unwrap();
            println!("[ts-parity] wrote {}", FIXTURE);
        }
        let have: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE)
            .expect("the fixture is missing — generate it with ETHER_WRITE_EQ_FIXTURE=1")).unwrap();
        let (a, b) = (want["cases"].as_array().unwrap(), have["cases"].as_array().unwrap());
        assert_eq!(a.len(), b.len());
        let mut n = 0;
        // serde_json's default float PARSER (no `float_roundtrip` feature — the engine's dependency features are
        // not changed for a test) can land 1 ulp off, so numbers compare to 4 ulp; everything else exactly.
        fn same(x: &serde_json::Value, y: &serde_json::Value, worst: &mut f64) -> bool {
            match (x, y) {
                (serde_json::Value::Number(p), serde_json::Value::Number(q)) => {
                    let (p, q) = (p.as_f64().unwrap(), q.as_f64().unwrap());
                    let r = (p - q).abs() / p.abs().max(1e-300);
                    *worst = worst.max(r);
                    p == q || r <= 4.0 * f64::EPSILON
                }
                (serde_json::Value::Array(p), serde_json::Value::Array(q)) => p.len() == q.len() && p.iter().zip(q).all(|(p, q)| same(p, q, worst)),
                (serde_json::Value::Object(p), serde_json::Value::Object(q)) => p.len() == q.len() && p.iter().all(|(k, v)| q.get(k).map_or(false, |w| same(v, w, worst))),
                _ => x == y,
            }
        }
        let mut worst = 0.0f64;
        for (x, y) in a.iter().zip(b) {
            assert!(same(x, y, &mut worst), "the committed fixture is not what the engine computes: {} vs {}", x, y);
            n += x["bq"].as_array().unwrap().len() * 5;
        }
        println!("[ts-parity] {} cases, {} coefficients: the committed fixture equals the engine's (worst relative {:.1e}, bar 4 ulp)", a.len(), n, worst);
    }
}

// ── SLICE 6 — THE TS TRANSFER GRAPH = THE ENGINE (docs/dsp-channel-dynamics.md §2) ─────────────────────────────
// The dynamics editor draws the static curves from a TS port of comp_gr_db / gate_gr_db (src/components/rack/
// dynMath.ts). Pinned here to ONE committed fixture (dynCurve.fixture.json): 50 parameter sets × 9 input levels;
// vitest pins TS to it at 1e-9. Regenerate only on purpose: ETHER_WRITE_DYN_FIXTURE=1.
#[cfg(test)]
mod ts_dyn_parity {
    use super::*;
    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/components/rack/dynCurve.fixture.json");
    fn cases() -> serde_json::Value {
        let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut rnd = move || { s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (s >> 11) as f64 / (1u64 << 53) as f64 };
        let xs = [-80.0, -60.0, -45.5, -30.0, -21.0, -20.0, -17.25, -5.0, 10.0];
        let mut out = Vec::new();
        for i in 0..50 {
            if i % 2 == 0 {
                let (t, r, w) = (-40.0 + 50.0 * rnd(), 1.0 + 19.0 * rnd(), 12.0 * rnd());
                let gr: Vec<f64> = xs.iter().map(|&x| comp_gr_db(x, t, r, w)).collect();
                out.push(serde_json::json!({ "kind": "comp", "t": t, "r": r, "w": w, "x": xs, "gr": gr }));
            } else {
                let (t, r, d) = (-80.0 + 80.0 * rnd(), 1.0 + 4.0 * rnd(), 40.0 * rnd());
                let gr: Vec<f64> = xs.iter().map(|&x| gate_gr_db(x, t, r, d)).collect();
                out.push(serde_json::json!({ "kind": "gate", "t": t, "r": r, "depth": d, "x": xs, "gr": gr }));
            }
        }
        serde_json::json!({ "about": "SLICE 6 — the engine's static dynamics curves (native/src/rack.rs comp_gr_db / gate_gr_db). Generated by rack::ts_dyn_parity; the TS port (dynMath.ts) must match to 1e-9. Do not edit by hand.", "cases": out })
    }
    #[test]
    fn the_ts_dynamics_fixture_is_the_engines_curves() {
        let want = cases();
        if std::env::var("ETHER_WRITE_DYN_FIXTURE").ok().as_deref() == Some("1") {
            std::fs::write(FIXTURE, serde_json::to_string_pretty(&want).unwrap() + "\n").unwrap();
        }
        let have: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).expect("fixture missing")).unwrap();
        let (a, b) = (want["cases"].as_array().unwrap(), have["cases"].as_array().unwrap());
        assert_eq!(a.len(), b.len());
        let mut worst = 0f64;
        for (x, y) in a.iter().zip(b) {
            for (p, q) in x["gr"].as_array().unwrap().iter().zip(y["gr"].as_array().unwrap()) {
                let (p, q) = (p.as_f64().unwrap(), q.as_f64().unwrap());
                worst = worst.max((p - q).abs());
            }
        }
        println!("[ts-dyn-parity] {} cases × 9 levels: the committed fixture equals the engine's curves (worst |Δ| {:.1e} dB)", a.len(), worst);
        assert!(worst < 1e-12);
        // the spec's case, exactly
        assert!((comp_gr_db(-10.0, -20.0, 4.0, 6.0) - 7.5).abs() < 1e-12);
        assert_eq!(gate_gr_db(-60.0, -45.0, 5.0, 15.0), 15.0);
    }
}

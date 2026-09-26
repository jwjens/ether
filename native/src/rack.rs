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
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ChannelModule {}

impl<'de> Deserialize<'de> for ChannelModule {
    // Slice 4 has no channel modules, so every channel module in a document is refused — by name, so the
    // reason reaches the operator ("`ride` is not a channel module").
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Tag { #[serde(rename = "type")] ty: String }
        let t = Tag::deserialize(d)?;
        Err(serde::de::Error::custom(format!("`{}` is not a channel module (channel racks hold no modules yet; a loudness module never belongs in one)", t.ty)))
    }
}

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

/// A channel rack (slices 5–6). In slice 4 it can only be empty — which is what slice 4 promises.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChannelRack { pub slots: [Slot<ChannelModule>; CHANNEL_SLOTS] }

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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(e.contains("`ride` is not a channel module"), "{}", e);
        // and the PGM section cannot hold one either (loudness is per branch)
        let pgm = shipped_json().replace(r#"{"type":"geq","bands":[0,0,0,0,0,0,0,0,0,0]}"#, r#"{"type":"ride","target":-14,"rate":1.5,"clamp":12}"#);
        let e2 = MasterRack::from_doc_json(&pgm).unwrap_err();
        println!("[type-rule] PGM section with a ride → {}", e2);
        assert!(e2.contains("unknown variant `ride`"), "{}", e2);
        // an empty channel rack is fine — the only kind slice 4 has
        assert!(serde_json::from_str::<ChannelRackDoc>(r#"{"v":1,"sections":{"ch":[{"module":null}]}}"#).is_ok());
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

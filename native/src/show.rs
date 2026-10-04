// show.rs — SLICE 7: a show preset as the ENGINE applies it (docs/dsp-show-presets.md §3).
//
// The daemon (the blade) decides WHICH channels a Take touches (the live rule: a channel that is ON keeps what it
// has until it goes OFF). This module is what happens to the ones it hands over: every field, every channel and the
// master, written into the dispatch thread's Params copy in one go, so the callback adopts the whole show in ONE
// buffer, or none of it.
//
// Every setter here is ALSO the one the single-control command uses (SetMasterRack, SetChannelRack, SetDuckParams,
// SetAuxMonitor), so a Take and the same values set by hand are the same arithmetic — which is why a restored show
// nulls against a hand-set board.
//
// What a show can NOT do, structurally:
//   · open a channel. A slot carries `cut` (true = take it OFF) and nothing that means ON (Jeff's ruling 3);
//   · name a device, a mic patch or processing on/off — there are no such fields, and an unknown field is refused.

use serde::Deserialize;
use crate::rack::{ChannelRack, ChannelRackParams, MasterRack, BRANCH_LOCAL, BRANCH_STREAM};
use crate::rt::Params;
use crate::audio::{SlotKind, SLOT_COUNT};

/// One channel's part of a show. Every field optional: absent = leave it as it is.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ShowSlot {
    pub fader: Option<f32>,
    /// true = cut the channel (take it OFF). There is no way to say ON.
    pub cut: bool,
    pub duck: Option<bool>,
    pub duckable: Option<bool>,
    /// The room / aux monitor level (0…4) — every source fader (D/E/F, S1..S5), exactly as SetAuxMonitor.
    pub room: Option<f32>,
    pub rack: Option<ChannelRack>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DuckParams { pub depth_db: f32, pub threshold_db: f32, pub attack_ms: f32, pub hold_ms: f32, pub release_ms: f32 }

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ShowApply {
    pub slots: [Option<ShowSlot>; SLOT_COUNT],
    pub master_fader: Option<f32>,
    pub master_rack: Option<MasterRack>,
    pub duck: Option<DuckParams>,
    pub monitor: Option<f32>,
}

// ── The wire document (audio_apply_show) ─────────────────────────────────────────────────────────────────────
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SlotDoc {
    #[serde(default)] fader: Option<f32>,
    #[serde(default)] cut: Option<bool>,
    #[serde(default)] duck: Option<bool>,
    #[serde(default)] duckable: Option<bool>,
    #[serde(default)] room: Option<f32>,
    #[serde(default)] rack: Option<serde_json::Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DuckDoc { depth_db: f32, threshold_db: f32, attack_ms: f32, hold_ms: f32, release_ms: f32 }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MasterDoc {
    #[serde(default)] fader: Option<f32>,
    #[serde(default)] rack: Option<serde_json::Value>,
    #[serde(default)] duck: Option<DuckDoc>,
    #[serde(default)] monitor: Option<f32>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ShowDoc {
    #[serde(default)] slots: std::collections::BTreeMap<String, SlotDoc>,
    #[serde(default)] master: Option<MasterDoc>,
}

fn level(v: Option<f32>, what: &str, max: f32) -> Result<Option<f32>, String> {
    match v {
        Some(x) if !x.is_finite() || x < 0.0 || x > max => Err(format!("{what} {x} is not a level (0…{max})")),
        o => Ok(o),
    }
}

impl ShowApply {
    /// Parse and validate the whole show. ALL OR NOTHING: one bad field refuses the show, so a Take can never land
    /// half-applied.
    pub fn from_json(json: &str) -> Result<ShowApply, String> {
        let doc: ShowDoc = serde_json::from_str(json).map_err(|e| format!("show document: {}", e))?;
        let mut s = ShowApply::default();
        for (name, d) in doc.slots.iter() {
            let idx = crate::audio::deck_index(name).ok_or_else(|| format!("`{}` is not a fader (A–F, CART, S1–S5)", name))?;
            if d.cut == Some(false) {
                return Err(format!("{}: a show cannot turn a channel ON (only the operator can)", name));
            }
            let rack = match &d.rack {
                Some(v) => Some(ChannelRack::from_doc_json(&v.to_string()).map_err(|e| format!("{}: {}", name, e))?),
                None => None,
            };
            s.slots[idx] = Some(ShowSlot {
                fader: level(d.fader, &format!("{name} fader"), 4.0)?,
                cut: d.cut == Some(true),
                duck: d.duck,
                duckable: d.duckable,
                room: level(d.room, &format!("{name} room level"), 4.0)?,
                rack,
            });
        }
        if let Some(m) = doc.master {
            s.master_fader = level(m.fader, "master fader", 1.0)?;
            s.monitor = level(m.monitor, "monitor level", 4.0)?;
            if let Some(v) = m.rack { s.master_rack = Some(MasterRack::from_doc_json(&v.to_string())?); }
            if let Some(d) = m.duck {
                for x in [d.depth_db, d.threshold_db, d.attack_ms, d.hold_ms, d.release_ms] {
                    if !x.is_finite() { return Err("duck parameters must be numbers".into()); }
                }
                s.duck = Some(DuckParams { depth_db: d.depth_db, threshold_db: d.threshold_db, attack_ms: d.attack_ms, hold_ms: d.hold_ms, release_ms: d.release_ms });
            }
        }
        Ok(s)
    }

    /// Which faders this show touches.
    pub fn slot_indices(&self) -> impl Iterator<Item = usize> + '_ {
        self.slots.iter().enumerate().filter_map(|(i, s)| s.map(|_| i))
    }

    /// Write the whole show into the dispatch thread's copy. The caller sends ONE Params block after this.
    pub(crate) fn apply(&self, p: &mut Params, fs: f64) {
        for (i, s) in self.slots.iter().enumerate() {
            let Some(s) = s else { continue };
            if let Some(v) = s.fader { p.volume[i] = v; }
            if s.cut { p.muted[i] = true; }
            if let Some(d) = s.duck { p.duck_enabled[i] = d; }
            if let Some(d) = s.duckable { p.duck_duckable[i] = d; }
            if let Some(g) = s.room { set_room(p, i, g); }
            if let Some(r) = s.rack { set_channel_rack(p, i, r, fs); }
        }
        if let Some(v) = self.master_fader { set_master_fader(p, v); }
        if let Some(r) = self.master_rack { set_master_rack(p, r); }
        if let Some(d) = self.duck { set_duck_params(p, d); }
        if let Some(v) = self.monitor { set_monitor(p, v); }
    }
}

// ── The shared setters: the single-control commands and a Take are the same code ─────────────────────────────

/// SetAuxMonitor: the room level of a SOURCE fader — D/E/F and S1..S5, every slot whose layout kind is
/// SlotKind::Source (2026-10-04: "they all are just input sources and need to work interchangeably on all faders";
/// it was D/E/F only, so S1..S5 were silent in the room). A/B/C and CART are board channels and are refused, silently,
/// as always. Keyed on the slot's LAYOUT kind, not its current kind: a source fader dialled to sweepers keeps its row,
/// and the row then reaches it through room_gain on the room chain instead of the aux tap.
pub(crate) fn set_room(p: &mut Params, idx: usize, gain: f32) {
    if idx >= SLOT_COUNT || crate::audio::default_kind_for(idx) != SlotKind::Source { return; }
    p.aux_monitor_gain[idx] = gain.clamp(0.0, 4.0);
    if p.kind[idx] != SlotKind::Rotation { p.room_gain[idx] = gain.clamp(0.0, 4.0); }
}

/// SetSlotKind: WHICH BUS a slot joins. A/B/C are automation's decks and are never re-kinded: putting a rotation
/// deck on another bus is not something an operator can ask for by dialling a dropdown. The one setter the
/// dispatch thread and the tests share, so a test that sets a kind sets it exactly as the product does.
pub(crate) fn set_slot_kind(p: &mut Params, idx: usize, kind: &str) {
    if idx >= SLOT_COUNT || p.kind[idx] == SlotKind::Rotation { return; }
    // BOTH sweeper spellings: "jingle" is the value the board's Sweeper entry has always persisted
    // (src/lib/sourceKinds.ts isSweeperKind), "sweeper" the one this command was written for. Matching only one of them
    // meant a fader dialled to Sweeper on the board would join the aux bus instead of the programme.
    p.kind[idx] = if kind == "sweeper" || kind == "jingle" { SlotKind::Sweeper } else { SlotKind::Source };
}

/// SetChannelRack: the plan is computed here (dispatch thread, f64) and the version moves.
pub(crate) fn set_channel_rack(p: &mut Params, slot: usize, rack: ChannelRack, fs: f64) {
    if slot >= SLOT_COUNT { return; }
    let v = p.ch_rack[slot].version.wrapping_add(1);
    p.ch_rack[slot] = ChannelRackParams { rack, plan: rack.plan(fs), version: v };
}

/// SetMasterRack: the live-only ride/limiter bypasses are kept as the engine runs them; the GEQ's version moves
/// only when its bands change.
pub(crate) fn set_master_rack(p: &mut Params, new_rack: MasterRack) {
    let cur = p.rack;
    let mut r = new_rack;
    r.set_branch_in(BRANCH_LOCAL, cur.ride(BRANCH_LOCAL).1, cur.limiter(BRANCH_LOCAL).1);
    r.set_branch_in(BRANCH_STREAM, cur.ride(BRANCH_STREAM).1, cur.limiter(BRANCH_STREAM).1);
    r.eq_version = if r.geq().0 != cur.geq().0 { cur.eq_version.wrapping_add(1) } else { cur.eq_version };
    p.rack = r;
}

/// SetDuckParams: clamped at the edges only.
pub(crate) fn set_duck_params(p: &mut Params, d: DuckParams) {
    p.duck_depth_db   = d.depth_db.clamp(-60.0, 0.0);
    p.duck_threshold  = 10f32.powf(d.threshold_db.clamp(-90.0, 0.0) / 20.0);
    p.duck_attack_ms  = d.attack_ms.clamp(1.0, 1000.0);
    p.duck_hold_ms    = d.hold_ms.clamp(0.0, 5000.0);
    p.duck_release_ms = d.release_ms.clamp(1.0, 5000.0);
}

/// SetMasterVolume: 0…1 (master is an attenuator on air).
pub(crate) fn set_master_fader(p: &mut Params, v: f32) { p.master_vol = v.clamp(0.0, 1.0); }

/// SetMonitorVolume: the station's monitor level, 0…4 — the room only, never air.
pub(crate) fn set_monitor(p: &mut Params, v: f32) { p.monitor_vol = v.clamp(0.0, 4.0); }

#[cfg(test)]
mod tests {
    use super::*;

    const PEQ: &str = r#"{"v":1,"sections":{"ch":[{"module":{"type":"peq","bands":[{"freq":100,"gain":0,"width":1},{"freq":1000,"gain":6,"width":1},{"freq":3000,"gain":0,"width":1},{"freq":8000,"gain":0,"width":1}]},"in":true}]}}"#;

    #[test]
    fn a_show_parses_every_field_and_touches_only_the_slots_it_names() {
        let j = format!(r#"{{"slots":{{"D":{{"fader":0.5,"cut":true,"duck":true,"duckable":false,"room":0.7,"rack":{PEQ}}},"S1":{{"fader":0.9}}}},
                          "master":{{"fader":0.8,"monitor":0.6,"duck":{{"depthDb":-9,"thresholdDb":-40,"attackMs":20,"holdMs":300,"releaseMs":600}}}}}}"#);
        let s = ShowApply::from_json(&j).unwrap();
        assert_eq!(s.slot_indices().collect::<Vec<_>>(), vec![3, 7]);
        let d = s.slots[3].unwrap();
        assert_eq!((d.fader, d.cut, d.duck, d.duckable, d.room), (Some(0.5), true, Some(true), Some(false), Some(0.7)));
        assert!(d.rack.is_some());
        assert_eq!(s.master_fader, Some(0.8));
        assert_eq!(s.duck.unwrap().depth_db, -9.0);
    }

    #[test]
    fn a_show_cannot_turn_a_channel_on() {
        let e = ShowApply::from_json(r#"{"slots":{"A":{"cut":false}}}"#).unwrap_err();
        assert!(e.contains("cannot turn a channel ON"), "{e}");
    }

    #[test]
    fn a_show_carrying_a_device_or_processing_is_refused_whole() {
        for j in [r#"{"slots":{"D":{"fader":0.5,"device":"USB Mic"}}}"#,
                  r#"{"slots":{"S1":{"mic_input":"x"}}}"#,
                  r#"{"master":{"audio_output_device":"Speakers"}}"#,
                  r#"{"master":{"procLocal":true}}"#,
                  r#"{"pfl_cue_device":"Headphones"}"#] {
            assert!(ShowApply::from_json(j).is_err(), "accepted: {j}");
        }
    }

    #[test]
    fn a_bad_field_anywhere_refuses_the_whole_show() {
        assert!(ShowApply::from_json(r#"{"slots":{"D":{"fader":0.5},"Q":{"fader":0.5}}}"#).is_err());
        assert!(ShowApply::from_json(r#"{"slots":{"D":{"fader":-1}}}"#).is_err());
        assert!(ShowApply::from_json(r#"{"master":{"fader":1.5}}"#).is_err());
    }
}

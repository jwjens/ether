// native/src/patch.rs — THE PATCH BAY, OUTPUTS (step 1 of docs/ether-audio-patch-bay-plan.md, 2026-10-27).
//
// Jeff's Outputs answers (docs/outputs-section-plan-2026-10-27.md), which this module encodes:
//   1. Master is the existing main/monitor output, after the MONITOR fader, one per station. No new output.
//   2. Stalls: a setting, "If the output device stalls, switch to the Windows default", on or off. Until the user sets
//      it, warn on screen and keep retrying; never switch on its own.
//   3. AUX moves into Outputs (the Patch Bay).
//   + any device, channel pairs on devices with more than two channels, saved per computer, the screen shows the device
//     the engine actually opened, a missing device = a clear on-screen warning naming it, NO fallback.
// And from the plan: one output row may connect to several devices at once.
//
// Everything here is pure (no cpal, no threads), so the decisions are unit-tested; audio.rs does the opening.

/// Most devices one output row may feed at once. The first is the row's own stream (for Master, the station's clock);
/// the rest are fed through rings like the AUX monitor always was.
pub const MAX_DESTS: usize = 4;
/// Extra destinations per row (everything after the first).
pub const MAX_EXTRA: usize = MAX_DESTS - 1;

/// One crosspoint: a device and the channel pair on it. `pair` is the FIRST channel, 0-based and even: 0 = 1-2,
/// 2 = 3-4, 4 = 5-6 …
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Dest { pub device: String, pub pair: u16 }

impl Dest {
    /// The string the monitor-output thread compares to decide whether to reopen: a different device OR a different
    /// pair is a different destination.
    pub fn key(&self) -> String { if self.device.is_empty() { String::new() } else { format!("{}\u{1}{}", self.device, self.pair) } }
    pub fn pair_label(&self) -> String { format!("{}-{}", self.pair + 1, self.pair + 2) }
}

/// One station's output patch: each row's destinations, and Jeff's stall setting.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct OutputPatch {
    pub master: Vec<Dest>,
    pub aux: Vec<Dest>,
    pub cue: Vec<Dest>,
    /// None = the user has not set it: warn and keep retrying (answer 2). Some(true) = switch to the Windows default
    /// after repeated stalls. Some(false) = never switch.
    pub stall_switch: Option<bool>,
}

fn dests(v: Option<&serde_json::Value>) -> Vec<Dest> {
    let mut out: Vec<Dest> = Vec::new();
    for d in v.and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]) {
        let device = d.get("device").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        if device.is_empty() { continue; }
        let pair = d.get("pair").and_then(|x| x.as_u64()).unwrap_or(0).min(62) as u16 & !1;   // even, ≤ 62
        let dest = Dest { device, pair };
        if out.contains(&dest) { continue; }                 // the same crosspoint twice is one crosspoint
        if out.len() == MAX_DESTS { break; }
        out.push(dest);
    }
    out
}

/// `{"master":[{"device":"Speakers","pair":0}],"aux":[…],"cue":[…],"stall_switch":null|true|false}`
pub fn parse_patch(json: &str) -> Result<OutputPatch, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("output patch is not JSON: {}", e))?;
    if !v.is_object() { return Err("output patch must be an object".into()); }
    Ok(OutputPatch {
        master: dests(v.get("master")),
        aux: dests(v.get("aux")),
        cue: dests(v.get("cue")),
        stall_switch: v.get("stall_switch").and_then(|x| x.as_bool()),
    })
}

/// How many channels to open a device with for a pair, or None when the device has no such pair.
/// Pair 1-2 opens exactly as before (at most 2 channels) so every existing setup is unchanged; a higher pair opens the
/// device with all its channels so the pair exists.
pub fn open_channels(device_channels: u16, pair: u16) -> Option<u16> {
    if device_channels == 0 { return None; }
    if pair == 0 { return Some(device_channels.min(2).max(1)); }
    if pair as u32 + 2 <= device_channels as u32 { Some(device_channels) } else { None }
}

/// Write one stereo frame into a device buffer of `ch` channels at `pair`: L/R into the pair, silence everywhere else.
/// ch == 1 → the mono sum (as before); ch == 2 with pair 0 → exactly the old two writes.
#[inline]
pub fn write_frame(data: &mut [f32], ch: usize, pair: usize, f: usize, l: f32, r: f32) {
    if ch == 1 { data[f] = (l + r) * 0.5; return; }
    let base = f * ch;
    if ch == 2 { data[base] = l; data[base + 1] = r; return; }
    for c in 0..ch { data[base + c] = 0.0; }
    data[base + pair] = l;
    data[base + pair + 1] = r;
}

/// What the Master's own stream opens this time round.
#[derive(Debug, PartialEq, Eq)]
pub enum MasterOpen {
    /// The device the user patched (or, with nothing patched, the Windows default — the existing behaviour, shown
    /// by name on screen).
    Chosen,
    /// The Windows default, because the chosen device stalled repeatedly AND the user turned the stall switch on.
    DefaultAfterStalls,
}

/// Answer 2. `stalled_out` = the stall watcher's "this device has failed FALLBACK_AFTER times in a row".
/// A device that is simply MISSING never reaches this: not-found never counts as a stall, and never opens another device.
pub fn master_open_plan(chosen: Option<&str>, stalled_out: bool, stall_switch: Option<bool>) -> MasterOpen {
    if chosen.is_some() && stalled_out && stall_switch == Some(true) { MasterOpen::DefaultAfterStalls } else { MasterOpen::Chosen }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_patch_parses_and_keeps_order_pairs_and_the_stall_setting() {
        let p = parse_patch(r#"{"master":[{"device":"Speakers (Realtek)","pair":0},{"device":"MOTU","pair":2}],
            "aux":[{"device":"Bose","pair":0}],"cue":[],"stall_switch":true}"#).unwrap();
        assert_eq!(p.master, vec![Dest { device: "Speakers (Realtek)".into(), pair: 0 }, Dest { device: "MOTU".into(), pair: 2 }]);
        assert_eq!(p.aux.len(), 1);
        assert!(p.cue.is_empty());
        assert_eq!(p.stall_switch, Some(true));
    }

    #[test]
    fn unset_stall_switch_is_none_never_a_silent_default() {
        assert_eq!(parse_patch(r#"{"master":[]}"#).unwrap().stall_switch, None);
        assert_eq!(parse_patch(r#"{"stall_switch":null}"#).unwrap().stall_switch, None);
    }

    #[test]
    fn duplicates_blanks_and_odd_pairs_are_cleaned_and_rows_are_capped() {
        let p = parse_patch(r#"{"master":[{"device":"A"},{"device":"A","pair":0},{"device":" "},{"device":"B","pair":3},
            {"device":"C"},{"device":"D"},{"device":"E"}]}"#).unwrap();
        assert_eq!(p.master.iter().map(|d| (d.device.as_str(), d.pair)).collect::<Vec<_>>(),
                   vec![("A", 0), ("B", 2), ("C", 0), ("D", 0)]);   // B's odd pair 3 → 2; capped at MAX_DESTS
    }

    #[test]
    fn bad_json_is_an_error_not_an_empty_patch() {
        assert!(parse_patch("nope").is_err());
        assert!(parse_patch("[]").is_err());
    }

    #[test]
    fn pair_one_two_opens_exactly_as_before_and_higher_pairs_need_the_channels() {
        assert_eq!(open_channels(2, 0), Some(2));
        assert_eq!(open_channels(1, 0), Some(1));
        assert_eq!(open_channels(8, 0), Some(2), "pair 1-2 on an 8-channel interface: unchanged from today");
        assert_eq!(open_channels(8, 2), Some(8));
        assert_eq!(open_channels(8, 6), Some(8));
        assert_eq!(open_channels(8, 8), None, "9-10 does not exist on an 8-channel device");
        assert_eq!(open_channels(2, 2), None);
        assert_eq!(open_channels(0, 0), None);
    }

    #[test]
    fn write_frame_puts_the_pair_where_asked_and_silence_elsewhere() {
        let mut d = vec![9.0f32; 16];   // 2 frames × 8 channels, garbage first
        write_frame(&mut d, 8, 2, 1, 0.5, -0.25);
        assert_eq!(&d[8..16], &[0.0, 0.0, 0.5, -0.25, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(&d[0..8], &[9.0; 8], "other frames untouched");
        let mut s = vec![0.0f32; 4];
        write_frame(&mut s, 2, 0, 1, 0.1, 0.2);
        assert_eq!(s, vec![0.0, 0.0, 0.1, 0.2]);
        let mut m = vec![0.0f32; 2];
        write_frame(&mut m, 1, 0, 1, 0.2, 0.4);
        assert!((m[1] - 0.3).abs() < 1e-6);
    }

    #[test]
    fn stalls_switch_to_the_default_only_when_the_user_turned_it_on() {
        assert_eq!(master_open_plan(Some("Bose"), true, None), MasterOpen::Chosen, "unset: warn and keep retrying");
        assert_eq!(master_open_plan(Some("Bose"), true, Some(false)), MasterOpen::Chosen);
        assert_eq!(master_open_plan(Some("Bose"), true, Some(true)), MasterOpen::DefaultAfterStalls);
        assert_eq!(master_open_plan(Some("Bose"), false, Some(true)), MasterOpen::Chosen, "no stalls, no switch");
        assert_eq!(master_open_plan(None, true, Some(true)), MasterOpen::Chosen, "nothing chosen: already the default");
    }

    #[test]
    fn a_dest_key_changes_with_device_or_pair() {
        let a = Dest { device: "MOTU".into(), pair: 0 };
        let b = Dest { device: "MOTU".into(), pair: 2 };
        assert_ne!(a.key(), b.key());
        assert_eq!(Dest::default().key(), "");
        assert_eq!(b.pair_label(), "3-4");
    }
}

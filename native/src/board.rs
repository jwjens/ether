// native/src/board.rs — the board as the engine actually holds it (2026-10-11, docs/board-state-on-connect-diagnosis-2026-10-11.md).
//
// Jeff: "a fader is never asleep. Whatever the board shows must be live in the engine from the moment Ether opens."
// Until this existed the engine could not say what it held: after a fresh start every Source fader was silent in the
// room, and which value was missing could only be inferred from meters. `audio_get_board_state` answers with TWO copies
// of every operator-set value:
//   · control — the dispatch thread's authoritative Params (what the last command set);
//   · applied — the Params block the audio CALLBACK published with its latest meter frame (what the mix ran on).
// They differ only while a block is in flight. A lasting difference is a delivery fault, and naming it is the point.
use crate::audio::{SlotKind, SLOT_COUNT};
use crate::rt::Params;

pub(crate) const SLOT_NAMES: [&str; SLOT_COUNT] = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"];

fn kind_name(k: SlotKind) -> &'static str {
    match k { SlotKind::Rotation => "rotation", SlotKind::Sweeper => "sweeper", SlotKind::Source => "source" }
}

/// Every operator-set value in a Params block, keyed by fader name. Racks are summarised (their own kv reconcilers own
/// them); the levels, switches, rows and duck settings are exact.
pub(crate) fn params_json(p: &Params) -> serde_json::Value {
    let mut slots = serde_json::Map::new();
    for i in 0..SLOT_COUNT {
        slots.insert(SLOT_NAMES[i].to_string(), serde_json::json!({
            "volume": p.volume[i],
            "muted": p.muted[i],
            "kind": kind_name(p.kind[i]),
            "duck": p.duck_enabled[i],
            "duckable": p.duck_duckable[i],
            "aux_monitor_gain": p.aux_monitor_gain[i],
            "room_gain": p.room_gain[i],
            "pfl": p.pfl[i],
        }));
    }
    serde_json::json!({
        "slots": slots,
        "monitor_vol": p.monitor_vol,
        "master_vol": p.master_vol,
        "master_monitor_vol": p.master_monitor_vol,
        "proc_local": p.proc_local,
        "proc_stream": p.proc_stream,
        "duck_params": {
            "threshold": p.duck_threshold, "depth_db": p.duck_depth_db,
            "attack_ms": p.duck_attack_ms, "hold_ms": p.duck_hold_ms, "release_ms": p.duck_release_ms,
        },
        "pfl_dim_db": p.pfl_dim_db,
        "pfl_to_device": p.pfl_to_device,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_fader_is_reported_by_name_with_its_room_row() {
        let (prod, _c) = ringbuf::traits::Split::split(ringbuf::HeapRb::<f32>::new(64));
        let mut b = crate::audio::BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100,
                                                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)));
        let mut p = b.params();
        crate::show::set_room(&mut p, 7, 0.74);   // S1, as SetAuxMonitor does
        p.volume[4] = 0.15;                        // E
        b.apply_params(&p);
        let j = params_json(&b.params());
        assert_eq!(j["slots"].as_object().unwrap().len(), SLOT_COUNT);
        assert!((j["slots"]["S1"]["aux_monitor_gain"].as_f64().unwrap() - 0.74).abs() < 1e-6);
        assert!((j["slots"]["E"]["volume"].as_f64().unwrap() - 0.15).abs() < 1e-6);
        assert_eq!(j["slots"]["A"]["kind"], "rotation");
        assert_eq!(j["slots"]["S1"]["kind"], "source");
    }
}

# Live-mic routing verdict — 2026-07-09 (read-only discovery)

## Verdict: UNWIRED to the native engine (not "muted", not "gated-by-design")

The live mic is captured entirely in **Web Audio (`getUserMedia`)** and connects only to
`ctx.destination` (the browser's default output = local monitor). It **never reaches the Rust
mixer's program bus**, and therefore **never reaches the Icecast stream**. There is **no mic slot
in the native mixer** and **no NAPI export to push mic PCM into Rust**. Mic-to-stream WAS spec'd
(Phase B4) — it is simply **not implemented**. The local operator hears the mic; listeners never do.

## Receipts

**Capture — Web Audio only, no NAPI:**
- `src/components/MicDeck.tsx:113` `getUserMedia({audio})` → `:135` `analyser.connect(ctx.destination)` (local monitor works — so the doc line below that says "goes nowhere" is stale re: monitor).
- `src/components/MicChannel.tsx:40` `getUserMedia` → gain → `ctx.destination`; `:72` gain gated locally `isOn ? volume : 0`.
- No `invoke()` / IPC / pipe command on mic-open; purely React state + Web Audio graph.

**No mic slot in the Rust bus:**
- `native/src/audio.rs:129` deck flags = `a,b,c,d,e,f,cart` (7 slots, all file sources). No mic. (only "mic" hit is a lock comment at `:215`.)
- `mixer_callback` mixes decks A–F + CART into program bus + monitor; mic never enters the graph.

**Master/monitor vs stream split — mic in neither native bus:**
- Program bus (stream): `native/src/audio.rs` `ring_prod.try_push` gated on `STREAM_CLIENT_CONNECTED` — fed only by decks+cart.
- Studio monitor: `data[..] = out_l/out_r * monitor_vol` — fed only by decks+cart.
- Broadcast-delay path (`drain_program_bus`) operates on the program bus only — mic never present.

**No NAPI mic path:**
- `native/src/lib.rs` exports: `audio_load/play/pause/stop/set_volume/set_monitor_volume/get_state/get_levels/get_spectrum/set_broadcast_delay/dump/broadcast_delay_state/last_callback_ms/list_output_devices/set_output_device/get_program_bus_port/set_eq`. No `audio_mic_*` / PCM-push.

**Default state:** mic starts OFF (`MicDeck.tsx:51 micLive=false`; `MicChannel.tsx:12-13 isOn=false, gain 0`) until the operator engages it.

**Spec (intended, not built):**
- `docs/phase-a-amendment-4.md:118` bus table: "Mic Deck → Program Bus + Video Broadcast Bus when operator engages mic; off otherwise."
- `docs/phase-a-amendment-4.md:246-254` **Phase B4 — Mic Deck through Rust**: "Wire the captured mic stream into Rust (via NAPI audio buffer push). Rust routes to Program Bus when operator engages mic." Verification gate: voice audible in stream + monitor, absent from cue/editor.

## Is it a small safe fix? NO — it's a feature arc (Phase B4)

Getting mic → stream requires all of:
1. **Rust** — add a mic input source to `BusState` + route it into program bus (and monitor) in `mixer_callback`, with its own gain/mute + sample-rate handling.
2. **NAPI** — a new export to push mic PCM frames from JS into Rust (ring buffer, SR conversion, backpressure).
3. **Browser** — an AudioWorklet/ScriptProcessor in MicDeck to pull PCM off the `getUserMedia` graph and push it across.
4. **Daemon transport** — in daemon mode the **daemon** owns Icecast streaming in a separate process, so mic PCM must travel UI → daemon, not just into the in-process engine. This is the hard part.
5. Latency/echo/AGC + interaction with the broadcast-delay buffer.

Recommendation: **does NOT ride in 4.4.42.** It's its own arc (Phase B4), spanning Rust + NAPI + browser + daemon IPC. 4.4.42 should ship the jingles + command-path scoping fix as-is.

# Hold to talk: what it needs from the engine, and the risk (2026-10-16)

Nothing is built. This is the engine part of the build, for Jeff's OK before any engine code changes.
Governing plan: `docs/park-hold-to-talk-plan-2026-10-15.md` (and Jeff's answers in it).

## Jeff (verbatim)

> Listen works on the Park page. Priority now: build Hold to talk (the park mic), with the approved plan and answers:
> - A PARK TALK input source that shows on the board and can be put on any fader, like other sources.
> - That fader's audio goes to the park speakers through MONITOR, and to MAIN/stream when its "To stream" switch is ON (switch visible, saved, starts ON).
> - Music ducks under the voice with its own duck settings, starting at the station's current numbers. If that needs an engine change, tell me the risk before building it.
> - Limiter on the voice; longest talk 20 s; echo cancellation ON, noise suppression ON, auto gain OFF; all visible settings.
> - Logged-in staff only, one talker at a time, blocked by the studio lock, follows MUTE ("Park is muted. Unmute to be heard."), stop button in Ether by the strip, who/when shown in Ether.
> Build it into the next installer, path and sha256. The clocks diagnosis comes after this.

## What the engine does today (read from `native/src`)

- **A fader can already carry a live input.** The mic and the Remote Link install a *live feed* on a source slot: a
  ring filled off the audio thread, read on the audio thread by `micin::LiveIn` (resampling, never waits)
  (`audio.rs:3547-3566`, `apply_mic_actions` `:3730`, the callback's `src.live` branch `:4519`).
  From there the slot is "every other channel: meter, rack, fader, cut, duck".
  - Nothing can feed it *from another program* (the daemon's ffmpeg). The `network` kind is a placeholder
    (`src/lib/sourceKinds.ts:58`).
- **Every fader always goes to air.** In the mix loop every fader adds to the programme sum: `mix_l[f] += lv; // AIR —
  every fader, unchanged` (`audio.rs:4589`).
  - Its local feed is separate: the AUX row × MONITOR, or the main room row.
  - The fader and the channel ON switch silence both. There is no switch that takes one fader off air but keeps it local.
  - A source fader is **not doubled** in the park: its air copy never goes into the room sum (`:4600-4613`).
- **One ducker per station.** One set of five numbers (`duck_depth_db`, threshold, attack, hold, release; `audio.rs:746-755`),
  one detector (`det_l/det_r`: every fader with "ducks music" on), one `duck_gain`.
- **The channel rack has gate, compressor and EQ, but no limiter.** The compressor goes up to 20:1, attack from 0.1 ms
  (`rack.rs:299-304`). The −1 dBTP limiter exists only on the programme/branch processors.

## The engine changes Hold to talk needs

### E1. Live input from a local port (the "Park talk" source): needed, LOW risk

- **What:**
  - a new engine input that listens on a 127.0.0.1 port and puts what arrives (f32 PCM from the daemon's ffmpeg) into
    the same live-feed ring the mic uses;
  - one new command (`SetPcmInput { slot, port }`) and one NAPI call.
- **Where:** a new file (`pcmin.rs`), modelled on the Link's receiver: its own thread, never the audio thread.
- **Audio thread:** **no change.** It plays the ring through the existing `LiveIn`.
- **Risk:** low. It's isolated: off unless a fader is patched to Park talk.
  - Failure modes: the port can't be opened (refused, shown on the strip), or nothing arrives (silence, counted).
  - Existing goldens can't move, because no mixing code changes.

### E2. Per-fader "To stream" switch: needed, LOW–MEDIUM risk

- **What:** a per-fader `air_on` flag. When OFF, that fader skips the air sums (`mix`/`core`/`src`) but keeps its
  local (park) feed, its meter and its "ducks music" ear.
- **Audio thread:** **yes, the mix loop**: one branch per fader.
  - With every fader ON (the default, and what every existing station has), the arithmetic is the same operations in
    the same order. So the parity goldens (74/74 bit-exact) and the existing mix tests must stay identical, and they
    gate it.
- **Risk:** low–medium, because this is the hot loop every station plays through. Mitigations:
  - the default leaves the sums exactly as they are;
  - goldens plus new tests (OFF = absent from the stream, present in the park, still ducks).
- **Generic:** this is a switch on *every* fader, not a talk special. Faders are generic. The board shows it on the
  PARK TALK strip; whether to show it on every strip is Jeff's call (the plan: on the talk strip).

### E3. Talk's own duck settings: needed for "its own duck settings", MEDIUM risk

- **What:** a second detector with its own five numbers.
  - A fader can be set to use "its own duck" instead of the station's.
  - Its voice drives the second detector; every other ducking fader keeps driving the station's.
  - The music is pulled down by whichever of the two is deeper at that moment.
- **Audio thread:** **yes, the ducker block** (`audio.rs:~4700-4760`).
  - With no fader on its own duck, the second detector doesn't run and the existing path is untouched. The goldens
    check that.
- **Risk:** medium. The ducker affects the music on air at every station that ducks. Mitigations:
  - the default path stays byte-identical (goldens);
  - new tests: talk's numbers decide the dip while talk is on; the station's numbers stay unchanged for every other
    source; the deeper wins when both duck at once.
- **Without E3:** the talk fader ducks with the station's ducker numbers (one set for every source). That works today
  with no engine change, but it is not "its own duck settings".

### Limiter on the voice: two ways

- **L1 (no engine change):** the talk fader's channel rack gets a compressor set as a limiter: threshold = the ceiling,
  20:1, fast attack, the release you set, all shown on the strip's rack.
  - It is close to a limiter but not a hard ceiling. Peaks can pass by a dB or so for a few milliseconds.
  - The stream's own −1 dBTP limiter still guards the stream.
- **L2 (engine change, MEDIUM risk):** a true limiter module in the channel rack (reusing the programme limiter's
  detector).
  - It touches the rack code every channel runs through. It is off unless a fader adds it.

## Not engine (no OK needed beyond the GO)

- **Server:** talk floor and ticket, `/talk` and `/talk/stop`, the auth case, the lock check, the audit, and the talk
  state in `/public/ops`.
- **Park page:** the HOLD TO TALK button and states, the WHIP mic publisher, the meter and countdown, the mic-permission
  flow, Listen paused while talking.
- **Ether:**
  - the daemon receiver (ffmpeg RTSPS → the port);
  - `park:talk` with lease, 20 s limit, lock refusal and MUTE;
  - the "Park talk" source;
  - the To stream switch on the strip;
  - the stop button, the who/when line and the settings;
  - health events, a Health Monitor row, and the help doc.
- **Relay:** one MediaMTX path rule for `park/<station>/talk`. Server config, with Jeff's OK when it's time.

## Asked of Jeff

- OK for E1 and E2 (both needed for what was asked).
- E3: OK to build talk's own duck (medium risk), or use the station's ducker numbers for now (no engine change).
- Limiter: L1 (compressor as limiter, no engine change) or L2 (a true limiter, engine change)?

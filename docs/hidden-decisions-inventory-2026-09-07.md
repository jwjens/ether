# Hidden decisions — what Ether decides about your sound where you cannot see it

**Date:** 2026-09-07 · **READ-ONLY INVENTORY.** Nothing was changed, nothing is proposed. This is a list,
not a work plan. Jeff decides what gets touched and when.

**The question:** what else in Ether is a decision about how the station SOUNDS or WHAT AIRS that is made
in code, where the operator cannot see the value or change it?

**Scope searched:** `audiod/engine.js`, `audiod/loggen.js`, `native/src/audio.rs`,
`native/src/program_processor.rs`, `electron/generate-core.js`, and the generator/announcement paths in
`electron/main.js`.

**Count: 24 findings.** 19 are unsettable today; 3 are settable but with an invisible default; 2 were
surfaced during this session and are listed as closed so the record is complete.

Ranked by **what it costs if it is wrong**, not by how easy it is to change.

---

## The ten that cost the most

### 1 · The limiter ceiling — −1.0 dBTP

- **`native/src/program_processor.rs:20`** — `const CEILING_DBTP: f32 = -1.0;`
- **Decides:** the absolute loudness ceiling of everything that leaves the station.
- **If it is wrong:** too high and MP3/AAC encoding for Icecast produces inter-sample overs that clip on
  the *listener's* decoder — distortion you cannot hear locally. Too low and you are quietly the softest
  station on the dial.
- **Settable:** **no.** Compile-time constant.
- **Ever asked for:** no record. It arrived with Audio Processing v1 as an engineering default.

### 2 · The loudness ride's rate and clamp — 1.5 dB/s, ±12 dB

- **`native/src/program_processor.rs:160`** — `rate_db_per_s: 1.5, clamp_db: 12.0`
- **Decides:** how fast the programme's level is pulled toward target, and how far it may travel.
- **If it is wrong:** too fast and every song seam pumps audibly; too slow and a quiet track stays quiet
  for a minute. The ±12 clamp on quiet material can lift a noise floor 12 dB.
- **Settable:** **no.**
- **Ever asked for:** no record.
- **Live consequence:** this is the pair implicated in the overlap complaint of 2026-09-06 — over a
  5-second two-song overlap the ride can travel several dB and then walk back over the head of the
  incoming song.

### 3 · The limiter's release and look-ahead — 120 ms, 1.5 ms

- **`native/src/program_processor.rs:91`, `:94`** — `la = fs*0.0015`, `rel = exp(-1/(fs*0.120))`
- **Decides:** how quickly the limiter lets go after a peak, and how far ahead it sees.
- **If it is wrong:** short release distorts bass and pumps; long release leaves the programme ducked
  after a transient. Look-ahead **is** the processing latency, so it also sets local-vs-stream alignment.
- **Settable:** **no.** Look-ahead additionally cannot be changed at runtime without reallocating the
  delay lines on the audio thread.
- **Ever asked for:** no record.

### 4 · The true-peak detection headroom — ×1.15

- **`native/src/program_processor.rs:106`** — `let tp = self.os.push_peak(l, r) * 1.15;`
- **Decides:** how much margin the limiter assumes when estimating true peak, i.e. how conservative the
  ceiling actually is. 1.15 is ~1.2 dB, so the effective ceiling is nearer −2.2 dBTP than −1.0.
- **If it is wrong:** too small and real inter-sample peaks escape; too large and the station is
  permanently ~1 dB quieter than its own stated ceiling.
- **Settable:** **no.**
- **Ever asked for:** no record. It is a correctness margin, but it silently costs loudness.

### 5 · `crossfadeDuration` — 3 seconds, with no delivery path

- **`audiod/engine.js:113`** — `this.crossfadeDuration = 3;`
- **Decides:** the manual X-key crossfade length, and (until 2026-09-06) the delay before the outgoing
  deck was force-stopped.
- **If it is wrong:** the operator's X-key crossfade is not the length they set.
- **Settable:** **no — and this one is worse than unsettable.** `ether-audiod.js` has no `setCrossfade`
  command. `src/App.tsx` sets `engine.crossfadeDuration` on the *renderer* object, which a daemon-driven
  station never reads, and `ether_xfade_duration` has never once been written to localStorage. **There is
  a slider in Settings that changes nothing.**
- **Ever asked for:** the slider was, so this is a control that was asked for and does not work.

### 6 · The arm window — 30 seconds

- **`audiod/engine.js:1925`** — `static get _ARM_WINDOW_S() { return 30; }`
- **Decides:** how close to the end of a song the engine starts looking for a sweeper to place on the seam.
- **If it is wrong:** too short and a long lead-in cannot be honoured — a sweeper set to fire 40 s before
  the end silently never arms. Too long and the read-ahead is noisier than it needs to be.
- **Settable:** **no.**
- **Ever asked for:** no record. It becomes a live limit the moment an operator sets a LEAD above 30.

### 7 · The end-of-song detection thresholds — 0.3 s, 5 s

- **`audiod/engine.js:799-800`** — `dur > 5 && pos > 0 && (dur - pos) < 0.3`, and
  `backendEnded && (dur <= 5 || (dur - pos) < 5)`
- **Decides:** the moment the engine declares a song finished and rotates.
- **If it is wrong:** an early trigger clips the end of every song; a late one leaves a gap. The `dur > 5`
  guard also means anything **under 5 seconds long is excluded from position-based end detection
  entirely** and relies on the backend flag.
- **Settable:** **no.**
- **Ever asked for:** no record.

### 8 · The separation defaults — artist 60 min, song 180 min, title 120 min

- **`audiod/loggen.js:45`** — `g('artist_separation_min', 60)`, `g('song_separation_min', 180)`,
  `g('title_separation_min', 120)`
- **Decides:** how long before the same artist, song or title may return.
- **If it is wrong:** the station repeats too tightly, or a small library starves and the ladder relaxes
  constantly.
- **Settable:** **partly.** `separation_rules` rows are real and editable — but **only if a row exists and
  is active.** With no row, these fallbacks decide it and nothing on screen says so.
- **Ever asked for:** the rules were. The fallback values were not.

### 9 · The break auto-fit tolerance and window — 15 s, 360 s

- **`electron/generate-core.js:343`** — `const FIT_TOL_S = 15, FIT_WINDOW_S = 360;`
- **Decides:** how far a scheduled break may land from its target minute before Ether calls it drift, and
  how much of the hour the fitter may reshape to hit the anchor.
- **If it is wrong:** commercials land minutes from their sold time (an advertiser-facing problem), or the
  fitter rearranges six minutes of music to chase a minute that did not matter.
- **Settable:** **no.**
- **Ever asked for:** no record. The drift *reporting* was designed; the tolerance was not.

### 10 · The sweeper "is it really playing" threshold — peak > 0.0001

- **`audiod/engine.js:_cartObserve`** — `if (peak > 0.0001) return { flowing: true, ... }`
- **Decides:** whether a fired sweeper counts as actually on air — which gates the play-log entry, the
  FIRING indicator, and the seam bridge.
- **If it is wrong:** a quiet sweeper intro reads as "not flowing", so it is never logged as aired and
  never bridges the seam. 0.0001 is about −80 dBFS, so this is generous — but it is a silence detector
  choosing what counts as broadcast.
- **Settable:** **no.**
- **Ever asked for:** no record.

---

## The remaining fourteen

| # | where | value | decides | settable | asked for |
|---|---|---|---|---|---|
| 11 | `engine.js:35` | `SAFETY_CUT_MS = 300` | how fast the outgoing comes off on an operator take-over | no | no record |
| 12 | `engine.js:1926` | `_FIRE_CONFIRM_MS = 900` | how long a fired sweeper has to produce samples before it is called failed and cancelled | no | no record |
| 13 | `engine.js:2065` | `_foreignGraceMs = (segueOverlap + crossfadeDuration)*1000 + 1500` | how long two decks may both be on air before the guard stops one | derived, not set | no record |
| 14 | `engine.js:44` | `STALL_MS = 1000` | how long with no deck playing before the watchdog forces an advance | no | no record |
| 15 | `engine.js:39` | `FLIP_AHEAD_SLACK_SEC = 120` | how far ahead of the playhead the log-reader may look when choosing the next row | no | no record |
| 16 | `engine.js:2225` | `jingleDoneMs = firedAt + jinDur*1000 + 500` | the 500 ms grace after a sweeper's nominal end before the entry is cleared | no | no record |
| 17 | `engine.js:1003` | `near = cfMs + 800` | how soon after a rotate the standby decks are cued | no | no record |
| 18 | `loggen.js:397` | `NEAREST_ANCHOR_TIE_SEC = 2` | which anchor wins when two are equidistant from the playhead | no | no record |
| 19 | `audio.rs:2448` | `VU_RELEASE = 0.82` | meter ballistics — how fast every level meter falls back | no | no record — affects what you *see*, not what airs |
| 20 | `main.js:9003-9004` | threshold 4 days, target 10 days | when auto-generate tops the log up, and how deep | **env var only** (`ETHER_RUNWAY_THRESHOLD_H` / `_TARGET_DAYS`) — nothing in the UI | no record |
| 21 | `main.js:4385` | `ANNOUNCE_TICK_MS = 250` | the resolution at which scheduled announcements fire | no | no record |
| 22 | `loggen.js` `baseConditions` | rule, not a number | a MUSIC song with **no category can never air**, and `rotation_status='inactive'` is always excluded | no | the rules were designed; documented |
| 23 | `engine.js:2085-2090` | rule, not a number | **"CLEAN SPOT EDGES"** — music never overlaps a commercial's tail, and a spot never starts early over a song | no | **yes** — Jeff's broadcast ruling, cited in the code |
| 24 | `program_processor.rs:27-28` | 4× oversampling, 8 taps | true-peak detection quality vs CPU | no | no record — an engineering choice, not a sound |

---

## Closed during this session — listed so the record is complete

| where | was | now |
|---|---|---|
| `engine.js` segue overlap | `= 3` literal, then per-machine localStorage | **station setting**, synced (`segue_overlap_sec`) |
| `main.js` `SWEEPER_DEFAULT` | `{ lead: 5, under: 2 }`, three disagreeing copies | **one number, visible** in the Sweepers LEAD column |
| `proc_target_lufs` | −14 in three code paths, no row on 3 of 4 stations | **written to kv on every station**, shown as the current value |
| `engine.js` spot-seam suppression | the engine decided imaging "didn't belong" next to a commercial | **deleted** — a scheduled sweeper fires |
| `engine.js` timed force-stop | outgoing killed 3.5 s after a rotate | **conditional** — a deck with audio is never stopped |

## Not a finding — settable today, correctly

Worth stating so the list is not read as worse than it is:

- **The ducker is fully exposed.** Depth, threshold, attack, hold and release are all station settings
  (`DuckerSection.tsx`, `duck_*` keys in `station_config_kv`), delivered live via `setDuckParams`.
- **Master EQ** is a per-station setting (`eq_master`) with a live push and an "active" indicator.
- **Separation rules, clocks, categories, active hours, sweeper LEAD** are all operator-owned.

---

## What this inventory does not claim

Every row carries a `file:line` read from source on 2026-09-07. **"Ever asked for" is the weakest column:**
it reflects what the code comments, `docs/` and the git history record, and absence of a record is not
proof a decision was never made — several of these predate the current documentation habit. Nothing here
was executed, measured at runtime, or changed. The consequences described are what the code says would
follow, not observations of it happening.

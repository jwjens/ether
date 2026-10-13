# The duck amount comes only from Preferences (2026-10-13)

## Jeff's ruling (verbatim)

> Duck ruling: the duck amount is set by the user in Preferences, never by code. The engine must have no duck amount of its own.
> 1. Find every place a duck amount (depth, attack, release, or any duck number) is written in code: engine, daemon, renderer, defaults. Report the list in plain words.
> 2. Make Preferences the only source. The engine uses exactly what Preferences says, for every fader, every source, the same way. Where Preferences has no value yet (new install), the starting value lives in one place only, visible and editable in Preferences, and is shown there.
> 3. If Preferences and the engine ever disagree, it shows on the Health page as an error, like the board-state mismatch check.
> 4. Goldens: the test renders must set their duck amount explicitly in the test itself (a test value), not rely on any default. Then the duck goldens test the duck working, not a baked number.
> 5. Do the same check for every other sound number from docs/audio-numbers-audit-2026-10-11.md that is still in code and not in Preferences. List them. Don't change them yet; I decide.

## 1 · Every duck number that was written in code (before this change)

| Where | What it held | Now |
|---|---|---|
| Engine `native/src/audio.rs` BusState::new | depth −22 dB, threshold 0.0056 (≈ −45 dBFS), attack 30 ms, hold 700 ms, release 500 ms — the engine's own boot values | **removed**: the engine starts with NO duck values (`duck_set: false`), does not duck until Preferences send them, and its board snapshot reports `duck_params: null` until then |
| Daemon applier `audiod/board-state.js` DUCK_KEYS | the same five numbers as fallbacks for any key missing in Preferences | **removed**: it sends exactly the five values Preferences holds, or nothing |
| Main `electron/main.js` armAllStationDuckers | read those fallbacks; only stations with a source channel got values | **removed**: every station gets exactly its Preferences values, or nothing |
| Show presets `audiod/show-presets.js` DUCK_DEFAULTS | a fallback when capturing a show, and the built-in "Flat" show carried the five numbers | **removed**: a show captures the ducker only as Preferences holds it (all five or none); taking "Flat" leaves the ducker as Preferences has it |
| Ducker panel `src/components/DuckerSection.tsx` DUCK_DEFAULTS | the five numbers, shown before Preferences were read and used by "Reset" | **removed**: the panel shows Preferences only; Reset writes the starting values it gets from main |
| `src/components/PodcastMode.tsx` useAutoDuck | its own duck: decks A/B/C pulled to 0.18 (≈ −15 dB) over 400 ms, back over 800 ms | **removed** (nothing called it) |
| Engine `show.rs` set_duck_params | edge limits: depth −60…0 dB, threshold −90…0 dBFS, attack 1…1000 ms, hold 0…5000 ms, release 1…5000 ms | kept — limits, not amounts; a Preferences value outside them now shows as a disagreement on the Health page |
| Engine mixer | 0.999 = "fully back up" (0.009 dB); 1 ms = the shortest allowed attack/release in the maths | kept — implementation tolerances, not amounts |
| Ducker panel sliders | depth 0–40 dB, hold 0–3000, release 50–3000, attack 1–300, threshold −70…−10 | kept — the panel's control ranges (listed for Jeff) |
| `src/components/Announcements.tsx` | writes `duck_level: 0.1` on a new announcement | read by nothing since slice 4 (the column stays for older builds); listed, unchanged |
| `src/components/StudioPro.tsx` | per-track side-chain duck default 12 dB | the production DAW's own per-track tool (not the on-air ducker); listed, unchanged |

## 2 · Preferences is the only source

- **The one place for starting values:** `audiod/duck-defaults.js` (−22 dB, −45 dBFS, 30 / 700 / 500 ms). A `.js`, not `.json`, because the audio daemon runs from a staged copy that carries `audiod/*.js` only (`audiod/engine-fingerprint.js`). A `.json` there would have crashed the staged daemon.
- **Written INTO Preferences, once per station:** `_seedDuckPreferences` in main uses `board-state.seedDuckPreferences`. It runs at startup and at every board connect pass, for any station whose Preferences lack a ducker value (a new install, a new station, an install from before this). It writes through the same Preferences writer the Ducker panel uses (journalled, synced, announced to the board watch). A value the operator set is never touched.
- **Shown and edited there:** Preferences → Ducker shows the station's five values, plus a line "Starting values (what a new station gets, written into its Preferences once): …". "Reset to the starting values" writes them. If a station somehow has none, the panel says so ("…so the music is not ducked") with a "Use the starting values" button.
- **The engine uses exactly that:** the applier (at engine start) and main's fan-out send every station exactly its Preferences values, through the one setter (`show::set_duck_params`). Every fader, every source, the same way.

## 3 · A disagreement is a Health page error

`audiod/board-state.js compareBoard` now compares the ducker: Preferences' five values against the engine's own copy (`board.rs` `duck_params`). The board watch raises the existing red `board-state-mismatch-error` within a second, naming it:
- "Ducker depth" / "Ducker threshold" / "Ducker attack" / "Ducker hold" / "Ducker release" — a value differs;
- "Ducker settings in the engine" — Preferences has values, the engine was never sent them;
- "Ducker settings in Preferences" — Preferences has none.

A Ducker-panel drag (the engine hears the value live, Preferences saves it on release) is not an error: main holds the dragged values as "pending" until the Preferences write lands, or for at most 10 s.

## 4 · The golden renders state their own duck values

`native/src/offline_render.rs`: an AUX render that ducks now carries `duck_params` in its own settings. `music__AUXDUCK_LINKED` / `_OFF` state `TEST_DUCK` = depth −20 dB, threshold −45 dBFS, attack 30, hold 700, release 500 — written in the test, used by nothing else. A render with the duck armed and no values does not duck. The engine's own duck tests state the same values through one test helper (`BusState::set_test_duck`). The two duck goldens therefore differ from the current manifest; they are re-captured with the rest after Jeff approves by ear (docs/golden-review-4.6.59-2026-10-13.md).

## Proof

- **Real daemon + the new engine** (`node scripts/smoke-duck-from-preferences.js`), 7/7:
  1. no ducker values in Preferences → the engine holds none (`duck_params null`), and the check names "Ducker settings in Preferences";
  2. starting values written into Preferences → the engine holds exactly them, and the check is silent;
  3. the engine told −30 dB → "Ducker depth — Preferences −22, engine −30".
- **`audiod/duck-defaults.test.js`** (5), replacing "defaults agree everywhere", now asserts there is no copy:
  - the engine boots with none;
  - the applier sends Preferences or nothing (never four values from Preferences and one from code);
  - seeding writes only missing keys, once;
  - no other file holds a duck amount;
  - disagreements are named.
- **vitest 878/878.** Fixtures in `board-state.test.js`, `board-watch.test.js` and `attach-restore-sequence.test.ts` now hold ducker values in Preferences and in the engine model.
- **Smokes:** board-restore 39/39, attach-restore 15/15, show-presets 52/52, local-playback PASS.
- **Rust:**
  - 149 passed; the same 5 golden tests fail, re-capture pending Jeff's ear;
  - duck tests 13/13 with explicit test values;
  - doc tests 2/2.
- **Engine rebuilt:** `native/ether-audio.node` sha256 `34babea3a6c6272464a0c8c20948f8026a41f2b0386e46a8320f58be35cac693` (was `7598aef6`).
- **CPU timing gate** (`channel_rack_cost`): it fails on this machine today **with the old engine and the new one alike**. Ether is playing live on it, and the old engine's two back-to-back runs read 0.66–1.11 ms median on "4 faders + 5 mics", the same range as the new engine's 0.78–0.87. The change adds one boolean test per buffer. The gate needs an idle machine, as in earlier builds: listed for release prep.

## 5 · Other sound numbers still in code, not in Preferences (for Jeff to decide; unchanged)

From `docs/audio-numbers-audit-2026-10-11.md`, re-checked against today's code:

| # | Number | Where | What it does |
|---|---|---|---|
| 2 | loudness ride listens to the last 400 ms ("momentary") | `program_processor.rs:262` | what the ride reacts to |
| 3 | ride freezes below −70 LUFS | `program_processor.rs:290` | silence/quiet handling |
| 4 | ride moves every 100 ms | `program_processor.rs:266` | how often it adjusts |
| 5 | limiter look-ahead / attack 1.5 ms | `program_processor.rs:146` | limiter transparency |
| 6 | track loudness trim range −20 … +12 dB | `audio.rs:4349` (0.1…4.0) | how far normalization may move a song |
| 7 | operator take-over cut 300 ms | `audiod/engine.js:39` | overlap before a hard stop when the jock skips |
| 8 | sweeper arm window 90 s | `audiod/engine.js:2189` | how far ahead a sweeper can arm (part of the sweeper work) |
| 9 | jingle-tail weave 150 ms | `audiod/engine.js:2451` | whether the next song weaves under a jingle tail (part of the sweeper work) |
| 10 | stream codec MP3 at 44,100 Hz | `audiod/stream.js:49,81` | `icecast_format` is stored but never used |
| 12 | RTMP audio AAC 128 kbps / 44,100 Hz | `main.js` (video stream) | Show+ stream audio |
| 13 | master GEQ band width Q 1.0 | `eq.rs:18` | EQ band shape |
| 14 | clipper at ±1.5 full scale inside the GEQ | `eq.rs:160` | a hard clip after the GEQ |
| 15 | clean-output clamp ±1.0 full scale when processing is off | `audio.rs` (moved to the clean tap's points of use) | the only peak control with processing off |
| 16 | channel compressor detector 5 ms | `rack.rs:313` | compressor feel |
| 17 | mono room device = (L+R)/2 | `localout.rs:102,126` | −6 dB on a mono room device |
| 18 | AUX / cue output buffer ~40 ms | `audio.rs:3907` | latency of the AUX and cue outputs |
| 19 | the bottom of every fader (−60 dB at 5 %, then to off) | `src/lib/faderLaw.ts` | the fader law's last segment |
| — | a song whose loudness measurement fails is stored at −14 LUFS | `native/src/lib.rs` analyze_lufs | per-song gain (part of the loudness work) |

Resolved since the audit:
- the limiter detect margin (now 1.0, ruling 5);
- the legacy stream's fixed 128k (now the station's bitrate);
- the duck depth inconsistency (this change).

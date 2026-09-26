# Source-slot metadata falls through to deck B (2026-09-26)

**Jeff's report (verbatim):** "moving the MIC fader moves deck B's fader too."

## Cause

The engine keeps a metadata record per deck: title, artist, file, status, volume, cut. That record is what a
deck **reports back**. `deck_meta_mut` (`native/src/lib.rs:925-934`) chooses the record by name. It knows
A, C, D, E, F and CART. Every other name falls to **deck B** (`_ => &mut audio.deck_b`), and `AudioState`
has no record at all for S1–S5.

**Timeline:**
- The fall-through dates from 2026-03-29 (`fb9277ed`).
- It became reachable when S1–S5 became addressable on 2026-08-21 (`d28ece1`, slot pool 7 → 12).
- Unchanged at 4.6.49 (`b72b8ef`).
- **Not caused by slice 5:** no slice 5 diff touches `deck_meta_mut`, `audio_set_volume`, `FaderSection`,
  `SourceChannelStrip` or `MicChannel`. The only `ConsoleStrip` change is the EQ button.

**How the mic fader reaches deck B's fader:**
1. The mic is a source-channel strip on an S slot. Its fader calls `engine.getDeck(slot).setVolume(v)`
   (`FaderSection.tsx:273-276`).
2. `audio_set_volume("S…")` sends the mixer command. The mixer resolves the slot correctly (`deck_index` →
   slot 7–11), **so the mix is right**.
3. It also writes the fader value into the metadata record, and for an S slot that is **deck B's**.
4. B reports that volume (`DeckMeta::info`). The daemon copies it into B's state (`audiod/engine.js:579`)
   and re-emits it on change (`:877`).
5. B's strip draws it (`FaderSection.tsx:297`). **B's fader moves.**

**It is wider than the fader.** All 7 `deck_meta_mut` callers fall through for S1–S5, so load, play,
pause, stop and the channel cut on an S slot all write deck B's reported state:

| Call on an S slot | What it did to deck B's record |
|---|---|
| **Load** | overwrote B's reported title, artist and file |
| **Stop** | **cleared** B's file path, so a following play on B could be refused with "no content loaded" |
| **Play** | its guard checked **B's** file path, not the S slot's |
| **Pause** | changed B's reported status |
| **Channel cut** | changed B's reported cut |

## Fix

- **`AudioState` gets `deck_s: [DeckMeta; 5]`,** and `deck_meta_mut` maps "S1"–"S5" to it.
- **"B" becomes an explicit arm.**
- **Any other name gets a throwaway record (`deck_unknown`), never B.** It is logged once per name, so a
  misrouted name is visible, not silent.
- **Nothing in the mix changes.** The mixer already resolved S slots correctly, so the goldens are
  unaffected by construction.

**How each caller now behaves for an S slot** (they all go through `deck_meta_mut`):

| Caller | Now |
|---|---|
| `audio_load` | writes the S slot's own title, artist and file |
| `audio_play` | the guard checks the S slot's own file (set by its own load) |
| `audio_pause` | sets the S slot's own status |
| `audio_stop` | clears the S slot's own record |
| `audio_set_volume` | sets the S slot's own volume |
| `audio_set_muted` | sets the S slot's own cut |

`audio_load` is the only NAPI path that sends `Load`, so an S slot's load and its play guard always read the
same record.

## Receipts (build, 2026-09-26)

**New tests (`lib.rs` `source_slot_meta`).** They call the **real** NAPI functions on a device-free engine
(`audio::test_audio_state()`):

| Test | What it proves |
|---|---|
| `a_source_fader_never_moves_deck_b` | Set B to 0.80, then S3 to 0.25: **B reports 0.80, S3 reports 0.25**. A cut on each of S1–S5 lands on that slot, never on B. |
| `play_on_a_source_slot_checks_its_own_file_not_bs` | With B loaded and S2 empty, **play on S2 is refused**. Before the fix it passed on B's file path. Loading and playing S2 leaves B's title alone. **Stopping S2 leaves B's file path, and B still plays.** Pausing S2 leaves B playing. |
| `an_unknown_name_never_touches_deck_b` | `MIC`, `s1` (wrong case) and `ZZ` go to the throwaway record, and **deck B is unchanged**. Each is logged once. |

**Deliberate-failure twin:** with the old `_ => deck_b` arm temporarily restored, **all 3 fail**. The first fails
with B reporting **0.25**, the S3 fader's value: Jeff's report, reproduced.

**Suite:**
- goldens `[null]` 43/43 bit-exact;
- `[rack-null]` 43/43;
- `[ch-out-null]` 43/43;
- allocation trap 0;
- `npm run test:rust`: 68 + 7 + 2 doctests pass (1 ignored = `capture_goldens`).

**Engine:**
- `.node` `f0be19a3…4799` (contains the new log line);
- NAPI check: `[napi] 43/43 renders bit-exact to the manifest`.

**Runtime:** UNVERIFIED until Jeff moves the mic fader in the dev app with this engine.

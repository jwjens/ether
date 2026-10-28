# Golden review for 4.6.59 (2026-10-13)

## Jeff's request (verbatim)

> Step 1, goldens: the 5 failing golden reference renders fail because of the approved duck default and the true-peak limiter. Render each one with the current engine and put them in one folder with plain names saying what each is (e.g. "music ducked under voice", "limiter at ceiling"). Give me the folder path and tell me in plain words what to listen for in each. Do not re-capture anything until I approve by ear.

## What fails, exactly (`npm run test:rust`, 2026-10-13: 149 passed, 5 failed, 4 ignored)

The 5 are **tests**, not 5 renders:

| Test | What it holds |
|---|---|
| `null_vs_golden` | every render vs the golden WAVs/hashes (manifest commit `7896e92`) |
| `rack_path_nulls_against_existing_goldens` | the same renders through the rack-document path |
| `channel_racks_present_but_out_null_against_existing_goldens` | the same with channel racks present but out |
| `link_tap_attached_nulls_against_existing_goldens` | the same with a link tap attached |
| `audio::slice1_regression::aux_monitor_single_pass_regression` | one checksum of the AUX processing path (`GOLDEN_AUX_SINGLE_PASS`) |

Across them, **31 of 43 renders differ**:
- every processed render: 5 signals × LOCAL / STREAM / LINKED / SPLIT / EQ, plus `music__LINKED_B1024`, `_B441`, `_DEV48K_MON07` and `sweep__EQ_DEV48K_MON07`;
- the two duck renders, `music__AUXDUCK_OFF` and `music__AUXDUCK_LINKED`.

**12 are still bit-exact:** every unprocessed (`OFF`) render, the −6 dB trim, and silence through every configuration. So the unprocessed path is untouched.

## Attribution, by mechanism

- **The limiter** (`7e218ca`, Jeff's ruling 5): it changes only the processor. The detector is BS.1770-4 Annex 2, `DETECT_MARGIN` went from 1.15 to 1.0, and the latency went from 72 to 83 samples. That covers every processed render, and nothing unprocessed moved.
- **The duck default** (`277e750`): the engine's boot `duck_depth_db` went from −28 to −22. `music__AUXDUCK_OFF` differs with processing OFF, and only in the windows where the voice talks (11.6 % of samples), so that difference is the duck alone.
- **AUX checksum:** the AUX feed is processed in exactly one place (`audio.rs:5012`; the removed duplicate is documented at `:4975`). The checksum changed because the limiter it runs changed, not because of a second pass. The ear check is file 09.

## The review set — `C:\openair\native\goldens\review-4.6.59\` (gitignored)

Rendered by `scripts/render-golden-review.js` through `native/ether-audio.node` (`7598aef6`, the installed engine), each render with its own manifest settings. The OLD golden WAV is copied beside each NEW render. Measured with ffmpeg BS.1770 (`measurements.json`); compared by `scripts/golden-review-diff.js` (`differences.json`). Nothing re-captured, manifest untouched.

| # | Case | Render · tap | OLD → NEW | After removing the 11-sample delay |
|---|---|---|---|---|
| 01 | Music with processing on (room) | music__LINKED · monitor | −13.9 LUFS / −2.6 dBTP → same | **identical** |
| 02 | Music on the stream, −16 LUFS / −2 dBTP | music__SPLIT · stream | −15.9 LUFS; TP −3.2 → **−2.9** dBTP | differs at −32.7 dB |
| 03 | Speech with processing on | speech__LINKED · monitor | −14 LUFS / −2.3 dBTP → same | −64.3 dB (same) |
| 04 | **Limiter at ceiling** (−1 dBFS inter-sample peaks) | isp_m1__LINKED · stream | −1.2 → **−0.6** LUFS; TP −1.4 → **−1.0** dBTP | differs at −22.1 dB |
| 05 | Steady 1 kHz tone at −18 | tone_1k_m18__LINKED · monitor | −14.5 LUFS / −14 dBTP → same | **identical** |
| 06 | Sweep with EQ | sweep_20_20k_m18__EQ · stream | −12.6 LUFS / −11.6 dBTP → same | **identical** |
| 07 | **Music ducked under voice**, processing off | music__AUXDUCK_OFF · monitor | music under the voice **−38.8 → −34.3 dB**; between talking −12.1 both | — (no delay; only the duck windows differ) |
| 08 | Music ducked under voice, processing on | music__AUXDUCK_LINKED · monitor | music under the voice −38.8 → −34.3 dB; between −16.2 both | the duck windows only |
| 09 | Voice on the AUX room output | music__AUXDUCK_LINKED · aux | −14 LUFS / −2.3 dBTP → same | −64.3 dB (same) |

What to listen for in each is in the folder's `READ ME FIRST - what to listen for.txt`.

## Step 2 — waits for Jeff's approval by ear

When Jeff approves:
1. archive the current goldens and manifest;
2. re-capture with `capture_goldens -- --ignored`;
3. update `GOLDEN_AUX_SINGLE_PASS`, keeping both old values in its comment;
4. run every gate;
5. then the release prep he described.

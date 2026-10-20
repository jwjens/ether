# Play Log scroll + the 5 engine reference tests (2026-10-20)

## 1 · Play Log does not scroll

### Jeff's report (verbatim)

> Play Log window: I can't scroll up or down to see earlier rows (this morning). Find why the list doesn't scroll (file:line, which commit) and fix it so the whole day scrolls. Include it in 4.6.60.

### Cause — two, both in the tree (static analysis; the runtime fix is UNVERIFIED until Jeff opens the Play Log in the installed 4.6.60)

1. **No scroll region anywhere.** `src/components/Logs.tsx:388` (the panel's root) never had one, and every place the panel is hosted clips what does not fit:
   - the main panel area, `src/App.tsx:3148` `<main … overflow: "hidden">` — since `55379fc` (2026-03-18; it was `overflow: "auto"` before). `Logs.tsx` was born after that, in `83faeef` (2026-03-19), with no scroll of its own;
   - the pop-out window, `src/components/PopoutShell.tsx:63` (content `overflow: "hidden"`);
   - the Program Log window's Play Log pane, `src/components/schedule/ScheduleWorkspace.tsx:206` `<PaneFrame flush>` → `:86` `overflow: "hidden"` — `9a4e3d4` (2026-08-16, 4.4.218). `flush` is documented (`:77`) for "a pane that is … full-height … with its own scroll region"; the Play Log has none.

   Rows below the window's edge could never be reached, in all three hosts.
2. **The morning was not in the list.** `Logs.tsx:111` `ORDER BY played_at DESC LIMIT 200` — since `83faeef`. On a day with more than 200 plays, everything before the 200th most recent was simply not loaded, scroll or not.

### Fix (`src/components/Logs.tsx`)

- The panel is wrapped in its own scroll container (`flex: 1; height: 100%; min-height: 0; overflow-y: auto`) — a separate wrapper rather than the existing flex column, because a scrolling flex column would shrink the table's `overflow: hidden` box to fit and clip it again.
- **Today**, or a From/To range of one day, loads every play (no cap). Longer periods keep the newest-200 screen cap; the Songs Played tile and every export already cover the whole period. Not built: paging for multi-day periods.
- Help: `docs/help-logs.md` → Good to know.

## 2 · The 5 failing engine reference tests — explained, not re-recorded

Jeff, 2026-10-20: "Settle the 5 failing engine reference tests: re-record them, or explain each one, before trusting the seek change."

**Not re-recorded**, because the standing rule from 2026-10-13 is "Do not re-capture anything until I approve by ear" (`docs/golden-review-4.6.59-2026-10-13.md`), and no approval by ear is recorded anywhere since. The listening set is still at `C:\openair\native\goldens\review-4.6.59\` with `READ ME FIRST - what to listen for.txt`.

### Each one

| Test | Why it fails |
|---|---|
| `null_vs_golden` | 31 of 43 renders differ from the recorded goldens: every render with processing ON (the true-peak limiter, `7e218ca`, Jeff's ruling 5: detector margin 1.15 → 1.0, latency 72 → 83 samples), and the two duck renders (`music__AUXDUCK_OFF/_LINKED`: the duck values, `277e750`/`02e7f80`). All 12 unprocessed renders and silence are bit-exact. |
| `rack_path_nulls_against_existing_goldens` | The same renders through the rack-document path, against the same goldens — the same cause. |
| `channel_racks_present_but_out_null_against_existing_goldens` | The same renders with channel racks present but out — the same cause. |
| `link_tap_attached_nulls_against_existing_goldens` | The same renders with a link tap attached — the same cause. |
| `audio::slice1_regression::aux_monitor_single_pass_regression` | One checksum of the AUX processing path; it runs the limiter, so it moved with the limiter (`left 13288168936620410458`, `right 8547072521240218071`). Not a second pass (audio.rs single AUX processing site). |

These are the same 5, failing the same way, recorded on 2026-10-13 ("rust 149 + 5 pending goldens", `02e7f80`).

### The golden files themselves are intact

All goldens files carry a 2026-10-19 19:19 timestamp. Checked read-only (`golden-hash.js`, FNV-1a over the f32 samples as `offline_render.rs fnv_bits`): `tone_1k_m18__OFF` monitor, `tone_1k_m18__LOCAL` monitor + stream, `isp_m1__STREAM` stream, `speech__LINKED` monitor — every one hashes to the manifest value. `manifest.json` has no git diff. So the WAVs are the recorded goldens; the difference is the engine's processing, not the files.

### The seek change moves none of them

Same 5 tests run twice on this machine, 2026-10-20:
- with the seek change (full `--lib` run: 155 passed, 5 failed, 5 ignored; the new `seek_tests::a_load_from_a_point_is_the_same_audio_from_that_point` passes);
- with the three engine files set aside (untouched HEAD engine: 19 passed, 5 failed in the filtered run).

Every result line of the 5 failing tests (the per-render Δmax for monitor/stream/aux, the rack/link/racks lists and the AUX checksum, 92 lines) is **identical** between the two runs. The only extra lines in the second run are a passing test's `[linked]` prints, shown because that run used `--nocapture`.

### Still Jeff's

Listen to the review set; on approval: archive goldens + manifest, `capture_goldens -- --ignored`, update `GOLDEN_AUX_SINGLE_PASS` keeping both old values, run every gate (steps in the 10-13 doc).

## 3 · Open: a station with no designated machine has no way to get one

Committed as ordered (`af85263`): the log builder follows the existing designation and nobody claims by building. Consequence found while testing (read-only check of OVEVENTS' live DB, 2026-10-20):

| Station | Designated builder |
|---|---|
| 1 Open Format | ovowforestmusic |
| 2 halloVeen | ovowforestmusic |
| 3 Magical Forest | OVEVENTS |
| 4 Christmas in Jully | OVEVENTS |
| **9 Fall VIbes** | **none** |

Nothing in the app writes a designation for a station that has none: `decide()` never designates, `designation:bypass` refuses when nobody holds it ("there is nothing to bypass"), and there is no "make this computer the builder" control. So after 4.6.60 Fall VIbes (and any new station) is never built automatically — yellow in the Health Monitor; Fill Day still builds it. Not built: a door to designate a computer. Jeff's call.

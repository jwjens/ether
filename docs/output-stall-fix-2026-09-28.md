# OV dead air — the output callback stopped; nothing noticed (fix, 4.6.52, 2026-09-28)

**Report (Jeff, verbatim):** OV (4.6.51, onboard Realtek) went to dead air twice after a restart: the cpal output
callback stopped being called (frames=+0, cpal-stale 19.5 min, drain total=0), while the level meter kept
re-reporting the last value so the wedge detector scored it 0 ms and suppressed. Nothing in Rust logged the moment
the device stopped.

## Why it went unnoticed (read-only findings, receipts in the tree)

1. **Rust never watched its own callback.** The dispatch thread stamped `last_cb` when `cb_seq` moved and did nothing
   when it stopped. The stream object stayed alive, so no `'outer` reopen ever ran.
2. **cpal's error callback said almost nothing and did nothing**: `|err| eprintln!("[cpal] {}", err)` — no station,
   no device, no time, no recovery.
3. **The detector suppressed on levels before reading the callback.** `startAudioLivenessWatchdog`'s first line was
   `if (_stationAudioAgeMs(sid) < 6000) { … continue; }`. With the callback stopped, the dispatch thread keeps
   re-publishing the LAST meter frame, so levels stayed "fresh" and the station was skipped before the (authoritative)
   `lastCallbackMs` stamp was ever read.

The "Sept 23 wedge notes" were not found in `docs/` or in commit history; the nearest records are 4.4.43
(`03f5ab7`, "gate silent-wedge reload on the REAL cpal callback") and `docs/backlog.md`'s "DEAD-THREAD RECOVERY …
still unbuilt".

## The fix (one commit each)

| Commit | What |
|---|---|
| `8841d20` | `native/src/outwatch.rs` StallWatch on the dispatch thread: an OPEN stream with no callback for **> 1 s** is a STALL → `[RUST] <ISO time> Station N output STALL on "<device>": no output callback for <ms> ms (…) — reopening the output, decks restored`, counted (`rt_stalls`), and the stream reopened through the existing device-switch path (same device, `restore_decks_after_switch`). **2 stalls/failed opens in a row → the system default, said in the log** (`rt_stall_fallbacks`); from 4 in a row, 5 s between attempts. Health Monitor "audio engine" line shows `output stalls N`; the ledger's `audio-rt` events carry them. |
| `41e85af` | cpal's error callback: `[RUST] <ISO time> Station N cpal ERROR on "<device>": <err> — treating it as a stall (reopen)`, counted (`rt_device_errors`), and handed to StallWatch → the same reopen path. |
| `cf41665` | `electron/wedge-judge.js`: the callback stamp is read FIRST; stale (≥ 3 s) = a wedge, not held by fresh levels or by enginestate=live. Levels are consulted only when an engine cannot report a stamp. |
| `8215be4` | chore(release): 4.6.52 — engine rebuilt from HEAD (sha256 `e0f8b82d…`). |

## Receipts

- Fake stream whose callback stops → `STALL on 'chosen': NoCallbacks { ms: 306 } — reopening`, opens `[chosen, chosen]`,
  stalls 1, **19 callbacks in the next 200 ms (audio resumed)**. A card that never returns → `[chosen, chosen, default]`,
  "falling back to the system default" logged. A cpal error → `DeviceError(…)`, same reopen.
- `npm run test:wedge`: 11 PASS — first, "OV: callback stale 19.5 min + levels fresh (200 ms) + enginestate=live → wedge".
- Goldens: `cargo test` 43/43 bit-exact, allocation trap 0 across 43 renders; **NAPI 43/43 bit-exact** through the
  shipped `.node`.
- Gates: tsc 0 · vitest 608 · test:rust 136+7+2 · leak-guard 13 · every node smoke PASS except
  `test:audio-library-r2` (fails on 4.6.51 too — `uploadLibrary` no longer exported since `e36d675`; not touched).
- Installer: `C:\openair\dist-electron\Ether Setup 4.6.52.exe`, 220,186,202 bytes, built 2026-09-28 19:52 local,
  `--publish never`; `verify-packaged.js` → RELEASE GATE PASS.

## UNVERIFIED

A real WASAPI callback that stops (OV's Realtek) was not reproduced here: the watcher and the reopen loop are proven on
a fake stream; the reopen itself is the existing ReopenOutput path. The check that settles it: on OV, the next time it
happens, the log shows `output STALL on "<Realtek…>"` followed within ~1 s by `audio output opened`, and the Health
Monitor's `output stalls` goes to 1 with the station still on air.

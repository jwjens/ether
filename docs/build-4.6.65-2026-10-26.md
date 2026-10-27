# Build 4.6.65 — 2026-10-26

**`C:\openair\dist-electron\Ether Setup 4.6.65.exe`** · 216,333,547 bytes · sha256
`df1c81dd488fdcb701d20cfdbb09ad410fea613ed56e9674c656827a10f5725a` · built from `569b921` (clean tracked tree) on branch
release/1019 · `--publish never` · not pushed, not tagged · unsigned.

Jeff, 2026-10-26: "On my new computer (4.6.64), signing in fails: 'Ether could not finish opening your account's folder
because a file was still in use.' Closing and reopening Ether doesn't help ... close every connection Ether holds
(workers, audio engine, timers) first, reopen after. Make the message name the real holder. Add a test. Build it now."

## What is in it (on top of 4.6.64, 6c83518)

| Commit | What |
|---|---|
| `d3a2005` | Sign-in / account folder: every connection released before the folder moves or is removed; the message names the real holder |
| `a2c603a` | Devices: Manage Devices and the sign-in error read the license's seat tier (backend 59a8b94) |
| `569b921` | Version 4.6.65 |

### The cause (d3a2005)

Sign-in renames `profiles\_pending` to the account's folder (`profile:adopt`); a fresh computer always boots on `_pending`.
On Windows a folder cannot be renamed while any file in it is open, and three parts of Ether kept one open:
- **the audio engine** — adopt sent `shutdown`, and the client reconnected at once and spawned a new engine on the OLD path
  (`ETHER_DB_PATH` still named `_pending`), which reopened `_pending\openair.db`;
- **main itself** — no restore gate, so the next renderer call reopened the database (`getDb()` self-heal);
- **the show-log and library-health workers** — their own read-only connection.

### The fix

- `electron/profile-move.js`: release → rename (15 × 200 ms retry for a scanner's momentary lock) → on failure, Windows
  (Restart Manager) is asked who holds files in the folder → reacquire, always. The message names Ether's main program,
  Ether's audio engine (by its pid), another program by name, or says Windows named no one.
- `main.js` `_releaseActiveProfile` / `_reacquireActiveProfile`: restore gate; engine `shutdown` + client `stop()` (no
  respawn) + wait for the process to exit; `dbHolders.releaseAll()`; checkpoint + close. Reopen with the new
  `ETHER_DB_PATH`, workers (library-health is sent the new path first), engine (`resume()` + `ensure()`).
- Used by `profile:adopt` (rename AND switch to an existing/new profile) and the factory-reset wipe (which now keeps
  the pointer and reopens when the folder survives, and reports the named holder). The station-join swap already had it
  (4.6.63). Sign-out and the quit paths exit the app.

## No schema change

Newest migration still v68; no schema statement outside tests in `git diff 71fcc33 569b921`.

## Gates (on d3a2005 / 569b921)

tsc 0 · vitest 121 files / 1014 tests (new `electron/profile-move.test.js` 11/11: real Windows locks + Restart Manager —
a held file blocks the rename and release lets it through; a holder in this process is named as Ether's main program; a
child process is named by pid, not blamed on Ether) · test:sync 60/60 · test:db-release ALL PASS · verify:schema,
ipc-contract, preload-bridge, undefined-calls PASS · test:one-switch: only the old attach-restore-sequence.test.ts:37.

## Release checks

1. **Contents vs 4.6.64** (4.6.64 win-unpacked saved before the build): packages 217 = 217, PASS. app.asar 15,098 →
   15,099: added `electron/profile-move.js`; renderer bundles renamed. Nothing missing.
2. **Size:** 216,333,547 vs 216,338,598 bytes (−0.0%), PASS.
3. **Real launch: PASS.** Packaged Ether.exe (pid 12604, 17:51:51), temp LOCALAPPDATA/APPDATA + `--user-data-dir`, on a
   stripped copy of the OVEVENTS database (no account/licence/link keys, sync off). Opened the copy's profile; staged engine
   matched (native 9efb1764a140); daemon connected; handover complete; window shown 00:52:11Z; startup background work
   0.2 s. Responding on all 48 samples over 4 minutes. Closed through the Close Ether dialog's "Stop & Quit Ether" at
   00:56:38Z (clean-exit marker), 0 Ether processes left. My automated click was NOT what pressed it (foreground guard
   refused to send keys; the dialog was gone before the direct click) — someone at the computer answered it.
   Health log on the copy: one 15.2 s main stall at boot (the known first-launch-after-install cost), then a burst at
   00:53:07Z peaking at 1.1 s. Live DB untouched. As before, Chromium profile and logs land in the real `%APPDATA%\Ether`.

**Not tested end-to-end:** an actual sign-in on a fresh `_pending` profile in the packaged app (it needs a real account
sign-in, which registers a computer on a license). The release/move/naming is tested on real locks; the first real
sign-in on the new computer is the receipt.

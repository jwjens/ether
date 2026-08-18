# Re-key repair — dry run + DB-copy proof, 2026-08-18

**Machine:** OVEVENTS (profile `ETH-STN-BAA8-E056-6FC8`) · **App:** 4.4.226 installed

**Status: APPLIED to the live database 2026-08-18 — see §7 for the live run.** §1–§6 are the go/no-go
that preceded it, kept verbatim: they are what the decision was made on, and the live numbers in §7
match them exactly. Rollback: `openair.db.bak-prerekeyrepair-20260818`.

Two scripts, both dry-run-by-default:

| | |
|---|---|
| `scripts/repair-station-rekey.js` | existed (2026-08-16); gained `--json <path>` receipt emission today |
| `scripts/restore-rekey-ghost-config.js` | **NEW today** — no restore script existed; the purge had one, the restore did not |

---

## 1 · The map is anchored on identity, and two independent methods agree

The repair script derives `old id -> new id` from `created_at` order and **refuses** unless the orphan
count equals the station count. The purge snapshot corroborates it from a completely different
direction — the config rows carry the ghost station's own `station_uuid`:

| Ghost id | Snapshot `station_uuid` | Live station | Anchor used by the restore |
|---|---|---|---|
| 5 | `75532b61-fa0c-4bc5-a5f0-0298b94c0123` | **1** Open Format | station_uuid |
| 6 | `43889edc-203d-4743-9e4f-6ea311d6e035` | **2** halloVeen | station_uuid |
| 7 | `dfbc68ac-e4d2-4769-9519-a28ead7884ae` | **3** Magical Forest | station_uuid |
| 8 | *(none on any row)* | **4** Christmas in Jully | `station_name` = "Christmas in Jully" |

`5→1, 6→2, 7→3, 8→4` — as instructed, uuid-anchored, with id 8 falling back to name exactly as the
fix-pass doc predicted it would have to.

## 2 · DRY RUN against the LIVE database (read-only) — the numbers

`openair.db`, 713.7 MB. Receipt: `scratchpad/rekey-dryrun-live.json` (`mode: "dry-run"`,
`applied: false`, `exitCode: 0`).

```
orphaned station_id values: 5, 6, 7, 8

table                    rows   per-mapping
shows                       5   5->1:1      6->2:2      7->3:1      8->4:1
clocks                      5   5->1:1      6->2:2      7->3:1      8->4:1
clock_slots               120   5->1:58     6->2:21     7->3:18     8->4:23
categories                 16   5->1:10     6->2:3      7->3:2      8->4:1
separation_rules           20   5->1:5      6->2:5      7->3:5      8->4:5
station_programming        12               6->2:12
spots                       5               6->2:3      7->3:1      8->4:1
generated_schedule     137878   5->1:23554  6->2:47117  7->3:27615  8->4:39592
play_log                48099   5->1:6234   6->2:19829  7->3:10912  8->4:11124
TOTAL                  186160
```

**137,878 and 48,099 match the incident record exactly** (`docs/fix-pass-2026-08-17-rekey-guard.md`),
which is the strongest corroboration available that this is the same damage and the whole of it.

`station_config_kv` is **absent from the plan** — correct, and expected: the 2026-08-17 purge already
deleted those 79 ghost rows, which is why a separate restore is needed.

## 3 · PROOF on a copy — both scripts, end to end

The copy was taken with SQLite's **backup API**, not a file copy: a plain copy of a WAL database can
tear, because `-wal` holds committed pages the `.db` file does not yet have. 713.7 MB, consistent.

### 3a · Repair (`--write` on the copy)

```
applied — 0 duplicate(s) dropped, 186160 row(s) re-pointed.
VERIFY: orphans: 0
```

### 3b · Config restore (`--write` on the copy)

```
snapshot 2026-08-17T23:20:15.113Z — 79 rows, ghost ids [5,6,7,8]
to restore: 52 row(s)   (st1:12  st2:14  st3:11  st4:15)
already present, left alone: 27   (24 identical, 3 DIFFERENT)
applied — 52 row(s) restored.
total 31 -> 83   (expected +52)
rows under a non-existent station: 0
VERIFY OK
```

### 3c · The proven end state — what Jeff should see after the live run

```
station                 clocks shows cats slots  sep  spots  progLog(gen_sched)  playLog  config
1 Open Format                1     1   10    17    5      0               23554     6242      23
2 halloVeen                  1     1    2    20    5      1               47117    19853      28
3 Magical Forest             1     1    2    18    5      1               27615    10912      14
4 Christmas in Jully         1     1    1    23    5      1               39592    11124      18

orphaned rows across all child tables: 0
```

halloVeen's Program Log comes back at **47,117** rows with **19,853** play-log entries.

> Note on `slots`: the plan moves 120 `clock_slots` rows but the end-state table shows 17/20/18/23 = 78.
> The plan counts **all** rows; the end-state counts `deleted_at IS NULL` only. Both numbers are right;
> they answer different questions. Nothing is lost — 42 of those slots were already soft-deleted.

## 4 · One decision for Jeff — 3 config keys where live and snapshot DIFFER

The restore's default is **conservative and deliberate: an existing key is never overwritten.** Restore
what was lost; never clobber what is live. The live value is what the app has been using since the
incident, and some of these are identity. `--overwrite` forces it, and here is the diff to read first:

| Station | Key | Live value (kept) | Snapshot value (not applied) |
|---|---|---|---|
| 1 | `designated_generator` | machine `041ceb96…` | machine `8e8f6181…` (**this** machine) |
| 2 | `last_error` | `engine is not defined` | `datePickerOpen is not defined` |
| 2 | `sync_uuid_identity` | **`true`** | `false` |

My read, stated so it can be overruled:

- **`sync_uuid_identity` — keep live `true`.** Reverting a sync-identity flag to a pre-incident value as
  a side effect of a config restore is exactly the kind of silent change the last week was spent
  eliminating. If it should be `false`, flip it deliberately in the sync panel (it is live now — no
  restart needed as of 4.4.225).
- **`designated_generator` — Jeff's call.** The snapshot names *this* machine; live names another. It
  decides which machine generates the log for Open Format, so it is a real behavioural change, not
  cosmetic. Leaving it alone changes nothing about today.
- **`last_error` — irrelevant either way**, a stale diagnostic string.

The other 24 already-present keys are byte-identical, so nothing is at stake there.

## 5 · Receipts

| File | What |
|---|---|
| `scratchpad/rekey-dryrun-live.json` | dry run vs the LIVE db — stations, orphan ids, map, per-table plan, `applied:false` |
| `scratchpad/rekey-write-copy.json` | repair `--write` on the copy — plan, collisions, verify, per-station counts |
| `scratchpad/restore-dryrun-copy.json` | restore dry run — map with anchors, 52 to insert, 27 skipped with value diffs |
| `scratchpad/restore-write-copy.json` | restore `--write` on the copy — verify OK |

(Scratchpad is session-temporary. The numbers that matter are inlined above so this doc stands alone.)

## 6 · STOP — the live write, and exactly when

**Nothing runs against the live database until Jeff says go.** When he does, the sequence is:

### Close Ether first — both parts

1. **Quit the app window** — File ▸ Quit Ether, or the window's X.
2. **Quit the tray engine too** — right-click the Ether tray icon ▸ Quit. The tray keeps the audio
   daemon alive; the daemon holds `openair.db` open in WAL mode, which is why a half-close is not a
   close.
3. Confirm nothing is left: no Ether window, no tray icon. (I can verify no `Ether.exe` / `ether-engine`
   process remains before touching anything.)

This matters because the standing rule is that external writes to the live DB while Ether is open
corrupt it. The repair opens the database read-write; the daemon must not be holding it.

### Then, in this order

```
1. cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/repair-station-rekey.js --write --json <receipt1>
2. cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/restore-rekey-ghost-config.js --write --json <receipt2>
3. reopen Ether
```

Repair first, restore second: the restore matches on live station ids, and the repair is what makes the
children point at them.

**Acceptance:** Jeff opens Ether and sees clocks, shows and categories on all four stations, and
halloVeen's full Program Log.

A fresh backup-API copy of the live DB will be taken immediately before the write, so there is a
rollback that is not "restore from cloud".

---

## 7 · LIVE RUN — executed 2026-08-18

Jeff gave the go. Sequence and receipts below.

### 7.1 · The close that wasn't — an orphaned engine

Jeff reported nothing running in any taskbar or tray. **He was right, and a process was still alive:**
`ether-engine.exe` pid 30648, started 09:54:39. It had

- `MainWindowHandle = 0` and an empty window title — **no window and no tray icon**, so there was
  genuinely nothing for him to click;
- **parent process GONE** — an orphan left behind when the app closed;
- **zero TCP connections** — not streaming, nothing on air, so ending it could not cause dead air;
- **0.7 s total CPU** over ~7 hours — idle.

Ended it deliberately (`Stop-Process`), then confirmed: no `Ether`, `ether-engine`, `ether-audiod` or
`electron` processes, and **no `openair.db-wal` / `-shm` sidecars** — nothing held the database.

> **Product finding, one line:** the audio engine can survive app close as an invisible orphan with no
> window and no tray icon, so an operator has no way to see or quit it. Same family as the
> "Ether cannot be closed" install blocker that `installer.nsh` taskkill fixed. Not investigated
> further here.

### 7.2 · Rollback point

`openair.db.bak-prerekeyrepair-20260818` (713.7 MB), taken with the SQLite **backup API** beside the
live database. A local rollback that is not "restore from cloud".

### 7.3 · Pre-write dry run — identical to the proven run

`TOTAL 186160`, orphan ids `5,6,7,8`, same per-table per-mapping counts as §2. Nothing had drifted, so
the write went ahead against numbers that had already been proven on a copy.

*(Correction to an earlier note in this session: the live db had NOT grown to 748 MB — 748,408,832
**bytes** is 713.7 MB. Same size throughout.)*

### 7.4 · Repair — applied

```
0 collision(s)
applied — 0 duplicate(s) dropped, 186160 row(s) re-pointed.
VERIFY: orphans: 0
```

### 7.5 · Config restore — applied

```
to restore: 52 row(s)  (st1:12  st2:14  st3:11  st4:15)
already present, left alone: 27  (24 identical, 3 DIFFERENT — live values kept)
applied — 52 row(s) restored.
total 31 -> 83   (expected +52)
rows under a non-existent station: 0
VERIFY OK
```

The 3 differing keys kept their **live** values, per the conservative default and with no answer to the
contrary: `designated_generator` (st1), `last_error` (st2), `sync_uuid_identity` (st2, live `true`).
Reversible at any time — the snapshot is untouched.

### 7.6 · Live end state — matches the proven copy exactly

```
station                 clocks shows cats slots  sep  spots  progLog(gen_sched)  playLog  config
1 Open Format                1     1   10    17    5      0               23554     6242      23
2 halloVeen                  1     1    2    20    5      1               47117    19853      28
3 Magical Forest             1     1    2    18    5      1               27615    10912      14
4 Christmas in Jully         1     1    1    23    5      1               39592    11124      18

orphaned rows across all child tables: 0
```

### 7.7 · Integrity — and the repair strictly improved it

`PRAGMA integrity_check` → **ok**

`PRAGMA foreign_key_check`, before vs after:

| Violation class | Pre-repair | Post-repair |
|---|---|---|
| **total** | 119,066 | **119,054** (−12) |
| `station_programming -> stations` | **12** | **0** — fixed by the repair |
| `generated_schedule -> songs` | 118,555 | 118,555 (unchanged) |
| `songs -> artists` | 475 | 475 (unchanged) |
| `station_programming -> categories` | 12 | 12 (unchanged) |
| `station_programming -> songs` | 12 | 12 (unchanged) |

The only class that changed is the one the repair targeted. The repair introduced **zero** new
violations and removed 12.

> **Pre-existing and NOT touched here, one line:** 118,555 `generated_schedule -> songs` violations
> exist independently of this incident (schedule rows referencing songs that no longer exist). Flagged,
> not investigated — it is its own question.

### 7.8 · Receipts

`live-dryrun-final.json`, `live-repair-receipt.json`, `live-restore-receipt.json` (scratchpad,
session-temporary; the numbers are inlined above so this record stands alone).

### 7.9 · Outstanding

**Acceptance is Jeff's screen.** Reopen Ether and confirm clocks, shows and categories on all four
stations, and halloVeen's full Program Log. Database-level proof is not screen-level proof — a passing
query has never been evidence that a panel renders.

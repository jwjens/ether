# One switch: keep my stuff synced

**Status: BUILT · 2026-09-09 · §1 answered · §2–§6 all built · guard added (`npm run test:one-switch`).**

Deferred to their own tickets, deliberately: the `mutation-writer` table filter (§1.1), the 1.6 GB
log (§1.1), **Import a snapshot file** (§3.1), the `BackupRestore.tsx` orphan (§3.1).

Not verified by me, and it needs a machine: the card's seven states rendering against a real
account, and a real restore running through both phases. The gates here are static and unit-level.

Jeff, 2026-09-09:
> "Six buttons doing three jobs and no way to know which I need."
>
> "One thing: keep my stuff synced. Ether does the hard part — rows and files, both directions,
> right order. I shouldn't have to know there are two mechanisms."
>
> "Don't propose a surface that says 'safe' over a number nobody understands."

---

## 0 · The finding that reframes the task

**Step 4's engine has no UI.** `catalogue:backup:*` and the `catalogueBackup` preload doors
(`electron/preload.js:138`) have **zero references anywhere in `src/`**. The Backup & Restore screen
still drives the pre-step-4 songs-table path.

| what the screen calls | handler | what it counts |
|---|---|---|
| `library:cloud-status` (`SettingsPanel.tsx:2453`) | `main.js:10936` | `songs` rows with `r2_uploaded_at IS NOT NULL` → **510** |
| `libraryR2.upload` (`SettingsPanel.tsx:2755`) | legacy songs-table uploader | songs only |
| *(unused)* `catalogue:backup:status` | `main.js:11288` | `walkCatalogue()` → **483 files** + the real remote manifest |

"All 510 songs are in the cloud" is not a stale label — it is a different mechanism's answer,
asserted from `songs.r2_uploaded_at`, the column whose seed defects step 4 fixed (five rows marked
uploaded that were never in the bucket).

**So the surface work and the wiring work are the same job.** Ruling (Jeff): `catalogue:backup:*`
becomes the one path; the four `libraryR2.download` call sites move; two engines do not ship.

---

## 1 · The 79,341 — answered before designing anything

**The queue is fully drained. The counter measures the wrong set.**

Read-only probe against the live profile
(`%LOCALAPPDATA%\Ether\profiles\ETH-STN-BAA8-E056-6FC8\openair.db`):

```
PENDING BY TABLE:      79341  generated_schedule     ← the only table
BY STATUS:             pending 79341 · synced 77298 · conflicted 155
pending in push-excluded tables:  79341
pending actually pushable:             0
```

The chain:

- `sync/mutation-writer.js:349-350` stamps `origin:'local', sync_status:'pending'` on **every**
  journalled write. It filters local-only *columns* (`[N-24]/[N-25]` at `:457`, `:593`) but has
  **no table-level filter**.
- `sync/sync-engine.js:544` excludes `syncExcluded`/`local-only` tables from the push query —
  `generated_schedule`, `install_secrets_kv`, `monitor_routing`
  (`sync/synced-tables.js:464, 524, 620`).
- The counter (`sync/sync-scheduler.js:309`) is `COUNT(*) WHERE sync_status='pending'` —
  **unfiltered**.

Schedule-generation rows are journalled as pending, are never selectable by push, and are counted
forever. `push()` returns `{sent:0}` at `sync-engine.js:124` because its filtered set is empty.

Corroboration: 40 MB of recent `ether-startup.log` contains **no** `[SYNC] tick` line (it fires only
when `pushed>0||pulled>0`), no `push transport error`, no `push rejected`. The engine is healthy and
idle because there is nothing to send.

The progress bar at `SettingsPanel.tsx:1241` computes `100 − (79341/156786 × 100)` = **49%** — it
reads "stuck halfway" when the truth is "finished".

### 1.1 · Two defects this exposes — NOT part of this build

1. **Root cause.** The writer journals excluded-table mutations as pending, growing unbounded on
   every schedule generation. Fixing it upstream is what makes the count honest. Until then the
   card must never show this number.
2. **`ether-startup.log` is 1,606,382,121 bytes** (1.6 GB) and still appending. Unbounded log
   growth. Unrelated to sync; own ticket.

### 1.2 · What this means for the surface

The primary card shows **no** pending count. Advanced shows **two** numbers, never collapsed:

- **Waiting to sync** — pushable pending (currently **0**)
- **Journal rows not eligible to sync** — currently **79,341**, with one line saying these are
  local-only records that never leave this computer

Collapsing those two is what created the confusion.

---

## 2 · The surface

One card. One sentence. One switch. Everything else behind Advanced.

The sentence is computed from **both** mechanisms and states the **weaker** of the two, because
"safe" is only true when rows *and* files are both up.

| state | sentence | button |
|---|---|---|
| both current | "Everything on this computer is in the cloud — your whole setup and all 483 audio files, as of 2 minutes ago." | *none* |
| files behind | "Your setup is safe. 19 of 483 audio files haven't gone up yet — on another computer those would arrive with no sound." | **Finish sending** |
| rows behind | "483 audio files are safe. Your setup hasn't gone up since Tuesday." | **Back up now** |
| never run | "Nothing is in the cloud yet." | **Back up now** |
| pulling down | see §4 | **Stop** |
| unreachable | "Can't reach the cloud right now — last confirmed 3 hours ago. Nothing is lost; it'll catch up." | **Try again** |
| off | "Keeping your stuff synced is off. Nothing is going to the cloud." | *none* |

The switch is **"Keep my stuff synced"** — one master, replacing both `Enable the sync engine` and
`Back up automatically`. On means rows and files, both directions, continuously. The 6-hour interval
dropdown goes: it is an implementation detail of one of the two mechanisms.

The card never uses *backup*, *sync*, *push*, *pull*, or *R2*. Those are four names for two
mechanisms, and they are why six buttons looked like six jobs.

---

## 3 · Advanced — the escape hatch

Collapsed by default, one disclosure, headed by a line saying these are diagnostics not needed in
normal use.

- **Preflight / Push now / Pull now** — kept verbatim.
- **Clear pending** — kept, with its existing typed confirm, and the count it names must be the
  **pushable** count, not the raw one. Typing to discard "79,341" when 0 are pushable is a trap.
- **Enable UUID-based station identity** — a migration flag, not a preference. It must not sit
  beside the master switch where it reads as an equal choice.
- **This machine / station UUID list** — kept. The "compare before enabling on a second machine"
  instruction is real.
- **Waiting to sync / journal-only counters, engine state, ever-received** — per §1.2.
- **Change folder**, **Re-send every file (force)**.
- **Roll back this computer** — the snapshot list, relabelled.

### 3.1 · The snapshot restore already exists

Correcting the record: restore is wired. `SettingsPanel.tsx:3555` renders a Restore button per
snapshot → `restore()` at `:2711` → `restore_db` at `main.js:5810`. It is invisible only because
`backups.length === 0` renders "No snapshots yet." (`:3564`).

What does **not** exist is **importing a snapshot file** — `restore_db` takes a `backupName` from
the local backups directory only, so a snapshot from another machine or a USB stick has no way in.
Jeff: yes to building it, **scoped separately**, not holding this work.

`src/components/BackupRestore.tsx` is an orphaned duplicate of the same feature, rendered nowhere.
Delete or adopt — own decision.

---

## 4 · What the screen shows during a restore

There is already a better answer than anything new: `LibrarySyncProgressBar.tsx` is mounted in
`App.tsx` and renders **"Downloading library — 312 / 483 audio files"** with a percentage bar and an
error count. `CloudInstallPrompt.tsx` and `OnboardingFlow.tsx:680` drive it on a fresh install.

Promote it to the canonical restore surface, move it onto the catalogue engine, and give it the
phase — the order matters and is currently invisible:

1. **"Bringing your setup down…"** — rows first.
2. **"Bringing your audio down — 312 of 483 files."** — files second, resolved by basename.
3. **"Everything's here."**

The Settings card mirrors the same sentence rather than showing its own.

### 4.1 · Health Monitor during a restore — RULED

Between phase 1 and phase 2 every row exists and its file does not. Under the step-2 rule that is
**dead**, not foreign — so Health Monitor would report hundreds of dead rows mid-restore and the
operator would read it as damage.

Jeff's ruling: **"N files still arriving", not dead. A restore in progress is not a fault.**

So a restore-in-flight flag must reach the health read, and the dead-row line must render as
"N files still arriving" while it is set.

---

## 5 · Labels — every one on this list gets fixed

| now | why it's wrong | becomes |
|---|---|---|
| "All 510 songs are in the cloud" | songs-table count, wrong mechanism | "All 483 audio files are in the cloud" — from `catalogue:backup:status` |
| "Your music files" | it is carts, sweepers, spots, announcements and voice tracks too | "Your audio files" |
| "Send my music to the cloud" | duplicates the primary button | removed from the primary surface |
| "Cloud Backup … every station, your schedule, and your settings" | omits that audio is a separate transfer | "…your setup and your audio, both" |
| "Not backed up yet" beside "All 510 songs are in the cloud" | two mechanisms contradicting on one screen | one sentence, computed from both |
| "Audio files sync separately via Cloud Backup" (`SettingsPanel.tsx:1620`) | states the seam we are hiding | deleted |
| "Multi-Machine Sync — manual push/pull between installs" | describes the overrides, not the engine | "Advanced — sync diagnostics" |
| "Save a copy on this computer … Audio files aren't included." | accurate; keep the caveat | "Roll back this computer … your audio files are not part of a snapshot." |
| "PENDING MUTATIONS 79,341 of 156,786" | counts unpushable rows as backlog (§1) | split per §1.2 |

Rule: never "songs" for a catalogue count. The catalogue is **483 files**; `songs` is **510 rows**.
They are different questions and both are honest — the label must say which one it is answering.

---

## 6 · Build order

1. **Wire the one path.** Move the four `libraryR2.download` call sites — `CloudBackup.tsx:242`,
   `CloudInstallPrompt.tsx:32`, `OnboardingFlow.tsx:680` and `:2442`, plus
   `LibrarySyncProgressBar.tsx:47/63` — onto `catalogueBackup.*`. Retire `libraryR2` from the
   renderer.
2. **One status source.** Card reads `catalogue:backup:status`; `library:cloud-status` leaves the
   renderer.
3. **The card.** §2, with the seven states.
4. **Advanced.** §3, including the two-number split from §1.2.
5. **Restore phases.** §4, and the Health Monitor flag from §4.1.
6. **Labels.** §5, all of them.
7. **Guard.** A smoke check that no renderer file references `libraryR2.` or
   `library:cloud-status`, so the second engine cannot come back, and that no user-facing string
   pairs a catalogue count with the word "songs".

Deferred, own tickets: the `mutation-writer` table filter (§1.1), the 1.6 GB log (§1.1),
**Import a snapshot file** (§3.1), and the `BackupRestore.tsx` orphan (§3.1).

---

## 7 · Gates at the time of writing

`tsc` 0 · vitest 394/394 · window-station 8 sections · copy-on-import · catalogue-r2 ·
resolver 15/15. HEAD `9534343` on `log-reader-flip`.

---
feature: catalogue-sync
title: OV not getting today's new songs — rows and audio went up; OV likely quarantines schema-66 changes (2026-10-19)
summary: 102 songs imported on OVEVENTS today all landed in the catalogue folder, their audio IS in the cloud and their rows WERE pushed; leading cause = OVEVENTS runs the 1018 test build (schema 66) and a receiver on an older schema quarantines v66 changes.
audience: programmer
status: DIAGNOSIS — read-only; nothing changed. §"Conclusion" below was WRONG and is RETRACTED — see "Correction"
---

# OV not getting today's new songs (2026-10-19)

## Jeff's report (verbatim)

> "i cant figure out why OV isnt getting all the new songs i added today"
> "the new category synced but the new kids bop and little shop of horror songs are not there i hit the backup button
> on here on ovevents"
> "all songs imported are supposed to land in catalogue find out if they did today"

## Receipts (read-only, this machine = OVEVENTS, profile ETH-STN-BAA8-E056-6FC8, live DB opened read-only)

- **Songs imported today: 102.** All 102 have their file **in the catalogue folder**
  (`music-dir.txt` = `C:\Users\jensj\AppData\Local\Ether\catalogue`); **0 elsewhere, 0 missing on disk.**
  → the import step worked. (`scratchpad/diag-today-in-catalogue.js`)
- The Kidz Bop / Little Shop rows are on station 2 **halloVeen**, categories **Kids** (19) and **Movie Soundtrack**
  (23, created today 17:05). 100 of today's 102 have `r2_uploaded_at` empty — but that column is the *old* row-driven
  upload marker (`electron/audio-library-r2.js:26`); the current upload keeps its record in the R2 manifest, so this
  alone does not prove absence.
- **The category arrived because it travels with the database / categories mirror; song audio does not.**

## The mechanism (source on sched/one-scheduler; installed build is the 1018 installer — same paths)

| Button | What it sends | Code |
|---|---|---|
| **Cloud Backup → "☁ Backup Now"** | **The database only** (`cloud-backup:run-now` → `runBackup`) — songs' rows, categories, clocks. **No audio.** Its success line says "✓ Full station backed up to the cloud" | `src/components/CloudBackup.tsx:255-276`, `electron/cloud-backup.js:230` |
| **Preferences → cloud "Back up now"** | Database **then the audio** (`catalogueBackup.upload`) — "Part 2 — the audio" | `src/components/SettingsPanel.tsx:2640-2666` |
| "▲ Back Up Catalogue to Cloud" | Audio only | `CloudBackup.tsx:436` |

- **Audio never goes up on its own.** `SettingsPanel.tsx:3752-3755`: "Going up is still a button — nothing watches the
  catalogue folder and nothing uploads on a clock." The only caller of `catalogue:backup:upload` is a button.
- **Coming down is automatic** on the receiving machine (every 5 min, `CATALOGUE_PULL_INTERVAL_MS`, `main.js` ~14018),
  but only while that machine's switch (`sync_enabled`) is on, and only for files already in R2.
- No `[catalogue:backup]` or `[CLOUD-BACKUP]` line from today is in `Roaming\Ether\ether-startup.log` — inconclusive
  (those modules may not log there).

## Conclusion

The songs and their category reached the cloud as **database rows**; their **audio did not go up**, because the
button pressed ("☁ Backup Now") sends the database only and nothing uploads audio automatically. OV has rows with no
sound to fetch. **UNVERIFIED** until the counter is read: Preferences → the cloud section shows
"N of M audio files haven't gone up yet" (`SettingsPanel.tsx:3630`, from `catalogue:backup:status`).

## Fix for today (operator)

On OVEVENTS: Preferences → cloud section → **Back up now** (the one that says it sends audio files). When it reports
0 files waiting, OV pulls them within ~5 minutes (if its switch is on).

## Product defects (named, not fixed — Jeff's call)

1. **"☁ Backup Now" says "Full station backed up" but sends no audio** — an honest-UI defect; it is how this happened.
2. **New audio never goes up by itself** — every import needs a human to press a second, different button.

## Correction (same day) — the audio IS up; the first conclusion is retracted

Jeff's screen (Preferences → Backup & Restore): **"All 670 audio files are in the cloud"** / "✓ Library already in the
cloud". So the audio went up; the "audio never went up" conclusion above was wrong (inferred from code + an empty
legacy column, not measured). The button table above is still accurate as a description of the buttons.

### Receipts (read-only, live DB on OVEVENTS)

- **All 102 song rows were pushed**: every one has an `insert` mutation, `sync_status = synced`, `origin = local`
  (16:44–17:06Z), plus 210 `update`s, all synced. `station_id` NULL = account library (expected).
- **Stamped schema 66.** Today's mutations: songs 405 × v66 (6 × v65 earlier), categories 5 × v66. This DB = v66
  (the 1018 test installer).
- **The receiver rule** (`electron/sync/merge-engine.js`, Step 3 [N-102]): `if (m.schema_version >
  this._localSchemaVersion) → _quarantine(m)` — parked in `quarantine_mutations`, applied only after the receiver
  upgrades (`sync-engine.js:414-417` drains `foreign_schema_version <= local`).

### Leading cause (UNVERIFIED — needs OV's side)

OV runs an older build (schema < 66), so it **received and quarantined** all 102 song inserts. Settled by one of:
1. OV: **Help → About** version (is it below the 1018 build?);
2. OV's DB: `SELECT foreign_schema_version, COUNT(*) FROM quarantine_mutations WHERE drain_status='pending' GROUP BY 1`.

**Does not fit yet:** the new category was also stamped v66 — if it reached OV by the same sync path it should have
been quarantined too. Need: where Jeff sees the category on OV (desktop Library/Categories on the OV computer, or the
dashboard), and whether OV is on the same account (OVEVENTS = license ETH-STN-BAA8-E056-6FC8).

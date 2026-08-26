# Freeze and Inventory — 2026-08-17

**Status:** read-only audit. Nothing was changed, built, installed, or repaired.
**Run from:** `OVEVENTS` (user `jensj`), repo `C:\openair`.
**Reason:** multiple context-less sessions made unknown changes; a build reported as `4.4.124`
was believed to have been produced and possibly installed on OV.

**Headline finding:** `4.4.124` was **not** produced recently. It is a two-week-old artifact from
2026-08-03. What actually happened on this machine is a `4.4.221 → 4.4.224` jump with `4.4.222`
and `4.4.223` never built and never run.

---

## 1. Git state — `C:\openair`

| Field | Value |
|---|---|
| Branch | `log-reader-flip` (tracking `origin/log-reader-flip`, in sync) |
| HEAD | `e190a6321b80f1b14149809b1ea4fc2b805553a6` (`e190a63`) |
| HEAD date | `2026-08-17 11:47:29 -0700` |
| HEAD subject | fix(sync): sync flags are read for the ACTIVE station, not whichever row is oldest (4.4.224) |
| `package.json` at HEAD | `"version": "4.4.224"` |

### Last 15 commits

```
e190a63 2026-08-17  (HEAD -> log-reader-flip, origin/log-reader-flip)
                    fix(sync): sync flags read for ACTIVE station (4.4.224)
b82939d 2026-08-17  fix(sync): stop pushing generated_schedule, stop retrying what the server refuses
8dba8bd 2026-08-17  fix(show+): shader failures loud and survivable; programs link independently
6825cd9 2026-08-17  fix(show+): stop the render mode flapping — hysteresis, quantised slices, morph
d3f2c08 2026-08-16  feat(show+): raise the zoom ceiling to 512 so sample mode is reachable
163182a 2026-08-16  feat(show+): Audition-grade waveform — sample trace, peak+RMS, stereo lanes
d705b08 2026-08-16  feat(show+): real waveform detail when zoomed, and a cursor that sweeps it
f296acb 2026-08-16  feat(debug): pop-out DevTools + console bridge — every pop-out, for free
a9b97d6 2026-08-16  fix(show+): the white bug dies — viewport slicing bounds the canvas (4.4.223)
81f49df 2026-08-16  docs(handoff): the bridge for the next session
eb2c9d1 2026-08-16  feat(show+): DAW shell, mixer, and a waveform that stops going white (4.4.222)
8ff3cd9 2026-08-16  feat(shift): identity from the profile's members; the operator roster dies (4.4.221)
c223284 2026-08-16  fix(sync): uuid-identity no longer re-keys local rows; station repair (4.4.220)
7e4b1ea 2026-08-16  feat(sync): baseline watermark — the journal wipe that sticks (4.4.219)
9a4e3d4 2026-08-16  feat(schedule): Program Log + Play Log panes, one record page (4.4.218)
```

### Uncommitted changes

**None to tracked files.**

- `git diff --stat` → empty
- `git diff --cached --stat` → empty

Untracked only (9 entries):

```
?? check-designation.js
?? marked-for-deletion.json
?? temp-extract/
?? scripts/prove-filekey-filepath.js
?? scripts/r2-orphan-report.js
?? docs/phase-c-takeover-design-2026-08-12.md
?? docs/show-daw-redesign-2026-08-16.md
?? docs/show-daw-workspace-mockup.html
?? docs/station-coexistence-design-2026-08-15.md
```

### Other branches touched in the last 24h

**None.** The reflog, 40 entries deep, contains only `commit:` entries — no `checkout:`, no
`reset:`, no `rebase:`, no `merge:`. Every commit since 2026-08-13 landed on `log-reader-flip`.
The only other local branch is `main` at `298cecb` (2026-07-22, 4.4.81), untouched for 26 days.

### Position of the named commits

| Ref | Commit | Date | Relative to HEAD |
|---|---|---|---|
| `eb2c9d1` (4.4.222) | `eb2c9d15dfc5773f310bc962bb1d04d5fb839cfe` | 2026-08-16 20:32:44 -0700 | ancestor of HEAD, **10 commits behind** |
| 4.4.221 | `8ff3cd9d912dedd5f42b416b2c181505a55585b8` | 2026-08-16 15:56:10 -0700 | ancestor of HEAD, **11 commits behind** |

**No tag exists for 4.4.221, 4.4.222, 4.4.223, or 4.4.224.** The newest tag in the repo is
`v4.4.215`. A tag `v4.4.12` exists (2026-06-23) — do not confuse it with 4.4.124.

---

## 2. What is 4.4.124

**The installer exists, but it was not produced recently.**

```
C:\openair\dist-electron\Ether Setup 4.4.124.exe
  size           202,764,854 bytes
  CreationTime   8/3/2026 1:00:23 PM
  LastWriteTime  8/3/2026 1:00:30 PM
```

| Question | Answer |
|---|---|
| Which commit built it | `8f1bdaafa4e594198c4031d4c4986164b21382c3`, `2026-08-03 12:55:50 -0700` — *feat(startup) 4.4.124: the truthful boot — attach/adopt/project, silence asserted, AUTO observed*. Confirmed by `git log -S'"version": "4.4.124"' -- package.json`; the commit lands 5 minutes before the exe timestamp. |
| From which branch | `git branch -a --contains 8f1bdaa` → `log-reader-flip` and `origin/log-reader-flip` only. Same lineage as HEAD; an ancestor, not a fork. |
| When | 2026-08-03, ~1:00 PM local. File timestamps unchanged since. |
| Installer in `dist-electron` | Yes — plus its `.blockmap`, both dated 8/3. |

### Was it installed anywhere?

On **this** machine: once, on its own build day, and never since.

```
ether-startup.log:
2026-08-03T20:04:15.246Z version: 4.4.124  packaged: true  pid: 40664
```

That is the only occurrence of 4.4.124 in a startup log covering 2026-07-06 → now. No run in the
last 24 hours, last week, or last two weeks. The uninstall registry
(`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`) holds exactly one Ether entry:

```
Ether 4.4.224 | ver=4.4.224
```

No 4.4.124 receipt anywhere on this box.

### What was actually built recently

```
Ether Setup 4.4.224.exe        194.7 MB   8/17/2026 12:22:41 PM
latest.yml   version: 4.4.224   releaseDate: '2026-08-17T19:22:53.236Z'
win-unpacked\Ether.exe         FileVersion 4.4.224   8/17/2026 12:21:16 PM
```

The build (12:22 PM) postdates the HEAD commit (11:47 AM) with a clean tracked tree, so the
4.4.224 installer corresponds to `e190a63`.

### The real version anomaly

**4.4.222 and 4.4.223 have no installer in `dist-electron` and never ran here.** The box went
`4.4.221 → 4.4.224` directly. If someone reported a "wrong version," this gap is the anomaly that
actually exists in the evidence; 4.4.124 is not.

`dist-electron` holds 137 `Ether Setup *.exe` files spanning 4.4.84 (2026-07-23) through 4.4.224
(today). 4.4.124 is one unremarkable entry in that archive.

---

## 3. This machine — `OVEVENTS`

Hostname `OVEVENTS`, user account `jensj`, email `jensj@opportunityvillage.org`.
Machine-id `8e8f6181-b68a-433f-a93d-8005787b641b`
(`%LOCALAPPDATA%\EtherMachine\machine-id`, written 2026-07-05).

| Item | Value | Receipt |
|---|---|---|
| Profile pointer | `ETH-STN-BAA8-E056-6FC8` | `%LOCALAPPDATA%\Ether\profiles\active`, mtime 8/17 2:13 PM |
| Active profile path | `C:\Users\jensj\AppData\Local\Ether\profiles\ETH-STN-BAA8-E056-6FC8` | dir mtime 8/17 2:19:40 PM |
| Profile DB | `openair.db` — **748,408,832 bytes**, mtime 8/17 2:19:40 PM | directory listing |
| App version installed | **4.4.224** | `%LOCALAPPDATA%\Programs\Ether\Ether.exe` FileVersion=4.4.224, mtime 8/17 12:22:30 PM; install dir mtime 12:59 PM |
| Engine sidecar | **4.4.224** | `%LOCALAPPDATA%\Ether\engine\version.txt`, 8/17 1:00:29 PM |
| Dev / repo version | **4.4.224** | `package.json` at HEAD |
| Schema version | **37** | `system_state.schema_version`, updated 1787000845 = 2026-08-17T21:07:25Z |
| Pending mutations | **41** | `SELECT sync_status, COUNT(*) FROM mutations` → pending 41, synced 2438, total 2479 |
| Quarantined mutations | **0** | `SELECT COUNT(*) FROM quarantine_mutations` |
| UUID identity flag | **`true` on the ACTIVE station (id 2)**; `false` on orphan stations 5–8 | `station_config_kv` |
| `baseline_hlc` | **PRESENT** — `1786989531508:0:8e8f6181-…` = 2026-08-17T17:58:51Z, row updated 17:59:06Z | `system_state` |
| Rebaseline markers | `rebaseline_started=1`, `rebaseline_done=1`, both 2026-08-16T17:56Z | `system_state` |
| App running now | **No** — `Get-Process Ether,ether-engine` empty; last activity 21:19:40Z | process list + log tail |

### Sync flags per station

This is exactly what `e190a63` changed the reader for.

```
station_id | key                | value | updated_at
1          | sync_enabled       | false | 2026-08-17T18:04:01Z
2          | sync_enabled       | true  | 2026-08-17T20:55:20Z   <- ACTIVE station
6          | sync_enabled       | true  | 2026-08-14T19:34:02Z
2          | sync_uuid_identity | true  | 2026-08-17T20:06:06Z   <- ACTIVE station
5,6,7,8    | sync_uuid_identity | false | 2026-08-16T18:42:22Z
```

The `stations` table contains **only ids 1–4**. Config rows for **stations 5, 6, 7 and 8 are
orphans** with no matching station row. Active station is id **2** (`halloVeen`, `is_active=1`).

Under the pre-4.4.224 "oldest row wins" reader, station 1 (`sync_enabled=false`) or the orphan
5/6/7/8 rows (`sync_uuid_identity=false`) would have been read instead of station 2's
`true`/`true`.

### Stations table

```
id | name              | is_active | uuid                                 | scheduler_mode
1  | Open Format       | 0         | 75532b61-fa0c-4bc5-a5f0-0298b94c0123 | clock
2  | halloVeen         | 1         | 43889edc-203d-4743-9e4f-6ea311d6e035 | clock
3  | Magical Forest    | 0         | dfbc68ac-e4d2-4769-9519-a28ead7884ae | clock
4  | Christmas in Jully| 0         | f6ac7a00-d905-4b87-b0ef-f219ac3b1e1e | clock
```

All four owned by license `ETH-STN-BAA8-E056-6FC8`.

### The 41 pending mutations are a write loop, not operator work

All 41 are `station_config_kv` updates. Forty of them are the **same `license_key` key rewritten
across all four stations at roughly 9-second intervals** during the last 3 minutes of uptime:

```
license_key station 1: 10 rows  21:16:42.334Z → 21:19:40.345Z
license_key station 2: 10 rows  21:16:42.335Z → 21:19:40.348Z
license_key station 3: 10 rows  21:16:42.336Z → 21:19:40.350Z
license_key station 4: 10 rows  21:16:42.337Z → 21:19:40.352Z
```

The tail of `ether-startup.log` corroborates a tight 1–1.5 s repeat over the same window:

```
[BOOTSEQ] post-auth · OBSERVED-AUTO inst=e2 station=2 attachState=daemon
          _daemonStarted=true returns=true
```

### Mutation journal shape

The `mutations` table's oldest surviving row is `2026-08-17T17:54:29.752Z` — consistent with the
baseline watermark wipe (4.4.219) having fired at 17:58:51Z today.

```
origin | count        client_id                            | count | last
local  | 1925         8e8f6181-… (this machine)            | 1938  | 2026-08-17T21:19:40Z
remote |  554         041ceb96-… (peer)                    |  541  | 2026-08-17T21:10:56Z
```

### Retired and legacy artifacts present (left untouched)

```
profiles\_pending.retired-2026-08-16\                openair.db  905,216 B   8/15 10:39 PM
profiles\ETH-STN-E00D-87A1-C976.retired-2026-08-16\  openair.db  917,504 B   8/15 10:38 PM
%LOCALAPPDATA%\Ether\ether.db                                    0 bytes     8/10 11:53 AM
%LOCALAPPDATA%\Ether\openair.db                                  0 bytes     8/10 11:54 AM
```

The two root-level DBs are empty legacy stubs from before the profile migration.

---

## 4. OV — what is knowable from here

There is no direct access to OV from this machine. Everything below comes from the sync tables in
this profile's DB, plus one strong path fingerprint.

### Peers seen (`system_state.sync_cursor`)

| client-id | last HLC | UTC | Who |
|---|---|---|---|
| `8e8f6181-b68a-433f-a93d-8005787b641b` | `1787001229704` | 2026-08-17 21:13:49Z | **This machine (OVEVENTS)** — matches `machine-id` and `client_identity` |
| `041ceb96-3d66-4d39-85c0-e2f5aa6e3b1e` | `1787001056386` | 2026-08-17 21:10:56Z | **The peer — almost certainly OV** |
| `f09d1219-272c-4f89-8698-6e65798a10be` | `1783977454032` | 2026-07-13 21:17:34Z | Stale third client, silent 35 days |

Supporting state:

- `system_state.sync_server_seq` = **856225**, updated 2026-08-17T21:15:53Z — last successful
  server round-trip.
- `system_state.sync_initial_drained` = 1 since 2026-08-14.
- `replication_config.site_id` = `af5ccb2e-dda5-4510-9b14-2c0dafb15737`.
- `replication_peers` table is **empty**.
- Backend: `https://ether-backend-production.up.railway.app`.

### Peer identification receipt

Remote `play_log` inserts from `041ceb96` carry file paths under
**`C:\Users\projector\Music\ether music library\`** — a different Windows user account than this
box's `jensj`. That is the OV playout machine.

### Mutations received from OV since yesterday

**541 total, all dated today (2026-08-17), all after 18:03Z.**

| Table | Op | Count | Window |
|---|---|---|---|
| `station_config_kv` | update | **520** | 18:03:20Z → 21:10:56Z |
| `stations` | update | 12 | 18:03:34Z → 20:54:06Z |
| `play_log` | insert | 9 | 18:03:22Z → 21:00:00Z |

### What those 520 config updates touched

```
key                station  count  first                      last
license_key           2       488  2026-08-17T18:11:02.371Z → 21:10:56.386Z
license_key           1        24  2026-08-17T18:03:20.162Z → 18:11:02.300Z
first_run_complete    2         2  2026-08-17T20:55:56Z
sync_enabled          2         2  2026-08-17T20:55:20Z
canvas_layout         2         1  2026-08-17T20:55:33Z
license_email         2         1  2026-08-17T20:55:56Z
plan_tier             2         1  2026-08-17T20:55:55Z
sync_backend_url      2         1  2026-08-17T20:55:20Z
```

**512 of 520 are the same `license_key` row** (uuid `2e438f63-d42e-42ee-b8e6-904cd2ae7529`, value
`ETH-STN-BAA8-E…`) rewritten on a **20-second cadence** — OV is in the same write loop as this
machine.

The `sync_enabled` / `sync_backend_url` / `canvas_layout` / `plan_tier` / `license_email` /
`first_run_complete` cluster falls in a **36-second burst at 20:55:20–20:55:56Z**. That reads as a
first-run / onboarding pass completing on OV shortly before 21:00Z today — i.e. something *was*
installed or re-set-up on OV. **The version cannot be determined from here**; no version string
crosses the sync channel.

### The 12 `stations` updates

OV rewrote all four station rows (`Open Format`, `halloVeen`, `Magical Forest`,
`Christmas in Jully`) in two rounds, at 20:25:14Z and 20:54:06Z. **Station UUIDs are stable across
both rounds and match this machine's `stations` table — no identity re-keying occurred.**

### The 9 `play_log` inserts — real playout on OV

Shake It Off (deck B), Chicken Noodle Soup (deck C), Good Times – 2018 Remaster (deck A), a
Halloween impact cart (deck CART), then Candy Girl, Bad Blood and Witch Doctor (Kidz Bop Kids,
deck A) through 21:00:00Z.

---

## 5. Song paths

**Format: plain user-Music absolute paths. Not `com.ether.radio`, not profile-relative, not
blob-ref.**

### Ten sampled `songs.file_path`, each tested against the filesystem

```
OK  C:\Users\jensj\Music\ether music library\...Baby One More Time.mp3
OK  C:\Users\jensj\Music\ether music library\A Little Respect - 2009 Remaster.mp3
OK  C:\Users\jensj\Music\ether music library\ABC.mp3
OK  C:\Users\jensj\Music\ether music library\Addicted To Love.mp3
OK  C:\Users\jensj\Music\ether music library\Africa.mp3
OK  C:\Users\jensj\Music\ether music library\Ain't No Mountain High Enough - Stereo Version.mp3
OK  C:\Users\jensj\Music\ether music library\Ain't No Mountain High Enough.mp3
OK  C:\Users\jensj\Music\ether music library\All I Wanna Do.mp3
OK  C:\Users\jensj\Music\ether music library\Always Something There to Remind Me.mp3
OK  C:\Users\jensj\Music\ether music library\Another One Bites The Dust - 2011 Remaster.mp3
```

**10 / 10 resolve.** A wider random sample resolves **59 / 60** out of 542 non-null paths. The
library directory `C:\Users\jensj\Music\ether music library` exists and holds 1,414 files.

### Format histogram across all 543 songs

```
user Music\ether music library : 542
NULL                           :   1
com.ether.radio                :   0
profile-path                   :   0
```

Cross-checked against `play_log` (48,121 rows): **zero** `com.ether.radio` paths in either table.

### What the format tells us

The song library was **never rewritten by a profile-path migration, and never carried a
`com.ether.radio` prefix in this DB**. The paths are the original absolute user-Music form.

The profile migration (4.4.216 profile-per-account, 4.4.217 ledger carry) moved the *database*
into `…\Ether\profiles\<license>\` but **left `file_path` values untouched** — which is precisely
why they still resolve: the audio never moved.

### The one real path divergence

`play_log` holds two machines' absolute paths in one synced table:

```
owner                count    first played_at   last played_at
jensj (OVEVENTS)     44,632   1783361034        1787001432
projector (OV)        3,488   1786472115        1787000400
NULL                      1
```

`C:\Users\projector\Music\ether music library\Witch Doctor.mp3` is valid **on OV only**. Nothing is
corrupted, but any code resolving `play_log.file_path` locally will miss roughly 7% of rows.

Transport note: OV's play_log mutations arrive with `file_path` wrapped as
`{"__blob_ref": "C:\\Users\\projector\\..."}` while landed rows are flat strings — the blob-ref
wrapper is the sync transport format, not the storage format.

`songs_v2` (350 rows) has **no `file_path` column at all** — it is keyed on `content_hash` with
`source_folder` / `original_name`. It is not a path store and not a migration target for these
values.

---

## State map

### OVEVENTS — this machine (`8e8f6181-…`, user `jensj`) — INTACT and current

- Repo `C:\openair` on `log-reader-flip` @ `e190a63` = **4.4.224**. Working tree clean of tracked
  changes; 9 untracked scratch files. No branch switching, resets or rebases in the reflog.
  `origin` in sync.
- Installed app **4.4.224**, engine sidecar **4.4.224**, dev **4.4.224** — all three agree.
  Installer built today 12:22 PM from HEAD, installed 12:59 PM, first ran 20:00:36Z (1:00 PM
  local).
- Profile `ETH-STN-BAA8-E056-6FC8`, 748 MB DB, schema 37, `baseline_hlc` present (set today
  17:58:51Z), 0 quarantined.
- Song library **healthy**: 542/543 paths in original user-Music format, ~98% resolve on disk.
- **41 pending mutations** — not operator work; a `license_key` rewrite loop across all four
  stations at ~9-second intervals during the last 3 minutes of uptime.

### The "wrong build 4.4.124" — did not happen here, and is not new

- The exe is a **2026-08-03** artifact from `8f1bdaa`, on the same branch lineage, sitting in
  `dist-electron` alongside 136 other historical installers. Its file timestamps have not changed
  since build day.
- It ran on this machine exactly once, on 2026-08-03. Zero occurrences in the last 24h. The
  registry knows only `Ether 4.4.224`.
- What actually skipped versions here is **4.4.222 and 4.4.223** — committed, never built into an
  installer, never run. The box went 4.4.221 → 4.4.224 directly.
- **Open question:** it cannot be ruled out from here that a 4.4.124 installer was copied to and
  run on OV. Confirming that requires reading OV's own `ether-startup.log` and uninstall registry,
  which is not reachable from this machine.

### OV (`041ceb96-…`, user `projector`) — live, syncing, showing a fresh onboarding

- Actively exchanging with the backend all day: 541 mutations received here, first 18:03:20Z, last
  21:10:56Z.
- **Re-onboarded around 20:55Z today** — `sync_enabled`, `sync_backend_url`, `canvas_layout`,
  `plan_tier`, `license_email`, `first_run_complete` all written in a 36-second burst. Something
  was installed or re-set-up on OV shortly before 21:00Z.
- Rewrote all four `stations` rows twice (20:25Z, 20:54Z). **Station UUIDs unchanged** — no
  identity re-keying.
- Playing out normally: 9 logged plays through 21:00:00Z, real audio, real paths under
  `C:\Users\projector\`.
- **In the same `license_key` write loop** — 512 rewrites of one config row on a 20-second cadence,
  18:11Z → 21:10Z.

### Third client `f09d1219-…` — dormant

Present only as a stale `sync_cursor` entry, last HLC 2026-07-13. No mutations, no peer row. Not a
factor.

### What diverged

1. **Orphan station config rows.** `station_config_kv` carries rows for station ids 5, 6, 7 and 8
   with no matching `stations` row. Station 6 even carries `sync_enabled=true` and a backend URL
   from 2026-08-14. These orphans are what the pre-4.4.224 "oldest row" sync-flag reader could
   latch onto instead of active station 2.
2. **`sync_enabled=false` on station 1 vs `true` on station 2** — the exact ambiguity `e190a63` was
   written to resolve. As of that fix the reader takes station 2, which is correct.
3. **`play_log` holds two machines' absolute file paths in one table.** OV's 3,488
   `C:\Users\projector\...` rows are dead paths from OVEVENTS's point of view, and vice versa.
   Inherent to syncing a machine-local absolute path.
4. **Both machines are burning the sync channel on one `license_key` row** — roughly 1,000
   mutations today between them for a value that never changes.

### What is intact

Repo history and branch state · working tree · version alignment across app, engine and dev ·
profile pointer and active profile · `baseline_hlc` and the rebaseline markers · station UUID
identity (no re-keying) · the song library and its file paths · zero quarantined mutations.

---

**No repairs performed. No builds run. The only file written during this audit is this document.**

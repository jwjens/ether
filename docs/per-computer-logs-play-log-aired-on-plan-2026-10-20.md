# Per-computer program logs; the Play Log says which computer aired it — plan (2026-10-20)

## Jeff's request (verbatim)

> Replace machine designation with this model:
> 1. Each computer generates its OWN program log for each station. Program logs are local and never sync between computers. No computer claims or owns a station; there is no builder designation at all. Remove it.
> 2. The Play Log (what aired) syncs between all computers. Every play records which computer aired it.
> 3. The Play Log gets an "Aired on" column with the computer's name, and a filter by computer, so a PD on any computer can see and print exactly what a station aired on any computer for any time range (e.g. HalloVeen on OVEVENTS, 3–6 PM). Exports (PDF, CSV, BMI/ASCAP, As-Run) include the column and respect the filter.
> 4. Each computer's rotation rules count the plays that aired on that computer.
> 5. Remove the 200-row cap in the Play Log for every range.
> Test on the test stations with two computers airing the same station. Next build, after I've installed 4.6.60.

Status: **plan only — nothing changed.** Read-only findings below. The conflict and the decisions under "For Jeff" need your answer before building.

## What already exists (receipts)

| Point | Today |
|---|---|
| 1 · logs local | Already true. `generated_schedule` is `syncExcluded` (`electron/sync/synced-tables.js:478`, ruling A); the backend refuses it too. Only designation sits on top. |
| 2 · Play Log syncs, records the computer | Mostly true. `play_log` is a synced table (`synced-tables.js:736`) with `machine_id` (v63). The one writer, `audiod/playlog.js:69`, stamps `client_identity.client_id` on every play. **Live on OVEVENTS (read-only, 2026-10-20):** halloVeen holds 534 plays from computer `041ceb96…` (10-18 → 10-19) and 266 from this one (`8e8f6181…`) — plays do travel. |
| 3 · computer name | **Missing.** Only the id travels. The name is `os.hostname()` (`electron/main.js:12465`), stored on no play — so no computer can show another's name. |
| 4 · rotation | **Counts every computer's plays.** The readers — `audiod/loggen.js:57,64,366`, `audiod/scheduler-core.js:215,225`, `electron/separation-enforce.js:19,24,35`, `electron/sweeper-pool.js:34` — filter `play_log` by station only, and synced plays from other computers are in that table. |
| 5 · cap | `src/components/Logs.tsx:111`: since ee43be3 (4.6.60) a day is uncapped; longer ranges still take 200. |

Legacy: **~176,000 plays have no computer recorded** (everything before v63, 10-18): station 1 25,993 · halloVeen 122,830 · Magical Forest 12,674 · Christmas in Jully 14,447.

## The build

### 1 · Designation removed
- `electron/generation-designation.js`, `_designationTick`, the `mayAutoGenerate` gate in `_autoExtendTick` (`main.js` ~12813), IPC `designation:status` / `designation:refresh` / `designation:bypass`, the Health Monitor row (`src/lib/designationRow.ts`), its tests and `electron/smoke-designation-write.js` → deleted.
- Every computer auto-builds every station's log (the existing "built before the show starts" rule, c32f459), with no gate.
- The `designated_generator` / `kill_designation` rows already in `station_config_kv` (a synced table): **left in place, read by nothing** — no write into synced data to remove them.
- Help: `docs/help-designated-generator.md` deleted, every door to it removed; `help-program-log.md` says "each computer builds its own log".
- Untouched: the server's **broadcast owner** (which computer's now-playing feeds the Remote/Park pages and stream status). Different job; not a builder designation.

### 2 · Every play carries the computer's name
- Schema v67: `play_log.machine_name TEXT` (synced column). Written at go-live with the id — a snapshot of the name at the time, so a renamed computer never rewrites history.
- **Plays land on the right station on the other computer:** `play_log` gets `refs: { station_id: 'stations' }` (station by UUID), so a play never lands under whatever station has the same local number over there. `deck_id` / `session_id` stay unmapped (sacred).

### 3 · Play Log: "Aired on" + filter by computer
- Column **Aired on** = `machine_name`; a play with only an id shows the short id; a legacy play shows **Not recorded**.
- Filter **Computer:** All · each computer seen in this station's plays · Not recorded. Combines with the period, From/To, search, deck and class filters.
- Exports — **PDF, Export CSV (As-Run), BMI, ASCAP** — get the column and take exactly the rows the screen filter selects (computer + period). Traffic is the schedule, not plays — unchanged.
- Help: `help-logs.md` updated.

### 4 · Rotation counts this computer's plays
- One helper (`playsHere(db, stationId)` SQL fragment: `machine_id = <this computer>` + the legacy choice below) used by every reader listed above. One place, so they can never disagree.

### 5 · No cap
- Every range lists every play. Rendering 124,000 rows every 5 s would freeze the window, so: the table renders only the rows on screen (virtualised), and the 5 s refresh fetches only plays newer than the newest shown.

### Senses
- Health Monitor: "plays arriving from other computers" (last arrival per computer per station); a play stored with an unknown station UUID is a named error, not silently dropped.

## For Jeff

1. **Conflict with a binding doc:** `docs/scheduler-rotation-playout-design.md` §3.9 says "**Rotation counts plays of the broadcast owner only** (setting, starting value on)". Point 4 replaces that with "each computer counts its own plays". I'd update §3.9 to your wording. (Neither is in the code today — the readers count everything.)
2. **The ~176,000 plays with no computer recorded** — for rotation on each computer:
   - **(a) count them on every computer** (recommended). They are all older than 10-18, so they drop out of every separation window within days, and least-recently-played keeps its full history;
   - (b) ignore them — every song not played since 10-18 then looks "never played", which reshuffles rotation everywhere at once.
3. **Uncapped "All" needs a virtual list.** The shared grid deliberately has none (`src/components/grid/DataGrid.tsx` header). I'd add `@tanstack/react-virtual` — the same TanStack family the grid already uses. OK to add the dependency?
4. **The two-computer test:** which, and where?
   - **(a)** two isolated Ether installs on OVEVENTS, each with its own computer identity, both signed into a **test account** with a test station, airing it at the same time through the real backend (recommended — no customer, OV or live station involved). Which account/station is "the test stations"?
   - (b) OVEVENTS + ovowforestmusic airing one of your stations.
5. **Station numbering:** fixing the station mapping for plays (build §2) is needed for point 2 to be correct in general. On OV today both computers' halloVeen happen to be station 2. Include it?

Nothing is built until you answer. Build after you've installed 4.6.60, as you said.

## Jeff's answers (verbatim, 2026-10-20)

> 1. Yes, update §3.9 to my rule: each computer's rotation counts the plays that aired on that computer.
> 2. Count the old plays with no computer recorded on every computer.
> 3. Yes, add @tanstack/react-virtual.
> 4. Two separate installs on OVEVENTS, never ovowforestmusic. Propose which test account and test station you'd use, never a customer account or accounts 21/23, and wait for my OK before signing in.
> 5. Yes, include the fix: synced plays find their station by identity, not local number. Check every other synced table for the same problem.
> Build after I've installed 4.6.60.

Done: §3.9 updated (`docs/scheduler-rotation-playout-design.md`).

## 5 · Every synced table, checked (static, the tree at e9b02ff)

**Per table — fine.** Through `refsOf` (`electron/sync/synced-tables.js:1210`, the one definition push and merge both read), every synced station table — `play_log` included — sends its station as the station's UUID and the receiver maps it to its own local station. The default for a station table with no explicit refs is `{ station_id: 'stations' }`, since c2c9409 (2026-10-19, in 4.6.60). Not synced (correct): `generated_schedule`, `install_secrets_kv`, `monitor_routing`. `screen_layouts.station_uuid` is itself a UUID value. Install-scope tables have no station column. So the earlier plan's "§2 station fix" is **already in 4.6.60** at the table level.

**The pipe — the same problem, one level up (affects every station table, not just plays):**
1. **The account's sync pulls only the ACTIVE station.** `electron/main.js:4053` `getStationId: () => getActiveStationId()`; the backend (`ether-backend src/routes/sync.js` pull) returns rows for that one station plus install-scope rows.
2. **One cursor for all stations.** `sync-engine.js:107` one `cursorKey` (`system_state`) per sync context. The server's position moves past rows of stations that were not active, so (reading of the code — **runtime UNVERIFIED**) a play aired on another computer for a station that is not active here is never delivered here, even after switching to it.
3. **Station identity is a per-station switch, read from the active station.** `sync_uuid_identity` (`main.js:4036`, comment: "OFF by default … not yet validated on the real two machines"). Off → the server scopes by the sender's/receiver's local station **number** (`station_id = $3`). On OVEVENTS today: station 1 true, 2 (halloVeen, active) true, 3 false, 4 false, 9 none.
4. **Whether a computer pushes at all** is `sync_enabled` of the active station (`main.js:4000`): station 2 true, station 1 false, others none.

What matches: OVEVENTS' live DB shows another computer's halloVeen plays (534, 10-18 → 10-19) — halloVeen is the active station with identity on. Magical Forest / Christmas in Jully show none from another computer.

**Proposed (needs Jeff's OK — it changes how all station data syncs, not only plays):** sync every station this account holds, each by its station UUID with its own cursor — exactly what the member path already does per station (`main.js:4118-4126`: `uuidIdentity: true`, `cursorKey: 'sync_cursor_member_' + uuid`). Identity always on (the per-station switch retired). Pushes journal every station's rows regardless of which is active. The 2-computer test proves it.

## Test account and station — proposal (nothing signed in)

- **Not license 24 (jensj@opportunityvillage.org):** OVEVENTS' live install is signed into it (`install_config_kv.account_email`) and it holds halloVeen, Open Format, Magical Forest, Christmas in Jully, Fall VIbes — a test station there would appear on the real OVEVENTS (and any other computer on that account).
- **Proposed: djdeniro, license 22**, with **one new station created only for this test, "TEST Two Computers"**, deleted at the end (station delete preserves the account library). Never 21/23, never OV's license 19.
- Two installs on OVEVENTS, each fully isolated: its own empty LOCALAPPDATA (own computer identity, own DB) **and its own `--user-data-dir`** (the 4.6.60 launch showed the APPDATA variable alone leaves the browser profile and daemon log in the real Roaming folder). Audio to a non-air output; no stream.
- Needs Jeff to confirm: no live computer is signed into djdeniro; two extra seats on license 22 are acceptable for the test.

## Jeff's rulings (verbatim, 2026-10-20, second set)

> 1. Yes: sync every station the account holds, each by identity with its own position marker, pushes for every station regardless of which is active. Remove the sync_uuid_identity switch; identity is always on. Same for sync_enabled per station if it gates pushes the same way: no per-station switches deciding what syncs.
> 2. No test account and no test station on any real account. Prove it with two separate databases and the real sync code against a local test server on OVEVENTS, nothing touching the real backend or any account.
> 3. After I install 4.6.60, build it.

### Findings for the build (read-only)
- `sync_enabled` is the **Settings → Multi-Device Sync** on/off for the whole sync engine (`main.js:4000`, written by `SettingsPanel.tsx:1144`), but stored per station and read from whichever station is active — so switching stations can switch sync on or off. Journaling (`mutation-writer.js`) does not read it. To be retired as a per-station value (question to Jeff: what it becomes).
- **The proof (no real backend, no account):** the pattern of `ether-backend/scripts/prove-member-convergence.js` — the REAL `makeSyncRouter` (`ether-backend src/routes/sync.js`) on in-memory Postgres (pg-mem), two separate SQLite databases each with its own computer identity, the REAL desktop `SyncEngine` / `MergeEngine`. Two computers airing the same station; each records plays; the Play Log on each shows both computers' plays with "Aired on"; each computer's rotation counts its own; a station that is not active on the receiving computer still receives; stations numbered differently on the two computers still land right.
- The backend already serves one station by identity (`station_uuid` branch of the pull); no backend change expected — confirmed during the build.

## Jeff's ruling — the sync switch (verbatim, 2026-10-20, third set)

> (a) One on/off for the whole computer, starting on where any station has it on today. Its purpose: if a mistake is made on a computer (like the library on OVEVENTS), I switch sync off so it can't spread, restore a recent backup, then switch sync back on.
> - While off, show it plainly on screen everywhere, never silent.
> - Restoring a backup while sync is off discards every unsent change made before the restore, so turning sync back on never sends the mistake out. After the restore, the computer catches up from the other machines.
> - Include this in the proof on the two test databases.

### How it maps onto the code (read-only)
- **Switch:** one computer-wide value (`install_config_kv`), Settings → Multi-Device Sync. Migration: on if any station's `sync_enabled` is `true` (OVEVENTS: halloVeen → on). The per-station `sync_enabled` rows are left in place, read by nothing.
- **Off, everywhere:** a persistent "SYNC OFF on this computer" indicator in the header (every window, pop-outs included) + a Health Monitor line + a ledger event when switched. Off = no push and no pull. Changes made while off are still recorded in the outgoing queue (journaling never read the switch).
- **Restore:** both restore handlers (`db:restore` `main.js:7672`, `restore_db` `:7866`) swap the whole database file (`swapDatabaseFile`). The restored file brings **its own** outgoing queue (whatever was unsent when the backup was taken) and its own read position. Build: after a restore, **every unsent change in the restored file is discarded** (marked discarded, counted, ledger event, shown in the restore result) — so nothing made before the restore can go out. The read position is kept, so switching sync back on catches up everything the other computers sent since the backup.
- **The case the ruling does not settle:** a mistake this computer **already sent** before sync was switched off. It is on the server and on the other computers; the catch-up after the restore brings it back to this computer too (the server returns this computer's own earlier changes, and the restored file no longer knows it applied them). Options: (a) catch up everything, including this computer's own already-sent changes — every computer stays the same, the mistake included, and it must be fixed on purpose; (b) skip this computer's own changes made after the backup's time — this computer stays clean but differs from the others. Question to Jeff.
- **Proof additions (two test databases, local server):** sync on both → computer A makes a mistake with sync OFF → nothing reaches B; A restores a backup → A's unsent queue is discarded (counted); A switches on → nothing of the mistake reaches the server or B, and A receives what B changed meanwhile. Plus the already-sent case, whichever way Jeff rules.

## Jeff's ruling — an already-sent mistake (verbatim, 2026-10-20, fourth set)

> Neither. After a restore, give me an admin action "Send this restore to every machine" (with a confirm) that makes the restored data replace the mistake on every computer. Without that action, use (a). Include it in the proof.

### Design
- **Where:** offered in the restore result and in Settings → Multi-Device Sync, while sync is OFF after a restore. Admin only (the existing admin-PIN gate), with a confirm that names the backup's time and the number of rows it will put back.
- **What "the mistake" is:** the changes **this computer sent** after the backup was taken (the server's record of this computer's own changes since the backup's read position). Changes other computers made in the meantime are not touched — unless they changed one of the same rows, in which case the restored row wins (the confirm shows that count separately).
- **How:** fetch those changes from the server without applying them; for every row they touched, send the restored version as a new change (it wins on every computer by being newest), or a delete where the row did not exist in the backup. Then sync switches on and catches up as in (a).
- **Without the action:** (a) — catch up everything, the mistake included; it must be fixed on purpose.
- **Senses:** ledger event (who, when, backup time, rows put back, rows deleted); Health Monitor line until every pushed change is accepted.
- **Proof addition:** A sends a mistake with sync on (it reaches B) → A switches sync off → A restores → A runs "Send this restore to every machine" → on B the mistaken rows are back to the restored values, rows the mistake created are gone, and B's own unrelated change made in the meantime is still there. And the same run without the action → (a): A ends up with the mistake too.

Confirmed by Jeff (verbatim, 2026-10-20): "Yes, only this computer's changes since the backup."

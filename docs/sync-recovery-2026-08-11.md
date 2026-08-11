# OV sync recovery, the silent installer, and the toggle that never wrote

**Date:** 2026-08-11 · **Status:** RECORD — the fixes are shipped in 4.4.185; the procedure below is
operational, not proposed.
**Machines:** OV (Opportunity Village, live master) · jensj (dev)
**Related:** `docs/generate-worker-design-2026-08-11.md`, backlog *"Multi-machine two-writer hazard"*

---

## 0. What is verified, and what is reported

House rule: a claim about a running machine needs a runtime receipt. This document mixes both, so it
says which is which rather than flattening them.

| Claim | Basis |
|---|---|
| The toggle never wrote; `set-local` refused every call | **VERIFIED** — allowlist read from source; `station_config_kv` held **0 rows** for the key against **4** for `log_reader_flip` |
| `auto_generate_enabled` is allowlisted in the shipped 4.4.185 asar | **VERIFIED** — read out of the packaged `app.asar` |
| Local-only state cannot return from the cloud | **VERIFIED** — `synced-tables.js` / `LOCAL_ONLY_KEYS`, cited in §4 |
| Installer spun and failed silently; restart resolved it | **OPERATOR-REPORTED** (Jeff, on the machine) |
| Restore sat at 0% then errored | **OPERATOR-REPORTED** |
| OV now on 4.4.185, auto-generation ON, sync working both ways | **OPERATOR-REPORTED** |
| Defender/SmartScreen involvement | **SUSPECTED, NOT ISOLATED** — see §3 |

---

## 1. The problem

The OV machine — the live master for Opportunity Village — had gone months without an update and was
stranded on an old build.

1. **The installer would not launch.** 4.4.182, 4.4.183 and 4.4.184 each spun for about a second and
   then failed with no dialog, no error, nothing. The same installers ran normally on other machines.
2. **The sync restore failed.** Once installed, a restore sat at 0% for roughly a minute and then
   errored.
3. **The auto-generation toggle flickered** — found during the same session, unrelated to OV.

---

## 2. The toggle: root cause found, and it was never a UI problem

This is the part with hard receipts, so it is stated first.

`station_config_kv:set-local` refuses any key not in `LOCAL_ONLY_KEYS`
(`electron/sync/handlers/station_config_kv.js`). That set contained exactly one key:

```js
const LOCAL_ONLY_KEYS = new Set(['log_reader_flip']);
```

`auto_generate_enabled` was never added. **Every click returned `{ok:false}` and wrote nothing.** The
UI painted the new state optimistically, re-read the store, found it unchanged, and snapped back —
which looks exactly like a race and was not one.

**Receipt:** `station_config_kv` contained **zero rows** for the key and **four** for
`log_reader_flip`. The mechanism worked; the key was not admitted to it.

**Two releases claimed this fixed.** 4.4.184 corrected a genuine parsing bug — the reader compared
the `{ok, value}` envelope against `"0"` — and shipped as the fix without ever checking whether the
write succeeded. The flip canary ten lines above *does* check the write's verdict and says why in a
comment. A second toggle was written without that check.

**Shipped in 4.4.185:** key allowlisted; `set-local` logs accepted writes and refusals; the toggle is
controlled (renders only what the store confirms, so a refusal cannot masquerade as a flip); a
refused or non-sticking write shows an error under the row. A test now asserts that **every key the
UI toggles is in `LOCAL_ONLY_KEYS`** — guarding the class, not the instance.

**Default also changed to OFF.** An unattended writer to the playout log is switched on deliberately,
never inherited (§5).

---

## 3. The silent installer — resolved, but NOT root-caused

A restart cleared it and the install proceeded. That is the operational fact and it is worth
recording. What is **not** established is why.

Three explanations were in play — a stuck installer process, Defender/SmartScreen, and needing
Administrator. **None was isolated before the restart resolved the symptom**, and a restart clears
all three at once. Recording one of them as *the* cause would be inventing a finding.

> **Naming note:** this was filed as a "file path issue". Nothing in the evidence points at a path.
> The observed fact is a silent, immediate failure to launch. Keeping the wrong name would send the
> next person looking in the wrong place.

**If it recurs, isolate before restarting** — the restart destroys the evidence:

1. Task Manager → Details: is a previous `Ether Setup *.exe` or `Un_A.exe` still resident?
2. Event Viewer → Windows Logs → Application, at the moment of the click. SmartScreen and Defender
   both log there; a silent block is visible even though the UI shows nothing.
3. Run the installer from a console (`.\Ether Setup 4.4.185.exe`) — NSIS writes errors to stderr that
   the shell swallows on a double-click.
4. Only then restart.

---

## 4. Clean install: the procedure, and what it COSTS

The procedure that recovered the machine:

1. Uninstall Ether.
2. Delete `%LOCALAPPDATA%\Ether`, `%APPDATA%\Ether`, `%LOCALAPPDATA%\Programs\Ether`.
3. Restart.
4. Install the current build.

It works because it removes every stale local file, so the restore lands on nothing that can
conflict. **It also destroys state that no cloud restore can bring back**, and that is not obvious
from the steps.

`%LOCALAPPDATA%\Ether\com.ether.radio\openair.db` is the database. Deleting it discards everything
marked local-only in sync, which by design never left the machine and therefore cannot return:

| Lost | Where | Consequence |
|---|---|---|
| `log_reader_flip` | `LOCAL_ONLY_KEYS` | Station silently reverts to the legacy playout path |
| `auto_generate_enabled` | `LOCAL_ONLY_KEYS` | Auto-generation reverts to default — **OFF** from 4.4.185 |
| `generated_schedule.state` / `played_at` / `seq` | `synced-tables.js:324-326` | As-run truth for this machine; the log returns as plan-only |
| `generated_schedule.source` | `synced-tables.js:327` | Provenance — `operator` deck-loads and `auto` marks are gone |
| Deck routing | `scope: 'local-only'` | Output device assignment is per-physical-machine |
| `stream_key` | `synced-tables.js:613` | Stream credential must be re-entered |

**So the procedure has a mandatory step 5 the original list omits: re-set this machine's local
settings.** On OV that means the log-reader flip and switching auto-generation back ON — which is
precisely why OV needed it enabled by hand after the rebuild, rather than inheriting it.

**Prefer the narrower recovery when it applies.** A full wipe is the blunt instrument: it is
warranted when the schema is stale and the local state is suspect, as here, but a restore over a
working file loses the same six categories for nothing. Offline-first repair is local and in-place;
the cloud restore is the last resort on a genuinely dead file.

---

## 5. Current state

Operator-reported unless marked:

- **OV** — 4.4.185, auto-generation **ON**, live master.
- **jensj (dev)** — 4.4.185, auto-generation **OFF**.
- Sync working in both directions.
- The toggle writes and sticks.

**That ON/OFF split is the mitigation, not a coincidence.** With `_autoExtendTick` carrying no leader
guard and `generated_schedule` synced, two machines with auto-generation ON for the same station both
generate it and both write — see §6. Exactly one machine being ON is currently the only thing
preventing that, and nothing in the code enforces it.

---

## 6. What is still broken

**The multi-machine two-writer hazard.** Receipts: `_autoExtendTick` has no leader guard;
`generated_schedule` is synced (`synced-tables.js:25`); reconciliation is last-writer-wins. Two
machines generating the same station produce *different* schedules — separation state, LRP order and
`ORDER BY RANDOM()` all differ per machine — and the survivor is an LWW interleaving of both.

Default-OFF (4.4.185) shrinks the blast radius: a fresh install no longer enrols itself as a second
generator. It does not fix it. The fix is a **synced, station-scoped generation lease** keyed on the
existing stable `machine_id`, with a heartbeat so a dead machine cannot hold a station hostage.
Filed in the backlog; not built.

---

## 7. Lessons

1. **Check whether the write succeeded before diagnosing the UI.** Two releases treated a rejected
   write as a rendering problem. The IPC returned `{ok:false}` the entire time and nobody read it.
2. **When a neighbouring implementation guards something, copy the guard.** The flip canary checks
   the write verdict and documents why; the second toggle omitted it and shipped broken twice.
3. **A restart that fixes a problem also erases its cause.** Isolate first, restart second — §3.
4. **A clean install is not state-preserving.** Local-authoritative data never syncs, so it cannot
   come back. Budget for re-setting it, per §4.
5. **Name the symptom, not a guess.** "File path issue" would have sent the next person hunting
   paths for a failure that showed no path evidence.

---

## 8. Next steps

1. **Single-writer election** — the only real fix for §6, and the largest open risk in this arc.
2. **Week-view AUTO chip** — the marker is month-view only, and week is the default view, so today
   the provenance work is invisible where operators actually look.
3. **Operator-row protection (Fix 2)** — `docs/manual-log-editing-design-2026-08-10.md`, designed and
   unbuilt. `_commitDayRows` deletes its window unconditionally, `source='operator'` included.
4. **Confirm on OV** that auto-generation is genuinely ON *in the store* — 4.4.185 is the first build
   where that write can succeed at all:

   ```sql
   SELECT station_id, key, value FROM station_config_kv WHERE key = 'auto_generate_enabled';
   ```

   A row with `value='1'` is the proof. No row means the default (OFF) is in force whatever the
   button shows.

---

## 9. Compliance

- **Read-only record.** Everything described here shipped in 4.4.185; this document changes nothing.
- **No diagnostic persistence.** Nothing installed on either machine; no watcher, poller or task.
- **Verified vs reported is marked throughout** (§0). The installer cause is recorded as unresolved
  rather than assigned to the most plausible candidate.

# Web-UI mirror regression — diagnosis (2026-07-14)

**Status: READ-ONLY DIAGNOSIS COMPLETE. Fix is a PROPOSAL — awaiting Jeff's GO. No changes made.**
Symptom: programming / categories / library edits stopped mirroring to the web dashboard
(`app.ether-technologies.com`). Prime suspect on entry: the July 13 DB re-sync.

## Root cause (receipts)

The dashboard mirror is fed by the **mutation-push sync engine** (local edits → `POST /sync/mutations`
→ Railway backend → dashboard reads). That engine is **gated OFF** and has **never run on this DB**.

- **Gate:** `electron/main.js:1980-1984` — `SELECT value FROM station_config_kv WHERE key='sync_enabled'`;
  `if (enabledRow?.value !== 'true') → '[SYNC] disabled'`. Opt-in, off by default (Settings → System →
  Multi-Device Sync).
- **Flag absent:** `station_config_kv` contains **no `sync_enabled` and no `sync_backend_url`** for any
  station (ids 1=Open Format, 2=halloVeen, 3=Magical Forest). `SELECT COUNT(*) ... IN ('sync_backend_url','sync_enabled') = 0`.
- **Backlog never drained:** `mutations` = **53,944 rows, ALL `sync_status='pending'`, ZERO ever `synced`**
  (oldest 2026-07-06T17:44Z, newest today). quarantine=0.
- **DB genesis ~Jul 6** (oldest mutation == first-run config writes). So sync has been dead since this
  DB's birth — it did not "break recently"; it was never enabled here.
- **What's stuck** (by target table): `generated_schedule` 43,771 · `station_config_kv` 4,584 ·
  `play_log` 1,945 · `stations` 1,483 · `songs` 1,464 · `artists` 299 · `clock_slots`/`clock_breaks`/
  `clocks`/`separation_rules`/`shows` · `categories` 11 · `spot_categories` 3. → the entire
  programming/library/category surface.
- **Backend URL:** `electron/lib/etherBackend.js:17` = `https://ether-backend-production.up.railway.app`.
- **Library path is separate:** `electron/main.js:1962-1975` `runLibrarySync` (GET `/library/snapshot`
  /`/library/changes`) is gated only on JWT+license, NOT `sync_enabled` — so library *metadata* still
  flows; the dead path is specifically the mutation push (programming/categories edits).

## The July 13 event (suspect — cleared as prime cause)

The Jul-13 re-sync **is real** but is an amplifier, not the cause: it added **19,965 pending mutations**
that day — a `generated_schedule` mass rewrite (17,370) + `station_config_kv` 1,566 + `songs` 401 +
`stations` 393. It rewrote the schedule but did NOT enable sync; the drain was already off before and
after. Pending-by-day: Jul6 15,672 · Jul7 3,025 · Jul8 197 · Jul9 1,443 · Jul10 3,470 · **Jul13 19,965**
· Jul14 10,172.

## What broke, when

- **What:** the mutation-push sync engine is disabled (`sync_enabled` + `sync_backend_url` absent from
  `station_config_kv`), so no local edit has ever reached the backend from this DB.
- **When:** since this DB's genesis (~2026-07-06). The dashboard shows only the **last successful sync of
  a PRIOR DB (pre-Jul-6)** and none of this install's edits since — which reads to the operator as
  "mirroring stopped recently." Prior working mirror (e.g. OV category-edit verified 2026-05-26) was on
  the earlier DB.

## Restore path (PROPOSAL — needs GO; touches the live airing box)

1. **Back up** the live DB first (74 MB) — a one-way drain of 53,944 mutations is significant.
2. **Enable sync** via the supported path — Settings → System → **Multi-Device Sync** toggle — so it sets
   `sync_enabled='true'` correctly (station-scoped, mutation-tracked) rather than a raw SQL write. Verify
   it also sets `sync_backend_url` = the Railway URL above; if not, set that too (else `baseUrl=''` and
   the push has no host — `main.js:1989`).
3. **Restart the app** so the sync scheduler initializes (it's built once at startup, `main.js:1979`;
   flipping the flag mid-session won't start it). ⚠️ **This restarts the 3 airing stations** → requires
   explicit GO naming the stations, per the standing rule.
4. **Drain + watch:** scheduler drains ≤500/round (`sync-engine.js:296`). Monitor `sync_status`
   pending→synced and the dashboard catch-up. Watch backend load — 43k `generated_schedule` rows
   (many redundant from the Jul-13 re-import) will push.

### Open decisions for Jeff
- **Backlog hygiene:** push all 53,944 as-is, or **checkpoint/compact** first (the `mutations` schema
  supports a `checkpoint` op) to avoid flooding the backend with redundant Jul-13 schedule history?
- **Conflict direction:** backend holds stale pre-Jul-6 data; local is newer. Confirm HLC/local-wins is
  desired before draining (a `conflicted` status path exists).
- **`station_programming`=0** vs `generated_schedule`=20,407 local: confirm which table the dashboard's
  "programming" view reads, so we know the drain actually repopulates it.

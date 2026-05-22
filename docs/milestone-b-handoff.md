# Milestone B — handoff for next session

**Date:** 2026-05-22
**Status:** Milestone B foundation complete (Phases 1.1–1.3j + task #8b). Phase B (Screen 4 button wiring) not started — design questions answered, build order locked. New session picks up at B.1.

---

## What landed this session

**`C:\openair` — 28 session commits** from `91279a8` (identity IPC, task #1) through `402cdf4` (1.3j SDK uninstall). Covers:

- Onboarding tasks #1–9 (identity IPC → OnboardingFlow scaffold → Screens 1/2a/2b/3/3b/bolted/4 → resumption logic)
- Phase 1.1 (schema v17 — `songs.file_key` + `songs.r2_uploaded_at`)
- Phase 1.2 (frontend `plan_tier` write from `/account/*` responses)
- Phase 1.3f–k (cloud-backup migration, library sync upload, audio fetch, `audio:load` fallback, KV cleanup migration v18, `@aws-sdk` uninstall)
- Tracker entries logged: OB1, OB5, OB6, OB7, OB8, SP1

**`C:\ether-backend` — 10 commits unpushed** (`d73daec` through `87054a8`):

```
87054a8 GET /sync/pending-count (task #8b)
d24bf11 /backup/upload-url dual signed URLs (1.3e amendment)
b3e004f POST /backup/upload-url (1.3e)
f4d6fd3 GET /audio/list (1.3d)
ae60212 POST /audio/download-url (1.3c)
810ba3a POST /audio/upload-url (1.3b)
05892a7 R2 client scaffolding (1.3a)
9ac33dc /account/* responses include plan (1.2)
e23b066 cleanup-test-onboarding.js helper
d73daec POST /account/deauthorize-seat + GET /account/seats
```

**Railway env vars to set when un-paused** (currently the audio + backup endpoints return `503 r2_not_configured` until these land):

- `R2_ACCOUNT_ID`
- `R2_BUCKET` (defaults to `ether-audio`)
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- Optional: `R2_ENDPOINT` (non-standard hosts)

---

## Phase B — design questions locked

**Do not re-litigate; locked in the prior turn:**

1. **Rename `library:sync-r2:start` → `library:sync-r2:upload`** and add a parallel `library:sync-r2:download` handler. Symmetric naming. Zero consumers today (grep confirmed). No real breaking change.
2. **"From this computer" silently skips unmatched files.** Show "Matched X of Y songs from your folder." Unmatched files ignored — customer adds them via normal Library → Import later. Avoid decision-fatigue in onboarding.

---

## Build order — each step its own commit, show diff before commit

### B.1 — Rename `library:sync-r2:start` → `library:sync-r2:upload`

- Rename the IPC channel + handler name in `electron/main.js` (handler currently around line 3737 — verify with grep before editing, line numbers shifted across the session).
- Update the comment in `electron/cloud-backup.js:397` that references the old name.
- No renderer-side consumer to update (zero callers; confirmed via grep).
- Grep tip: the broad pattern `library:sync-r2` timed out via Grep tool — narrow with path globs (`electron/`, `src/`) separately if needed.

### B.2 — Add `library:sync-r2:download` IPC handler

Parallel async function alongside upload in `main.js`. Mirrors upload's structure with inverse direction:

- **Tier gate:** Network+ (same as upload). Reads `plan_tier` from `station_config_kv`.
- **License key** from `station_config_kv` (same pattern).
- **SELECT:** `songs WHERE file_path IS NOT NULL AND r2_uploaded_at IS NOT NULL`. Then filter in JS via `fs.existsSync` to skip songs already on disk.
- **For each:** call `fetchR2Track(file_key)` — already extracted in 1.3k, available at module scope in main.js.
- **On success: DO NOT write `file_path` back.** 1.3k's `audio:load` fallback handles load-time resolution via the cache. The download just pre-warms `<userData>/r2-cache/`. Same reasoning as Option B in 1.3k — writing file_path back generates sync-log churn.
- **Emit** `library:sync-r2:download:progress` with shape `{ done, total, errors, current }`.
- **Terminal** `library:sync-r2:download:done` with `{ done, total, errors, aborted }`.
- **Add** `library:sync-r2:download:cancel` IPC + `_libDownloadAbort` flag (mirror upload's `_libSyncAbort`).

### B.3 — Screen 4 button wiring in `OnboardingFlow.tsx`

The three button placeholders exist in `OnboardingFlow.tsx` from the onboarding arc. Verify state-machine state names before editing (the spec doc renumbered Screens 4 → 5 for metadata pull and inserted a new Screen 4 = `pickLibrarySource` — confirm the code matches before adding handlers).

**"Skip for now":**
- Write `onboarding_library_source: 'skip'` to `station_config_kv`.
- `setState('pullingMetadata')` (or whatever the metadata-pull state is named).

**"From this computer":**
- `window.ether.dialog.openDirectory()` → folder path.
- Recursive scan for audio extensions (reuse pattern from `ImportDialog.tsx` or `loggen.ts`).
- For each scanned file: extract basename.
- SELECT `songs WHERE file_path basename matches any of the folder basenames`.
- Show preview: "Matched X of Y songs from your folder. Unmatched files will be ignored — add them later through Library → Import."
- On confirm: **raw bulk UPDATE songs SET file_path = ? WHERE id = ?** per match. **Not `songsUpdateById`** — this is local-truth path data; receiver machines find their own files via their own scan. Going through mutation log would make every machine churn through other machines' paths.
- Write `onboarding_library_source: 'local'` to KV.

**"From the cloud":**
- Tier-gated (Network+ only). Grey out + tooltip "Upgrade to Network to sync from cloud" when `plan_tier < station`.
- Invoke `library:sync-r2:download` (the new B.2 channel) — background, fire-and-forget.
- Write `onboarding_library_source: 'cloud'` to KV.
- `setState('pullingMetadata')` **immediately** — don't wait for download. Per the Phase 3.6 background-fetch decision: metadata pull and audio download run in parallel; audio continues post-onboarding via the persistent progress bar (B.4).

### B.4 — Persistent bottom-of-UI audio sync progress bar

- New component, lives at `App.tsx` top-level (visible across all panels).
- Subscribes to `library:sync-r2:download:progress` IPC events.
- Bar shape: ~32px tall, full-width, bottom of viewport.
- Auto-hides when `library:sync-r2:download:done` fires (or after a short fade).
- Copy: "Downloading library — 1,247 / 5,890 audio files".
  - Total count comes from the download handler's initial SELECT, included in the first progress event.
  - Byte counts (e.g., "3.2 GB / 18.4 GB") are optional for v1 — would require per-file size aggregation. Skip unless you want it now.
- Visible across all panels (Library, Playlist, Studio) — lives at `App.tsx` level, not panel-specific.

---

## Open architectural questions for next session

1. **`r2_uploaded_at` semantics on download.** Field is local-only (1.1 design) and currently means "this machine uploaded the bytes." After B.2's download path, downloaded songs have a local copy too — should they set `r2_uploaded_at`? Two options:
   - **(a) Reuse the column, rename the meaning** to "this machine has a local copy of the bytes (by upload OR download)." No schema change. Update comments. Recommended.
   - **(b) Add a separate `r2_downloaded_at` column.** More precise but adds schema churn for marginal benefit.

   Lean (a). Decide and document before B.2 lands.

2. **Screen 4's `/sync/pending-count` consumer not wired.** Backend endpoint exists (`87054a8` in `C:\ether-backend`) but `PullingScreen` in `OnboardingFlow.tsx` doesn't call it yet. After Railway un-pause + deploy, a small frontend follow-up adds the call (likely a new `window.ether.sync.getPendingCount(client_id, since_seq)` IPC bridge). Folds naturally into B.3 or a B.5 step.

3. **Bucket name discrepancy.** `R2_BUCKET` env var defaults to `ether-audio` in `C:\ether-backend\src\index.js`. Legacy `cloud-backup.js` historically used `ether-backups`. Operator must pick: single bucket with prefixes (audio under `${license_id}/...`, backups under `${license_id}/backups/...`) or two buckets with separate `R2_BUCKET` configs. Tonight's backend code assumes single. **Operator decision required on Railway provisioning.**

4. **OB1 — `ETHER_BACKEND_URL` inlining now spans ~9 sites in `C:\openair`.** Started at 4 with onboarding; added with each Milestone B migration. Consolidate to `src/lib/etherBackend.ts` after Milestone B fully ships. Tracker item, not blocking.

---

## Where to pick up in a fresh session

1. **Read this doc first.** Then verify git state:
   ```
   git -C C:\openair log origin/main..HEAD --oneline | head -30
   git -C C:\ether-backend log origin/main..HEAD --oneline
   ```
   Expect ~28 openair commits (this session) + ~14 pre-session unpushed commits (unrelated), and 10 ether-backend commits.

2. **Start with B.1 (rename).** Cleanest entry — one small commit. Confirms tooling + state before bigger work.

3. **Then B.2 → B.3 → B.4 in order.** Each its own commit. Show diff before commit. Same disciplined cadence as the rest of the Milestone B arc.

4. **Don't push until Railway un-pauses.** Both repos hold their unpushed stacks. When the pause clears, the backend deploys and the full Milestone B path goes live end-to-end.

---

## Active tracker items (parked for after Milestone B ships)

| ID | Item | Where |
|---|---|---|
| OB1 | `ETHER_BACKEND_URL` inlined in ~9 sites — consolidate to shared module | `docs/close-out-tracker.md` |
| OB5 | Playout-server still needs customer R2 credentials | `docs/close-out-tracker.md` |
| OB6 | Audio sync 2-calls-per-file — batch-sign optimization candidate | `docs/close-out-tracker.md` |
| OB7 | `r2-cache` unbounded growth — eviction policy needed | `docs/close-out-tracker.md` |
| OB8 | `r2:fetch-track` concurrent-fetch dedup | `docs/close-out-tracker.md` |
| SP1 | Splash screen runs on `setTimeout`, not real startup events | `docs/close-out-tracker.md` |
| EB3 | Stripe webhook silent fallback to `"pro"` on unknown priceId | `docs/close-out-tracker.md` |
| EB4 | `/admin/issue` accepts arbitrary plan strings — no enum validation | `docs/close-out-tracker.md` |

None block Phase B.

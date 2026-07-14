# DESIGN-TRUTH

Canonical registry of load-bearing product decisions that are **not** self-evident from the code —
the ones that get silently reverted when a screen is refactored or a build is wiped. Each entry states
the decision, the invariants it must preserve, the mechanism, and the *lesson* (the specific way it was
lost or nearly lost before). If you are about to change a flow named here, read its entry first. If you
change the decision, edit the entry in the same commit — a stale entry is worse than none.

Format per entry: **Decision · Screen/Owner · Invariants · Mechanism · Test that guards it · Lesson.**

---

## 1. Onboarding restore gate — "Sync existing stations" vs "Create a new station"

**Decision.** When a user signs in and the account **already owns stations**, the station-selection
screen MUST offer *both* doors, side by side:

- **Sync existing stations** — the account's stations are listed with a **per-station checkbox**
  (sync 1 of 3, or all). The picked stations are pulled down **complete** onto this machine.
- **Create a new station** — the existing add-station wizard, unchanged, beside it.

A fresh sign-in on an account that has data must **not** be able to reach a usable app without passing
this gate (you either sync ≥1 existing station or explicitly create one). "Empty stations after a fresh
sign-in" is the failure this exists to prevent.

**Screen / Owner.** `src/components/OnboardingFlow.tsx`
- selection screen: `cloudSync` state (per-station `StationRadioCard` checkboxes, select-all, member
  stations) — reused, not rebuilt.
- gate screen: `pulling` state → `PullingScreen` (consumes `sync:progress` / `sync:initial-complete`).
- routing: `routeAfterAuth` (post-auth decision table).
- Settings surface (post-onboarding, same path): `src/…/Settings` "Sync a station to this machine".

**Invariants (honor, do not blind-revert).**
1. **Phase-4 clean-room** (`fe46e66` and successors): `ensureCleanRoom` (account-aware; only a
   *different-account* sign-in wipes — same-account re-sign-in PRESERVES local work), total sign-out
   invariant, UUID station identity. The restore gate is **reintegrated into** this model, not layered
   over a revert of it.
2. **Per-station attach is real, not cosmetic.** Picked stations are **attached** (`/account/attach`,
   role `monitor` = non-exclusive, never takes the exclusive playout claim). **Unpicked stations are
   NOT attached** — they are absent, *not* hidden/soft-deleted. Fail-closed: no attachment →
   `provisioning.js` materializes nothing (never "everything").
3. **Fresh machine identity always.** No cloned `SYNC_SERVER_ID`; UUID-identity rules hold. A customer
   reinstalling lands in THEIR data, never a blank world and never someone else's.

**Mechanism (Hybrid — the one door).**
1. `routeAfterAuth`: on affirmative connect with `stations.length > 0`, route to the **sync-existing
   selection screen** (with "Create" available beside it). `0` stations → create. Connect failure →
   the existing "can't reach server — retry" state (never create; the C1–C3 fix).
2. Attach the **picked** stations only (`provisionAttached`, monitor role, clean-room compatible).
3. **CRDT pull is the restore engine.** The `SyncScheduler` initial bulk pull brings **programming,
   library links, schedules** (station-scoped rows + install-scoped KV, per the sync per-table
   handlers). The app is **gated on `sync:initial-complete`** (persisted one-shot in `system_state`,
   resumes if interrupted — `electron/sync/sync-scheduler.js`).
4. **Audio blobs** (the mp3s — which CRDT does NOT carry) download from **R2**, reusing the existing
   music-download **progress card** from the old screen. Both must finish before "done".
5. **The whole-DB blob path is RETIRED from onboarding.** `station:install-from-cloud` (whole-account
   DB restore + `account_jwt` wipe + relaunch) is unreachable from the onboarding/settings sync path.
   One door only.

**Machine states covered.** brand-new machine (attach picked → full CRDT pull + music) · reinstall over
existing local data (same-account → preserve + CRDT merge per HLC/CRDT rules, no wipe) · account with
the 5-device cap in play (attach is monitor, non-exclusive → no claim collision) · offline sign-in
(connect fails → retry state, never a false "create"; the gate does not strand the user in a dead end).

**Test that guards it** (sync-suite level, so it can't silently vanish again):
- fresh sign-in on an account WITH stations shows the existing stations for selection (not "create");
- selecting exactly one station attaches exactly that station and pulls exactly its data;
- **sign-in cannot complete (reach a usable app) without passing restore when account data exists**;
- receipts assert row counts (stations / songs / schedules) match the source.

**Lesson.** The choice was introduced in **`b824ed4`** (2026-06-11, "sign-in on a fresh machine pulls
account stations from the cloud") and **removed as a side effect of `fe46e66`** (2026-07-03, "Phase 4 —
onboarding station-provisioning decision table"), which replaced `setState('cloudSync')` with a *silent*
table (`0→create, 1→silent attach, ≥2→placement`). Silent attach materialized a station *row* so the app
looked provisioned, but nothing gated on the initial data pull — so a fresh sign-in could land on a
station with no library/schedules. The screen and the pull machinery were never deleted, only orphaned.
Fix = **reintegrate the choice into the Phase-4 clean-room model** (not revert Phase 4), and add the
"cannot complete without restore" test so a future refactor can't orphan it again unnoticed.

---

## 2. Station audio isolation — "each station is its own sound card"

**Decision (Jeff, verbatim law).**

> **"Each station acts like its own separate sound card. Stations do not know each other exists."**

Per-station cpal output stream on the (same or chosen) device — **own stream handle, own callback,
own buffer, own `lastCallbackMs`, own error/recovery path.** No shared stream, no shared mixer state,
no global liveness. One station's wrap / stall / crash must be **structurally incapable** of touching
another station's output. Per-station monitor-device selection falls out for free (fixes the
device-stacking bug). Recovery: a dead stream reopens **its** stream only — automate the manual
automation toggle, scoped to one card. Where the OS forces one physical sound card, the shared layer
is a **dumb passive mixer that never blocks on any single station's state.**

**Screen / Owner.** `native/src/audio.rs` (per-station mixer + cpal output), `native/src/lib.rs`
(`ENGINES` registry), `electron/main.js` `startAudioLivenessWatchdog()` (the net on top).

**Invariants (honor, do not blind-revert).**
1. **No shared mutable state below the engine layer.** Every liveness/stream/mixer datum is keyed by
   `station_id`. Enumerated bug surface (2026-07-10 audit) that must all become per-station:
   `LAST_AUDIO_CALLBACK_MS` (audio.rs:15), `STREAM_CLIENT_CONNECTED` (audio.rs:837),
   `PEAK_REPORT_NS` (audio.rs:952), the B1 diag statics (audio.rs:832–836), and the renderer scalars
   `_lastDaemonAudioAt` / `_lastAudioReloadAt` (main.js).
2. **Structural non-interference.** A station's wrap/stall/crash touches only its own stream, buffer,
   and clock. No code path lets station X's state gate station Y's PCM.
3. **Shared physical device only.** The single default output device is the *only* thing stations may
   share, and only because the OS (WASAPI/audiodg) forces it. That layer is passive.

**Mechanism.**
- Output already per-station: `start_station_mixer(station_id, …)` (audio.rs:526) spawns a per-station
  dispatch thread (audio.rs:567) building its own `device.build_output_stream` (audio.rs:601).
  **3 streams per process, one per station** — confirmed at runtime.
- Make liveness per-station: replace the global `LAST_AUDIO_CALLBACK_MS` with a per-station stamp
  (field on the station's shared state); napi getter `lastCallbackMs(stationId)`.
- Move `STREAM_CLIENT_CONNECTED` into per-station `BusState` (each drain sets its own; each
  `mixer_callback` reads its own).
- Per-station stream-reopen recovery (automates the manual toggle), scoped to one card.
- Watchdog reads **per-station** `lastCallbackMs` + jensj's persistence-ceiling diff as the net.

**Test that guards it.** Packaged smoke + 2-hour 3-station soak with **wrap-survival counts**; a
kill/stall injected on one station must leave the other two's `lastCallbackMs` advancing and audio
unbroken. No global audio static may reappear (grep guard in CI).

**Lesson.** 2026-07-10 live wedge: halloVeen + Magical Forest lost VU + audio simultaneously while
Open Format kept airing, yet `/health` reported `alive:true, staleMs:1` — because the surviving
station kept the **single global `lastCallbackMs`** fresh, masking two dead stations from the
watchdog so recovery never fired. Shared global state (one liveness clock, one stream-client flag)
made one station's death both invisible and cross-station. See
`reports/wedge-capture-2026-07-10.md` and `reports/station-isolation-fix-design-2026-07-10.md`.

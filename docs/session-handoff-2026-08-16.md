---
feature: session-handoff
title: Session handoff — 2026-08-16
summary: What shipped, what is uncommitted, what is still owed, and the two rulings Jeff has not made. Read this first in a new session.
audience: programmer
---

# Session handoff — 2026-08-16

**Read this before touching anything.**

### First reply of the next session must state, plainly:

1. **The two owed rulings** (§4) — one line each, so Jeff sees them tonight-equivalent rather than
   discovering them mid-Monday.
2. **A read-only verdict on the 1,617 orphaned rows** (§3) — what they are, which tables, their
   origin, and **whether they touch anything OV pulls Monday.** If they are laptop-local debris they
   wait; if any sit in a synced table, Monday needs to know before the update. Read-only. No repair
   without Jeff's go.

---

## 1. Tree state — clean

Committed as **4.4.222** (`eb2c9d1`): `StudioPro.tsx` + `WaveformGL.tsx` + the version bump.
Gates green at commit: **tsc 0 · node --check clean · vitest 332/332**, and the pre-commit
`verify:schema` transformer-chain gate passed (v2→v37, 37 scripts).

**This is a checkpoint, not a release.** No installer was built for 4.4.222 and none should be
without Jeff's word — **4.4.221 remains the OV installer story, untouched.**

---

## 2. Committed this session

| Commit | Version | What |
|---|---|---|
| `77f6f25` | 4.4.216 | **Profile-per-account** — one account, one directory. Pointer at `profiles/active` breaks the boot circularity. `ensureCleanRoom` removed; sign-in stopped being destructive |
| `a301a62` | — | Migration carries the append-only ledgers; collision branch no longer deletes a source |
| `26e828e` | 4.4.217 | Version bump only — 4.4.216 had been built twice |
| `9a4e3d4` | 4.4.218 | Program Log + Play Log panes, one record page, full visual pass (341 font sizes, 29 radii, 6 shadows) |
| `7e4b1ea` | 4.4.219 | **Baseline watermark** — `system_state.baseline_hlc`, gate in `backfill-sync-mutations.js:213`, "Clear pending" button. Live journal cleared 339,809 → 0 |
| `c223284` | 4.4.220 | **uuid-identity no longer re-keys local rows** (`merge-engine.js:207`) + station repair + identity receipt log line |
| `8ff3cd9` | 4.4.221 | Shift identity from members (`users`), operator roster dead |

Installers exist for **4.4.219, 4.4.220, 4.4.221** in `dist-electron/`.
**4.4.221 is Monday's installer** unless something below changes that.

---

## 3. STILL BROKEN — the biggest open item

**14 tables, 1,617 orphaned rows on jensj's profile.** The uuid-identity re-key moved stations
`1,2,3,4 → 5,6,7,8`; a repair ran but used a **hand-written table list** and missed these:

```
artists 326 · runway_history 440 · mutations 434 · metadata_definitions 188
metadata_vocabulary 140 · deletion_queue 33 · deck_configs 24 · clock_breaks 13
cart_slots 5 · operators 4 · jingle_categories 4 · spot_categories 4 · albums 1 · users 1
```

Consequences visible in the app: timed breaks missing from clocks, imaging assignments gone, deck
setup lost, traffic buckets gone.

**The fix is designed and NOT run.** Rebuild `scripts/repair-station-rekey.js` to drive from
`PRAGMA table_info` across all 42 station-scoped tables instead of a list, keep the two-phase
offset, keep the duplicate-drop the `station_config_kv` PK collision needed, **exclude
`deletion_queue`** (it points at station 0 — pre-existing, unrelated), and verify orphans reach 0
across all 42. Prove on a copy first. **Jeff has not given the go.**

`sync_uuid_identity` is currently **false** on all four stations — leave it there.

---

## 4. Two rulings Jeff owes

1. **`syncExcluded: true` on `generated_schedule`** (`electron/sync/synced-tables.js:300`).
   339,207 of the 339,809 cleared mutations were that one table, journaled by `logMutation` at
   write time — which no watermark gates. Without this line, PREFLIGHT returns to 0 and then climbs
   again on the next Generate. That table already marks `state`/`played_at`/`seq`/`source` as
   `local-only`, and every machine generates its own log from clocks that do sync.
2. **`CLAUDE.md:15`** says not to rename the legacy `com.ether.radio` directory. The profile
   migration moves data out of it. Deliberate, flagged, unconfirmed.

---

## 5. Show+ DAW — where the build is

Design: `docs/show-daw-redesign-2026-08-16.md` · Mockup: `docs/show-daw-workspace-mockup.html`
(published artifact, approved by Jeff).

**Estimate: 13–18 days across (a)–(d).** The original 3–4 day figure predated the automation
requirement and was wrong.

| Phase | State |
|---|---|
| **(a) Shell + transport** | **DONE (committed, 4.4.222).** `TransportBar` at the bottom, 46px timecode, green play, Peak/LUFS + master meters, transport removed from the top strip, `PaneTabs` chrome, sidebar widened 220→268 with sized controls, automation `▾` speck → labelled `A` button |
| **(b) Headers + mixer + metering** | **MOSTLY DONE (committed, 4.4.222).** `MixerStrips` (pan, fader, VU, dB, M/S + master), tabs switch Inspector↔Mixer and Tracks↔Library, Library pane, header pan slider. Per-track meters already existed |
| **(b) remaining** | **Dockview hosting** (drag/dock/resize/save layouts) and **effects rack as a docked pane** (still modal `FxWindow`). Both deliberately left — each deserves its own gate |
| **(c) Waveform renderer** | Partly addressed by the white-zoom fix (see below). Still owed: stereo peak+RMS layering, mip pyramid per clip, desaturated clip bodies with 3px colour cap |
| **(d) Automation + clip edges** | **NOT STARTED.** No reducer actions exist for lane points (`ADD_LANE_POINT` etc. return nothing), so there is nowhere for a keyframe drag to commit. This is why (d) is 5–7 days |

### The white-zoom fix (committed 4.4.222, in `WaveformGL.tsx`)

Ctrl+zoom painted the timeline white. Three compounding faults:
1. DPR clamped to 2 — a zoom past 2x stopped growing the backing store
2. **Additive blending** (`SRC_ALPHA, ONE`) — overlapping fragments accumulate until RGB clamps at
   white. *That* was the white, not a missing background
3. The draw effect had no DPR dependency, and a zoom is not a React render — so the corrupt state
   persisted

Fixed by: DPR tracked in state via a **self-re-arming** `matchMedia("(resolution: Xdppx)")`
listener, a **total-pixel** cap instead of a ratio cap, and **standard alpha blending**.

Same change addressed Jeff's "waveform is a big rectangle": inside-alpha floored at `0.7` so a
whisper painted as solid as a peak, and `GLOW_PAD 0.07` closed the gaps between peaks. Now alpha
tracks amplitude (`0.30 + amp*0.55`), tight crest highlight, `GLOW_PAD 0.006`.

**Jeff has not verified this on screen yet.** That verification gates the next job.

### Next task, blocked

**Job 2 — Smart Tool** (zone-based context cursors on clips: trim / I-beam / grab / fade by
position, toolbar as explicit override). Spec is in the last prompt. **Ctrl+drag modifier dropped**
by Jeff's amendment — Ctrl is already the zoom gesture. Alt+edge-drag trim-with-fade stays.
Blocked until Jeff confirms the timeline never paints white.

---

## 6. Monday

`docs/ov-update-checklist.md` is written. Step 2 is the **identity receipt** — read the
`[identity] profile=… machineId=…` line before anything else; if it is wrong, STOP, reinstall the
old build, the stream never moved. Step 4: **leave `sync_uuid_identity` OFF on OV.** OV never
enabled it, so OV has none of the re-key damage on this laptop.

---

## 7. Working notes for whoever picks this up

- **Verify every premise against the tree.** Several prompts this session named functions, files,
  tables and columns that do not exist (`seedJournalLocked`, `resetAndReseed`,
  `sync-preflight-and-push.js`, `sync_state`, `hlc_ts`, `dev-fallback`). Grep before building.
- **Prove destructive work on a copy first.** It caught a `station_config_kv` PK collision and a
  locked-file refusal that reading would not have.
- **Sanity-check your own greps.** A dead-component sweep flagged all 46 components as dead twice;
  only a control check ("`TrackLane` must be non-zero") caught it.
- Ether's live DB is `%LOCALAPPDATA%\Ether\profiles\ETH-STN-BAA8-E056-6FC8\openair.db` (~713 MB).
  Read-only diagnostics belong in `scripts/diag-*.js` (gitignored).

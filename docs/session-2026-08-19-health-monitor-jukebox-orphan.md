# Session record — 2026-08-19

**Web Health Monitor · Jukebox layout v2 · orphan-engine review**

Written because the terminal scrollback cannot be copied out. This is the whole session in one place:
what shipped, what is deployed, what is proven, what is NOT proven, and what is waiting on Jeff.

---

## 0 · THE SHORT VERSION

| Thing | State |
|---|---|
| Fleet health data pipe (install → Postgres → web) | **BUILT, DEPLOYED, PROVEN END TO END** |
| Backend (`ether-backend`) | **DEPLOYED to Railway** — commit `f8bf988`, already on origin |
| Web page (`ether-health`) | **DEPLOYED to Cloudflare Pages** — live at https://ether-health.pages.dev |
| Web page's *presentation* | **REBUILT** to be the app's WALL VIEW (was an invented dashboard — wrong, corrected) |
| Jukebox layout v2 (header strip) | **BUILT**, gated, **uncommitted** |
| Orphan-engine fix (another session's work) | **REVIEWED + INDEPENDENTLY VERIFIED 4/4** |
| Pushes from this machine | **NONE**, except the backend (where push IS the deploy) |
| Version bump | **NONE** |

---

## 1 · COMMITS

| Tree | Commit | Where it is |
|---|---|---|
| `openair` | **`119a978`** | LOCAL only. Branch `log-reader-flip`, **ahead 7, unpushed** |
| `ether-backend` | **`f8bf988`** | **ON ORIGIN** — pushing is how Railway deploys this repo-connected service |
| `ether-health` | **`ee466b4`** | LOCAL only. New repo, **no remote configured** |

**`119a978` mixes two sessions' work and is not a clean push candidate.** It contains the health push
and Jukebox work written here, PLUS the orphan-engine fix that arrived from a concurrent session
(`electron/audio-daemon-client.js`, `electron/audio-health.js`, `watchdog/watchdog.js`, `package.json`,
`HealthMonitor.tsx`, both `audiod/` files, and two docs). They share `electron/main.js` — health hunks
at ~350/712/822, orphan hunks at ~2569–2618 — so they could not be split without hunk surgery. The
commit message states the authorship split explicitly.

**Uncommitted on top of `119a978`:** the Jukebox layout v2 (`src/components/Jukebox.tsx`,
`docs/help-jukebox.md`). Held back deliberately so Jeff verifies on screen first.

---

## 2 · THE WEB HEALTH MONITOR

Design doc: `docs/web-health-monitor-design-2026-08-18.md` (that doc carries §1–§13 in full detail).

### 2.1 · The rule that governed it

**Machines push health frames by EXTENDING the existing Control Center push — no second channel.**
`pushCcData` was already generic over `table`, so a health frame needed no new endpoint, no new auth
and no new transport: it is a new `table` value on the channel that already runs.

### 2.2 · What was built

| Tree | File | What |
|---|---|---|
| ether-backend | `src/index.js` | `table !== "health"` carve-out on the reconcile sweep |
| ether-backend | `src/index.js` | `GET /api/account/health` — the one authed fleet read |
| openair | `electron/health-frame.js` **(new)** | the frame builder — pure, no Electron, no DB |
| openair | `electron/main.js` | `_procLast` 1s decimation of procmeters + the `health:frames` IPC |
| openair | `src/lib/ccData.ts` | `pushHealthFrames()` — one push per station |
| openair | `src/App.tsx` | 60s heartbeat / 5s watch loop + the `health:watch` command |
| openair | `scripts/test-health-frame.js` **(new)** | 12 tests; prints the wire JSON, measures payload |
| ether-health | whole tree **(new)** | the web page |

### 2.3 · The hazard that shaped the design

`/api/account/data/sync` **tombstones every row of a `(station, table)` a push did not just send.**
Right for categories/clocks (one install owns the table); **wrong for health**, because a station can
be served by more than one machine and each sends only its own row — they would erase each other about
once a minute. Ruling: **Option B**, exempt `health` from the sweep; rows age out at the reader instead.

### 2.4 · Deploys — both GO-gated, both given

**Railway (backend).** The service is repo-connected, so push IS the deploy; `railway up` was
deliberately not used (it ships local bytes and drifts production from the repo).
Deployment `0f0043d1` → **`edcec51c`**, Online.

| Probe | Before | After |
|---|---|---|
| `/api/account/health` no token | `404 Cannot GET` | **`401 missing_token`** |
| `/api/account/health` bad token | — | **`401 invalid_token`** |
| `/health` | 200 | **200** |
| `/api/account/station/:uuid/data` no token | 401 | **401 `missing_token`** |
| `/api/account/data/sync` no key | 401 | **401 `missing_license_key`** |

404 → 401 proves the new route is live and authed. The bottom two rows prove the existing Control
Center mirror is untouched.

**Cloudflare Pages (web).** Project `ether-health`, **direct-upload** (like `ether-cast`; the dashboard
and listener are git-connected). Deployment `b6c5a7ed`.

| Probe | Result |
|---|---|
| `GET /` | **200**, `noindex, nofollow` present |
| `/api/fleet` no token | **401 `missing_token`** (the Function's own refusal) |
| `/api/fleet` bad token | **401 `invalid_token`** — the BACKEND's string, so Pages→Railway is proven |
| header | **`Cache-Control: no-store`** |
| header | **`Access-Control-Allow-Origin: https://health.ether-technologies.com`** |
| header | **`Vary: Origin, Authorization`** |

The listener's Functions set `access-control-allow-origin: *` and edge-cache with `caches.default`.
Correct for public station metadata; **catastrophic for authed fleet data** — an edge-cached authed
response keyed only by URL can serve one account's fleet to another. This Function does neither.

### 2.5 · ROUND TRIP PROVEN

Read-only query against production Postgres (`railway run --service Postgres`, SELECT only):

```
station_cc_data by table:
      19  categories    newest 2026-08-19T11:42:02Z (18s ago)
       7  clocks        newest 2026-08-19T11:42:02Z (18s ago)
      99  clock_slots   newest 2026-08-19T11:42:02Z (18s ago)
       2  health        newest 2026-08-19T11:41:34Z (46s ago)
    3335  library       newest 2026-08-19T11:42:02Z (18s ago)
       5  shows         newest 2026-08-19T11:42:02Z (18s ago)
       5  spots         newest 2026-08-19T11:42:02Z (18s ago)

health rows: 2
  halloVeen    · GREEN · mode=daemon · cadence=60s · 1194B · 46s ago
     43889edc-203d-4743-9e4f-6ea311d6e035:8e8f6181-b68a-433f-a93d-8005787b641b
  Open Format  · GREEN · mode=daemon · cadence=60s · 1229B · 46s ago
     75532b61-fa0c-4bc5-a5f0-0298b94c0123:8e8f6181-b68a-433f-a93d-8005787b641b
```

**Proven:** the install assembles the frame, pushes it as table `health`, the backend stores it,
`row_uuid` is `station:machine`, `cadence` rides along for the staleness rule, heartbeat is 60s (no
viewer), `mode=daemon` is honest. Every other CC table pushed 18s earlier — the carve-out broke nothing.

**NOT proven:** both rows carry the SAME `machine_id`. **Two machines on one station — the exact case
the carve-out exists for — has never been exercised.** Different stations were never at risk from each
other (different keys). This stays open until a second machine reports on a station this one also
reports on.

**Payload correction:** real frames are **1,194 / 1,229 bytes**, above the 960-byte synthetic average
from `scripts/test-health-frame.js` (real station names, track titles and designation text add ~250 B).
Corrected cost: 1 station heartbeat ≈ **1.73 MB/day**; 4 stations ≈ **6.9 MB/day**; 40 stations ≈
**69 MB/day**.

### 2.6 · THE PRESENTATION WAS WRONG, AND WAS REBUILT

The page first shipped as a **newly-invented fleet dashboard**. That was wrong. Jeff asked for the
**existing in-app Health Monitor's WALL VIEW**, rendered on the web. Rebuilt accordingly.

**Reused verbatim — copied from `src/components/health/`, UNMODIFIED, compiling in the web tree with
0 errors and zero edits:**

`sectionChrome.tsx` (the panel chrome — the visual language itself) · `HealthCard.tsx` ·
`HealthBar.tsx` · `HealthSection.tsx` · `healthUtils.ts` · `chartPath.ts` · `meterScale.ts` ·
`useContainerWidth.ts`

Plus `src/theme.css`: the app's own CSS variables copied verbatim from `src/index.css`
(`--bg-primary: #0d0d0f`, `--text-tertiary: #6060a0`, `--radius: 0`, the `--s-*` scale, the VU
palette). The look is inherited, not re-authored.

**Layout reproduced from the source, not from screenshots:**
- fixed **1920×1080 canvas, CSS-scaled, `overflow:hidden`, no internal scrollers** (`HealthMonitor.tsx:1024`)
- grid `minmax(0,1fr) 460px`, LIVE ACTIVITY rail on the right
- dashboard region: station name + "at a glance"; four cards on `repeat(auto-fit, minmax(184px,1fr))`;
  then the **3fr/2fr** wall grid (`HealthDashboard.tsx:258`)
- then the ENGINE band (UPTIME / PID / RESTARTS / EVENT-LOOP PING) and STATIONS (LIVE)

**Card faces call the app's own helpers** — `runwayValue()`, `designationValue()`, `queueLevel()`,
`toLevel()` — so the words on the web card are the words on the app card. The frame's `runway` and
`designation` objects carry exactly the field names those helpers expect, so they are fed directly.

**Four panels state what they cannot show rather than faking it:**

| Panel | Why |
|---|---|
| Runway · last 7 days | series lives in `runway_history`, **LOCAL-ONLY BY CONSTRUCTION** (`main.js:2027`) — needs a ruling |
| Rotation goals | per-category /hr and targets are not in the frame |
| Live events / activity terminal | a per-machine JSONL ledger, hundreds of lines a session |
| Audio levels | frame carries aggregate peak + active-deck count, **not per-deck A/B/C** |

Program loudness DOES render, from the processing trio already in the frame.

### 2.7 · A REAL GAP CAUGHT DURING DEV SETUP

Plain `vite` **does not run Pages Functions**, so `/api/fleet` would have 404'd locally and the wall
could never load. `npm run dev` now runs `npx wrangler pages dev dist --port 8788`, which serves the
page AND the Function against the real Railway backend.

### 2.8 · HOW JEFF VERIFIES IT

1. `cd /c/ether-health && npm run dev`
2. Open **http://localhost:8788**
3. Sign in with the **owner account** (email + password — `POST /api/auth/owner-login`, the login that
   mints the token carrying `lk`; **not** `/api/user/login`, which has no `lk` and would 401).
4. The wall should render with live stations from the frames already in Postgres.

**Not verified by me: I have never seen the wall.** It is behind account sign-in and I have no
credentials. `tsc` 0 errors and a clean build are not the same as seeing it.

---

## 3 · JUKEBOX LAYOUT V2 (header strip)

`src/components/Jukebox.tsx` — **built, gated, UNCOMMITTED.**

**Priority that drove it:** the people's NAMES are the product — customers pay to see their name up
there, so the queue dominates and the now-playing card does not compete with it.

- **Header strip** (`:700`) replaces BOTH the "Pick a song" title row AND the "Routed to Deck D ·
  channel ON · AUTO on" operator banner. Horizontal: 90px artwork left (`NowArt … square`, `:713`),
  three lines right — **NAME / TITLE / ARTIST**, "Unknown" for shuffle picks. Sits above the search
  bar; the song wall below is unchanged.
- **Right column is entirely the queue** — header `THE QUEUE` (`:856`), UP NEXT on top with its
  larger/flashing treatment, the rest under an `AFTER THAT` divider (`:904`), numbered from #2. It
  climbs as songs play. **QR untouched** at the bottom (`:929`).
- **Row overlap fixed** — the three rows had no explicit `lineHeight`, so they crowded at larger
  sizes. Now `lineHeight: 1.25` on each row; queue title 14→18px, artist 12.5→14.5px, now-playing
  title 20→25px for distance reading.
- The only remaining "Pick a song" in the file is the comment at `:701` explaining what was replaced.

**One judgement call, flagged for a ruling:** the removed title row also held **ON AIR** and the
**AUTO toggle** — both operator controls. Deleting them outright would strand the operator, so they
moved with the routing note into a small **OPERATOR** button at the strip's right edge: closed by
default, dot goes **amber** when routing is broken (not routed / channel off / fader down) and
red-flashing when genuinely on air. If Jeff wants that in Settings instead, it is a small move.

Help entry updated (`docs/help-jukebox.md`).

---

## 4 · ORPHAN-ENGINE FIX — REVIEW AND INDEPENDENT VERIFICATION

Another session's work, committed unverified inside `119a978`. Reviewed here because it is the top
defect and must not reach OV unverified. Its own doc: `docs/orphan-engine-fix-2026-08-18.md`.

### 4.1 · What it does

**NO OWNER, NO ENGINE.** Ownership is claimed, not implied:

- `ETHER_OWNER_PID` passed at spawn by **both** spawners — `audio-daemon-client.js:147` (dev **and**
  packaged; it sits outside the `dev ?` ternary) and `watchdog.js:151`.
- The daemon **polls every second, from boot, forever** (`ether-audiod.js:115-133`) and exits when
  owner, watchdog and spawner are all dead. Not an event — a poll, so a close event that never arrives
  cannot leave an engine running.
- Graded grace: **5s dev / 45s packaged / 120s update** via the `.ether-expected-restart` sentinel.
  An unreadable sentinel yields the SHORTER grace — failure shortens life, never extends it.
- `hello` (`:313-320`) lets a restarted app **adopt** a running daemon, which is what keeps a station
  on air across a crash/update/watchdog respawn.
- Dev eviction: the app only ever talks to a daemon it spawned; a foreign one is evicted and respawned
  (`audio-daemon-client.js:214-221`), capped at 3 attempts then used anyway and said loudly.
- `trayExists()` (`main.js:2621`) gates the close dialog — **"Keep Playing in Tray" is offered only
  when a tray actually exists**; `createTray()` failure is caught, logged and survivable
  (`main.js:3304`). An engine with no visible owner is forbidden by construction.
- `electron:dev` gains `-k --kill-signal SIGTERM`, so `concurrently` tree-kills vite and Electron.

### 4.2 · Three things specifically probed

1. **The `_knownDead` latch looks like a hole and is not.** `hello` un-latches a pid (`:317`),
   apparently defeating PID-reuse protection. But the latch guards the passive `process.kill(pid,0)`
   probe; `hello` is an **active claim** from a process that actually connected. An active claim is
   stronger evidence than a liveness probe. Correct as written.
2. **The watchdog-as-owner path closes properly.** A live watchdog counts as an owner, so: what
   happens when it stands down? `watchdog.js:304-313` — on the clean-exit sentinel it **stops the
   daemon first, then exits**. No "watchdog alive but stood down, daemon plays forever" gap.
3. **It backstops the gate identified earlier in this session.** `before-quit` only sends `shutdown`
   when `AUDIO_DAEMON` is true, so an app that had fallen back to in-process while a daemon was alive
   never told it to stop — that was the actual mechanism of the incident. The poll now covers it
   independently of that gate. Closed structurally, not by patching one branch.

### 4.3 · Independent verification

**The doc's own T1–T4 harness is NOT in the tree** — there is no `smoke-orphan*.js` among the 21 smoke
files, so its proof existed only as pasted text. An independent harness was written (isolated pipe,
stand-in owner processes, never touching the live daemon or any DB):

```
PASS  T1 owner dies          — daemon exited 6.0s after the owner was killed
PASS  T2 born ownerless      — daemon exited 6.5s (owner pid already dead)
PASS  T3 bare socket held    — daemon exited 6.2s with a client socket open the whole time
PASS  T4 hello adopts        — still running 9s past the grace
4 passed, 0 failed
```

`node audiod/smoke-shutdown.js` → PASS. Live daemon PID 26444 untouched throughout.

**Verdict: the fix is sound and it does close the unkillable-audio path.**

### 4.4 · Two things wanted before OV

1. **Make the harness permanent** — the test proving the top defect should sit beside the other 21
   smoke files as `audiod/smoke-orphan.js`, not expire with a session scratchpad.
2. **The trade-off is Jeff's to accept, not a doc's:** packaged + HA **off** + a crash now means audio
   stops after 45s instead of continuing indefinitely. With HA on (the OV configuration) the watchdog
   relaunches Ether and `hello` adopts the daemon — nothing drops. `ORPHAN_GRACE_MS` in
   `audiod/ether-audiod.js` is the single knob.

---

## 5 · NAMING — "Jukebox", never "kiosk"

Ruling: **Jukebox everywhere** — component, commit, doc, variable, window title. Existing occurrences
were **flagged, not renamed mid-session**:

| File | Count | Nature |
|---|---|---|
| `src/components/Jukebox.tsx` | 13 | comments only |
| `src/App.tsx` | 8 | comments only |
| `src/components/DeckConfigurator.tsx` | 3 | incl. **user-visible** `desc: "Public request kiosk — …"` (`:54`) |
| `docs/help-jukebox.md` | 11 | incl. the **title/frontmatter** `Jukebox (public request kiosk)` |
| `src/components/SettingsPanel.tsx` | 3 | **user-visible** copy (`:2149`, `:2181`, `:2185`) |

**One is not cosmetic:** `Jukebox.tsx:580` writes `source: "kiosk"` into `jukebox_requests.source` — a
**stored data value**. Renaming it is a migration plus a read-path change, not find-and-replace.

Commit `119a978`'s message also says "kiosk queue panel". The web page title was corrected from
"Fleet Health" to **Health Monitor** this session.

---

## 6 · MACHINE STATE AT END OF SESSION

- Dev restarted **04:28–04:29 on 2026-08-19**, clean: port 1420 owned by **today's** vite (PID 29764),
  **no 8/17 leftovers**, daemon PID 26444 spawned 04:29:07 by this app, pipe alive.
- All source predates the app start by ~5 hours, so the running dev app **has** these changes loaded.
- `electron:dev` now carries `-k --kill-signal SIGTERM`.
- Live audio during the session: station 1 deck D (Jukebox) and station 2 deck A ("Be Our Guest",
  `a=0.527`) — a station playing on its **own** deck, which is the condition the processing-meters
  test needs.
- No diagnostic persistence left armed. Session scratchpad only (expires with the session):
  `ask-daemon.js`, `check-health-rows.js`, `verify-orphan.js`.

---

## 7 · OPEN — WAITING ON JEFF

1. **Push decision.** `119a978` mixes verified and unverified work. Nothing pushed from `openair`.
2. **Runway history ruling** — can a summarised 7-day series ride in the per-machine frame (the same
   attribution argument as §2.1 of the design doc), or does runway history stay off the wire? The
   wall's runway chart cannot exist until this is answered.
3. **Jukebox OPERATOR drawer** — keep it on the strip, or move ON AIR / AUTO / routing into Settings?
4. **Custom domain** `health.ether-technologies.com` must be attached to the `ether-health` Pages
   project in the Cloudflare dashboard (a console action, not a wrangler one).
5. **Land the orphan harness** as `audiod/smoke-orphan.js`?
6. **Two machines on one station** — the carve-out's real case, still unexercised.
7. **Deploy of the rebuilt wall view** — the live Pages site still serves the OLD invented dashboard
   until a new deploy GO.

---

## 8 · VERIFY CHECKLIST FOR JEFF'S SCREEN

| # | What | How |
|---|---|---|
| 1 | Jukebox layout v2 | Open the Jukebox window: horizontal artwork + Unknown/title/artist across the top; right column all queue; UP NEXT on top; rows readable at distance |
| 2 | Web Health Monitor wall | `cd /c/ether-health && npm run dev` → http://localhost:8788 → owner sign-in |
| 3 | Processing meters | Health Monitor, with **Process local output ON** in Preferences and a station playing on its own decks — flat bars with it OFF is honest, not broken |
| 4 | Orphan fix | Close the app any way → within seconds, zero ether processes, silence |

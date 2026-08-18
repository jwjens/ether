# Jukebox Rebuild — karaoke-style requests, TouchTunes look

**Date:** 2026-08-17 · **Status:** DESIGN + Phase 1 build in progress · **Requested by:** Jeff
**Supersedes parts of** `docs/jukebox-mode-design-2026-08-04.md` (the design of record, APPROVED
2026-08-04, Slice 1 built as `src/components/Jukebox.tsx`).

Governing docs read before designing: the 08-04 jukebox design, `docs/sync-systems-map.md` §2
(Control Center push) and hazard C, and the listener/Cloudflare infra (`C:\ether-listener\functions`,
`C:\ether-backend\src\routes`).

---

## 0 · What changed, and what that costs — read before building

Jeff's rebuild spec reverses three decisions the 08-04 doc ruled on and reasoned about. Recording the
reversals rather than quietly building over them, per ARCHITECTURE BEFORE CODE.

### 0.1 · Popout instead of in-renderer takeover — REVERSED BY JEFF, building as instructed

08-04 §2.1 ruled: *"A route/overlay inside the existing renderer that occupies the whole window, not a
new BrowserWindow. Reasons: the audio engine, active station and daemon connection are already
resolved in this renderer; a second window would need the whole station-context handshake again, and
this session has already paid for that class of bug twice (command-path station scoping, popout
`?? 1`)."*

Jeff's call is a pop-out kiosk window. Building that. **But the hazard the doc named is not
theoretical and is still open on disk:**

- `src/components/PopoutRenderer.tsx:72` → `stationId={stationId ?? 1}`
- `src/components/PopoutRenderer.tsx:81` → `getEngine(stationId ?? 1)`

Memory `project_command_path_station_scoping` carries this as OPEN ("automation loadToDeck effects +
Popout `?? 1`"). A jukebox kiosk that silently falls back to station 1 would show a **different
station's songs to the public and queue them onto a station nobody asked for**. So:

> **The Jukebox popout resolves the active station explicitly and renders an honest "no station" state
> when it cannot. It never writes `?? 1`.** This is not scope creep — it is the precondition the
> reversed decision was protecting, and the honest-state rail.

The existing `?? 1` lines are left alone (not my task).

**A SECOND station-1 trap, found while building this — worth knowing about beyond the jukebox:**
`src/audio/AudioEngineContext.tsx:6` is `createContext<number>(1)`. A pop-out has no
`AudioEngineProvider` above it, so **`useAudioEngine()` in any pop-out silently returns the engine for
station 1** — the same defect as `?? 1`, wearing a convenience hook instead of an operator. It is not
a fallback anyone typed at the call site, which is what makes it easy to miss. The jukebox therefore
does not call `useAudioEngine()` at all: it resolves the station itself and calls
`getEngine(stationId)` only once it has one (`getEngine` *constructs on demand*, so handing it a
placeholder id would fabricate an engine for a station that does not exist). Flagged, not fixed —
auditing every other pop-out's engine binding is its own task and Jeff's call.

### 0.2 · Categories instead of clock-as-playlist — clean supersede

08-04 §2.4 ruled clock-as-playlist and §5 recorded its costs (playlist moves when programming moves;
category granularity only). Jeff now rules: **multi-select categories in Preferences; the clock setup
dies.** This is strictly simpler, removes cost §5.1 and §5.3 entirely, and the 08-04 doc already named
a category allow-list as the escape hatch. Storage follows §2.4's standing rule unchanged — a
user-managed scalar in `station_config_kv`, **no migration**:

| key | value |
|---|---|
| `jukebox_categories` | JSON array of category ids, e.g. `[3,7,11]` |
| `jukebox_request_url` | public request URL encoded in the QR (Phase 2 wires it for real) |

`jukebox_source_clock_id` becomes dead and is ignored (left in the KV rather than purged — purging
per-station config is what the 08-17 rekey pass had to clean up by hand).

### 0.3 · "Queue feeds playout; when empty, shuffle the categories" — BLOCKED, NOT BUILT

This is the one that needs Jeff's ruling before a line of it is written.

08-04 §2.3 + §6 ruled the opposite, on the ONE-scheduler rail: *"Jukebox never schedules. It enqueues
into the daemon's queue and only while automation has stopped deciding (MANUAL)."* The pick path is
`queue:enqueue` then `queue:move(qid,"top")` — two existing intents, no new path into the engine.

"When the request queue empties, shuffle the selected categories" makes the jukebox **decide what
plays next** — a second scheduler, running alongside the rotation scheduler. Two readings, materially
different builds:

- **(A) Jukebox owns playout while it's open.** Automation must be stopped (MANUAL or a new jukebox
  mode); jukebox fills all air; empty queue → shuffle pool. Needs an explicit engine contract, and
  answers for: does it still air spots/talk breaks from the clock? does it write `play_log`? what
  happens at top-of-hour? what happens when the operator closes the kiosk window mid-song?
- **(B) Requests are PLAY NEXT into the running station.** Jukebox enqueues; rotation keeps deciding
  when there are no requests, so "fall back to shuffle" is unnecessary — the scheduler already fills.
  This is the approved 08-04 semantics and is **already built and working** in `Jukebox.tsx`.

**Phase 1 ships (B)** — the approved, existing, strictly-smaller path — plus every new thing Jeff
asked for that is invariant across both readings (relocation, categories, artwork wall, named queue,
QR). **The fallback shuffle is not built and nothing decorative stands in for it.** If Jeff rules (A),
it slots in behind the same pick path and is designed then, with the engine contract written first.

### 0.4 · Requester NAME needs a record — the one new table

The daemon queue has no requester field, and Phase 2 needs a request record anyway. New table
`jukebox_requests` (migration v38), **LOCAL-ONLY — deliberately NOT registered in
`synced-tables.js`**:

```
id, station_id, requester_name, song_id, file_path, title, artist,
status TEXT DEFAULT 'queued',       -- 'pending' | 'awaiting' | 'queued' | 'played' | 'cancelled'
donation_cents INTEGER DEFAULT 0,   -- RESERVED, unused in this build (spec item 8)
payment_status TEXT DEFAULT 'none', -- RESERVED — 'none' | 'awaiting' | 'paid'
source TEXT DEFAULT 'kiosk',        -- 'kiosk' | 'web' (Phase 2), so the rail can tell them apart
qid TEXT, created_at, played_at, cancelled_at
```

**No `uuid` column** — corrected during the build against the v37 precedent
(`scripts/migrate-deletion-queue-phase-sync-37.js`, which states it plainly: a `uuid` column and a
`synced-tables.js` entry are *what make a table replicate*). The migration's own post-verification
asserts both the absence of `uuid` and the absence of the table from the registry, so a later edit
cannot quietly put this table on the wire.

**Why local-only, stated plainly:** `docs/sync-systems-map.md` §2 records that cloud-authored rows
written through ordinary IPC handlers *become CRDT mutations and propagate to peers* — "Two machines
both importing the same staged programming will both journal it." A public request is a per-kiosk,
per-station, ephemeral fact. Journalling it would push a stranger's name to every peer install and
re-play it on machines that never had the kiosk open. Hazard A (integer station ids in a uuid world)
is a second reason to keep it off the wire.

`donation_cents` / `payment_status` exist and are never read in this build. **No payments code.**

### 0.5 · Fullscreen — main-side only

`electron/main.js:5178-5181` records that the `win:toggleFullscreen` / `win:isFullscreen` renderer
handlers were removed 2026-08-05 ("the app uses NATIVE title bars only … **Do not reintroduce them
without asking**"). Jeff's spec requires a fullscreen-capable kiosk. Resolved without reintroducing
renderer window controls: **fullscreen is handled entirely in the main process for this panel** —
F11 / Escape via `before-input-event` on the jukebox window only. No renderer-facing window-control
IPC comes back.

---

## 1 · Phase 1 — desktop, what is being built

| # | Spec | Where |
|---|---|---|
| 1 | Leaves the bottom tab bar; hamburger → Windows → Jukebox → pop-out, fullscreen-capable | `App.tsx` (tab + takeover removed, drawer entry added), `main.js` POPOUT_SIZES/LABELS + F11, `PopoutRenderer.tsx` route |
| 2 | Preferences → **Jukebox** section, ALL rotation categories, checkboxes, multi-select | `SettingsPanel.tsx`, writes `jukebox_categories` |
| 3 | TouchTunes artwork wall — big art, dark, fullscreen-proud, real art | `Jukebox.tsx`, `src/lib/albumArt.ts:115 resolveArtwork` |
| 4 | Right rail queue: NAME, PLACEMENT #1/#2/#3, song; **#2 enlarged + flashing UP NEXT** | `Jukebox.tsx` + `jukebox_requests` |
| 5 | QR every time the window opens, scannable across a room | `qrcode.react` (already a dependency, `package.json:40`) + `jukebox_request_url` |

**Placement semantics, stated because the spec is literal and I am building it literally:** entries are
numbered #1, #2, #3… in queue order and the entry at **#2** is the enlarged, flashing UP NEXT one. That
reads correctly when #1 is the song currently on air. If Jeff means "#1 is the next to play and #2 is
after it," the badge moves one slot — a one-line change, flagged rather than assumed.

Artwork reuses the library's existing resolution path with its per-file cache and lazy per-tile
loading (IntersectionObserver, one resolve per tile, ever). **`getLocalArt`, not `resolveArtwork`** —
decided during the build: `resolveArtwork` falls through to `fetchMusicStoreArt`, an iTunes lookup per
(title, artist), which across a wall of thousands of tiles is a network request storm and is exactly
what 08-04 §3 ruled out ("firing a music-store lookup per tile across hundreds of songs would be both
slow and exactly the guessing the spot fix removed"). `getLocalArt` reads the embedded cover from the
file, caches per path, and never touches the network. Missing art keeps the 08-04 rule — neutral
tinted treatment with the title large, never an empty square.

Kept from the approved build because they are public-facing safety, not creep: songs with no local
file are excluded from the wall (08-04 §2.5.1 — "a public-facing pick that produces dead air is the
worst possible failure"), repeat protection, and the pending cap.

## 2 · Phase 2 — the web page (design only; NO deploy without Jeff's explicit GO)

**Public identity is the station SLUG, never a license key.** The listener PWA already establishes the
pattern: `C:\ether-listener\functions\api\station\[slug].ts` is an edge-cached Cloudflare Pages
Function proxying the Railway backend's `/public/station/<slug>`. The jukebox request page rides the
same rails — same repo, same Pages project, same slug, no new hosting.

```
phone → https://listen.ether-technologies.com/jukebox/<slug>
          ├─ GET  /api/jukebox/<slug>/pool     (CF function, edge-cached ~30s)
          │        └─ backend GET /public/jukebox/:slug/pool
          ├─ POST /api/jukebox/<slug>/request  (CF function, NOT cached)
          │        └─ backend POST /public/jukebox/:slug/request  {name, song_id}
          └─ GET  /api/jukebox/<slug>/queue    (short cache; "you're #3")
desktop → POST /api/account/jukebox/pool     (x-license-key)  publishes the checked categories' songs
desktop ← GET  /api/account/jukebox/requests (x-license-key)  drains pending requests into the kiosk
```

- **The pool the web sees is exactly the desktop's checked categories** — the desktop publishes it;
  the backend never derives it. Same shape as the CC push in map §2 (`pushCcTable` →
  `POST /api/account/data/sync`, `x-license-key`), which is a proven, license-keyed channel.
- **Account-scoped** on the desktop/authoring side; **public read-only** on the phone side. A phone
  never presents a license key and can never enumerate other stations.
- **Inbound requests must not journal CRDT mutations** (§0.4). The desktop drains them into the
  local-only `jukebox_requests` table, not through a synced handler.
- **Donation slots in front of `queued`**: `status: 'pending' → 'awaiting' → 'queued'`. The fields
  exist now, unused. No payment provider, no pricing, no receipts — 08-04 §4's provider interface is
  already the seam when one arrives.

Abuse surface, named now rather than discovered in the park: name field length-capped and stripped of
markup, one request per device per N minutes, the existing pending cap enforced desktop-side (the
authority), profanity screening on names deferred to Jeff's call.

## 3 · Architecture compliance

| Rail | Compliance |
|---|---|
| ONE scheduler | Phase 1 never schedules — picks are `queue:enqueue` + `queue:move(top)` into the daemon. The one thing that *would* make a second scheduler (fallback shuffle) is **blocked pending Jeff's ruling**, not built. |
| Daemon = single source of truth | Queue rendered from the daemon's queue; no renderer mirror. |
| Honest state | No optimistic queue; no `?? 1` station fallback; missing-file songs excluded, not silently dead. |
| Doors before rooms | Moves from a bottom tab to the canonical hamburger → Windows, plus a help entry. |
| Station = switchable context | Pool + URL are per-station `station_config_kv`; requests carry `station_id`. |
| No new schema without cause | One table, for a fact that has nowhere else to live (requester name + the donation seam). Local-only so it never reaches the wire. |
| Build the sense | Song count + resolved category names in Preferences; excluded-for-missing-file count; empty state explains itself. |

## 4 · Gate

Phase 1 acceptance is Jeff's screen: hamburger → Windows → Jukebox pops out fullscreen, checked
categories populate the wall, a test request shows a name in the queue with #2 flashing UP NEXT, QR
renders. **Phase 2 is not started until Phase 1 passes on his screen and he rules on §0.3.**

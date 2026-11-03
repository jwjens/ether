# Ether Screens — design plan

**Date:** 2026-10-05 · **Type:** READ-ONLY design. No code changed, no commits.
**Tree:** `C:\openair` `main` @ `5068390` (4.6.59).
**Method:** a read-only agent inventoried the building blocks; key items were re-checked by hand.

**Related plans:**
- `docs/ui-freeze-diagnosis.md`: Screens must not add to the stall causes found there.
- `docs/settings-streaming-tiers-plan.md` §6: the :3400 auth / Wall 3 work.
- `docs/paywall-entitlements-plan.md`: tiers and the lapse rule.
- `docs/multitenancy-audit.md`.

**What we're competing with:** an installed per-seat console-screen app — installed and licensed on each Windows seat, and reachable remotely only through a VPN or a remote-desktop tool.

**Ether Screens is "design once, open anywhere"**, with **no install and no seat licence on viewing devices**. A layout built once opens in three places:
1. **as its own desktop window** on any monitor;
2. **in any browser on the station's network**, at the Ether machine's address;
3. **remotely**, through the hosted web app (the existing web remote and command bus).

Domain: **`app.ether-cast.com`** (RULED by Jeff 2026-10-05: `ether-cast.com` is canonical; old `*.ether-technologies.com` subdomains 301).

---

## 1. Architecture

### 1.1 One widget library, three transports
- **A single React widget library** (`src/screens/widgets/*`) renders the same layout JSON everywhere. Each widget talks only to a small **transport interface**:
  - `subscribe(topic, fn)` for state: deck, queue, levels, announcements, clock, closing time
  - `command(name, args)`: actions, always by **name**, never a direct engine call
  - `capabilities()`: what this surface and device may do (viewer vs operator)
- **Three transports implement it:**

| Surface | State in | Commands out |
|---|---|---|
| Desktop window | the existing `sendToAllWindows` channels via preload | one IPC, `cmd:execute` → the command service (§2) |
| LAN browser | SSE from the Screens server on the Ether machine | `POST /api/cmd` to the same server → the command service |
| Remote (hosted web) | the backend mirror (now-playing, `station_cc_data`) over the existing dashboard reads | the existing `/api/cmd` → `cmd-stream` → desktop → the command service |

- **Layouts are plain JSON:** `{version, station_uuid, grid:{cols, rows}, widgets:[{id, type, x, y, w, h, config}]}`. The same file opens on every surface, and is exported and imported as `.etherscreen.json`.

### 1.2 The desktop Screens window
- **A pop-out-style BrowserWindow with its own renderer process**, keyed `screens:<layoutId>`. The existing per-key bounds store already remembers position and size per key (`popout-bounds.json`, `main.js:7145-7165`, with the off-screen guard `boundsOnScreen` at `:7157-7165`). Screens adds the **display id** to the saved record, so a window returns to the same monitor.
- **Optional always-on-top**, per window: `setAlwaysOnTop(true, "floating")`. Only the splash window uses it today (`main.js:2530`).
- **Lightweight entry:** a separate Vite page (`screens.html` → `src/screens/main.tsx`) that imports **only** the widget library and transport. This avoids the **3.34 MB** full-app bundle every pop-out loads today, which is freeze cause #4.
- **Window flags:** `show:false` + ready-to-show; hide-on-close (instant reopen); `backgroundThrottling:false` only while the window is visible and in live mode (clocks and countdowns must not drift when it's covered).
- **Stays responsive if the main window stalls:**
  - It's a separate renderer, so the main window's React work (freeze cause #1) can't touch it.
  - **It still shares the Electron main process**, so a main-process stall (synchronous DB, the 60 s `push()`) delays its state and commands too. The fixes in `ui-freeze-diagnosis.md` #0/#2/#5/#6 benefit Screens directly.
  - For the strongest isolation, a later option is for the Screens window to read state directly from the daemon's broadcast stream instead of through main.
- **The station is explicit, never guessed:**
  - The window opens with `?station=<uuid>`. Pop-outs today resolve the machine-global active station (`useActiveStation.tsx:55-74`), and **don't hear station switches made in another window**: `station-switched` is a window-local DOM event (`App.tsx:914`, `:2525`; `stations:switch` broadcasts nothing, `main.js:11832-11840`).
  - A Screens layout belongs to a station, so it binds to that UUID.
  - Add the Screens files to `scripts/smoke-window-station.js` (its `?? 1` ban currently covers only `PopoutRenderer.tsx`, `:101-112`).

### 1.3 Edit mode vs live mode
- **Live (default, locked):** widgets act; nothing moves; there are no editing handles.
- **Edit (explicit toggle, operator role only):**
  - a grid (default 24×16) with drag, drop and resize;
  - a widget palette;
  - a per-widget config panel (e.g. cart grid size and which carts, which meter, clock format).
  - Saving writes the layout and returns to live mode.
  - **Editing never sends commands**: buttons are inert while editing.
- **Reuse with care:** the dormant `src/canvas/` engine (`WidgetRegistry.ts`, `CanvasEngine.tsx`, `WidgetCanvas.tsx`) has the grid, collision and profile mechanics, but carries known defects:
  - layout reads with **no `station_id` filter** (`CanvasEngine.tsx:17-24`, `116`, `126-128`);
  - save and load callbacks that close over `stationId` without deps (`:231`, `:243`, `:251`, `:256`), the stale-station pattern the project rule forbids;
  - TODO notes for broken resize and picker (`WidgetCanvas.tsx:101`, `:492`).

  Take the mechanics, not the persistence.

### 1.4 Storage
- **Per station, in `station_config_kv`.** Decision for Jeff:
  - **Synced** (key `screens_layouts`): a layout follows the station to every computer on the account, *and* reaches the hosted web app through the existing mirror.
  - **Local-only** (prefix `screens_local_`): it stays on one machine. That needs the `LOCAL_ONLY_PREFIXES` entry plus `local-only-keys.test.js` (`electron/sync/handlers/station_config_kv.js:91-104`, `:390-399`); `schedule_layout_v1` is the local-only precedent, `:41-43`.
  - **Recommendation:** the **layouts sync** (they're station content and must reach the web app), while **window placement** (monitor, x/y, always-on-top) stays machine-local in `popout-bounds.json`.
- **Export / import:** reuse the `theme:export` / `theme:import` pattern (`main.js:9107-9133`, versioned JSON, `dialog.showSaveDialog` / `showOpenDialog`). **Parent the dialog to the window that asked** (`BrowserWindow.fromWebContents(evt.sender)`), not `mainWindow`; every dialog today is parented to the main window.

---

## 2. One command path, one auth model, one audit log

### 2.1 The command service (the single path)
- **Today there are two command layers:**
  - the main UI calls engine methods directly in the renderer (`getEngine(stationId)` → `engine-rodio.ts` → `window.ether.audio.*` IPC → main handlers → daemon pipe);
  - the web remote's `execCmd` maps command **names** onto the same engine methods (`App.tsx:1346-1759`). But `execCmd` lives **inside an App.tsx effect closure**, so another window can't reuse it.
- **Design:** extract the name → action layer into a **command service** with one entry point:

  ```
  execute({ stationUuid, cmd, args }, principal) → { ok, error?, cmd_id }
  ```
  - `principal` = `{ surface: "desktop" | "screen-window" | "lan-device" | "remote", deviceId?, userId?, role: "operator" | "viewer" }`.
  - Every action ends in **the same main-process handlers the main UI already uses**: `audio:load/play/stop/setVolume`, `audio:daemon` intents (`main.js:6109-6127`), `setMasterVolume` (`:5988-5994`), `stationConfigKv.upsertByKey`, `announcements:fire`, and so on.
  - So there is **never a second path to the engine**. The main UI's existing calls already land on those handlers, and over time its buttons can move onto `execute()` as well.
- **Rules enforced in `execute()`:**
  - resolve the station from `stationUuid` on every call (the project rule: fresh lookup, never a captured engine);
  - refuse when the role is `viewer`;
  - refuse unknown commands;
  - **never await audio**: commands are fire-and-acknowledge, like today's intents.
- **Audit log:** every `execute()` writes one line to the existing health ledger / console stream with `{ts, station, cmd, args summary, surface, device or user, result}`. The same line feeds the existing web-remote ack (`POST /api/cmd/ack`), so the operator page shows the real outcome.

### 2.2 LAN pairing (shared with the port-3400 fix)
- **Today** :3400 binds `0.0.0.0` with no auth and an ungated transport route (✔ `main.js:8809`, `:8669-8682`). It's held back because legitimate LAN clients exist: the `/remote` page (`:8569-8573`), phone pairing at `/m` (`PairMobileApp.tsx:81`, currently a dead route), and site-replication peers (`/api/repl/*`, `site-replication.js:39`).
- **One auth model for everything on the Ether machine's network port**, Screens included:
  - **Pairing (one time per device):** Settings → **Screens & Devices** → "Pair a device" shows a **QR code plus a 6-digit PIN** (valid 5 min, one use).
    - The device opens `http://<ether-ip>:<port>/pair`, scans or types the code, and is issued a **per-device token**: 256-bit random, stored **hashed** in a machine-local `paired_devices` table `(id, name, role, token_hash, created_at, last_seen_at, revoked_at)`.
    - It's kept in the browser as an HttpOnly cookie and sent as a bearer header for API calls.
  - **Roles per device:** `operator` (can act) or `viewer` (read-only).
  - **Settings lists every paired device** (name, role, last seen) with **Revoke**. Revocation takes effect immediately for new requests and open streams.
  - **Every LAN endpoint requires a valid token**: Screens pages, state stream, `/api/cmd`, **and** the existing `/remote`, `/api/transport/*` (routed through `execute()`), `/api/status`, macros, and GPIO.
  - **Loopback exceptions**, which are the 3400 fix itself:
    - the watchdog's `GET /health` stays open on **127.0.0.1 only**;
    - **Iris** gets an install token at spawn (Wall 3, `docs/iris-integration-arc-2026-08-06.md`);
    - **site-replication peers** pair as devices with role `replication`, limited to `/api/repl/*`.
- **Transport security, an honest tradeoff:**
  - A token over plain HTTP on the LAN can be sniffed by anyone on the same network.
  - **Option A (v1):** HTTP + tokens + revocation + viewer default. Simple, and acceptable on a trusted studio LAN.
  - **Option B:** Ether generates a local TLS certificate (HTTPS). Every device sees a browser trust warning once, unless a cert is installed.
  - **Jeff to choose.** Recommend A for v1, with B as a setting.
- **Migration:**
  - Existing `/remote` users must pair once; the release note will say so.
  - The dead `/m` door (`PairMobileApp`) is replaced by the pairing screen.
  - **Until the shared auth model ships, LAN Screens stays off.** Phase 1 (the desktop window) doesn't need it.

### 2.3 Remote (internet)
- Uses the **existing** chain: account sign-in + the **Control Center PIN** (`account_users`, PIN login `/api/auth/login`, `ether-backend/src/index.js:2397+`) → `POST /api/cmd` → SSE `cmd-stream` → the desktop → `execute()` with `principal.surface="remote"`.
- The remote web app renders the same layout JSON from the synced `screens_layouts` (mirrored to the backend like the other `station_cc_data` tables).
- **Limits to state honestly:**
  - Remote state is only as live as the mirror: now-playing every 3 s; queue and announcements on push.
  - **There's no live meter feed to the cloud today**, so remote meters are a Phase 3+ item or are shown as "not available remotely".
- Station commands are already aimed at the machine sourcing the station (`src/lib/station-commands.js` in the backend), so Screens inherits that.

---

## 3. Widget inventory for v1 (each mapped to existing data and commands)

| Widget | Data source | Action → command (via `execute()`) | Existing pieces (file:line) | New engine command? |
|---|---|---|---|---|
| **Cart grid** (configurable rows×cols, assignable carts, hotkeys) | `cart_slots` per station (`ether.cartSlots.list`, `DeckConfigurator.tsx:756`); cart VU from levels **filtered by station UUID** (the current wall doesn't filter, `:820-822`) | `cart:fire {slot}`, the same logic as `fireCart` / `resolveFireChannels` → `loadToDeck` → `play` on the cart channel (`DeckConfigurator.tsx:719-735`, `:875-918`). Already a named command in `execCmd` (`App.tsx:1609-1640`) | `BoutiqueCartWall` (`DeckConfigurator.tsx:684`); grid constants `:583-585` (fixed today); hotkeys `1-8 / Q-I / A-K` (`:657-662`, window-level listener `:850-860`) | **No.** Extract `resolveFireChannels` into the command service. Grid size becomes widget config. Hotkeys are scoped to the focused window |
| **Big clock** | local system time (and station time zone) | none | `ClockDisplay` (module-local, `App.tsx:6620-6642`); `SelfHealingClock.tsx`; canvas `ClockWidget` | No |
| **Closing time control** | `station_config_kv.closing_time` `{default, byWeekday, byDate}` (`main.js:4743-4782`) | `ops:set-closing {date, time}`. **byDate only** (the hard rule pinned by `scripts/smoke-closing-isolation.js`); today it lives inline in `execCmd` (`App.tsx:1568-1593`) | Announcements ScheduleBoard closing draft (`Announcements.tsx:493`, `:602-611`); there's no standalone "tonight's closing" control | **No new engine command.** Extract the merge into a shared helper used by both `execCmd` and Screens |
| **Upcoming announcements + countdowns** | `announcement_schedule` for today; close-offset rows resolved against tonight's closing time like `dueTimeFor` (`main.js:4845-4849`) | optional "Fire now" → `announcements:fire` (`main.js:5140-5155`) | UpNext interleave (`UpNext.tsx:159-210`). **It drops close-offset rows** (filters `trigger_time`, which is null for them, `:190`; Announcements writes `trigger_time:null`, `:643`). UNVERIFIED at runtime | **BUILT 2026-10-06** on `fix/aftersign-announce-catchup` (`e7e65fd`): `announcements:upcoming(stationUuid | id)` in main, same rows, `dueTimeFor` and catch-up rule as the scheduler; before-closing lines included; events on `announce:event`. Up Next and the heads-up strip use it; Screens reuses it (`src/lib/upcomingAnnouncements.ts`) |
| **Song request search + "play next"** | library search over the operator's ticked categories (`Jukebox.tsx:437-489`, renderer SQL) and the request list (`ether.jukebox.listRequests`) | **"Play next"** → a new `queue:insertNext {songRef}` | today: `queueEnqueue` appends only (`audiod/engine.js:1921`); "Play Next" in UpNext moves an **existing** row to the top (`UpNext.tsx:497`, `:514`); `deck:playNow` plays immediately (`engine.js:2060`) | **YES: `queue:insertNext`** in the daemon (atomic insert at the head of the pending region, returns the qid). Doing it as enqueue-then-move races |
| **Now playing / next up** | `audio:daemon-deck` / `audio:daemon-queue` (`main.js:891`, `:935`) via the engine mirror (`engine-rodio.ts:387-424`) | none | `PopoutFaders` (`PopoutRenderer.tsx:140-157`); MasterOutput's expanded view (`MasterOutput.tsx:516-528`); UpNext | No. Read deck and queue **only on change**, never on a 250 ms forced tick (freeze cause #5) |
| **Master fader** | `levels.master` (`useShowState`, `MasterOutput.tsx:621-628`) | `set_volume` → `setMasterVolume` (`engine-rodio.ts:612-616` → `main.js:5988-5994` → daemon). Already a named command (`App.tsx:1526-1530`) | `MasterOutput` | No |
| **Meters** | the meter bus `audio:meters` ~30 Hz via the subscription lease (`useMeterSubscription`, `meter/meterStore.ts:49-84`; lease `main.js:5448-5459`) | none | `PeakAvgMeter`, `MasterMeters`, `GrMeter` (rAF, outside React) | No. On the LAN, meters stream over SSE at a reduced rate (10 Hz); remotely, not in v1 |

**New engine and service work in total:**
- **one new daemon command** (`queue:insertNext`);
- **one new read query** (`announcements:upcoming`);
- **two extractions into the command service** (closing-time merge, cart fire channel resolution).

Everything else reuses existing paths.

**Never block or delay audio:**
- widgets only *read* broadcast state and send fire-and-acknowledge commands;
- no widget runs synchronous main-process work per frame;
- meters use the lease (no stream unless something is visible);
- the Screens window is its own process;
- LAN/remote commands queue through the same intents as the main UI;
- the daemon owns playout timing (`audiod/engine.js:1-14`).

---

## 4. Phases

### Phase 1: "Live Assist" (fixed layout, desktop window), for OV's Magical Forest
- **Contents:** one prebuilt screen holding the cart grid (e.g. 4×6), big clock, tonight's closing time control, the next 5 announcements with countdowns, request search with "Play next", now playing / next up, master fader and meters.
- **Opens** from the hamburger ("Live Assist") and Tools ▸ Monitors (`main.js:2917-2933`). It's its own window, remembers its monitor and size, and has always-on-top as a toggle.
- **Builds:** the lightweight Screens entry; the command service (`cmd:execute`) with audit lines; `queue:insertNext`; `announcements:upcoming`; the two extractions; the explicit `?station=` binding plus the smoke contract.
- **Not built:** the editor, LAN, remote.
- **Blast radius:**
  - new window and entry (isolated);
  - **one daemon command** (`queue:insertNext`; needs a daemon reload and a packaged smoke);
  - one main query;
  - the extractions touch `execCmd` and `fireCart`, so pin them with tests that both callers produce identical writes;
  - **no schema change.**
- **Ship alongside** the freeze first batch (#0 announcement catch-up, #2, #5, #7), so a Live Assist window on the second monitor doesn't add load.

### Phase 2: the full builder (desktop)
- **Contents:** edit/live modes; the grid editor; widget config; multiple layouts per station; `screens_layouts` storage (synced, per the §1.4 decision); `.etherscreen.json` export/import; the help page `docs/help-ether-screens.md` and its door.
- **Blast radius:** renderer-only plus one synced KV key. A synced key means a sync-policy test, and the fleet should update together if the shape matters to older versions; older versions simply ignore an unknown key.

### Phase 3: macros, LAN, remote, touch
- **Contents:**
  - **button actions / macros:** a button runs an ordered list of existing named commands, each through `execute()`. **No new engine verbs.**
  - **LAN Screens** behind the shared pairing/token model (§2.2). **This *is* the port-3400 fix**: the same release closes `/api/transport` through `execute()` and moves `/remote` behind pairing.
  - **remote Screens** in the hosted web app (§2.3);
  - **touchscreen sizing:** coarse-pointer layouts, a minimum 64 px target (the cart tiles already use 64, `DeckConfigurator.tsx:651`), larger fonts, no hover-only affordances (global touch CSS exists, `src/index.css:1062-1079`).
- **Blast radius:**
  - **The LAN auth change touches every existing :3400 client**: the `/remote` page, replication peers, Iris (token at spawn), the watchdog (stays loopback). It needs a migration note and a release where all of them are updated together.
  - Remote rendering is dashboard-side, plus the mirror of `screens_layouts`.

---

## 5. Tiers

| Surface | Plan | Lapse behaviour |
|---|---|---|
| Desktop Screens window (Live Assist + builder) | **Included in Local** | Local feature: **keeps working when Local lapses** (lapse rule: banner and updates only) |
| LAN browser Screens (pairing) | **Included in Local** | Same: local network, no Ether cloud involved |
| Remote Screens via the hosted web app | **Hosted plans** (Station / Pro / Unlimited) | Cloud feature: stops after the cloud grace period; local and LAN screens keep working |

- **Per-seat comparison:** an installed per-seat console-screen app has to be installed and licensed on every seat, and remote use needs a VPN or remote desktop. Ether Screens needs **no install and no seat licence on any viewing device**. Any browser on the network (after one-time pairing), or the hosted web app for remote use, opens the same layout.

---

## 6. Order of work and blast radius

| Step | What | Blast radius | Depends on |
|---|---|---|---|
| 0 | Freeze first batch (#0, #2, #5, #7 in `ui-freeze-diagnosis.md`) | Small, UI-local; #0 is the on-air announcement fix | — |
| 1 | Command service + audit + the two extractions (closing time, cart fire) | `execCmd` and `fireCart` rewired onto shared code. Tests pin identical behaviour | — |
| 2 | `queue:insertNext` (daemon) + `announcements:upcoming` (main) | One daemon intent (daemon reload, packaged smoke) + one read query | — |
| 3 | **Phase 1 Live Assist window** (lightweight entry, explicit station, always-on-top, monitor memory) | New window only | 1, 2 |
| 4 | Phase 2 builder + layout storage + export/import + help page | Renderer + one synced KV key | 3; the §1.4 storage decision |
| 5 | Shared LAN auth (pairing, tokens, revoke, roles) = **the port-3400 fix**; then LAN Screens | **Every :3400 client** (`/remote`, replication, Iris, watchdog). Coordinated release | 1 (commands through `execute()`); the §2.2 TLS decision |
| 6 | Remote Screens (hosted web app) | Dashboard + backend mirror of `screens_layouts` | 4, hosted plans (entitlements P2) |
| 7 | Macros + touch layouts | Renderer; macros reuse named commands only | 4 |

**Can ship together:** 0 + 1 + 2 + 3 as one desktop release ("Live Assist", with the freeze fixes). Then 4. Then 5 on its own release, since it touches every LAN client. Then 6 and 7.

---

## 7. The default screen — what Screens opens to the first time

**Status:** PLAN ONLY (2026-10-06). Nothing below is built, except `announcements:upcoming` (built on branch
`fix/aftersign-announce-catchup`, commit `e7e65fd`; see the note in §3).

**What it is:** a ready-made, single-page console. Every element is a normal Screens widget (§3), so an operator can
rearrange it in edit mode later. It is drawn in **Ether's own visual language**: the purple brand accent on near-black,
the existing token colours (`--accent-cyan`, `--deck-a/b/c`), DM Mono for numbers, square edges, and the same meter
components the board already uses. Nothing is skeuomorphic: no brushed metal, no 3-D knobs.

### 7.1 Layout (landscape, scales down to a 1280×720 touchscreen)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ PROGRAM  L ▕████████████████████████▏-6   R ▕██████████████████████▏-7   (horizontal, full width) │
├──────────────────────────┬────────────────────────────┬──────────────────────────────────────┤
│  CART GRID (4 × 4)       │  ┌VU┐┌VU┐  ║ MASTER        │   ◯ ANALOG SHOW CLOCK                 │
│  ▢ ▢ ▢ ▢   colour =       │  │▇ ││▇ │  ║ fader         │     (seconds ring)                    │
│  ▢ ▢ ▢ ▢   cart colour,   │  │▇ ││▇ │  ║               │   TIME OF DAY     9:29:18 PM          │
│  ▢ ▢ ▢ ▢   label + state  │  │▇ ││▇ │  ║               │   ELAPSED         2:41 / 3:58         │
│  ▢ ▢ ▢ ▢   text           │  └──┘└──┘  ║               │   NEXT HARD EVENT 0:42  (announcement) │
├──────────────────────────┴────────────────────────────┴──────────────────────────────────────┤
│ FADER BANK — one strip per enabled board channel:  [A] [B] [C] [MIC] [ANN] [CART] …              │
│ each: label · colour · fader · ON button (lit when on) · small meter                            │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ QUEUE ON THE CLOCK — :00 ─────── :15 ─────── :30 ─────── :45 ─────── :00                        │
│  [song][song][SPOT BREAK][📢 ANN 9:30:00][song]…  (each block placed at the minute it airs)      │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Element → existing data and commands → anything new

| Element | Data (exists) | Command (exists) | New needed |
|---|---|---|---|
| **Horizontal program meters** (top, full width) | The meter bus: `audio:meters` ~30 Hz per subscribed station, a lease renewed every ≤5 s (`audio:subscribe-meters` `electron/main.js:5550`; relay `main.js:850`); renderer store + hook `useMeterSubscription` (`src/components/meter/meterStore.ts:72`); drawn with requestAnimationFrame outside React (`PeakAvgMeter.tsx`, `MasterMeters.tsx`) | — (display only) | A **horizontal** orientation for `PeakAvgMeter` (it is vertical today). **Load: see §7.3** |
| **Vertical VU meters beside the master fader** | Same meter frames: program bus L/R, peak + average | — | Nothing new beyond §7.3 |
| **Master fader** | `levels.master` (`useShowState`, `MasterOutput.tsx:627`) | `setMasterVolume` → `audio:setMasterVolume` (`src/audio/engine-rodio.ts:612`, `main.js:6090`) → daemon. Already the web remote's named command `set_volume` (`App.tsx:1527-1530`) | Goes through the command service `execute()` (§2.1), like every widget action |
| **Analog show clock with seconds ring** | Local system clock; the show/daypart now on air from `getActiveShowClock` (`src/audio/loggen.ts`, used by `UpNext.tsx:142`) | — | New **drawing** widget only (SVG, hour/minute hands + a 60-tick ring that fills by the second). The digital clock exists (`ClockDisplay` `App.tsx:6624`, module-local; `SelfHealingClock.tsx`) |
| **Time of day** (digital) | Local clock | — | Reuse `ClockDisplay` after exporting it |
| **Elapsed on the current item** | The playing deck's position/duration from the daemon's deck stream (`audio:daemon-deck`, `main.js:891`) via the engine mirror. **Trap:** `getState` has no position/duration; they come only from the onDeck stream (memory: `reference_daemon_getstate_no_position`) | — | None. Read the same stream UpNext's deck rows read (`UpNext.tsx` deckStates) |
| **Countdown to the next hard event** | Fixed-time events that exist today: **(1)** the next announcement, from `announcements:upcoming` (dueEpoch, **built**, `e7e65fd`); **(2)** the next spot break, from `schedule:playhead-view` (`main.js:11543`, returns `scheduled_at` + `content_class`; first `SPOT` row) | — | **A definition decision (Jeff):** which events count as "hard". Proposal: an announcement, a spot-break start, and the top of the hour, whichever is soonest, labelled with which one it is. Computed in the renderer from those two reads, so no new main query |
| **Coloured cart button grid** | `cart_slots` per station (`ether.cartSlots.list`, `DeckConfigurator.tsx:756`); cart colour per slot; cart VU from levels | `fireCart` (`DeckConfigurator.tsx:875`), already the web remote's named command `cart:fire` (`App.tsx:1610-1640`) | The extraction of the fire-channel resolution into the command service (§3, already planned). **Fix the cart VU's missing station filter** (`DeckConfigurator.tsx:820-822`, freeze cause #5). Grid size becomes widget config (fixed constants today, `:583-585`). State as text on the button (READY / PLAYING / empty), never colour only |
| **Fader bank mapped to the board channels, with ON buttons** | `deck_configs` per station: slot, label, colour, enabled, kind, `channel_on` (`DeckConfigurator.tsx:118-127`, v58) | Fader: `audio:setVolume` (`main.js:5311`) → daemon `setVolume`. ON: `setChannelOn` → `writeChannelOn(ether.deckConfigs …)` (`DeckConfigurator.tsx:179-182`, "the only renderer writer of channel_on") | Both go through `execute()` as named commands (`channel:set-volume`, `channel:set-on`). **Faders are generic** (memory `project_faders_are_generic`): every strip shows the same controls whatever the source |
| **Queue that follows the clock** | Live queue with projected air times (`engine.getQueue()`; items carry `scheduledAt`; UpNext projects `now + durations`, `UpNext.tsx` mergedUpcoming); the log's times from `schedule:playhead-view` (`scheduled_at`, `duration_s`, `content_class`); announcements from `announcements:upcoming` | Queue edits stay where they are (UpNext's intents) | A new **timeline** widget: a horizontal hour ruler (:00–:60) with each element drawn at the minute it airs, width = its length; announcements as fixed markers at their exact second (megaphone + word, as in Up Next). **Honest note:** until the log-reader flip's Phase 3, the live queue and the log can disagree (the shadow-compare in `UpNext.tsx` measures exactly that). The timeline draws the **live queue's projection** (what will actually play) and marks any element whose log time differs by more than a set tolerance |

### 7.3 Meters must not add load to the main process

**Today (receipt):** the daemon sends a meters line over the pipe; main parses it once and calls
`sendToAllWindows("audio:meters", …)` (`main.js:850`). That is **one structured clone per open window per frame**,
whether or not that window subscribed. A Screens window would be one more recipient: about 30 clones a second more.

**Design: Screens meters come straight from the daemon, never through main.**
- The daemon opens a **loopback-only meter stream** (WebSocket on `127.0.0.1`, the `ws` package is already in
  `node_modules`) that serves the same frames it already builds for the pipe. No new metering work in the
  audio path, just a second writer of the same buffer.
- When main opens a Screens window it asks the daemon for a **one-time token** and passes it to that window once (in
  the URL). The window connects directly; main is not in the data path.
- A frame is sent only to connections that asked for that station (the same lease semantics as
  `metersSubscribe`). The Screens window draws with requestAnimationFrame from a frame store, exactly as
  `meterStore.ts` does.
- **Later:** the LAN Screens server (§2.2) serves the same stream to paired browsers at a reduced rate (10 Hz), with
  the paired-device token instead of the one-time token.
- **Blast radius:** a daemon change, which means a daemon reload: an update needs a full close and reopen (memory:
  the daemon never reloads on auto-update). A packaged smoke test is required. If the stream is unavailable, the
  meters say "meters unavailable" rather than falling back to the main relay. A silent fallback would quietly put
  the load back on main.
- **Also worth doing (separate, small):** send `audio:meters` only to windows that hold a lease, instead of
  `sendToAllWindows`. That cuts today's load for every pop-out, Screens or not (freeze cause #5).

### 7.4 What the default screen is NOT
- Not a second board. Every action uses the same named commands as the main UI (§2.1), so the main board and Screens
  can never disagree.
- Not a copy of any vendor's screen. It borrows the *idea* of a one-page console (meters across the top, a clock
  with seconds, readouts, carts, a fader bank) and is drawn entirely in Ether's style.
- Not an audio path. Meters are read-only; faders and buttons are commands; nothing on the screen touches audio
  directly.

### 7.5 New work this screen needs, in total
1. A horizontal orientation for the existing meter component.
2. An analog clock widget (SVG). Export `ClockDisplay`.
3. A clock-aligned timeline widget.
4. The "next hard event" definition (Jeff) and its renderer-side computation.
5. Named commands `channel:set-volume` and `channel:set-on` in the command service (with the cart-fire extraction
   already planned).
6. The daemon's loopback meter stream with one-time tokens (§7.3). This is the only daemon change.
7. Fix the cart VU's station filter (bug, freeze cause #5).

---

## Decisions for Jeff
1. ~~Which domain hosts remote Screens~~ — **RULED: `app.ether-cast.com`** (Jeff, 2026-10-05).
2. Layout storage: synced per station (recommended) vs local-only.
3. LAN transport: HTTP + tokens for v1 (recommended) vs local HTTPS with a one-time trust prompt.
4. The default role for newly paired devices: viewer (recommended) or operator.
5. The Live Assist grid for Magical Forest: cart rows×cols, and which carts.
6. **Default screen (§7):** which events count as the "next hard event" (proposed: announcement, spot-break start, top of the hour).

**Stop.** Awaiting Jeff's review and GO.

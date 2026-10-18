# Screen Builder: design plan (2026-10-18)

**Type:** design only. Nothing is built until Jeff says GO.
**Branch:** `ui/screen-builder`, from 6558e57 (the build on air). Never the scheduler branch.
**Method:**
- A read-only agent inventoried the tree.
- The receipts the design rests on were re-checked by hand:
  - the dormant canvas switch (`App.tsx:2555`, `setUseCanvas` has no caller);
  - the canvas deck widget calling the engine directly (`src/canvas/widgets/DeckWidget.tsx:26-29`);
  - the canvas layout reads with no station filter (`src/canvas/CanvasEngine.tsx:116, 126-128`);
  - the cart wall's window-wide key listener (`src/components/DeckConfigurator.tsx:858-869`);
  - the module-level active-station cache (`src/hooks/useActiveStation.tsx:37-45`);
  - the working dockview pane registry (`src/components/schedule/layoutStore.ts:30-45`);
  - the ☰ door test (`src/lib/drawerDoors.test.ts`).

  Anything about runtime behaviour is from the code and marked UNVERIFIED.

**Governing docs:**
- `docs/ether-screens-plan.md` (2026-10-05, untracked, never approved). This plan keeps its command service, explicit station,
  storage and window design, and **overrides its widget library** (§2.10).
- `CLAUDE.md`: DOORS BEFORE ROOMS, BUILD THE SENSE, ARCHITECTURE BEFORE CODE, physical deck positions are sacred, the board is
  the sole gate.
- Memory rulings: faders are generic; MONITOR is master of local output; a station is a switchable context.

---

## Summary, in plain words (one page)

**Jeff's goal:** "I build any surface myself, e.g. one with carts + program log + song library. NO new hard-coded page. Ever."

**What exists today:**
- **No working Screen Builder.** There is a widget canvas from March 2026 (`src/canvas/`). It is still mounted, but no button
  can switch it on: its switch, `setUseCanvas`, lost its only caller in `4d8bfb0`.
- **What it would show is mostly theater:**
  - its deck buttons play and stop decks directly, around the board's ON gate (`DeckWidget.tsx:26-29`);
  - its library is a copy of the Library;
  - four of its widgets are placeholder text, and the podcast widgets fake their work;
  - its saves read any station's layout.
- **Two things do work and point the way:**
  - **The Schedule Manager is a real docking workspace** (dockview). It hosts the real Program Log, Spots, Sweepers and
    Rotation components.
  - **Pop-outs already render about 30 of the app's panels stand-alone** (`PopoutRenderer.tsx`).

**What the Screen Builder will be:**
1. **Every panel is a registered module.** The module *is* the component the app already uses, on the same engine and the
   same commands: Carts, Program Log and Song Library first, then decks, faders, meters, announcements, clocks and the rest.
   There are no copies and no mocks. A module that cannot be fully wired is not in the palette, and a test enforces that.
2. **You build surfaces.** Place, size and arrange modules, as many of one kind as the module allows (two cart banks, two
   logs). Give each module its options (which carts, which columns), and its station, per your ruling below.
3. **One layout engine:** dockview, the one already proven in the Schedule Manager. The dead canvas is deleted.
4. **Layouts are data.** Each one is saved per user and station in a new synced table and follows the station to every
   computer, like everything else. Only window position stays per machine. Nothing about a layout lives in code.
5. **One way screens are made.**
   - Today's fixed pages become **default layouts** built from the same modules, all the way to the main window.
   - Each pop-out becomes a one-module layout. The Schedule Manager's presets become layouts.
   - The ☰ menu opens layouts.
6. **Every module has a help entry and an empty state** (doors before rooms). A module that lacks either cannot be
   registered.
7. **Proof:**
   - A cart fired from a built surface must make exactly the same calls to the engine as one fired from the Carts page.
   - A log edit made in one module must show at once in the other.
   - A static check fails the build if anyone adds a page that isn't a layout of registered modules.

**Decisions: Jeff ruled all six on 2026-10-18** (§5):
- one station per layout now;
- dockview, and the canvas deleted;
- a synced `screen_layouts` table, per station plus per user profile;
- Carts, Program Log and Library first;
- the main window after the scheduler ships;
- the canvas rows left alone.

**Phase 1 is GO:** the registry, the Carts, Program Log and Library modules, their parity tests, and the no-hard-coded-page
check. It is built in a separate git worktree for `ui/screen-builder`, never on the scheduler branch.

---

## 1. What exists today (receipts)

### 1.1 The dormant canvas: unreachable, and theater where it renders
- **History:**
  - created `beee8b9` (2026-03-27);
  - `cb79f0a` (2026-05-13) "disable broken picker and resize, suppress types pending rebuild";
  - after that, only sweeps.
- **Mounted but unreachable:**
  - `App.tsx:2550` `useCanvasEngine()`;
  - `App.tsx:2555` `const [useCanvas, setUseCanvas] = useState(false)`;
  - `App.tsx:3208` renders `<WidgetCanvasLive>` only when it is true.
  - **No code calls `setUseCanvas`.** Its last callers were in the React `MenuBar`, deleted in `4d8bfb0` (2026-08-10).
- **Still live, and saving a layout nobody can see:**
  - the native `file:save` / `file:new-session` call `saveCurrentLayout` / `resetLayout` (`App.tsx:1244-1245`);
  - the ☰ "Reset Layout" calls `canvasEngine.resetLayout()` (`App.tsx:2578-2582, 3186-3192`).
- **What it can do:**
  - 16 widget types (`WidgetRegistry.ts:6-22, 40-218`);
  - a 20×12 grid placed in percent (`WidgetCanvas.tsx:176-180`);
  - free-position placement (`CanvasEngine.tsx:55-66`);
  - move clamped to the grid but never collision-checked (`:181-189`);
  - per-widget `config` (`:204-206`);
  - named layout profiles (`:213-256`).
  - **The same widget twice** only for deck and social (`allowMultiple`, `WidgetRegistry.ts:48, 159`; decks capped at 3,
    `CanvasEngine.tsx:151, 263`).
  - **No per-widget station:** every widget reads the one global active station.
- **Half built:**
  - **resize is a stub** that returns, under a "never worked" TODO (`WidgetCanvas.tsx:100-111`); its fallback path snaps
    against the wrong unit (`:155-156`);
  - **the picker is never rendered** (`:340-413`, TODO `:492-499`);
  - **`LayoutSaver` and `GridOverlay` are never rendered** (`:252-336`, `:417-432`);
  - **edit mode is ignored** (`CanvasEngine.tsx:103`);
  - `// @ts-nocheck` on the file (`WidgetCanvas.tsx:1`);
  - **`proOnly`** is a badge, never enforced.
- **Theater** (UNVERIFIED at runtime: unreachable today):

| Widget | Same component as the real page? | Same engine/command path? |
|---|---|---|
| deck | **No**: an old `OnAirDeck`, not the board's `FaderSectionLive` | **No**: `engine.getDeck(slot).play()/pause()/stop()` directly (`DeckWidget.tsx:26-29`), around the board's ON gate ("the board is the sole gate", `App.tsx:2053-2056`). **A live-air hazard if ever re-enabled.** |
| library | **No**: a copy, capped at 200 rows (`Widgets.tsx:144-193`) | partly: enqueue is real; its "A" button loads the deck directly, where the real Library uses `deck:cue` (`PopoutRenderer.tsx:167-168`) |
| queue, mic, history, clock | the real `UpNext`, `MicStatusPanel`, `SongHistoryStrip`, `LiveHourClock` | queue gets a stale length and a no-op change handler (`Widgets.tsx:18`) |
| nowplaying | a copy (`Widgets.tsx:45-71`) | display only |
| cartwall, vumeter, social, scheduler | **placeholder text** (`WidgetCanvas.tsx:41-45`) | none |
| episode, remoteguest, export, shownotes | `PodcastMode.tsx` | **fake:** export progress is simulated (`PodcastMode.tsx:361-369`); show notes call `api.anthropic.com` from the renderer (`:502`) |

- **Storage:**
  - keys `canvas_layout`, `canvas_layout_version`, `canvas_profiles`, `canvas_active_name` in `station_config_kv`;
  - **written per station but read with no station filter** (`CanvasEngine.tsx:116, 126-128`);
  - callbacks close over a stale `stationId` (`:231, 243, 251, 256`);
  - **the keys sync** (not local-only, `electron/sync/handlers/station_config_kv.js:91, 105-107`);
  - rows exist on live installs (`docs/freeze-inventory-2026-08-17.md:286`).

### 1.2 What works and is the precedent
- **The Schedule Manager's dockview workspace:**
  - `ScheduleWorkspace.tsx:28` with a pane registry (`layoutStore.ts:30-45`) and presets (`:69-104`), with versioned
    payloads (`:13, 22, 112-124`);
  - it hosts the **same** `ProgramLog`, `Spots`, `SweepersPanel`, `RotationAnalytics` and `Logs` components;
  - history: `cad9ac4` (Phase 1), `7bfee3b`, `9094488`, `ae1f3df`, `9a4e3d4`, `8b315c5`, `95ae9eb`;
  - saved local-only under `schedule_layout_v1` (`ScheduleWorkspace.tsx:263, 280, 396`).
- **Pop-outs:**
  - `PopoutRenderer.tsx` has 29 cases (decks, master, processor, imaging, mic, phone, voicetrack, upnext, health, carts, shows,
    clocks, categories, library, studiopro, videostudio, programlog, logs, rotation, spots, announce, eas, schedulehub,
    streaming, smartschedule, analytics, cloudbackup, multioutput, importlibrary);
  - all under `<AudioEngineProvider gate>` (`src/main.tsx:112-116`);
  - one window per panel key (`main.js:8311-8317`).
- **The ☰ list and its test:** `drawerDoors.test.ts` checks every ☰ entry opens a pop-out the router knows. This is where
  the "no new hard-coded page" check grows from (§3).

### 1.3 Not built from the Ether Screens plan
- `src/screens` does not exist.
- `cmd:execute` (the one command service) does not exist.
- `announcements:upcoming` exists only on `fix/aftersign-announce-catchup` (`e7e65fd`).
- The plan itself is untracked (`git status`: `??`).

---

## 2. The design

### 2.1 A module is the real component, registered
`src/modules/registry.ts`: one entry per module.
```
{ type: "carts", title: "Carts", component: BoutiqueCartWall,
  instances: "many" | "one-per-window" | "one",
  station: "follows-layout" | "per-module",     // per decision 1
  options: [{ key: "bank", kind: "cart-bank" }, { key: "rows", kind: "int", min: 1, max: 8 }, ...],
  help: "docs/help-module-carts.md",
  empty: { title: "No carts in this bank yet", action: "Assign carts" },
  proof: "src/modules/proof/carts.proof.test.tsx" }
```
- **`component` is imported from where the app already uses it,** never redefined: `BoutiqueCartWall` from
  `DeckConfigurator.tsx`, `ProgramLog`, `LibraryPanel`, `FaderSectionLive`, and so on.
- **A module is placeable only when its `proof` test exists and passes,** and its help doc and empty state exist. A static
  test fails the build otherwise. That is "if a module can't be fully wired, it can't be placed", enforced by the gate, not by
  memory.
- **The module renders inside a `ModuleFrame`** that provides three things:
  1. **Its station** (§2.3).
  2. **Its instance id,** so hotkeys, DOM ids and stored view preferences are per instance (§2.4).
  3. **Its options,** as props.

  Nothing else. The frame adds no buttons of its own to the module.

### 2.2 Surfaces: dockview, the one layout engine (decision 2)
- **A surface is a dockview workspace of module panes:** placed, split, tabbed, sized by dragging, and floated or popped out
  to another window.
- **Why dockview, not the canvas grid:**
  - it already runs in this app with the real Program Log;
  - it handles resize and tabs, the two things the canvas never got working;
  - one mechanism means one way screens are made.
  - **The canvas is deleted** (§2.9).
- **Edit vs live, as the Screens plan (§1.3):**
  - **Live is the default and locked:** modules work, nothing moves.
  - **Edit is an explicit toggle:** a palette of the registered modules, a per-pane options sheet, "add another" where the
    module allows it.
  - Nothing a module does is blocked or faked in edit mode. The frame only stops panes being dragged by accident in live.
- **A grid-style button console** (Zetta-style screens of fixed tiles) is a dockview layout of small panes. A cart module with
  1 row × 4 carts is a tile. No second engine.

### 2.3 Station: explicit, never guessed (decision 1)
- **Today:** every component reads one machine-global active station (`useActiveStation.tsx:37-45`, a module-level cache).
  Pop-outs don't hear a switch made in another window (`docs/ether-screens-plan.md` §1.2).
- **Design:**
  - **A `StationScope` context:** `useActiveStation()` reads the nearest scope first and falls back to the global one only
    where no scope exists. Every module is under one.
  - **A layout belongs to a station** (`station_uuid`). By default every module follows it.
  - **The module's engine is resolved fresh by that station** every time (the command-path rule: `getEngine(stationId)` fresh,
    never closed over).
- **Your ask, "sets each module's station", meets the standing ruling that a station is a whole context you switch into,
  with nothing mixed between stations.** Two options:
  - **(a)** A layout is one station; every module follows it; to watch two stations you open two surfaces side by side. Keeps
    the ruling.
  - **(b)** A module may name its own station. The pane shows that station's name in its header, in that station's colour,
    always. Needed for an engineer's "all stations" wall.
  - **Recommended: (a) now, (b) as an option you switch on per layout.**

  Either way, a module never guesses: no `?? 1`. `smoke-window-station.js` is extended to every module file.

### 2.4 More than one of the same module
- **What must change before a second instance is allowed** (receipts; UNVERIFIED at runtime):
  - **Carts:**
    - every instance adds a window-wide `keydown` (`DeckConfigurator.tsx:858-869`), so one key would fire two walls;
    - `fireCart`'s guard is set only after its awaits (`:900-922`), so it could double-fire;
    - keys A/S/G also collide with App's global keys (`App.tsx:2071-2079`).
    - **Design:**
      - hotkeys belong to the **focused** cart module only;
      - every bank's hotkeys are an option, checked for clashes when the layout is saved;
      - the cart fire is the one command (`cart:fire`, extracted per the Screens plan §2.1) with its own in-flight guard.
  - **Program Log:** state is per instance; `schedule:changed` is debounced per instance. **Safe now.** Its stored date becomes
    per instance.
  - **Library:** state is safe. Its column widths in localStorage (`App.tsx:5004, 5063`) become per-instance options.
  - **Health Monitor:** hard DOM ids (`HealthMonitor.tsx:1222, 1347-1848`) → `one-per-window` until the ids are scoped.
  - **StudioPro:** module-level caches and a capture-phase key handler (`StudioPro.tsx:303-304, 1814`) → `one`, a single
    instance.
- **The registry's `instances` field says which, and the palette enforces it.**

### 2.5 Layouts are data, synced (decision 3)
- **A new synced, station-scoped table** `screen_layouts`:
  - `uuid`, `station_uuid`, `owner` (an in-app user profile uuid, or NULL for the station's shared layout), `name`, `kind`
    (`surface` | `default`), `payload` (versioned JSON: dockview's serialized state + each pane's module type, instance id,
    station and options), `version`, the usual sync columns.
  - It is registered in `electron/sync/synced-tables.js` like every other station table, so it follows the station to every
    computer on the account and reaches the web app through the existing mirror.
  - **Why a table, not `station_config_kv`:** layouts are rows with an owner and a name; one KV blob per station is how the
    canvas lost layouts to the wrong station.
- **Per user and station:** a user sees the station's shared layouts plus their own. User profiles are in-app profiles, not
  the account (CLAUDE.md): this is a preference, not identity.
- **Machine-local only:** which monitor a surface window opens on, its position and always-on-top. These stay in
  `popout-bounds.json`, keyed by layout uuid plus display id (Screens plan §1.2).
- **Export / import** `.etherscreen.json`, by the `theme:export` pattern.
- **Nothing about a layout is in code:** default layouts ship as seed rows (§2.6), written on first use. A static test (§3)
  forbids layout literals in components.

### 2.6 One way screens are made: today's pages become default layouts
Every fixed page becomes a **default layout** made of registered modules. A pop-out is a one-module layout. The ☰ menu
opens layouts. "Reset" on a default layout restores its seed.

| Today | Module(s) it becomes | Converts cleanly? (receipt) |
|---|---|---|
| **Carts** pop-out + push-up strip (`PopoutRenderer.tsx:234`, `App.tsx:4526`) | `carts` | **after §2.4 hotkey scoping.** One instance is clean today |
| **Program Log** push-up, pop-out, Schedule pane, panel `schedulebuilder` (`App.tsx:4505, 3244`; `PopoutRenderer.tsx:265`) | `programlog` | **yes**: already hosted 4 ways |
| **Song Library** panel + pop-out (`App.tsx:4871`, `PopoutRenderer.tsx:17`) | `library` | **mostly**: move `LibraryPanel` out of App.tsx; its `onEdit` needs the Track Editor as a module (`PopoutRenderer.tsx:178-183`) |
| **Decks / faders / board** (`FaderSectionLive`, `App.tsx:4466-4484`; pop-out `decks`) | `board` (options: which channels, narrow) | **yes**: it owns its own board state; keeps the ON gate and physical deck positions |
| **Master / meters / processor** (pop-outs `master`, `processor`; `meterStore.ts:47-87`) | `master`, `meters`, `processor` | **yes**: the meter lease is multi-instance safe |
| **Announcements** (panel + pop-out) | `announcements` | **yes**: no props, station from the hook |
| **Shows / Clocks / Categories** push-ups + pop-outs (`Scheduler defaultTab embedded`) | `shows`, `clocks`, `categories` | **yes** |
| **Sweepers** push-up (`SweepersPanel stationId`, `App.tsx:4520`) | `sweepers` | **yes**: already takes an explicit station |
| **Up Next / queue** (`UpNext.tsx:127`, pop-out wrapper `PopoutRenderer.tsx:46-65`) | `queue` | **mostly**: replace the length prop with the engine's queue stream |
| **Schedule Manager** (`ScheduleWorkspace`, presets `layoutStore.ts:69-104`) | its presets become default layouts; its panes become modules | **yes**: already dockview; its local-only layout moves into `screen_layouts` |
| **Spots, Rotation, Play Log, Imaging, Voice Tracker, Mic, Phone, EAS, Streaming, Analytics, Cloud Backup, Multi-output, Import Library, Smart Schedule** (pop-out cases) | one module each | **yes** for each one the pop-out renders with no App props; each gets its proof test |
| **Health Monitor** (`HealthMonitor.tsx`) | `health`, one per window | **after DOM-id scoping** |
| **StudioPro / Show+ DAW, Video Studio** | `studiopro` / `videostudio`, single instance | **entangled**: module-level state, IPC close guard (`main.js:8389-8396`), device double-open (memory). Converted last, single instance |
| **Settings, Station Manager, Track Editor, Clip Editor, Captions, Subscription, MIDI, Macros, Manage Devices** (main-window panels with App props) | one module each, kind `tool` (opened from the menu, rarely placed) | **entangled**: about 10 App props for Settings; `onStationSwitch`; `editSong`. Each is lifted out of App.tsx first |
| **The main window ("live")** itself: board + library + push-up dock + queue + header clock (`ClockDisplay`, module-local `App.tsx:6707`) | the **"Live" default layout** | **the largest conversion**: App-level state and the push-up dock. **Last** (decision 5) |
| `cartwall` panel (`CartWallPanel`, localStorage wall, `App.tsx:3704-3741`) | none | **dead**: no menu sends `nav:cartwall`; `onOpenCarts` never called. Removed |
| `src/canvas/*`, `LiveAssistPage.tsx` (repo root, Tauri era) | none | **dead or theater**. Removed |

The remaining `Panel` members (`App.tsx:147`: playlist, smartschedule, studio, broadcasteditor, phonedesk, showprep, autocue,
pdpicks, reasons, vtinbox, gselector, spotifyimport, schedulehubfixed, help, subscription…) are inventoried one by one in
Phase 0 and get a row in this table before their phase starts. None is converted without its row.

### 2.7 Help and empty state per module (doors before rooms)
- **Every module has a help doc** `docs/help-module-<type>.md`, to the `docs/help-sweepers.md` template, and an empty state
  that says what it is and the one action that fills it ("No carts in this bank yet — Assign carts").
- **The builder itself:** `docs/help-screen-builder.md`. Its door is the ☰ menu: "Screens → New screen / Open / Edit this
  screen".
- **A static test fails the build** if a registered module has no help file or no empty state.

### 2.8 Commands: one path
- **Modules call exactly what their component calls today.** That is the point of using the component.
- **Where a component's action lives inside App.tsx** (the web remote's `execCmd`, `App.tsx:1346-1759`), it is extracted into
  the command service from the Screens plan (§2.1 there, `execute({stationUuid, cmd, args}, principal)`). The page and the
  module then both call it: one path, two doors.
- **First extraction:** the cart fire (`resolveFireChannels` → `loadToDeck` → `play` on the cart channel).

### 2.9 Removed by this design, and what replaces each (the "don't remove what works" rule)
- **`src/canvas/` (1262 lines) and `LiveAssistPage.tsx`.** Unreachable today; theater; the deck widget bypasses the board.
  Nothing working is lost.
- **The `file:save` / `file:new-session` / ☰ "Reset Layout" calls to the canvas** (`App.tsx:1244-1245, 2578-2582`).
  - They save or reset an invisible layout, so no user-visible behaviour is lost.
  - "Reset Layout" becomes "Reset this screen" on a default layout.
- **The `canvas_*` keys.** They are no longer written or read. Existing rows are left in place (never written by script on a
  live database). A later cleanup is your call.
- **`CartWallPanel` (the localStorage wall).** Unreachable.
- **The Schedule Manager's local-only `schedule_layout_v1`.** Read once into a `screen_layouts` row, then no longer written.
  The workspace and its presets keep working, now as layouts.

### 2.10 Where this differs from the Ether Screens plan (2026-10-05)
- **The plan proposed a new widget library** (`src/screens/widgets/*`). Your rule now is "the SAME component the app already
  uses, never a copy". So **the modules are the app's own components;** there is no widget library. This supersedes the
  plan's §1.1 widget library.
- **Kept from the plan:**
  - the command service;
  - the explicit station;
  - the window design (own renderer, bounds per display, always-on-top);
  - edit vs live;
  - export and import.
- **The plan's LAN-browser and remote surfaces** need these same components to run outside Electron, against a transport
  under `window.ether`. That is a later phase (Phase 6). It does not change the module rule.
- **The plan's Phase 1 "Live Assist" fixed layout** becomes a default layout (§2.6), not a fixed page.

---

## 3. Proof (tests in the gate)

| # | Test | Pass condition |
|---|---|---|
| S1 | **Cart parity**: the Carts page's wall and a cart module on a built surface, rendered with the real `window.ether` bridge recorded (vitest + jsdom), fire the same cart | the two produce **the identical sequence of bridge calls** (deck config read, `loadToDeck` with the same channel and file, `play`), with the same station |
| S1b | **Cart parity on the engine** (a private daemon on a private pipe, muted, as `scripts/test-cart-exhaustion.js` does) | firing from each surface airs on the same cart channel and writes the same `play_log` row (title, file, content class, station) |
| S2 | **Log parity**: two Program Log modules on one surface plus the Program Log page; an edit (move, swap, delete) in one | every instance shows the change after one `schedule:changed`, and the database row is the one the page's own edit writes |
| S3 | **Library parity**: Load A / Queue from a library module vs the Library page | identical bridge calls (`deck:cue` / enqueue) |
| S4 | **Placeable = wired** (static) | every registry entry has its component imported from the app's own file (never defined in `src/modules/`), a passing proof test, a help doc and an empty state; else the build fails |
| S5 | **No new hard-coded page** (static, ratchet) | the `Panel` union, the PopoutRenderer cases, the ☰ list and the `new BrowserWindow(` sites are frozen to a recorded list; each must map to a default layout of registered modules. Adding a page, a pop-out case or a window that is not a layout fails the build. The list only shrinks as pages convert |
| S6 | **Two of the same** | two cart modules: a hotkey fires only the focused one, once; two logs keep separate dates; layouts with clashing hotkeys are refused at save |
| S7 | **Station explicit** | every module under a `StationScope`; no `?? 1` in any module file (`smoke-window-station.js` extended); a module of station B never reads station A's rows |
| S8 | **Layouts are data** | save, sync to a second install (the sync test harness), reopen: identical; no layout literal in any component (static); window position stays local |
| S9 | **The screen itself** | launch the app and look at each converted page and a built surface (CLAUDE.md: the only valid UI test) |

---

## 4. Build order (each phase a branch step, local commits, its tests passing; nothing ships without Jeff's GO)

| Phase | Builds | Proved by |
|---|---|---|
| **0. Inventory + guards** | Finish the §2.6 table for every `Panel` member. The S5 ratchet and S4 static check, against today's tree (today fails S4 for every page; S5 records today's list). | S4, S5 run and report |
| **1. The frame** | `StationScope` + `ModuleFrame` (station, instance id, options); `screen_layouts` table + sync registration + migration; the registry. | S7, S8 (sync) |
| **2. First three modules + the builder** | Carts (hotkeys scoped, `cart:fire` extracted), Program Log, Library (lifted out of App.tsx). The builder window: dockview, edit/live, palette, options sheet, save/open/export. Help docs + empty states. Delete `src/canvas/`, `CartWallPanel`, `LiveAssistPage.tsx`, the canvas menu calls. | S1, S1b, S2, S3, S4, S6, S9: Jeff builds carts + log + library himself |
| **3. Pop-outs become layouts** | Each pop-out case becomes a one-module default layout; the ☰ list opens layouts; Schedule Manager presets become layouts. | S5 list shrinks; per-module proofs; S9 |
| **4. The rest of the modules** | Board, master, meters, processor, announcements, shows/clocks/categories, sweepers, queue, health (ids scoped), spots, rotation, play log, the tools (lifted out of App.tsx one by one), StudioPro/Video (single instance) last. | each module's proof; S4 |
| **5. The main window** (decision 5) | The "Live" default layout: board + library + push-up dock + queue + clock as modules. App.tsx keeps only the shell. | S5 reaches zero hard-coded pages; S9 |
| **6. Other surfaces** (later, per the Screens plan) | The same modules in a LAN browser and on app.ether-cast.com through a transport under `window.ether`; LAN pairing; roles. | per that plan |

---

## 5. Jeff's decisions (2026-10-18)
1. **Station:** one station per layout now. Per-module station comes later, as an option per layout (§2.3 (a), then (b)).
2. **dockview is the one layout engine. The canvas is deleted** (§2.2, §2.9).
3. **Layouts** live in a synced `screen_layouts` table, per station plus per user profile (§2.5).
4. **Module order:** Carts, Program Log and Library first. Then decks, faders/board, meters, announcements and clocks. Then
   the rest of Phase 4 as listed.
5. **The main window** converts **after the scheduler ships** (Phase 5 waits).
6. **The old `canvas_*` rows** on installs are left alone.

**GO on Phase 1** (Jeff's scope, 2026-10-18):
- the registry;
- the Carts, Program Log and Library modules;
- their parity tests;
- the no-hard-coded-page check.

It is built in a separate git worktree for `ui/screen-builder`, so it never swaps out the scheduler branch. Local commits
only. Stop after Phase 1 and report.

That merges this plan's Phases 0–2 as follows:
- **in:** the registry and frame (station scope, instance id, options) and S4/S5 from Phase 0–1;
- **in:** the three modules with their help, empty states and proofs S1–S4/S6/S7 from Phase 2;
- **in:** the canvas deletion (decision 2);
- **later:** the builder window (dockview surface, palette, save/open) and the `screen_layouts` table, unless Jeff adds them
  to Phase 1.

**Stop after Phase 1 and report.**

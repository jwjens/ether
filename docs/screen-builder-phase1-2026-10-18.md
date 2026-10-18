# Screen Builder Phase 1: build report (2026-10-18)

**Branch:** `ui/screen-builder`, worktree `C:\openair-wt\screen-builder`, from `9d2e187`. Local commits only. Nothing
pushed, tagged or released. No installer built (no version bump; Jeff asked for none).

**Scope (Jeff's GO, design doc §5):**
- the registry and the frame;
- the Carts, Program Log and Song Library modules;
- their parity tests;
- the no-hard-coded-page check;
- the canvas deleted.

**Not built (as scoped):**
- the builder window (dockview surface, palette, save/open);
- the `screen_layouts` table;
- converting pop-outs or pages.

**Commits:**
- `68a95ac`: delete the widget canvas, `LiveAssistPage.tsx` and the dead `CartWallPanel`.
- `c0e83fb`: module registry, station scope and module frame, the three modules, the proofs and the ratchet.
- this report.

---

## 1. What was built

### 1.1 The station scope (design §2.3)
- **`src/hooks/useActiveStation.tsx:53`** `StationScope`, `:58` `useStationScope()`.
- **`useActiveStation()` reads the nearest scope first** (`:115`). Inside a scope it returns the scope's station,
  ready (`:145`).
- **Outside a scope nothing changes.** The hook runs its global cache, listeners and load exactly as before. Hook
  order is unchanged, so moving a component in or out of a scope is safe.

### 1.2 The frame (design §2.1, decision 1)
- **`src/modules/ModuleFrame.tsx:19` `ModuleSurface({ station })`** takes ONE station for the whole surface: a
  `StationScope` plus `<AudioEngineProvider>` under it. So `useAudioEngine()` in every module resolves that
  station's engine by id, fresh (`getEngine(stationId)`).
- **`:33` `ModuleFrame({ type, instanceId, options })`** gives the module:
  - its instance id, through `ModuleInstanceContext` (`src/hooks/useModuleInstance.ts`);
  - its options, as props.
  - Nothing else: no buttons of its own.
- **It throws by name outside a `ModuleSurface`** (`:36`). A module never falls back to the machine's station (S7).
- **`:50` `ModuleBody`** calls the entry's `useBoundProps` (the app's own hook) and renders the component. When
  `scroll` is set, it wraps it in the same scroll wrapper the Library pop-out uses.

### 1.3 The registry (design §2.1)
`src/modules/registry.ts`. Each entry: `component` (the app's own, imported from its file), `instances`,
`station: "follows-layout"`, `options`, `help`, `empty`, `proof`.

| type | component (imported from) | instances | options | help | empty state (asserted by its proof) |
|---|---|---|---|---|---|
| `carts` (`:53`) | `BoutiqueCartWall` (`src/components/DeckConfigurator.tsx`) | many | `variant`: grid / strip | `docs/help-module-carts.md` | tile tooltip "Empty — click to assign" |
| `programlog` (`:69`) | `ProgramLog` (`src/components/ProgramLog.tsx`) | many | `embedded` | `docs/help-module-programlog.md` | "No shows configured for this day" |
| `library` (`:84`) | `LibraryPanel` (`src/App.tsx`, as PopoutRenderer imports it) + `useLibraryWindowActions` (`src/lib/libraryWindowActions.ts`) | many | none | `docs/help-module-library.md` | "Import audio to add items to the library." |

**`LibraryPanel` was not lifted out of App.tsx.** It is ~1,500 lines leaning on App.tsx helpers, and Jeff allowed
the lift only as a pure move. It is imported from App.tsx, as `PopoutRenderer.tsx:17` does.

**What was moved:** the Library window's actions, unchanged, from `PopoutRenderer`'s `PopoutLibrary` into
`src/lib/libraryWindowActions.ts`. `PopoutLibrary` (`PopoutRenderer.tsx:162`) now calls the same hook. So the
module and the page call one path (design §2.8).

### 1.4 Two of the same, made safe (design §2.4)
**Carts.** In `src/components/DeckConfigurator.tsx`:
- **Hotkeys belong to the focused wall only.**
  - `:686-691` holds this window's mounted walls and the focused one, in `ownsCartHotkeys`.
  - `:877` is the wall's id: the frame's instance id, else React's `useId()`.
  - `:887` `claimHotkeys` is set on each layout's root, by `onPointerDownCapture` and `onFocusCapture`
    (`:1256` strip, `:1338` grid and compact).
  - `:893`: the window `keydown` acts only for the owner.
  - **Owner rule:** the wall last clicked or tabbed into. Until then, the most recently mounted wall. **A single
    wall (the Carts pop-out, the push-up strip) owns its keys with no click, exactly as today.**
- **In-flight guard.** `firingRef` (`:905`) is checked at `:923` and set at `:946`, before the first await. It is
  cleared in `finally`. A second press during one fire's awaits is the same press.
- **Grid tiles now carry the strip's tooltip** ("Empty — click to assign", "… click to fire, right-click to
  delete", "… click to STOP"). Only the strip had it; this is the cart module's empty state on the full wall.

**Program Log.**
- State and the `schedule:changed` debounce are already per instance (proved by S2).
- **Each instance keeps its own on-screen day.**
- **Per-instance stored date: documented, not built.** The stored date (`PROGRAMLOG_DATE_KEY(stationId)`) is the
  seed for the NEXT one opened. It stays per station: making it per instance changes the docked + pop-out contract
  that slice 3 set ("open on the same day"), so it is Jeff's call.

**Library.**
- State is per instance.
- **Per-instance column prefs: documented, not built.** Column choices (`ether_lib_cols`, per machine) and widths
  and page (`…_${stationId}`, per station) live in localStorage, so two instances share them: a width dragged in one
  shows in the other on its next mount. Making them per instance means re-keying LibraryPanel's ten storage reads;
  not cheap inside App.tsx.

### 1.5 Help docs (doors before rooms, design §2.7)
- `docs/help-module-carts.md`, `docs/help-module-programlog.md` and `docs/help-module-library.md`: flat, to the
  `docs/help-sweepers.md` template.
- **Door today:** each names its door, the existing ☰ entry (Carts, Program Log, Library), because the module IS
  that panel. The builder's door (☰ → Screens) arrives with the builder.

---

## 2. Tests and results

### 2.1 The proofs (`src/modules/proof/`)

**No jsdom in this tree.** `node_modules` has no jsdom, happy-dom or testing-library (see the note at the top of
`ProgramLog.layout.test.tsx`), and installing was forbidden.
- **The fix:** `miniDom.ts` installs a small DOM on `globalThis`, enough for `react-dom/client` to mount the app's
  real components, run their effects and dispatch React events.
- **`etherStub.ts`** is a recording `window.ether`: every bridge call, in order, with its arguments.
- **This is test scaffolding.** It renders no pixels.

| # | File | What it proves |
|---|---|---|
| S1 | `carts.proof.test.tsx` | **The two carts surfaces match.** The Carts page (`<AudioEngineProvider gate><PopoutRenderer panel="carts"/>`, as `main.tsx` mounts it) and a Carts module fire the same cart with the identical bridge sequence (`deckConfigs.list(2)`, `console.emit`, `audio.load("D", file, …, 2)`, `audio.play("D", 2)`, …), on station 2. |
| S2 | `programlog.proof.test.tsx` | **An edit in one log reaches them all.** Two Program Log modules plus the Program Log page: a delete in module A shows in B and the page after ONE `schedule:changed`, with one re-read each, all on station 2. The module's write equals the page's write (`invoke("schedule:deleteRow","r1")`). Another station's `schedule:changed` is ignored. |
| S3 | `library.proof.test.tsx` | **Load A matches.** Load A from a Library module and from the Library page (`PopoutRenderer panel="library"`) give identical calls (`audio.daemon("deck:cue", {stationId: 2, …})`). Queue matches too: identical, and see §5. |
| S4 | `placeable.test.ts` | **Every entry is wired.** Each registry entry's component and bound hook are imported into `registry.ts` from an app file outside `src/modules` that exports them. Its proof exists and renders `type="<type>"` through `ModuleFrame`. Its help doc exists at `docs/help-module-<type>.md` with the template's sections. Its empty state is asserted by its proof. And no file under `src/modules` defines a component except the frame. |
| S5 | `noNewPage.test.ts` + `no-new-page.baseline.json` | **The page lists cannot grow.** The `type Panel` union (42), the PopoutRenderer cases (29), the ☰ list (17, parsed as `drawerDoors.test.ts` parses it) and the `new BrowserWindow(` sites (6, by enclosing function or ipcMain channel) are frozen. The test fails if any list grows, and also if the baseline names something the tree dropped, so a converted page is struck in the same commit. |
| S6 | `carts.proof.test.tsx` | **One key, one fire.** The page alone: key 1 fires (unchanged). Two modules with the first clicked: one fire. Then the second clicked: one fire, from B (no pause, so not A's stop). Two modules, none clicked: one fire. A double press inside one fire's awaits: one fire. |
| S7 | carts + library proofs, `smoke-window-station.js` | **A module stays on its surface's station.** A station-3 module reads and fires station 3 while the active station is 2. A `ModuleFrame` outside a `ModuleSurface` throws. `smoke-window-station.js` §3 now walks every file under `src/modules`, refusing any `?? 1` there, plus `src/lib/libraryWindowActions.ts`. |

**Mutation checks (temporary edits, reverted):**
- With `ownsCartHotkeys` and the in-flight guard disabled (today's behaviour), S6 fails 3 of its tests: both
  two-module cases and the double press.
- With a fake `"newpage"` Panel member, S5 fails.
- With a wrong help path, S4 fails.

### 2.2 Gates

**Before** (base `9d2e187`, clean worktree):
- `npx tsc --noEmit`: exit 0, **0 errors**.
- `npx vitest run`: **Test Files 108 passed (108), Tests 923 passed (923)**.
- `node scripts/smoke-window-station.js`: exit 0, 31 PASS, VERDICT: PASS.
- `node scripts/smoke-programlog-popout.js`: **exit 1, already failing on 9d2e187.** After 6 PASS lines it throws
  `ReferenceError: _popoutWins is not defined` at `openPopoutWindow (eval …smoke-programlog-popout.js:84:13)`.

**After** (`c0e83fb`):
- `npx tsc --noEmit`: exit 0, **0 errors**.
- `npx vitest run`: **Test Files 113 passed (113), Tests 965 passed (965)**: +5 files, +42 tests, all in
  `src/modules/proof`.
- `node scripts/smoke-window-station.js`: exit 0, 44 PASS, 0 FAIL, VERDICT: PASS.
- `node scripts/smoke-programlog-popout.js`: exit 1, **output byte-identical to the base run.** It is the same
  pre-existing ReferenceError, not caused by this work.
- The proof suite ran three times, 42/42 each.

**The pre-commit hook:** `.githooks/pre-commit` → `scripts/verify-transformer-chain.js` ran on each commit.
- It opens this machine's profile DB **read-only** (`new Database(dbPath, { readonly: true })`) to check the
  migration chain. Result: "v2 → v62, 62 migrations … Fresh-install chain run: v0-baseline + v1–v62 clean."
- Nothing in this work writes any database.

---

## 3. Removed, and what replaced each (Jeff's rule: list everything removed)

Each was checked by grep before deletion. After it, `tsc` is clean, so nothing imported any of it.

| Removed | Verified dead / invisible because | Replaced by |
|---|---|---|
| `src/canvas/` (1,262 lines): `CanvasEngine.tsx`, `WidgetCanvas.tsx`, `WidgetRegistry.ts`, `widgets/DeckWidget.tsx`, `widgets/Widgets.tsx` | The only importer was App.tsx. Nothing sets `useCanvas` true (`setUseCanvas` had no caller). | Nothing user-visible. The module registry is its successor (decision 2). |
| `LiveAssistPage.tsx` (repo root, Tauri era, 160 lines) | Imported by nothing; it lives outside `src`, so it is not even compiled. | Nothing. |
| App.tsx `useCanvasEngine()` and the `useCanvas` state | Canvas wiring, unreachable. | Nothing. |
| App.tsx `{useCanvas ? <WidgetCanvasLive/> : <LivePanel/>}` and the `WidgetCanvasLive` function | The branch was never taken. | `<LivePanel>` renders unconditionally, as it always did in practice. |
| App.tsx `file:save` → `canvasEngine.saveCurrentLayout(...)` | It saved a layout no screen shows. | Nothing. |
| App.tsx `file:new-session` → `canvasEngine.resetLayout()` | It reset an invisible layout. | `file:new-session` keeps its visible half, `setPanel("live")` (`App.tsx:1242`). |
| electron/main.js **File → Save Layout** (Ctrl+S) | Its only job was the canvas save. With that gone it had no purpose, so it is **removed, not repurposed**. | Nothing. (File → New Session stays: it still returns to the live panel.) |
| App.tsx ☰ **Reset Layout** button and `resetLayout()` | It only reset the invisible canvas. With that gone it had no purpose, so it is **removed, not repurposed**. | Nothing. The shortcut overlay line now reads "≡ Menu: Theme Studio". |
| App.tsx `CartWallPanel` (the localStorage wall, `ether_carts_v1`) and `{panel === "cartwall" && …}` | Its only route was `nav:cartwall`, and **no menu sends `nav:cartwall`** (grep of electron/ and src/: the only occurrence was the receiving map). LivePanel's `onOpenCarts` was destructured and never called. The ☰ "Carts" entry opens the `carts` pop-out (BoutiqueCartWall). | Nothing. The real wall (cart_slots, BoutiqueCartWall) is untouched. |
| App.tsx `"cartwall"` in `type Panel`, the `"nav:cartwall"` route, LivePanel's `onOpenCarts` prop | They only served the above. | Nothing. |
| `healthData.ts` comment citing `src/canvas/widgets/Widgets.tsx:18` | It pointed at a deleted file. | It now cites App.tsx's addToQueue (same pattern). |

**Left alone:**
- the `canvas_*` rows in `station_config_kv` (decision 6);
- `scripts/migrate-kv-phase3c.js`'s mention of them;
- `visiblePanels.cartwall`, a separate visibility key.

**Now unused, NOT deleted** (out of scope; one line each):
- `src/components/PodcastMode.tsx` and `src/components/OnAirDeck.tsx` were imported only by the canvas. Jeff's call.

---

## 4. Architecture compliance (receipts)

- **The registry and the frame match the plan.**
  - Design §2.1, "a module is the real component, registered": every component is imported from its own file.
    S4 enforces this statically and forbids components under `src/modules`.
  - The frame gives station, instance id and options, and nothing else.
- **One station per layout, never guessed.** Design §2.3 and decision 1 (option (a)):
  - `ModuleSurface` takes one station;
  - `ModuleFrame` has no station prop and throws without a surface;
  - `useActiveStation` reads the scope first and the global station only outside a scope;
  - the engine is resolved by id under the scope;
  - no `?? 1` in `src/modules` (the smoke).
- **Two of the same.** Design §2.4:
  - Carts hotkeys go to the focused module only, and the fire has its own in-flight guard.
  - **Not built:** clash-checked hotkeys per bank at layout save. Layouts don't exist yet.
  - Program Log and Library are documented per §2.4 (see §1.4 above).
- **Help and empty state.** Design §2.7: a help doc and an empty state per module, enforced by S4.
- **One path, two doors.** Design §2.8:
  - Library actions are moved, not copied (`libraryWindowActions.ts`).
  - Carts and Program Log modules call exactly what their component calls (S1, S2).
  - **Not built:** the `cart:fire` command-service extraction (§2.8 "first extraction"). Phase 1's parity is
    proved on the component's own fire path, which both doors share.
- **The canvas is deleted.** Design §2.9 and decision 2. Every removal is listed in §3, `canvas_*` rows kept
  (decision 6).
- **The page lists are frozen.** Design §3 S5: four lists frozen, ratchet only shrinks.
- **CLAUDE.md:**
  - BUILD THE SENSE: each module rides its component's existing console lines and health events. Nothing new was
    needed: no watcher, no poller, no scheduled task was created.
  - DOORS BEFORE ROOMS: help docs plus the existing ☰ doors.
  - Never write the live DB: nothing does.

**Where the code met the plan, and what I did:**
- **The plan's S1–S3 say "vitest + jsdom"; the tree has no jsdom.** I built the minimal DOM rather than install
  (installs forbidden). The proofs render the real components through `react-dom/client`.
- **Plan §2.6 says LibraryPanel moves out of App.tsx.** Jeff allowed that only as a pure move, and it is not one
  (§1.3). It is imported from App.tsx.

---

## 5. Findings (noted, not fixed: outside the scope)

1. **The Library window's Q (add to queue) reaches nothing, in the code.**
   - `useLibraryWindowActions().onQueue` (moved unchanged from `PopoutLibrary`) calls `(eng as any).enqueue?.(...)`.
   - `AudioEngine` has no `enqueue`. It has `queueEnqueue` (`src/audio/engine-rodio.ts:630`) and `addToQueue`.
   - So the optional call is skipped and no bridge call is made. S3 records this (`expect(fromPage.queue).toEqual([])`)
     so a fix updates the test on purpose.
   - **Runtime: UNVERIFIED.** The module inherits the same behaviour, by parity.
2. **The dashboard's Library and the Library window use different load paths.**
   - App.tsx `loadDeck`: resolves the R2/local path, refuses an on-air deck, shows a load message, auto-cues.
   - The Library window: `deck:cue` with the raw `file_path`.
   - The module follows the window (it is a window-style surface). Which one should be canonical is Jeff's call.
3. **Removing File → Save Layout's Ctrl+S accelerator may hand Ctrl+S to the window's single-key handler.**
   - App.tsx's `KeyS` → Schedule/Clocks (`App.tsx` handleKey) does not check modifiers.
   - Whether Electron already delivered Ctrl+S to the page while the accelerator existed is **UNVERIFIED**.
4. **A cart-type deck slot beside the push-up strip.** The main window can hold two cart walls: the push-up strip
   and a deck slot typed Cart (`FaderSection.tsx:395`).
   - Before: one key fired the cart on both (in the code).
   - Now: one fires, the last clicked, else the most recently mounted.
   - This is the intended fix, but it changes that install's behaviour. **UNVERIFIED** at runtime.

---

## 6. UNVERIFIED, and the one check for Jeff

**Nothing here was launched.** Every runtime statement above is from the code and the in-test DOM. The only valid UI
test is launching the app (CLAUDE.md).

**The check:** build this branch locally and launch it. Then:
1. Open **☰ → Carts**. Press **1** without clicking: the cart fires. Press **1** again: it stops.
2. On the main window, with the CARTS push-up open, press **1**: it fires once.
3. Open **☰ → Library**: A / B / C cue the deck. Check whether Q does anything (finding 1).
4. Open **☰ → Program Log**: delete a row in the hour editor, and see it vanish in the docked log too.
5. Confirm the ☰ menu has no "Reset Layout", and File has no "Save Layout".
6. Press **Ctrl+S** on the main window and note what happens (finding 3).

There is no screen yet where a module is placed: the builder window is the next phase.

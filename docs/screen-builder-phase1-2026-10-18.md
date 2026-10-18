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
- this report (`e1614aa`).

**Second pass** (Jeff's rulings on the three findings, same day; §7):
- `d6befc1`: single-key shortcuts ignore Ctrl/Alt/Meta, in every handler.
- `3b0490e`: one Library load/queue path for all three surfaces; never load over a deck on air; Q is the real
  enqueue.
- this report's update.

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
| `library` (`:80`) | `LibraryWindow` (`src/components/LibraryWindow.tsx`): the Library window, i.e. `LibraryPanel` from App.tsx with the Library's one action set (§7.2) | many | none | `docs/help-module-library.md` | "Import audio to add items to the library." |

**`LibraryPanel` was not lifted out of App.tsx.** It is ~1,500 lines leaning on App.tsx helpers, and Jeff allowed
the lift only as a pure move. It is imported from App.tsx, as `PopoutRenderer.tsx:17` does.

**What was moved (first pass):** the Library window's actions, unchanged, from `PopoutRenderer`'s `PopoutLibrary` into
`src/lib/libraryWindowActions.ts`.

**Superseded in the second pass (§7.2):**
- `PopoutLibrary` moved out to `src/components/LibraryWindow.tsx`. It is now both the Library window and the module.
- `libraryWindowActions.ts` was removed. The main window, the Library window and the module all call
  `src/lib/libraryDeckActions.tsx`.
- The registry's `useBoundProps` / `scroll` fields went with it.

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
| S3 | `library.proof.test.tsx` | **All three Library surfaces match** (second pass, §7.2): the main window's Library, the Library window (`PopoutRenderer panel="library"`) and the module. With a deck idle or cued, Load A is the identical sequence `invoke("audio:resolve-local-path")` → `audio.load` (in-process) or `audio.daemon("deck:cue")` (daemon). Q is `audio.daemon("queue:enqueue", {stationId: 2, items: [song]})` (daemon) or the engine queue (in-process). With a deck playing or paused: nothing is sent, and the refusal shows. |
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
  - Library actions are moved, not copied: one module, `src/lib/libraryDeckActions.tsx`, called by all three
    surfaces (§7.2).
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

## 5. Findings (first pass). Jeff ruled on 1–3 the same day: see §7

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

**Second-pass checks:** see §7.5.

---

## 7. Second pass: Jeff's rulings on findings 1–3 (2026-10-18)

### 7.1 Single-key shortcuts ignore Ctrl / Alt / Meta (finding 3)
**Jeff:** "Single-key shortcuts must ignore any key pressed with Ctrl/Alt/Meta. Find every single-key shortcut
handler."

**What 6558e57 did, in the code.** These facts are from the coordinator; I confirmed the handler:
- App's `handleKey` checked no modifier, and no menu item claims Ctrl+A.
- So Ctrl+A toggled automation like A, and Ctrl+L / Ctrl+S / Ctrl+G opened Library / Clocks / Logs.
- **Runtime: UNVERIFIED** (nobody pressed them).

**The fix.**
- **One helper: `src/lib/plainKey.ts` `isPlainKey(e)`** means no Ctrl, Alt or Meta.
  - Shift is allowed: Shift+/ and Shift-for-a-bigger/finer-step are deliberate.
  - AltGr (Ctrl+Alt on Windows) never fires a shortcut.
- **App's keys go through a pure mapping**, `src/lib/appShortcuts.ts` `appShortcut(e)`, which returns null
  for any modified key. App dispatches on it (`App.tsx:2053`).
- **No Save Layout item was re-added** to swallow Ctrl+S. The guard is the fix.

**Every single-key handler found, and its guard** (file:line of the guard):

| Window | Handler | Keys | Guard |
|---|---|---|---|
| main | App.tsx `handleKey` | L, S, G, A, Shift+/, Esc | `App.tsx:2053` → `appShortcuts.ts` |
| main | App.tsx metadata dropdown list | Esc, ↑, ↓, Enter | `App.tsx:4557` |
| main + pop-outs | the cart wall (`DeckConfigurator.tsx`) | 1–8, Q–I, A–K | `DeckConfigurator.tsx:894` |
| main | KeyboardHelp | Shift+/, Esc | `KeyboardHelp.tsx:9` |
| main | macro hotkeys (`useMacroHotkeys`) | any stored single key | `MacroEngine.tsx:189` |
| any with a fader | fader arrow keys (`useFaderControl`) | ←↑→↓ (Shift = fine) | `useFaderControl.ts:74` |
| Broadcast Editor | C, J, S, Space, Delete, Esc | (Ctrl+Z/Y kept) | `BroadcastEditor.tsx:607` |
| Phone Desk recorder | Space, ←, →, Delete | (Ctrl+Z kept, moved up) | `PhoneDesk.tsx:880` |
| Producer Desk window | Delete / Backspace | (Ctrl+C/V kept) | `ProducerDeskWindow.tsx:135` |
| Reel Splitter | Space, ←, →, Delete | | `ReelSplitter.tsx:94` |
| Show+ scene switcher | 1–9 | (already guarded, now via the helper) | `ShowPlus.tsx:1031` |
| Show+ DAW (StudioPro) | Space, S, Home, End, comma, period, backslash, Z, +/-, 1–9, M, ?, V/G/C/T/F, Delete | (already guarded, now via the helper; Ctrl combos kept) | `StudioPro.tsx:1694` |
| Cue editor (TrackEditor) | Space (window + editor) | | `TrackEditor.tsx:625`, `:1059` |
| Take editor | Space, ←→, Q, brackets, K, M, Delete | (Ctrl combos moved up) | `TakeEditor.tsx:128` |
| Voice Tracker | Space, ←→, Q, brackets, K, M, Delete | (Ctrl combos kept) | `VoiceTracker.tsx:837` |
| Video canvas | ←↑→↓ (Shift = bigger) | | `VideoEngineCanvas.tsx:449` |
| User login (PIN) | 0–9, Backspace, Esc | | `UserLogin.tsx:101` |

**Not shortcut handlers (left as they are):**
- Esc-only menu dismissers: App.tsx metadata popover, DebugPanel, the cart menu, FloatingWindow, fileLocation,
  songActions.
- Ctrl/Cmd-only handlers: ClocksTab copy/paste, ProducerDesk / ProducerDeskWindow Ctrl+S.
- Text-box Enter/Escape handlers.
- The macro hotkey RECORDER (it records the key; it acts on nothing).
- The Program Log, PopoutRenderer and the Jukebox have no single-key handler. Jukebox has only Enter in its search box.

**Tests.**
- **`src/lib/plainKey.test.ts`:**
  - `isPlainKey`;
  - `appShortcut`: Ctrl+S and Ctrl+A do nothing; Ctrl/Alt/Meta (and Ctrl+Shift, Ctrl+Alt) + every dashboard key
    does nothing; plain keys do what they did; Shift+/ still toggles the sheet;
  - App dispatches on `appShortcut`;
  - **a static check over every keydown handler in src/** (window/document/element listeners, JSX
    `onKeyDown`, `onKeyDown` definitions). Any handler testing a single key without a Ctrl/Meta requirement on
    that line must call `isPlainKey` (or `appShortcut`) before it.
  - Mutation-checked: removing the ReelSplitter and UserLogin guards fails it, naming both lines.
- **`src/lib/plainKey.behaviour.test.tsx`**, through the real components:
  - the Carts page: each of the 24 cart keys × Ctrl/Alt/Meta fires nothing, and plain 1 fires;
  - KeyboardHelp;
  - macro hotkeys (Ctrl/Alt/Meta+M runs nothing, M runs);
  - a fader (modified arrows move nothing, plain and Shift arrows step).
- **The other handlers' behaviour is proved by the static check only.** StudioPro, VoiceTracker, BroadcastEditor,
  PhoneDesk, ReelSplitter, the Show+ scenes, TrackEditor, TakeEditor, UserLogin, the video canvas, the Producer
  Desk and the dropdown are not mounted.
- **Two existing tests follow the mapping into `appShortcuts.ts`:** `deckKeys.test.ts` and
  `shortcutList.test.ts`. The no-Space/B/X assertions still hold, now on both files.

**Docs.**
- `docs/help-keyboard-shortcuts.md` (new);
- `help-module-carts.md` and `help-reel-splitter.md`;
- the in-app shortcut sheet gains "Ctrl / Alt / ⌘ + key — Not a shortcut — does nothing".

### 7.2 Library Q wired to the real enqueue (finding 1), and one load path (finding 2 / Jeff's ruling 3)
**Jeff:** "wire it to the real queueEnqueue in the Library window AND the module. No dead buttons kept for parity."
And: "refuse to load over a deck that is on air, everywhere (main window Library, Library window, module). Test it."

**The real enqueue path, verified by grep:**
1. `engine-rodio.ts:630` `queueEnqueue(items)` → `daemonCmd("queue:enqueue", { stationId, items })` →
   `window.ether.audio.daemon`.
2. `electron/preload.js:127` `daemon: (cmd, args) => ipcRenderer.invoke("audio:daemon", cmd, args)`.
3. `electron/main.js:7201` `ipcMain.handle("audio:daemon", …)` → `audiodClient.cmd(cmd, args)`.
4. `audiod/ether-audiod.js:775` `"queue:enqueue": (m) => getEngine(m.stationId).intentEnqueue(m.items)`.
5. `audiod/engine.js:1945` `intentEnqueue(items) { this.addToQueue(items) }`.

The handler answers "audio daemon disabled" when the daemon is off. So in-process mode uses the engine's own queue
(`engine.addToQueue`), the same split the web remote's `queue:enqueue` uses (`App.tsx` execCmd).

**One path: `src/lib/libraryDeckActions.tsx`.** It is a pure move of App.tsx's `loadDeck` / `addToQueue`, made the rule:
- **`deckOnAir` (`:35`):** playing or paused, as the engine reports the deck.
- **`onAirRefusal` (`:41`):** "Deck A is on air — "…" was not loaded. Stop deck A first."
- **`loadSongToDeck` (`:68`):** the on-air check before the resolve (`:73`) and again after it (`:89`), since the
  resolve can take a cloud round trip. Then the R2/local resolve, then `deckCue` (daemon) or `loadToDeck`
  (in-process), then the auto-cue.
- **`enqueueSong` (`:102`):** `queueEnqueue` (daemon) or `addToQueue` (in-process), in the dashboard's item shape.
- **`libraryDeckActions` (`:115`):** the LibraryPanel props for every surface.
- **`DeckLoadNoticeBar` (`:126`):** the dashboard's toast, moved.

**Who calls it:**
- **Main window:** `App.tsx:2507` `libActions = libraryDeckActions({ engine: () => getEngine(stationId), … })`,
  used by both LibraryPanels (`:3168` dock, `:3174` panel). Its toast is `<DeckLoadNoticeBar>` (`:3363`).
- **Library window and module:** `src/components/LibraryWindow.tsx` (PopoutLibrary moved out, a pure move plus the
  notice). PopoutRenderer `case "library"` renders it (`:218`), and the registry's library entry is it
  (`registry.ts:80`).

**Tests** (`library.proof.test.tsx`, 15 tests):
- With A, B or C playing or paused: Load from main, page and module sends nothing to the engine, not even the
  resolve, and shows the refusal.
- Idle or cued (a file loaded, not playing), in-process and daemon: the identical sequence from all three.
- Q, daemon: identical `audio.daemon("queue:enqueue", …)` from all three.
- Q, in-process: the song is on the engine queue from all three.
- S7 (station 3 module).
- A static check that App.tsx wires both LibraryPanels to `libraryDeckActions`.
- **Mutation-checked:** on-air reduced to playing-only fails the three paused cases; Q reverted off `queueEnqueue`
  fails the daemon Q test.
- **The "main" surface is not App itself.** It is App's own `libraryDeckActions` call in a small test component;
  the static check holds App.tsx to that exact call. App was not mounted, because it is the whole app behind the
  account gate.

**Docs:** `docs/help-module-library.md` (Q works; on-air refusal; troubleshooting line).

### 7.3 Removed, or changed in behaviour (Jeff's rule)

**Removed:**
- `src/lib/libraryWindowActions.ts`, replaced by `src/lib/libraryDeckActions.tsx`.
- PopoutRenderer's `PopoutLibrary`, moved to `src/components/LibraryWindow.tsx`.
- App.tsx's `loadDeck`, `loadA/B/C` and `addToQueue` (moved), and its inline toast (moved).
- The registry's `useBoundProps` / `scroll` fields.

**Changed in behaviour** (from the code; runtime UNVERIFIED):
1. **Ctrl / Alt / Meta + any single-key shortcut now does nothing, in every handler above.** Before:
   - Ctrl+A toggled automation; Ctrl+L / Ctrl+S / Ctrl+G opened screens;
   - Ctrl/Alt+1 fired a cart; Ctrl+M ran an M macro;
   - Ctrl+Space played in the cue editor, Reel Splitter, Voice Tracker and phone recorder;
   - Ctrl+arrow stepped a fader;
   - Ctrl+digit entered a PIN digit;
   - Ctrl+Esc closed the shortcut sheet and drawer.
2. **Paused decks are now refused.** Before, the main window's Library loaded over a **paused** deck, and refused a
   playing one silently. Now both are refused, with the message.
3. **The Library window now refuses on-air decks.** Before, it never checked and cued over a playing deck.
4. **The Library window now uses the dashboard's load path.** Before, it cued with the raw file path through the
   daemon only (in-process mode answers "audio daemon disabled"). Now it resolves local-first → R2 and works in both
   modes.
5. **The Library window's Q now queues.** Before, it sent nothing.
6. **The main window's Q now sends `queue:enqueue` in daemon mode.** Before, it sent the legacy `enqueue` command.
   Both run the daemon's `addToQueue` (`ether-audiod.js:688` vs `:775` → `engine.js:1945`).
7. **The Library window shows the dashboard's load notices** ("Loading … onto A…", the refusal, a failed resolve).
   Before, it showed none.

### 7.4 Gates (second pass)
- `npx tsc --noEmit`: exit 0, **0 errors**.
- `npx vitest run`: **Test Files 115 passed (115), Tests 989 passed (989)**.
  - After the shortcut commit alone: 115 / 978.
- `node scripts/smoke-window-station.js`: exit 0, 45 PASS, VERDICT: PASS. Section 3 now also covers
  `LibraryWindow.tsx` and `libraryDeckActions.tsx`.
- `node scripts/smoke-programlog-popout.js`: exit 1, output identical to the base `9d2e187` run. It is the same
  pre-existing `_popoutWins` ReferenceError.

### 7.5 UNVERIFIED, and the check for Jeff
Nothing was launched. Build this branch locally and launch it. Then:
1. **On the main window, outside any text box:**
   - Press **Ctrl+S**: nothing happens. Press **S**: Clocks opens.
   - Press **Ctrl+A**: AUTO does not change. Press **A**: AUTO toggles.
2. **Open ☰ → Carts:** press **Ctrl+1**: nothing fires. Press **1**: it fires.
3. **Open ☰ → Library and press Q on a song:** it appears in Up Next.
4. **Play deck A, then press A on a song** in ☰ → Library and in the main window's Library. Both show "Deck A is on
   air — … was not loaded. Stop deck A first." and the deck is untouched.
5. **Pause deck A and press A again:** the same refusal.
6. **With deck A stopped, press A:** the song cues, the same as from the main window.

**Noticed, not touched (one line):** the shortcut sheets list keys the handler does not have. App's sheet has
"N — Live Assist view" and "G — Program Log", though G opens the Play Log. KeyboardHelp lists N / F1–F4 / F10 / F12.

---

## 8. Third pass: the surface window and saved layouts (Jeff, 2026-10-18, deadline 2:05 PM)

**Jeff:** "finish what lets me build and use a surface myself: open a new surface, place Carts, Program Log and
Library modules in dockview, arrange and size them, save it as a layout, and reopen it. … only what passes its parity
tests goes in."

### 8.1 Commits
- `d10128b`: Jeff's `06bec99` (v63, scheduler branch), cherry-picked so this branch's migration chain stays
  contiguous.
  - **One conflict, resolved by dropping the file:** `06bec99` renames `scripts/lib/log-checker.test.js`, which
    this branch never had. The scheduler branch keeps it at the merge.
  - Everything else applied cleanly.
- `daccda7`: `screen_layouts` (v64). The migration, the sync registry entry and the handler.
- `0ec31e5`: the surface window, the ☰ door, the payload format, the tests and the help doc.

### 8.2 In
- **The surface window:** `src/components/ScreenSurface.tsx`.
  - **The door:** ☰ → **Screens** (one entry) opens pop-out `screen`. A saved screen opens as `screen:<uuid>`, one
    window per layout, each with its own bounds in `popout-bounds.json`. **NEW SCREEN** opens `screen:new-<time>`.
  - **Panes:** dockview, with every pane a `ModuleFrame` under the window's one `ModuleSurface`. The station is the
    one active when the window opened, and the window keeps it.
  - **EDIT:** the palette (only the registered modules: Carts, Program Log, Song Library; several of each, as
    the registry allows). New panes split to the right; drag, tab, split, size and close.
  - **LIVE:** `disableDnd` and `locked`, and tabs without a close button.
  - **Empty state:** "An empty screen — press EDIT, then add …".
- **Layouts as data.**
  - **The table:** v64 `screen_layouts` (`scripts/migrate-screen-layouts-phase-sync-64.js`), registered station-scoped
    in `electron/sync/synced-tables.js`. Its `station_id` is what the sync engine remaps; `station_uuid` is the
    layout's station by identity.
  - **The handler:** `electron/sync/handlers/screen_layouts.js`, installed in `handlers/index.js`. Channels
    `screen_layouts:list|get|save|delete`, every write through `withMutation`.
    - The renderer reaches them through the generic `ether.invoke` (`preload.js:554`), so no preload change was
      needed.
  - **The payload:** `src/modules/layoutPayload.ts`, `{ v: 1, dockview, panes }`. On restore the panes map is the
    authority, and unknown types are dropped.
- **S5:** the baseline gains popout case `screen` and ☰ `po-screens → screen`, recorded on purpose with the reason in
  its `_additions` field. All S5 checks still pass.
- **Help:** `docs/help-screen-builder.md`.

### 8.3 Tests (`src/modules/proof/screens.proof.test.tsx`, 9 tests; real dockview in the test DOM)
- **Real components:** placing Carts, Program Log and Library renders the real components (the cart wall's header,
  the log's Fill Day, the library row). The registry's component is `BoutiqueCartWall` itself.
- **EDIT / LIVE:** the palette shows in EDIT and is gone in LIVE.
- **Parity inside a surface:**
  - S1: a cart fired from a surface pane makes the identical calls to the Carts page.
  - S3: Load A and Q from a surface pane make the identical calls to the Library window (daemon `deck:cue`,
    `queue:enqueue`).
  - S2: a surface Program Log and the Program Log page each re-read once on one `schedule:changed`, on station 2.
- **The round trip.** Build a screen in the UI (3 modules), then SAVE through the dialog. The real handler writes a
  real SQLite table created by the real v64 migration: one `insert` mutation, the row on station 2 with its uuid.
  - Then give the row real grid sizes and a non-default option (cart wall `strip`).
  - Reopen `screen:<uuid>`. The window is in LIVE, and the carts pane is restored in strip layout.
  - **dockview's `fromJSON` receives exactly the saved grid sizes, width and panels.**
  - SAVE again: an `update` with identical panes and panels.
- **S7:**
  - Station B's window shows "That screen is not saved on this station." for A's uuid.
  - B's OPEN… list is empty.
  - Every layout call carries station 3.
  - The handler refuses to save over A's uuid from B.
  - Mutation-checked: removing the handler's station check fails this test.
- **The migration:** every column; `schema_version` = 64; idempotent; transformer passes through. The registry entry
  matches the columns.
- **The pre-commit hook** (`verify-transformer-chain.js`, on the live profile DB read-only) reported:
  "Fresh-install chain run: v0-baseline + v1–v64 clean", 64 migrations, no gaps.

### 8.4 Gates
- `npx tsc --noEmit`: exit 0, **0 errors**.
- `npx vitest run`: **Test Files 116 passed (116), Tests 998 passed (998)**.
- `node scripts/smoke-window-station.js`: exit 0, 47 PASS, 0 FAIL, VERDICT: PASS.

### 8.5 Out (not built, or not provable here)
- **Per-user layouts from the window.** The table, the registry and the handler's `list` all support
  `owner_user_uuid`. But a pop-out window does not know the signed-in in-app profile, so the surface saves shared
  layouts (`owner_user_uuid` NULL).
- **Delete / rename from the window.** The `screen_layouts:delete` handler exists; there is no button.
- **An options sheet per pane.** Options are saved and restored, but not editable in the UI.
- **Clash-checked cart hotkeys at save** (design S6, second half).
- **Export / import `.etherscreen.json`.**
- **The Schedule Manager's layout moving into `screen_layouts`.**

### 8.6 Removed or changed in behaviour
- **Nothing removed.**
- **Added:** ☰ gains a **Screens** row.
- **Changed:** in `main.js`:
  - pop-out windows keyed `screen:<uuid>` open at the screen size;
  - `screen:new-<time>` windows are destroyed on close instead of hidden.
  - Every other pop-out is unchanged.

### 8.7 UNVERIFIED, and the check for Jeff
**What is not proven:**
- **Sizes in a real window.** In the test DOM every element is 0 px, so dockview re-divides the grid after
  restoring. The test proves dockview is handed the exact saved sizes. Whether a real window keeps them is a
  launch check.
- **Sync of the rows:** the sync of `screen_layouts` rows to a second install is not exercised (S8 needs the sync
  harness, which is `npm run test:sync`, not run here).

**The check:** build this branch locally and launch it. Then:
1. ☰ → **Screens**, and place **Carts**, **Program Log** and **Song Library**.
2. Drag the dividers to size them, and tab two of them together.
3. **SAVE** it as "Test".
4. Close the window, open ☰ → Screens → **OPEN…** → **Test**, and confirm the same panes at the same sizes, in LIVE.
5. In LIVE, fire a cart and load a song. Then switch the main window to another station and confirm the screen
   still shows and works on its own station.

# Native menu audit — every item, its channel, its handler

**Date:** 2026-08-17 · **Report:** Jeff — "every item in the native menu bar (File/View/Library/
Schedule/Tools/Help) is present but dead: clicks do nothing." · **Scope of the report:** which windows
is still to be confirmed; see §4.

Read-only tracing first, as ordered. Fixes in §5.

---

## 1 · How the menu is wired

| Piece | Where |
|---|---|
| Template built | `electron/main.js:2573` `buildMenu()` |
| Installed | `electron/main.js:2709` `Menu.setApplicationMenu(...)`, called once from `createWindow` (`:3196`) |
| Rebuild hook | `electron/main.js:2715` `ipcMain.handle('menu:rebuild')` |
| **Every renderer-facing item** | `electron/main.js:2574-2577` — one helper: `send(cmd)` → `BrowserWindow.getFocusedWindow() \|\| mainWindow` → `webContents.send("menu-action", cmd)` |
| Bridge | `electron/preload.js:404-412` — generic `on/off`, **no channel allowlist**, so `menu-action` passes |
| Receiver | `src/App.tsx:1037-1075` — one listener, one `cmd` switch, registered in `App()` (`:539`) with no early return above it |

So there is exactly **one** channel (`menu-action`) and **one** receiver. That single shared link is
what makes an all-items-dead symptom possible, and it is where the two structural defects below live.

Items that do **not** use `send()` run entirely in the main process and are therefore
focus-independent: Sign Out (`accountSignOut`, `main.js:1142`), Quit (`fullStopAndQuit`, `:3885`),
Reload, Toggle DevTools, Documentation, and every **Monitors ▸** entry (`popout()`).

## 2 · The table — every item → channel → status

Legend: **WIRED** = channel has a live handler and its target renders · **DEAD** = reaches nothing the
operator can see · **MAIN-ONLY** = works, but only while the main window has focus (see §3.1).

### File
| Item | Channel / call | Status |
|---|---|---|
| New Session | `file:new-session` | WIRED (`App.tsx:1054`) · MAIN-ONLY |
| Save Layout | `file:save` | WIRED (`App.tsx:1053`) · MAIN-ONLY |
| Import Music… | `file:import` | WIRED (`App.tsx:1051`) · MAIN-ONLY |
| Preferences | `file:preferences` | WIRED (`App.tsx:1052`) · MAIN-ONLY |
| Sign Out | `accountSignOut()` main-process | WIRED (`main.js:1142`) — focus-independent |
| Quit Ether | `fullStopAndQuit()` main-process | WIRED (`main.js:3885`) — focus-independent |

Note: **Switch Account is already gone** (removed 4.4.216), and the dead `account:switch` branch in
`App.tsx` is documented as unreachable. Nothing in the menu still points at it — the "dead item still
pointing at removed Switch Account" suspect is **not** present.

### View
| Item | Channel / call | Status |
|---|---|---|
| Play Queue · Deck A · Deck B · Deck C · Mic Deck | `view:queue` / `view:deckA` / `view:deckB` / `view:deckC` / `view:mic` | WIRED (`App.tsx:1057-1061`) · MAIN-ONLY |
| Configure Decks… | `view:configure-decks` | WIRED (`App.tsx:1055`) · MAIN-ONLY |
| Reset to Default | `view:reset` | WIRED (`App.tsx:1056`) · MAIN-ONLY |
| Reload | `mainWindow.webContents.reload()` | WIRED — always the MAIN window, by design |
| Toggle DevTools (F12 / Ctrl+Shift+I) | focused window | WIRED — **deliberately** the focused window (`main.js:2637-2640`: F12 in a pop-out used to open the dashboard's DevTools) |

### Library
| Item | Channel | Status |
|---|---|---|
| Library | `nav:library` | WIRED · MAIN-ONLY |
| Spots & Promos | `nav:spots` | WIRED · MAIN-ONLY |
| Voice Tracker | `nav:voicetrack` | WIRED · MAIN-ONLY |
| Import from Folder… | `file:import` | WIRED · MAIN-ONLY |
| Cue Editor | `nav:trackedit` | WIRED · MAIN-ONLY |

### Schedule
| Item | Channel | Status |
|---|---|---|
| Clocks / Shows & Dayparts / Categories | `nav:clocks` + `nav:scheduler-tab:{clocks,shows,categories}` | WIRED (`App.tsx:1048-1050`) · MAIN-ONLY |
| Program Log | `nav:programlog` | WIRED (`App.tsx:1044-1047`) · MAIN-ONLY |
| Play Log | `nav:logs` | WIRED · MAIN-ONLY |
| Rotation Analytics | `nav:rotation` | WIRED · MAIN-ONLY |
| Schedule Manager | `nav:schedulehub` | WIRED · MAIN-ONLY |
| Announcements | `nav:announce` | WIRED · MAIN-ONLY |
| EAS Logbook | `nav:eas` | WIRED · MAIN-ONLY |

### Tools
| Item | Channel | Status |
|---|---|---|
| Voice Tracker | `nav:voicetrack` | WIRED · MAIN-ONLY |
| **Show+ DAW** | `nav:studio` → `setPanel("studio")` | **DEAD** — see §3.2 |
| Show+ | `nav:videostudio` | WIRED (renders at `App.tsx:2805-2806`) · MAIN-ONLY |
| Cue Editor · Clip Editor | `nav:trackedit` · `nav:clipeditor` | WIRED · MAIN-ONLY |
| Import Library… | `nav:importlibrary` | WIRED · MAIN-ONLY |
| Stream Manager · Smart Scheduler · Listener Analytics · Cloud Log Backup · Audio Routing · Station Manager | `nav:streaming` · `nav:smartschedule` · `nav:analytics` · `nav:cloudbackup` · `nav:multioutput` · `nav:stationmanager` | WIRED · MAIN-ONLY |
| System Health | `nav:health` | WIRED · MAIN-ONLY |
| Monitors ▸ Decks / Show+ / Queue / Station Health / Mic / Master Output / Phone Desk / Voice Tracker | `popout(<panel>)` | WIRED — focus-independent |
| **Monitors ▸ Camera** | `popout("camera")` | **DEAD** — see §3.3 |

### Help
| Item | Channel | Status |
|---|---|---|
| Keyboard Shortcuts | `help:shortcuts` | WIRED (`App.tsx:1062`) · MAIN-ONLY |
| Documentation | `shell.openExternal` | WIRED — focus-independent |
| Check for Updates | `help:check-updates` | WIRED (`App.tsx:1063`) · MAIN-ONLY |
| About Ether | `nav:about` | WIRED (`App.tsx:1064`) · MAIN-ONLY |

## 3 · The defects

### 3.1 · Every `send()` item is dead whenever a pop-out has focus — the whole menu, every menu

`send()` targets `BrowserWindow.getFocusedWindow()` (`main.js:2574-2576`). Pop-outs are ordinary
framed `BrowserWindow`s (`main.js:5138-5152`, `frame: true`), so on Windows **they display the full
application menu bar** — File, View, Library, Schedule, Tools, Help, all of it.

But a pop-out renders `<PopoutRenderer/>`, not `<App/>` (`src/main.tsx:92-96`), and **`PopoutRenderer`
registers no `menu-action` listener** — the only one in the tree is inside `App()`. So the message is
delivered to a window with nobody listening and vanishes.

**Result: click any menu item while a Decks / Mic / Library / Show+ / Jukebox pop-out is focused and
nothing happens — for every item in every menu.** That matches the reported symptom exactly, and it is
Jeff's own suspect #2. This is the dishonest-UI pattern at full size: a complete menu bar, entirely
inert, on every pop-out window.

### 3.2 · Tools ▸ Show+ DAW points at a panel that no longer renders

`nav:studio` → `panels["nav:studio"] = "studio"` → `setPanel("studio")`. `"studio"` is still in the
`Panel` union (`App.tsx:130`) but has **zero render sites**:

```
grep -c 'panel === "studio"' src/App.tsx  →  0
```

Show+ DAW moved to its own pop-out window; `App.tsx:2722` records it: *"Show+ DAW is no longer an
inline takeover — it opens as its own pop-out window (WINDOWS → Show+ DAW / Tools → Show+ DAW →
window:popout 'studiopro')"*. The **drawer** entry was updated; this native menu item was not. It sets
a panel nothing draws, so the click silently does nothing even in the main window. No other caller
sends `setPanel("studio")` — the menu was the only door to a room that no longer exists.

### 3.3 · Tools ▸ Monitors ▸ Camera opens an error window

`popout("camera")` loads `#popout/camera`. `PopoutRenderer` has cases for decks, master, mic, phone,
voicetrack, upnext, health, carts, shows, clocks, categories, calendar, library, studiopro,
videostudio and jukebox — **none for `camera`** — so it falls to `default:` and renders
*"Unknown pop-out panel: camera"*. `POPOUT_SIZES` and `POPOUT_LABELS` both carry a `camera` entry
(`main.js:5117`, `:5133`), which is why it looks supported. The camera lives inside Show+.

## 4 · What is NOT explained, and the one check that settles it

Static tracing shows the main-window path intact for every item except §3.2: one channel, one live
listener, every other target renders. **I could not find a static cause for main-window items being
dead**, and a grep is a claim about the tree, never about the product.

So the report is taken as given and the scope question stands: **were the dead clicks in a pop-out
window, or in the main dashboard?** §3.1 fully explains the pop-out case. If it was the main window,
there is a second cause and the 30-second receipt is:

> Focus the main dashboard, open DevTools (F12), paste
> `window.ether.on("menu-action", c => console.log("MENU:", c))`
> then click File ▸ Preferences.
> **A line appears** → the message arrives and the break is renderer-side (handler/panel).
> **Nothing appears** → the message never reaches the main window and the break is in `send()`/focus.

## 5 · Fixes applied

| # | Fix | Where |
|---|---|---|
| 1 | `send()` routes to the **main window** and shows/focuses it, so every item behaves identically from any window — Jeff's requirement 4, taken as "same behavior as the main window" rather than "no menu". DevTools deliberately still targets the focused window. | `electron/main.js` `buildMenu.send` |
| 2 | Tools ▸ **Show+ DAW** now opens the `studiopro` pop-out — its real home — instead of a panel that does not render | `electron/main.js` Tools submenu |
| 3 | Tools ▸ Monitors ▸ **Camera** REMOVED — no such pop-out panel exists; the camera is inside Show+ | `electron/main.js` Monitors submenu |
| 4 | `"nav:studio"` removed from the renderer's panel map so the dead route cannot be re-used by accident | `src/App.tsx` |

Requirement 3 ("items whose feature no longer exists get REMOVED") applies to exactly one item —
Camera. Show+ DAW still exists, so it is rewired rather than removed. Switch Account was already gone.

**Not changed (flagged, one line):** the native **Monitors** submenu has no **Jukebox** entry, while
the ☰ drawer's Windows list does. Adding it is a one-line parity fix, not a dead item, so it is left
for Jeff's call.

## 6 · Gates

Recorded in the build report: `tsc --noEmit`, `node --check` on `electron/main.js`, and the renderer
build. **Runtime UNVERIFIED** — acceptance is Jeff clicking the menus.

---

## 7 · Routing by source window — the board does not get covered

**Ruling (Jeff, 2026-08-17):** *"Menu actions from a POPOUT must not cover the dashboard. The main
window is the board; the board stays visible."* During a live event — Jukebox up, faders hot — a menu
click from a pop-out that raises the dashboard and buries the decks under a panel is exactly wrong.
This supersedes §5 fix 1, which routed everything to the main window.

### The rule as built

| Clicked from | Behaviour |
|---|---|
| the **main window** | unchanged — the panel opens in the dashboard |
| a **pop-out** | the target opens as **its own pop-out window**; the dashboard is not shown, focused or repainted |
| a pop-out, target already open | that window is **focused, not duplicated** — `openPopoutWindow` dedupes by window title (`main.js` `openPopoutWindow`, `const existing = …getTitle() === tag`) |
| a pop-out, **main-only** target | falls through to the main window (the §5 behaviour), because the action *is* a dashboard action — see the bucket below |

**Receipts — `electron/main.js`, inside `buildMenu()`:**

- `fromPopout()` — focused window exists, is not `mainWindow`, and its title starts with `popout:`
  (the tag `openPopoutWindow` assigns).
- `menuNav(cmd, popoutPanel)` — pop-out source and a stand-alone panel → `openPopoutWindow(panel)`;
  otherwise `send(cmd)`.
- `menuNavTab(tab)` — Schedule ▸ Clocks / Shows & Dayparts / Categories. In the dashboard these fire
  **two** commands (open the Scheduler, then select its tab); as a pop-out each tab is already its own
  panel, so the pair must not fire — two `send`s would open the scheduler *and* raise the dashboard.
- The duplicate pop-out opener that lived inside `buildMenu` is gone; it now delegates to
  `openPopoutWindow`. The copy had drifted — no saved-bounds restore, no jukebox kiosk fullscreen —
  so Monitors ▸ items now also remember their size and position.

### Pop-out-capable targets (22 menu items)

Each renders stand-alone: no props, or an `onClose` the window satisfies by closing itself. New
`#popout/<panel>` routes were added in `src/components/PopoutRenderer.tsx` for the ones that had none.

| Menu item | Pop-out panel | Was it already a pop-out? |
|---|---|---|
| File ▸ Import Music… · Library ▸ Library · Library ▸ Import from Folder… | `library` | yes |
| Library ▸ Spots & Promos | `spots` | **new** |
| Library ▸ Voice Tracker · Tools ▸ Voice Tracker | `voicetrack` | yes |
| Schedule ▸ Clocks / Shows & Dayparts / Categories | `clocks` / `shows` / `categories` | yes |
| Schedule ▸ **Program Log** | `programlog` | **new** |
| Schedule ▸ Play Log | `logs` | **new** |
| Schedule ▸ Rotation Analytics | `rotation` | **new** |
| Schedule ▸ Schedule Manager | `schedulehub` | **new** |
| Schedule ▸ Announcements | `announce` | **new** |
| Schedule ▸ EAS Logbook | `eas` | **new** |
| Tools ▸ Show+ | `videostudio` | yes |
| Tools ▸ Show+ DAW | `studiopro` | yes (§3.2 fix) |
| Tools ▸ Stream Manager | `streaming` | **new** |
| Tools ▸ Smart Scheduler | `smartschedule` | **new** |
| Tools ▸ Listener Analytics | `analytics` | **new** (keeps its `PlanGate`) |
| Tools ▸ Cloud Log Backup | `cloudbackup` | **new** (keeps its `PlanGate`) |
| Tools ▸ Audio Routing | `multioutput` | **new** (keeps its `PlanGate`) |
| Tools ▸ Import Library… | `importlibrary` | **new** |
| Tools ▸ System Health | `health` | yes |
| Tools ▸ Monitors ▸ (all) | their own panels | yes — always were |

### Main-window-only bucket — NAMED, not decided silently

These keep the current behaviour (they raise the dashboard) because **the action is itself a dashboard
action**: asking for it *means* asking for the board. None of them is disabled, because a disabled
File ▸ Save Layout would be a worse lie than one that does the thing.

| Item | Why it cannot stand alone |
|---|---|
| File ▸ New Session · File ▸ Save Layout | They reset/save the **dashboard's** canvas layout (`canvasEngine`). There is no layout in a pop-out to save. |
| View ▸ Play Queue · Deck A · Deck B · Deck C · Mic Deck | They toggle the visibility of panes **inside the dashboard**. |
| View ▸ Configure Decks… | Opens the deck configurator over the dashboard and applies to its deck strip. |
| View ▸ Reset to Default | Restores the dashboard's default pane set. |
| File ▸ Preferences | `SettingsPanel` takes ~10 live props from `<App/>` (xfade, station key, setters). Standing it alone means threading App state into a second window — a real change, not a route. |
| Tools ▸ Station Manager | Takes `onStationSwitch` — switching the active station re-scopes the whole app; that belongs on the board. |
| Library ▸ Cue Editor · Tools ▸ Cue Editor | `TrackEditor` needs the **currently selected song** (`editSong`) from `<App/>`. A window with no selection has nothing to edit. (A separate cue-editor window route exists and is opened with an explicit file — different door, not this one.) |
| Tools ▸ Clip Editor | Rendered inside the dashboard's main layout region, not as an independent panel. |
| Help ▸ Keyboard Shortcuts · Help ▸ About Ether | Overlays drawn over the dashboard. |
| File ▸ Sign Out · Quit · View ▸ Reload · Toggle DevTools · Help ▸ Documentation · Check for Updates | Main-process actions — never used `menu-action` at all. DevTools stays on the **focused** window by design. |

### Acceptance

From the Jukebox pop-out: **Schedule ▸ Program Log** opens a *Program Log* pop-out window
(`#popout/programlog`, titled "Program Log") while the dashboard sits untouched behind everything,
decks visible. Clicking it again focuses that same window rather than opening a second one.

**Runtime UNVERIFIED** — needs an Electron restart (main-process change); acceptance is Jeff's clicks.

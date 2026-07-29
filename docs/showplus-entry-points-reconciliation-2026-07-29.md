# Where Show+ actually opens from — reconciling the code with the running menu

**Date:** 2026-07-29 · **Mode:** READ-ONLY. Nothing built, nothing changed.
**Operator runtime facts, taken as given:** the WINDOWS (≡) menu contains **Desk, Now Playing, Phone, Show+ DAW,
Decks, Carts, Shows, Clocks, Categories, Library, Calendar, Live Captions, Theme Studio**. There is **no plain
"Show+"** in it, and **no "Monitors" submenu — and there should not be one.**

---

## Headline

**There are two entirely separate menu systems in this app, and I cited the wrong one.**

1. A **native Electron application menu** built by `buildMenu()` (`electron/main.js:1764-1882`) — File, View, Library,
   Schedule, Tools, Windows→Monitors, Help. This is where `main.js:1863` ("Show+" → `popout("videostudio")`) lives.
2. The **in-app ≡ drawer** rendered by React (`src/App.tsx`) — the menu Jeff actually sees and uses.

Everything I wrote about "Window → Monitors → Show+" was about menu system 1. Jeff's menu is system 2. They do not
share entries, and the lists do not overlap.

---

## 1. Where `main.js:1863` surfaces in the running app

**Almost certainly nowhere — the native menu is not drawn.**

```
electron/main.js:1882   Menu.setApplicationMenu(Menu.buildFromTemplate(template));
electron/main.js:1542   frame: false,        ← the MAIN window
```

The main window is created **frameless**. On Windows a frameless `BrowserWindow` renders **no menu bar**, so the whole
native template — File, View, Library, Schedule, Tools, and the `Windows → Monitors` submenu at `main.js:1861-1871` —
has no visible surface. That reconciles the code with Jeff's menu exactly: the Monitors submenu **exists in source and
is invisible in the product**, which is why the running WINDOWS menu neither has it nor should.

**One residual reachability path, and it does not apply here.** A `setApplicationMenu` template still binds
**accelerators** even with no visible menu bar. There are 5 in the whole template, all in File and View:

```
main.js:1801  New Session      CmdOrCtrl+N
main.js:1802  Save Layout      CmdOrCtrl+S
main.js:1810  Quit Ether       CmdOrCtrl+Q
main.js:1822  Reload           CmdOrCtrl+R
main.js:1823  Toggle DevTools  F12
```

**No Tools item and no Monitors item has an accelerator**, so `main.js:1846` (Tools → Show+) and `main.js:1863`
(Monitors → Show+) have **no keyboard route either**. Both are unreachable dead template entries.

**Status: VERIFIED as tree fact + consistent with Jeff's observation.** The frameless-window → no-menu-bar behaviour
is standard Electron on Windows and matches what the operator reports. **Still UNVERIFIED in the strict sense:**
whether the native menu bar is genuinely absent on this machine (rather than, say, toggled by Alt) — **the check:
press Alt in the main window and say whether a File/View/… menu bar appears.** If it does, the Monitors entry is
reachable after all and my original claim needs re-testing on that path.

### This retires the "dead door" question in a different way than expected

The previous correction (`docs/showplus-popout-premise-correction-2026-07-29.md`) asked Jeff to open
Window → Monitors → Show+ to settle whether `PopoutRenderer` renders it. **That check cannot be performed** — the menu
item has no surface to click. The question is therefore moot for product purposes:

- `PopoutRenderer.tsx` has no `videostudio` case, no ShowPlus/VideoStudio import, and no lazy import — so if that hash
  were ever loaded it could not render Show+ (tree fact, unchanged).
- But **nothing in the running app loads it**, because the only caller is an invisible menu item.

So it was never a "door onto a wall" in the product. It is a **dead template entry with no door at all**. My design
built a phase step on a menu the operator cannot see.

---

## 2. Where the video studio is actually opened from

Three reachable entry points, all in the renderer. **None of them is a popout.**

### A. ≡ menu → Tools → "Show+" — the primary door

```
src/App.tsx:3103   tools: (
src/App.tsx:3106     <Item label="Show+ DAW"  onClick={() => …invoke("window:popout", "studiopro")} />
src/App.tsx:3107     <Item label="Show+"      onClick={() => set("videostudio")} />
```

`set("videostudio")` switches the panel; `App.tsx:2614-2615` flips the container from `display:none` to `flex` and the
already-mounted `<VideoStudio active={panel === "videostudio"} />` becomes visible and starts its camera.

Note the pairing at `:3106-3107`: **"Show+ DAW" opens a popout window; "Show+" switches a panel.** Adjacent items,
same prefix, different mechanisms — which is precisely how I conflated the two in the first place.

### B. The "video engine is live" pill in the header

```
src/App.tsx:2198-2200
  {videoLive && panel !== "videostudio" && (
    <button onClick={() => setPanel("videostudio")}
            title="Video engine is live — click to return to Video Studio">
```

Only appears while the video engine is live and you are on another panel — a return path, not an opener.

### C. A deck slot configured as video

```
src/App.tsx:3912   if (deckType === "video") {
                     return <div …><VideoStudio embedded /></div>;
                   }
```

Reachable through the deck configurator. This is the embedded surface (the one that renders no stage — see
`docs/showplus-host-outbound-and-two-surfaces-trace-2026-07-29.md` §8).

### What is NOT an entry point

| Path | Why not |
|---|---|
| ≡ menu → WINDOWS list | Its popout list is `studiopro, decks, carts, shows, clocks, categories, library, calendar` (`App.tsx:2417-2424`) — **no `videostudio`**. Matches Jeff's list exactly, including Desk/Now Playing/Phone above and Live Captions/Theme Studio below |
| Native Tools → Show+ (`main.js:1846`) | Native menu not drawn (§1); no accelerator |
| Native Windows → Monitors → Show+ (`main.js:1863`) | Same; and no `Monitors` submenu exists in the product |
| `#popout/videostudio` | Nothing reachable loads it |

**Consequence for the design:** Show+ the video studio has **exactly one real door today — ≡ → Tools → Show+** — and
it opens **the full right-panel surface** (`App.tsx:2615`), the very tree the design listed for deletion. There is no
popout for the video studio anywhere in the running product. Phase 2's "wire the half-built popout" is not
half-built; it is **not built at all**, and the sequencing trap flagged in rev 3 is the binding constraint: that panel
cannot be deleted until a popout exists and `App.tsx:3107` is repointed to it.

---

## Corrections this forces on the design of record

| Design claim (rev 1-3) | Correct statement |
|---|---|
| "`main.js:1863` is a door onto a wall / renders Unknown pop-out panel" | The item has **no surface at all** — native menu not drawn, no accelerator. Not a wall; not a door |
| "Phase 2 step 0: open Window → Monitors → Show+ and report" | **Cannot be performed.** Replace with: the video-studio popout does not exist in the product; Phase 2 step 1 is construction, not wiring |
| "Repoint `main.js:1846` (Tools → Show+) when deleting the panel" | The live door is **`App.tsx:3107`**, not `main.js:1846`. Repoint *that*. `main.js:1846` is dead template text |
| "Two menu items share the label Show+" | True but in the **wrong menu**. The real adjacency is `App.tsx:3106` ("Show+ DAW" → popout) vs `:3107` ("Show+" → panel) |

These are recorded here; `docs/showplus-one-owner-popout-design-2026-07-29.md` should be revised to rev 4 against them
before any Phase 2 work starts. **Not done in this pass — this document is read-only reporting.**

## Method note

Both answers above rest on tree receipts plus Jeff's runtime report of the menu contents. The one thing I could not
verify myself is whether the native menu bar is truly unreachable (Alt-key behaviour on a frameless window) — named
as a check in §1 rather than asserted, per `CLAUDE.md:121`.

The deeper lesson from this pass: my error was not only "grep ≠ runtime". It was **assuming one menu system** when the
app has two, and never asking which one the operator was describing. The `main.js` template reads like the app's menu
and is not.

## Scope note

Read-only. Only this document was written. No source file modified, nothing committed, nothing built.

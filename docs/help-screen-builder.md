---
feature: screen-builder
title: Screens (build your own screen)
summary: Build a screen of your own from Ether's real panels — Carts, Program Log, Song Library — arrange and size them, save it, and open it again on any computer on your account.
where: ☰ menu → Screens
since: ui/screen-builder, 2026-10-18
audience: operator
tour: true
---

# Screens (build your own screen)

> **Help corpus template.** Written to the format in `docs/help-sweepers.md`: plain language, step-by-step, the
> section order kept.

## What it is

A **screen** is a window you lay out yourself. You put Ether's own panels in it — **Carts**, **Program Log** and
**Song Library** — side by side, stacked or as tabs, at the sizes you want, and save it under a name.

They are the **real** panels, not copies:
- a cart fired from your screen plays exactly as from the Carts window;
- an edit in your screen's Program Log shows in every other Program Log at once;
- a song loaded from your screen's Library follows the same rules as the main Library.

A screen belongs to **one station**: the station that was active when you opened it. Its name is shown in the
screen's top bar, and everything in the screen works on that station.

## When to use it

When the fixed windows don't fit your show. Typical screens:
- two cart walls and the log for a live show;
- the library and the log for building the day;
- carts and the library on a second monitor.

## Set it up (☰ → Screens)

1. **Open a new screen.** ☰ menu → **Screens**. A new, empty window opens in **EDIT**.
2. **Add panels.** Press **+ Carts**, **+ Program Log** or **+ Song Library**. Each new panel opens beside the last.
   You can add more than one of the same: two cart walls, two logs.
3. **Arrange them.**
   - Drag a panel's tab onto another panel to stack them as tabs.
   - Drag a tab to a panel's edge to split.
   - Drag the line between two panels to size them.
   - Press **×** on a tab to remove that panel.
4. **Save.** Press **SAVE** and give the screen a name. The next SAVE updates the same screen.
5. **Lock it.** Press **EDIT** to switch to **LIVE**. In LIVE nothing can be dragged, sized or closed by accident,
   and every panel keeps working.

## Open a saved screen

- In any screen, press **OPEN…** to see this station's saved screens. Pick one: it opens in its own window, in
  **LIVE**, exactly as you saved it.
- **NEW SCREEN** opens another empty screen.
- Each saved screen remembers **where its window was on this computer**. The arrangement inside it follows the
  station to every computer on your account.

## How it behaves on air

- **Cart keys** belong to the cart wall you last clicked (see `docs/help-module-carts.md`).
- **Loading a song onto a deck that is on air is refused**, with the reason, in a screen like everywhere else (see
  `docs/help-module-library.md`).
- **Switching station** in the main window does not change an open screen. It stays on its own station. To see
  another station, open that station's screens.

## If a screen won't open

- **"That screen is not saved on this station."** The screen belongs to another station. Switch to that station,
  then use **OPEN…**.
- **An empty screen** says so in its middle: press **EDIT** and add a panel.

## Not in this version (by design)

- **Panels:** only Carts, Program Log and Song Library can be placed for now. More panels arrive as each one is
  proven to work exactly like its window.
- **Shared screens only:** screens are saved for the station, not per user profile.
- **No delete or rename:** a saved screen cannot yet be deleted or renamed from the screen window.
- **Cart options:** a panel's options (for example the cart wall's strip layout) are saved and restored, but cannot
  yet be changed from the screen.

## Related

- **Carts module** (`docs/help-module-carts.md`), **Program Log module** (`docs/help-module-programlog.md`),
  **Song Library module** (`docs/help-module-library.md`).
- **Keyboard shortcuts** (`docs/help-keyboard-shortcuts.md`).

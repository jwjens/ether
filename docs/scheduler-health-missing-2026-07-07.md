# Scheduler Health missing from Tools — read-only diagnosis (2026-07-07)

Reported: Scheduler Health panel absent from the Tools menu on packaged v4.4.38 (jensj).
**Read-only. No fix, no commit until GO.** Receipts below.

## Finding 1 — the panel code IS in the tag (not the problem)
`git grep -n "Scheduler Health" v4.4.38` + `git ls-tree v4.4.38`:
- `v4.4.38:src/components/SchedulerHealthPanel.tsx` — present; commit `8d974fe`.
- Host mounted: `v4.4.38:src/App.tsx:1973` — `<SchedulerHealthHost />`.
- Menu item: `v4.4.38:src/App.tsx:2899`.

So the feature shipped in the binary. The gap is purely how it's reached from the menu.

## Finding 2 — the item is in the WRONG menu, and role-gated (the root cause)
Two different "Tools" menus exist:

1. **Native Electron menu bar** — `electron/main.js:1497` `{ label: "Tools", submenu: [...] }`. This is the
   title-bar "Tools" in the jensj screenshot (File / View / Library / Schedule / **Tools** / Help). Its
   items (main.js:1498–1513): Voice Tracker, Show+ DAW, Show+, Cue Editor, Clip Editor, Import Library,
   Stream Manager, Smart Scheduler, Listener Analytics, Cloud Log Backup, Audio Routing, Station Manager,
   System Health, Monitors. **There is NO "Scheduler Health" entry here.** No `isDev` / `NODE_ENV`
   conditional wraps anything — the item is simply absent from the native template.

2. **Renderer in-app Tools dropdown** — `src/App.tsx:2899`:
   `{(currentUser?.role === "admin" || currentUser?.role === "music_director") && <Item label="Scheduler Health" onClick={() => window.dispatchEvent(new Event("ether:open-scheduler-health"))} />}`
   This is where I added it. It is **role-gated** to `admin` / `music_director`.

**Root cause:** the Scheduler Health item was added to the renderer dropdown (`App.tsx`), NOT the native
Electron Tools menu (`main.js:1497`) the operator clicks. Compounding it: even in the renderer dropdown
it only renders for `admin` / `music_director` — so an operator without that role wouldn't see it there
either.

Note: other native Tools items open panels via `send("nav:<x>")` → the renderer maps `nav:*` to a panel
(`App.tsx:930` has the `nav:*` → panel map). There is **no `nav:schedulerhealth`** mapping, and the
native menu never sends it — consistent with Finding 2.

## Finding 3 — on-artifact screenshot
I cannot launch a packaged Windows app or screenshot its native menu from this sandboxed environment, so
step 3 (launch 4.4.38 on OVEVENTS, screenshot Tools) must be done on OVEVENTS. **However the code is
conclusive:** the native Tools template (`main.js:1497`) that ships in the packaged build has no Scheduler
Health item, which matches the jensj report exactly. Expected on OVEVENTS: same — absent from the native
Tools bar; present only if you open the renderer's in-app Tools dropdown while signed in as admin/
music_director.

## Proposed fix (NOT applied — awaiting GO)
1. Add to the native menu (`electron/main.js:1497` Tools submenu):
   `{ label: "Scheduler Health", click: () => send("nav:schedulerhealth") }`.
2. Map it in the renderer: either add `"nav:schedulerhealth"` to the `nav:*` handler (`App.tsx:930`) to
   dispatch `ether:open-scheduler-health`, or handle that nav id directly.
3. Decide role-gating: the native menu isn't per-item role-gated; confirm whether Scheduler Health should
   be visible to all operators (recommended — it's read-only health info) or gated. If gated, gate in the
   renderer handler, not the native menu.
4. Blast-radius: purely additive (one menu item + one nav mapping); no effect on playout or the panel
   itself, which already works via `SchedulerHealthHost` + the `ether:open-scheduler-health` event.

No code changed. No commit. Awaiting GO.

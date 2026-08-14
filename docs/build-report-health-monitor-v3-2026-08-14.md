# Build report — Health Monitor v3: the bottom half, and panels the operator arranges (4.4.208)

**Date:** 2026-08-14 · **Branch:** `log-reader-flip` · **Version:** 4.4.207 → 4.4.208
**Gates:** `tsc --noEmit` **0 errors** · `vitest` **315 passed / 23 files**

## Jeff's reports, verbatim

1. *"the bottom half font are still smaall and the the bottom meters are still small strips your not
   close to done dont build yet"*
2. *"bottom meters need to match the top bigger meters"*
3. *"each panel should have be collapsable and draggable"*
4. *"there are sections that still need to be designed dont get off track i was just adding to the
   list of tasks with the collapsable and draggable features."*
5. *"the top half are not draggable still need to make live events rotation gaols audio levels and
   runway are not draggable yet"*

Each is recorded as given. The diagnoses below are additions, not replacements.

---

## 1. Type size

A first attempt used a string-replacement sweep over `HealthMonitor.tsx` and **largely failed** — 1 of
7 patterns matched, because the inline styles are not written as the literals it searched for. It
reported success on the one pattern while 22 small sites remained. Redone **by size** across both
files: `9→11`, `10→12`, `11→13`. Zero `fontSize: 9` or `10` remain in either file.

Proportional rather than flat, so badges (SPOT/JIN/YOURS) stay badges instead of becoming body text.

`HealthRow`'s own sizes had already been raised (label 14, sub 12); it is now redesigned outright —
see §3.

## 2. Meters — one meter, not three lookalikes

The complaint was that the lower meters read as "small strips" beside instruments. The cause was not
only height. There were **three different bar geometries** in one panel:

| | before | after |
|---|---|---|
| dashboard deck meters | label 52 · `flex:1` · h14 · `--bg-primary` · −6 dB tick · 92px mono readout | unchanged — this was the reference |
| station rows (`health.tsx`) | fixed 110px chip in a grid column, h14 | the same row |
| audio processing | 6px hairline on `--bg-secondary`, 96px label, 62px readout | the same row |

`PanelMeter` in `sectionChrome.tsx` is now that one row, and all three use it. It takes an optional
`from` for the one meter that is bidirectional (ride gain, which grows left when cutting).

**A scale bug was fixed alongside the geometry.** Station PEAK is an AMPLITUDE and was drawn
linearly, while the dashboard maps amplitude through dB. The same signal rendered two different bar
lengths in one panel, and the quiet half of the range was invisible in the lower one while being
perfectly legible six inches above. Station peak now maps through `ampToDbfs`/`dbToPercent` like
everything else.

## 3. Sections redesigned

- **Stations (live)** — a 6-column grid squeeze (`18px 168px 1fr 1fr 84px 104px`) became a card per
  station: identity and status on line 1 with queue/stream on the right edge, then meters spanning
  the full card width.
- **Audio Processing** — four `StatTile` figures lead (in/out LUFS, target, ride), then in / out /
  ride / limiter as real meters. The limiter deliberately keeps its "idle" wording: it sits at 0 at
  steady state by design, and a bar pinned at zero reads as broken (the 2026-08-01 finding).
- **Spot Schedule** — the four-column timestamp table is replaced by `SpotTimeline.tsx`. **Two
  scales, stated as such**, because one cannot carry both honestly: hour LANES where a marker's
  position *is* its minute (drift is unshowable there — 60s is 1.6% of an hour, a sub-pixel nudge
  that would imply precision the lane does not have), and DRIFT BARS centred on the anchor at ±90s
  where 60s is two thirds out. Hollow = pending, solid = aired; a NOW line; hover for exact times.
- **`HealthRow`** — the workhorse behind Core Systems, HA, Library & Rotation, the canary, the
  shadow and the designation rows: **31 call sites**. Redesigning the component converted all of
  them at once rather than by editing 31 blocks of inline style. It is now a tile with a status EDGE
  and its reading set as a 17px figure. `HealthDot` was removed with it — the edge replaces it and
  is legible across a room, which a 10px dot is not.

## 4. Collapse and drag

`PanelStack` / `HealthPanel` / `usePanelStack` in `sectionChrome.tsx`.

- **Drag by the header only.** Several of these panels carry load-bearing controls (the canary flips,
  the auto-generate toggles, REFRESH NOW, the DMCA export). A draggable card body would make those
  unusable.
- **Persistence is keyed BY ID, not by position.** A saved order is a list of ids; unknown ids fall
  to the end in declaration order. That is what makes a saved layout survive a build that adds or
  removes a panel — the new panel appears instead of the layout being discarded, and a removed one
  is simply absent rather than leaving a hole or throwing.
- **The stack pins non-panel children rather than dropping them.** `HaRollupBanner` and the
  last-error block are children of the same region. A stack that rendered only what it recognised
  would have silently swallowed both — the exact failure class this panel exists to catch. They are
  pinned above the reorderable panels, which is also where an alert belongs.
- **Two stacks, deliberately** — `health-dashboard` (the four dashboard sections) and
  `health-monitor` (the nine below). The dashboard sits in a wall grid and the sections below stack
  vertically; a panel dragged across would land in a layout it was not built for.

**Top half (report 5).** The four dashboard sections were not draggable because they render their own
`HealthSection` chrome. Wrapping them in a `HealthPanel` would have produced a card inside a card —
two borders, two headers, two titles. Instead `HealthSection` now joins the stack itself via
`usePanelStack()`: same context, same persistence, same handle, one card.

The id had to be threaded as a real **prop** through `HealthChart`, `HealthMeters` and
`HealthTimeline` (each renders its own `HealthSection` internally, and two are `memo()`-wrapped).
Hardcoding the id inside would have left `PanelStack` unable to see them — they would have been
pinned as non-panels and silently undraggable, which is precisely the symptom reported.

`PanelStack` renders no DOM of its own, so the wall grid still lays the dashboard out: the 3fr/2fr
pairing at ≥1280px survives and dragging works across both columns.

---

## Architecture Compliance

| Rule / doc | Receipt |
|---|---|
| `docs/health-monitor-v3-sections-2026-08-13.md` (governing proposal) | Implemented; its status line now points here. |
| `docs/health-monitor-v2-design-2026-08-13.md` — one visual language | `PanelMeter` is now literally shared by dashboard, station rows and processing; `HealthSection` and `HealthPanel` use the same tokens and header treatment. |
| **Honest state — observed, never claimed** | No new claim added. The limiter still says "idle" rather than drawing a zero bar; unmeasured stations still read "not measured"; chart gaps still break the path. |
| **Doors before rooms** | Health Monitor's existing door (Tools menu / pop-out) is unchanged. The new arrangement affordance is self-describing: a ⠿ handle and a ▾ chevron in each header, plus the help entry below. |
| **Every feature ships its help entry** | `docs/help-health-monitor.md` — flat naming, no subfolder, written to the `help-jingles.md` template. Covers all panels and the drag/collapse steps. |
| **Build the sense, not the scaffold** | No watcher, poller or scheduled task created. The one new interval is a 5s clock inside `SpotTimeline` for the NOW line, scoped to the component and cleared on unmount. |
| Levels channel is ~90 fps / OOM-implicated | Untouched. `HealthMeters` keeps its ref-driven writes; nothing new subscribes to `audio:levels`. |
| Local-only / sync registry | No schema, IPC or DB change in this build. Layout state is `localStorage`, per machine, and never syncs. |

## Files

**New:** `src/components/health/SpotTimeline.tsx` · `docs/help-health-monitor.md` · this report.
**Changed:** `src/components/HealthMonitor.tsx` · `src/audio/health.tsx` ·
`src/components/health/{sectionChrome,HealthSection,HealthDashboard,HealthChart,HealthMeters,HealthTimeline}.tsx`
· `useContainerWidth.ts` · `package.json`.

## NOT verified

- **Everything above is source and gates.** Jeff confirmed on 2026-08-14 that the dev build renders
  all updated sections; the **top-half drag/collapse added afterwards has no runtime receipt yet**.
  The check that settles it: drag a dashboard header, collapse another, reload, confirm both return.
- No packaged smoke test has been run against the 4.4.208 artifact at time of writing.

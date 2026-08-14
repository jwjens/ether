# Health Monitor v3 — finishing the redesign (section conversion)

**Date:** 2026-08-13 · **Branch:** `log-reader-flip`
**Status:** BUILT in 4.4.208 (2026-08-14) — see `docs/build-report-health-monitor-v3-2026-08-14.md`.
Kept as the governing proposal; the build report records where the build diverged from it.
**Governing docs:** `docs/health-monitor-v2-design-2026-08-13.md` (v2 dashboard, binding),
`docs/build-report-health-two-column-live-activity-2026-07-30.md` (two-column layout),
`docs/audio-health-system-design.md` (live telemetry snapshot)

Jeff's report, verbatim: *"The Health Monitor is still a hybrid. The top has the new dashboard
(cards, chart, VU meters), but everything below is still the old wall of text."* That is exactly
right and is the defect this doc addresses.

---

## 1. Findings that change the brief

These are stated up front because three of them alter what "finish the redesign" means.

### 1.1 There is no fixed 1920×1080 no-scroll layout. It has never been built.

The brief treats the wall display as existing. It does not. `HealthMonitor.tsx:876-1544` roots a
percentage-height flex column, and the left column is an `overflowY: auto` scroller:

```tsx
<div ref={panelRef} style={{ height: "100%", display: "flex", flexDirection: "column", ... }}>
  <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: twoCol ? "row" : "column" }}>
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: "auto", padding: "0 32px" }}>
```

Commit `c11fca7` ("Health dashboard: wall-display layout") added a wall **grid inside
`HealthDashboard`** at `WALL_MIN_PX = 1280` (`useContainerWidth.ts`) — it did not make the panel
itself fixed or non-scrolling. So "no scrolling, at-a-glance" is **new construction**, not a
finishing pass. It is the largest item in this plan and it gates everything else, because it
determines the vertical budget every converted section must fit.

### 1.2 `var(--bg-card)` does not exist in this repo.

Zero matches tree-wide. The real token vocabulary, read from `src/components/health/*`:

| Role | Tokens |
|---|---|
| Card surface | `--bg-secondary` (HealthCard), `--bg-elevated` (HealthSection) |
| Other surfaces | `--bg-primary`, `--bg-tertiary`, `--bg-active` |
| Border | `--border-primary`, `--border-secondary` |
| Text | `--text-primary`, `--text-secondary`, `--text-tertiary` |
| Status | `--accent-green`, `--accent-amber`, `--accent-red`, `--accent-blue` |
| Spacing | `--s-1` … `--s-6` |
| Radius | `--r-0` (flat, per v2 doc), `--r-full` |
| Type | `--t-micro`, `--t-small`, `--t-body`, `--t-metric` |

Tokens are defined in `src/index.css`. The health components use **inline style objects only** —
no `className`, no CSS modules. Conversions follow that, for consistency.

### 1.3 Two competing status-colour vocabularies are live at once.

- New: `healthUtils.ts` → `HealthLevel = "green" | "yellow" | "red" | "grey"`, `LEVEL_COLOR`,
  `toLevel()` (unknown → grey, per the v2 honesty rule).
- Old: `src/audio/health.tsx` → its own `LEVEL_COLOR.RED` / `.YELLOW` (uppercase keys).

Every conversion routes through `healthUtils`. No section defines its own colour mapping.

### 1.4 Sections 1 and 2 are not in `HealthMonitor.tsx` at all.

`Engine` and `Stations (live)` are inside `LiveHealthMonitor` (`src/audio/health.tsx:121`),
mounted at `HealthMonitor.tsx:923`. The four fields named in the brief all exist —
`snap.engine.{pid, uptimeSec, restartCount, pingMs}` (`health.tsx:22`) and `snap.stations[]`
(`:23`). Converting them means editing `src/audio/health.tsx`, which also feeds the **MINI**
panel. Any change must keep MINI working — one feed, two surfaces (per
`docs/audio-health-build-2026-07-13.md`).

### 1.5 "Live events" is already converted — and there are four event surfaces, not one.

| Surface | Source | State |
|---|---|---|
| `HealthTimeline` (in `HealthDashboard`) | `health:recent-events` ledger | **new** ✅ |
| `Designation Activity` (1336–1384) | `health:recent-events`, designation kinds | old |
| HA `Recent Events` (1160–1173) | `ha.readLog(14)` — raw `watchdog.log` strings | old, unstructured |
| `LiveActivityTerminal` (right column, 1532–1542) | separate component | own style |

**Item 10 (Designation Activity) is therefore not a new component.** It is `HealthTimeline` with a
kind filter. Building a second timeline would violate "never rebuild what exists".

### 1.6 Five live sections are missing from the brief's list of ten.

Present on the page, unnamed in the brief — each needs a disposition, not a silent drop:

| Section | Lines |
|---|---|
| High Availability (+ its Recent Events) | 1086–1174 |
| Last Error (with Dismiss control) | 1176–1186 |
| Ether Infrastructure (static badges) | 1510–1530 |
| "Legacy diagnostics — may be stale" divider | 1046–1050 |
| `LiveActivityTerminal` (right column) | 1532–1542 |

Also: **Log-Reader Flip is two sections**, not one — Canary (1386–1451) and §2.7 Shadow
(1453–1474).

### 1.7 The same fact is fetched twice, on two clocks.

`HealthDashboard` self-fetches `library-health:get` and `designation:status` on its own 30s poll
(`healthData.ts`, `POLL_SNAPSHOT_MS`), while `HealthMonitor` fetches **the same two IPCs** on its
own 30s poll for the old sections below. The two can land out of phase, so the panel can show two
different numbers for the same station fact at the same moment. On a wall display an operator
reads as truth, that is an honesty defect, not a cosmetic one. Converting Library & Rotation
without fixing this would preserve the bug behind a nicer surface.

---

## 2. The central design conflict — wall vs ops

The brief asks for a **fixed 1920×1080, no-scroll, at-a-glance wall display** containing **ten
sections**, seven of which carry interactive controls:

| Control | Section | Lines |
|---|---|---|
| Flip toggle (per station) | Log-Reader Flip Canary | 1386–1451 |
| Auto-generate toggle (per station) | Log-Reader Flip Canary | 1386–1451 |
| Designation refresh (per station) | Library & Rotation | 1188–1334 |
| Unresolvable list expander | Library & Rotation | 1188–1334 |
| Export Play Log CSV | DMCA Export | 1476–1508 |
| Dismiss | Last Error | 1176–1186 |
| Refresh | HA Recent Events | 1160–1173 |

These two products do not fit in one screen. 1080px of height, minus header and the 460px-wide
right terminal, cannot hold the existing dashboard **plus** ten more sections **plus** per-station
control rows without either scrolling or shrinking everything below legibility at wall distance.
Forcing it produces a screen that is bad at both jobs.

### Recommendation: one component tree, two modes

- **WALL** — fixed 1920×1080 grid, `overflow: hidden`, read-only, status only. No buttons.
  Big type. This is the at-a-glance product the brief describes.
- **OPS** — today's scrolling diagnostic panel, all controls, same converted card visuals.

`HealthMonitor.tsx` already has `isPopout` (read from `window.location.hash`) — the popout window
is the natural carrier for WALL, with the docked panel staying OPS. That reuses an existing
mechanism rather than adding a mode flag.

This is the one decision that must be made before any code, because it sets each section's
vertical budget and decides whether a section renders its controls at all.

---

## 3. Section-by-section conversion plan

Order is dependency-driven: shared plumbing first, then sections, cheapest and least risky first.
Every phase ends in a dev-mode look before the next begins. No builds until the whole thing looks
right (Jeff's constraint, and CLAUDE.md's).

### Phase 0 — decisions (no code)
Wall/ops mode · disposition of the five unlisted sections · single-owner data fix (§1.7).

### Phase 1 — layout shell + data ownership
1. Fixed wall grid: `1920×1080`, `overflow: hidden`, CSS grid with named areas; OPS keeps the
   current scroller. Verify in dev at exactly 1920×1080.
2. Lift `library-health:get` + `designation:status` to a single owner and pass down, deleting the
   duplicate poll. One fetch, one clock, one number.
3. Unify `src/audio/health.tsx` onto `healthUtils` `HealthLevel` / `LEVEL_COLOR`.

*Stop. Look at it in dev.*

### Phase 2 — section conversions

| # | Section | Approach | New component? |
|---|---|---|---|
| 6 | Core Systems + Last Error + Infrastructure | one status grid of dots via `toLevel()`/`LEVEL_COLOR` | no |
| 1 | Engine | `HealthCard` ×4 (uptime, pid, restarts, ping) in `health.tsx` | no |
| 2 | Stations (live) | per-station `HealthSection` + `HealthBar`-style level, song, stream dot | no |
| 4 | Audio Processing | fold into `HealthMeters` — it already renders peak + LUFS + target | no |
| 8 | Log-Reader Flip (both) | toggle rows, status dot per station; OPS-only controls | no |
| 9 | DMCA Export | `HealthCard` (count + last played) + button; OPS-only | no |
| 10 | Designation Activity | `HealthTimeline` with a kind filter — **not** a new timeline | no |
| 7 | Library & Rotation | reconcile against dashboard cards; drop what the cards already say | no |
| 5 | Spot Schedule | anchors/drift strip — **the only genuinely new component** | `HealthSpots.tsx` |
| — | High Availability | status card + events → `HealthTimeline` if structurable | no |

Nine of ten reuse what exists. Only Spot Schedule needs a new visual.

### Phase 3 — close the gaps
- `docs/help-health-monitor.md` — **does not exist today**. Per CLAUDE.md a user-facing feature is
  not done without its help entry.
- Door check: confirm the Health Monitor is reachable from the hamburger (DOORS BEFORE ROOMS).
- Any new logic (spot drift level, engine level) goes in `healthUtils.ts` **with vitest tests**,
  matching the existing `healthUtils.test.ts` / `meterScale.test.ts` / `chartPath.test.ts`
  pattern. Pure logic out of components, tested.

---

## 4. Architecture compliance

- **Never rebuild what exists** — 9 of 10 sections reuse `HealthCard` / `HealthSection` /
  `HealthBar` / `HealthTimeline` / `HealthMeters`. Designation Activity explicitly reuses
  `HealthTimeline` rather than building a second one.
- **Honest state (v2 doc)** — `toLevel()` renders unknown as **grey, never green**; runway `null`
  renders `"—"`, never `0`. Carried into every converted section.
- **Flat, dense, muted** — `--r-0` throughout, per the v2 doc.
- **One region engine principle** — one status vocabulary (`HealthLevel`), one colour map.
- **Build the sense, not the scaffold** — no temporary tooling is created by this work.

## 5. Explicitly NOT building

- No new charting or component library; no new dependency (v2 doc costed and declined recharts).
- No second timeline component.
- No changes to the ledger writer, `health-events.jsonl` rotation (a known backlog item), or the
  `runway_history` backfill.
- No installer build until the whole dashboard is signed off.

## 6. Open risks

1. `health-events.jsonl` is unbounded (~39 MB / 24 days) — rotation is backlog, not this work,
   but a wall display polling it makes it matter sooner.
2. `libHealth`, `desig`, flip and shadow payloads are all `any`. Converting to typed cards means
   tightening those shapes — that is real work hidden inside "make it a card".
3. HA `Recent Events` is a raw string list from `watchdog.log` with no structured fields. It may
   not be convertible to a timeline without a source change; if so it stays a mono block in OPS
   and is **absent from WALL**.
4. Flip / auto-generate / designation refresh carry sequence guards and read-after-write
   semantics (`desigSeqNext`, `desigApplied`, `autoSeq`). A visual redesign must preserve those
   paths, not wrap them.

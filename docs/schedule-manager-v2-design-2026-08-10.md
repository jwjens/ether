# Schedule Manager v2 — docking workspace, visual language, shared grid
**Date:** 2026-08-10 · **Status:** DESIGN ONLY — no code written, nothing changed, no dependency installed.
**Builds on:** `docs/schedule-manager-design-2026-08-10.md` (v1: store, linking, advisor — shipped 4.4.172)

---

## 0. What the inventory changed about this brief

Three of the brief's premises move once measured.

### 0.1 The app is already flat. The sweep is smaller than "no bubbly" implies.

`borderRadius` across `src/components`:

| Value | Uses | Verdict |
|---|---|---|
| **0** | **1,032** | already flat |
| 50 / 999 | 163 | circles — avatars, status dots. **Legitimate, not bubbly** |
| 3, 4, 5, 6, 8, 10, 12 | **101** | the actual offenders |
| Tailwind `rounded` (=4px) | 46 | offenders |
| Tailwind `rounded-none` | 9 | already flat |

**The real sweep is ~147 call sites**, not "the whole app". That is a day, not a project.

`boxShadow` is the bigger job: **77 of 128 component files**, led by StudioPro (35), SubscriptionPanel (10), ProducerDesk (10). Most are `0 2px 8px rgba(...)` card lifts.

### 0.2 A token system already exists — and is *colour only*

`src/index.css` defines the palette, and it is used everywhere: `--text-tertiary` **1,279×**, `--border-primary` **1,109×**, `--bg-tertiary` 601×, `--accent-blue` 467×.

So "define design tokens once" is **half done**. Colour is tokenised and disciplined. What has no tokens — and is therefore ad-hoc at every call site — is **radius, spacing, type scale and elevation**. That is precisely where the inconsistency lives, and it is what §3 should add. Re-tokenising colour would be rework.

### 0.3 Nothing is installed

`dockview`, `flexlayout-react`, `@tanstack/react-table`, `react-window` — **all absent**. Every one is a new dependency in a renderer bundle already **2.49 MB** and warned about on every build. §1 and §4 must carry that cost honestly.

---

## 1. Docking shell

### 1.1 Recommendation: **dockview**, decided by spike, with flexlayout-react as the named fallback

| | dockview | flexlayout-react |
|---|---|---|
| Bundle (min+gz) | ~45–55 KB + CSS | ~35 KB + CSS |
| Model | panels/groups/floating, serialisable | tabsets/borders, serialisable |
| Theming | CSS variables — maps onto our existing token system cleanly | class-based, more overriding |
| Electron | no known issue; pure DOM | same |
| Risk | newer API surface | older, less active |

dockview's CSS-variable theming is the deciding factor: our design language is already expressed as CSS variables, so the shell can inherit rather than be fought.

### 1.2 The spike — specified here, run on approval

`spike/dock-spike/` — throwaway, deleted or promoted, never merged as-is.

**Passes if all five hold:**

1. **It mounts in our stack.** Vite + React 18 + Electron renderer, no build warnings beyond the existing chunk-size one.
2. **Drag, dock, resize, float, close, reopen** all work in the packaged renderer, not just `vite dev`. Packaged is the one that matters — `webSecurity: false` and the custom protocol handling differ.
3. **Serialise → reload → identical layout.**
4. **Theming reaches it.** Tab strips and splitters take `--bg-secondary` / `--border-primary`, not the library's defaults.
5. **§5's render-isolation test passes** — the one that decides the whole plan.

**Fails to flexlayout-react if:** theming needs `!important`, layout JSON is not stable across versions, or drag stutters under the tick load in §5.

**Budget:** one day. If neither library passes §5, **stop and report** — the answer would be that our re-render architecture must be fixed before any docking shell is worth adding, and that is a different project.

---

## 2. Pane inventory

| Pane | Source | Work |
|---|---|---|
| **Shows** | `scheduler/ShowsTab` | none — already prop-driven and hosted in v1 |
| **Clocks** | `scheduler/ClocksTab` | none for hosting; loses its spots half in the extraction below |
| **Categories** | `scheduler/CategoriesTab` | none — already hosted |
| **Spots** | **extract from `ClocksTab`** | ~80 spot/break references in a 1,066-line file. Real extraction, see 2.1 |
| **Jingles** | `JinglesPanel.tsx` (231 lines) | host via the same optional-props pattern |
| **Rotation Analytics** | `RotationAnalytics.tsx` | make hostable; it currently owns its own range state and header |

### 2.1 The Spots extraction is the only real surgery

`ClocksTab` is two editors in one component: the hour grid, and spot-category/timed-break management (`spotCats`, `breaks`, `spotCatCounts`, `breakEligible`, `anyEligible`, `editSpotCat`, `newSpotCat*` — ~80 references).

Same method as Phase A, which is proven: **move by exact line range, diff for byte-identity, re-export from the original so nothing that imports it notices.** Do not retype it.

> **CORRECTED BY THE BUILD (§14).** This paragraph is wrong twice. (1) It is not a line move: the
> clock editor still *needs* the spot-category list after the card is gone, so the split is a
> dependency untangle, not an extraction. (2) There was nothing to extract *to* — `Spots.tsx`, the
> shipped Spots & Promos manager, already owned this exact CRUD. What shipped hides the card here
> and hosts that panel. See §14.

The split leaves a question the doc cannot answer alone: **timed breaks belong to a clock**, so a Spots pane showing another clock's breaks would be confusing. Proposal: Spots pane owns *spot categories* (station-wide) and the **Clocks pane keeps timed breaks** (per-clock). Flagged for Jeff — see §9.

---

## 3. Visual language

### 3.1 Add the four missing scales; leave colour alone

To `src/index.css`, beside the existing palette:

```css
/* radius — flat. 2px is the maximum that is not a circle. */
--r-0: 0px;      /* default for every surface */
--r-1: 2px;      /* inputs, chips — the only permitted softening */
--r-full: 999px; /* circles ONLY: status dots, avatars */

/* spacing — tight, 4px base. More data per screen. */
--s-1: 2px;  --s-2: 4px;  --s-3: 6px;  --s-4: 8px;
--s-5: 12px; --s-6: 16px; --s-7: 24px;

/* type — smaller, fewer steps */
--t-micro: 9px;   /* column headers, badges */
--t-small: 10px;  /* dense table cells, metadata */
--t-body:  12px;  /* default */
--t-lead:  14px;  /* pane titles */
--t-head:  20px;  /* panel titles only */

/* elevation — none by default. Depth comes from borders. */
--e-0: none;
--e-1: 0 1px 0 rgb(from var(--border-primary) r g b / 0.6);  /* a hairline, not a lift */
--e-float: 0 4px 16px rgba(0,0,0,0.4);  /* dragged panes and modals ONLY */
```

**Rules, stated so they can be enforced rather than admired:**
- Radius is `0` unless it is an input (`--r-1`) or a circle (`--r-full`).
- **No `boxShadow` on anything that is not floating.** Cards are separated by borders and background steps, not lift.
- Colour is **semantic**: `--accent-amber` means "attention", `--accent-red` means "fault". A colour used decoratively is a bug.
- Type: five steps, no ad-hoc `fontSize: 13`.

### 3.2 The sweep, costed

| Work | Scale | Estimate |
|---|---|---|
| Add tokens to `index.css` | one file | 1 hour |
| Radius: 101 inline + 46 Tailwind `rounded` | ~147 sites | ~half a day, mechanical |
| Shadows: 77 files | StudioPro alone is 35 | **1.5–2 days**, and needs eyes — some are legitimate float |
| Spacing/type convergence | opportunistic | ongoing, not a phase |

**Recommendation: sweep only what enters the shell.** The six panes plus the shell chrome. A 128-file cosmetic sweep is not a prerequisite for a docking workspace, and bundling them makes both harder to review. StudioPro's 35 shadows are a separate cosmetic pass with its own risk.

---

## 4. Shared data grid

### 4.1 One grid, sixteen replacements

**16 components render their own `<table>`.** Every one re-implements headers, alignment and empty states; none has sortable or resizable columns.

**TanStack Table v8** (headless, ~14 KB gz, no styling of its own) + our tokens = `src/components/grid/DataGrid.tsx`:

- sortable headers (click, shift-click for secondary)
- **user-resizable columns**, widths persisted per pane per station
- dense rows (`--s-2` padding, `--t-small`)
- CSV export from the column definitions — one implementation, not per panel
- empty state as a required prop, so no grid can ship a blank rectangle
- virtualisation **deferred**: at ~400 rows/day the DOM is fine, and `react-window` is another dependency. Revisit when a pane exceeds ~2,000 rows.

### 4.2 Conversion order

1. **Rotation Analytics** — flagship. Four tables, already token-styled, already has CSV. Proves sort + resize + export against real data.
2. **Traffic** (`Logs.tsx`) — second, and the one with a real user need for sorting (by advertiser, by delta).
3. Everything else opportunistically. **No big-bang migration.**

---

## 5. Render isolation — the item that decides the project

### 5.1 The problem is real and measured

`App.tsx:1576`:
```js
const unsub = engine.on((id, st) => {
  if (id === "A") setDeckA({...st});      // App top-level state
  ...
  setQueueLen(engine.getQueue().length);
```

Deck state lives at App's top level, so **every deck tick re-renders App's entire tree**, including whatever panel is mounted. `stateChanged` floors `positionSec`, so this fires roughly **1 Hz per playing deck** — up to 3 Hz with three decks, plus queue and engine-state churn. That is the "clunky" the brief names, and it has a line number.

### 5.2 The precedent already in the codebase

`MasterOutput.tsx:538`:
> *"Subscribe to `audio:levels` directly — keeps masterLevel out of App.tsx state so the library table doesn't re-render at 30Hz."*

Someone already solved exactly this, once, for levels. **30 Hz levels are isolated; ~3 Hz deck state is not.** The fix is to apply the established pattern, not invent one.

### 5.3 The design

1. **The workspace is `React.memo`'d** and takes only referentially-stable props. Today `<ScheduleManager onOpenAnalytics={() => setPanel("rotation")} />` allocates a new closure per render, which would defeat `memo` silently — it must become a `useCallback`. **This is the single highest-value line in the whole document**, because it is invisible when wrong.
2. **No pane subscribes to deck/level IPC.** Nothing in the Schedule workspace needs transport state.
3. **Hub state is selector-shaped.** Panes receive the slices they use, not the whole hub object, so a category edit does not re-render the Shows pane.
4. **Layout state lives in the shell**, not App. A drag must not touch App's state at all.
5. **Column widths are refs + a debounced persist**, never per-pixel React state.

### 5.4 The spike test — the acceptance gate for the entire plan

```
Given  the dock spike mounted with three panes,
  and  a synthetic tick calling setState in an App-level parent at 4 Hz
       (above the ~3 Hz real deck rate, deliberately),
 When  a pane is dragged across the shell for 10 seconds,
 Then  the React Profiler shows ZERO renders of the workspace subtree
       caused by the tick,
  and  dragging holds ≥55 fps,
  and  removing the memo makes it fail — proving the isolation is doing the work
       and not merely coinciding with a fast machine.
```

That last clause matters: a passing number on a quiet machine proves nothing. **The test must be shown to fail when the guard is removed.**

**If this fails, the plan stops.** No amount of docking polish survives a workspace that stutters while a deck plays, and the honest conclusion would be that App's state decomposition (audit refactor #4) comes first.

---

## 6. Layout persistence

- **`station_config_kv`, key `schedule_layout_v1`, written via `station_config_kv:set-local`** — the proven local-only path, same as the log-reader flip canary. Layouts are per-machine ergonomics; syncing them would rearrange another operator's screen.
- **Per station.** Switching stations restores that station's layout.
- **Versioned.** `{ v: 1, layout: {...} }`. An unrecognised or unparseable version falls back to the default layout **silently and without data loss** — a corrupt layout must never block the panel.
- **Reset Layout always available**, in the shell header, no confirmation.
- **Presets** (Programming / Traffic / Analysis) are Phase 4, shipped as named default layouts.

---

## 7. Constraints — carried forward from v1, unchanged

| Constraint | How v2 holds it |
|---|---|
| Writes stay on `ether.<table>.*` | The shell adds no write path. Panes keep their own writes; the hub stays read-only |
| Remote web editor unaffected | No change to `/api/cmd` → SSE → `applyDbMutation`, or to `pushCcTable` |
| No engine/deck/`generated_schedule` surface | No pane subscribes to transport state; nothing here writes the log |
| Old routes and popouts keep working | `Scheduler.tsx` remains the compatibility shim; `PopoutRenderer` untouched; v1's fixed layout stays until v2 replaces it deliberately |
| Compose, don't rebuild | Panes are the same components. The Spots extraction is a **move**, verified byte-identical, not a rewrite |

---

## 8. Phased build plan

### Phase 0 — Spike (1 day) — **GATE**
dockview in the packaged renderer; §5.4 render-isolation test. **Nothing else starts until this passes.**
*Gate:* all five criteria in §1.2, and the isolation test failing when the memo is removed.

### Phase 1 — Shell + the three existing panes (2–3 days)
Docking shell, layout persistence, Reset Layout, tokens added to `index.css`, sweep limited to the shell and three panes. **Parity with v1 in dock form** — same linking, same advisor.
*Gate:* every v1 behaviour works docked; v1's fixed layout still works; old routes and popouts unaffected; isolation test still passes with real panes.

### Phase 2 — Spots extraction + Jingles pane (2 days)
Extract Spots from `ClocksTab` by line range, diff for byte-identity, re-export. Host `JinglesPanel`.
*Gate:* byte-identical diff; the tabbed Clocks tab and its popout unchanged; jingle editing works from both the push-up and the pane.

### Phase 3 — DataGrid + Rotation Analytics as a pane (2–3 days)
`DataGrid` on TanStack; convert Rotation Analytics; host it as a pane.
*Gate:* sort, resize, CSV match the current output byte-for-byte; column widths persist; Traffic still works on its own table (not yet converted).

### Phase 4 — Presets + Traffic conversion (1–2 days)
Named layouts; convert Traffic to `DataGrid`.

**Total ~8–11 days.** Phase 0 can invalidate everything after it, which is the point of running it first.

---

## 9. Open questions for Jeff

1. **Timed breaks: Spots pane or Clocks pane?** They belong to a clock, so a station-wide Spots pane showing one clock's breaks is confusing. I propose Spots owns spot *categories*, Clocks keeps *breaks*. (§2.1)
2. **Shadow sweep scope** — shell + six panes only (recommended), or all 77 files including StudioPro's 35?
3. **Does v2 replace v1's fixed layout, or coexist?** Coexisting means maintaining two shells; replacing means the fixed layout disappears once docking lands. I lean replace, after one release of overlap.
4. **Is 2.49 MB → ~2.55 MB acceptable** for dockview + TanStack? The bundle already warns on every build.
5. **If the spike fails §5.4**, do you want the App state decomposition (audit refactor #4) as the next project, or a simpler non-docking improvement to v1?

---

## 10. Compliance

- **Design only.** No code, no dependency installed, nothing changed.
- **Assumptions corrected with receipts** — §0.1 the app is already flat, §0.2 colour tokens already exist, §0.3 nothing is installed.
- **Compose over rebuild** — §2, and the Spots extraction reuses Phase A's proven byte-identical method.
- **Conflict surfaced** — §5 names the existing `App.tsx:1576` re-render path as the risk to the entire plan, with the codebase's own precedent (`MasterOutput.tsx:538`) as the fix, and makes the spike a hard gate rather than a formality.
- **Honest UI** — §3.1 makes "a colour used decoratively is a bug" a rule; §4.1 makes the empty state a required prop.

---

## 11. Phase 0 spike — RESULT (2026-08-10)

Run by driving the spike in a browser (`spike.html`, standalone entry — `DockSpike` touches no
`window.ether`, so it needs neither the Electron shell nor the account gate).

### §5.4 render isolation — **PASS, with the control condition**

| Condition | Tick (4 Hz) | Workspace renders | Panes |
|---|---:|---:|---|
| **Guard ON** (memo + stable prop) | 30 | **0** | 0/0/0 |
| **Guard OFF** (control) | 29 | **30** | 0/0/0 |

Guard off, the workspace tracks the tick 1:1. Guard on, it renders **zero** times across 30 ticks
while a pane is dragged. The control condition is what makes this evidence rather than a fast
machine: removing the memo *does* break it, so the memo is demonstrably doing the work.

**Unexpected bonus:** pane content rendered **0 times in both conditions**. dockview renders panels
into their own roots, so even an unmemoised shell re-render does not cascade into pane bodies. The
architecture isolates more than the design assumed.

### Other criteria

| Criterion | Result |
|---|---|
| 1. Mounts in our stack (Vite + React 18) | **PASS** — no new build warnings |
| 2. Drag / dock / close | **PASS** — a drag re-docked Categories into the Clocks group (3 groups → 2) |
| 3. Serialise → reload → identical | **PASS** — saved, closed a panel, restored: layout string identical |
| 4. Theming reaches it | **PASS** — `--dv-*` CSS variables; the dark theme sits correctly against our palette |
| 5. Render isolation | **PASS** — above |

### NOT measured — stated rather than assumed

**Frame rate during drag.** The FPS readout stayed at 0 throughout: `requestAnimationFrame` is
throttled in a non-foreground browser tab, so the instrument could not run. **The ≥55 fps criterion
is unverified.** The render-count result is the load-bearing half and it passed, but smoothness under
drag in the packaged Electron renderer still needs a human. Cheap to check when 4.4.173 is installed:
Menu → 🧪 Dock Spike (temp).

**Packaged renderer.** All measurements were taken in a browser via the Vite dev server, not in the
packaged Electron app. dockview is pure DOM with no Electron-specific surface, so the risk is low —
but "low" is not "verified".

### Corrections to this document, found by running it

1. **§1.1 named the wrong package.** dockview v8 made `dockview` a framework-agnostic re-export of
   `dockview-core`. React needs **`dockview-react`** (which depends on `dockview`). Installing only
   `dockview`, as written, yields no components.
2. **§1.1 underestimated the bundle by ~6×.** Estimated "~45–55 KB min+gz". Measured, on the real
   build: **660.3 → 743.4 KB gzip (+83 KB)**, 2.49 → 2.77 MB raw (+398 KB). That is open question 4,
   answered with a number.

### Verdict

**Phase 0 passes on every criterion that could be measured**, including the control condition that
makes the isolation result trustworthy. The remaining gate is the +83 KB gzip decision (open
question 4) and a human eye on drag smoothness in the packaged app.

### Phase 0 CLOSED — 2026-08-10 (Jeff)

Both open items from the run above are settled:

- **Packaged-app validation: PASS.** Drag confirmed fast and smooth in the packaged Electron
  renderer (4.4.173), and render isolation reproduced there **with the control condition** — the
  guard-off case does climb with the tick, so the memo is doing the work, not the machine. This
  closes the two "NOT measured" gaps: frame rate under drag, and the packaged renderer.
- **Bundle cost ACCEPTED.** +83 KB gzip (660.3 → 743.4 KB) is approved. Open question 4 is resolved;
  dockview-react is the shell, flexlayout-react is no longer a candidate.

**Phase 1 proceeds.** The render-guard pattern the spike proved is the pattern the real shell uses,
and the counter instrumentation survives behind a dev flag so the property stays *measured* rather
than assumed the first time someone adds a prop without `useCallback`.

---

## 12. Phase 1 defects found in 4.4.174 — fixed in 4.4.175

### 12.1 Clicking a clock did nothing — panes never re-rendered

**Cause, mine.** The first shell had panes read the model through a **ref**, to avoid rebuilding
dockview's component map. But mutating `ref.current` re-renders nothing, so panes never received new
props: the hub's selection updated and `ClocksTab` never saw the new `clockId`.

**The tell was in the Phase 0 spike and I misread it.** Pane render counts of `0/0/0` were recorded
as a bonus finding — "dockview isolates pane content too". They were not isolation. They were panes
that never update. A zero that flatters the design deserves more suspicion than one that doesn't.

**Fix: React context, provider OUTSIDE the memoised shell.**

```
<ModelCtx.Provider value={model}>   ← re-renders when data changes
  <Workspace onReady={…} />          ← memo, NO data props → still flat under deck ticks
    └─ dockview → panes useModel()   ← context consumers DO re-render
```

**Verified, not assumed:** `dockview-react` renders panels with **`createPortal`** and never
`createRoot` (checked in the shipped bundle). Portals keep panels in the same React tree, and context
updates cross `memo` boundaries by design — so panes stay live while the dockview tree stays still.

`Workspace` now takes no data props at all. The shape is the guard.

### 12.2 The X closed a pane permanently

No way back. Added a **Panels** menu — a checklist of every pane, generated from one `PANELS` array
so a pane cannot exist without a way to reopen it — plus Reset layout in the same menu and in the
header. The button turns amber and reads "Panels (N hidden)" when anything is closed, so a missing
pane reads as recoverable rather than lost.

Closing a pane cannot break the others: selection and linking live in the hub, not in any pane.

### 12.3 Reset Layout signed the operator out

`window.location.reload()` dropped App's **in-memory** `accountSignedIn` (`App.tsx:571`), the account
gate re-evaluated, and the operator landed on the sign-in screen. A layout control took the session
down with it.

**Fix: reset in place.** Clear only `schedule_layout_v1`, remove the panels, rebuild the default
arrangement through the dockview API. No reload, no navigation, session untouched.

### 12.4 Storage / reload audit

No `localStorage.clear()` or `sessionStorage.clear()` anywhere in `src/` or `electron/`. Nine
reload/navigation sites:

| Site | Verdict |
|---|---|
| `ScheduleWorkspace.tsx:200` | **was the bug — removed** |
| **`App.tsx:2023`** — the hamburger's Reset Layout | **SAME DEFECT, PRE-EXISTING.** `const resetLayout = () => { window.location.reload(); }` — wired at `:2617`. Takes the session down exactly as ours did. **Not fixed here** (outside this task); the canvas engine already has `canvasEngine.resetLayout()`, so the in-place fix is available |
| `main.tsx:45`, `HealthMonitor.tsx:106` | error-boundary recovery — reload IS the remedy. Correct |
| `OnboardingFlow.tsx:723` | post-sign-in reload; intentional, and the session is being established rather than dropped |
| `DebugPanel.tsx:156`, `devGlobals.ts:60` | developer tools, not operator-reachable |
| `BetaProgram.tsx:137,250` | `mailto:` — opens a mail client, does not navigate the app |

**One real finding beyond the reported bug: `App.tsx:2023`.** Any operator clicking Reset Layout in
the ≡ menu can be signed out the same way.

### 12.5 VERIFIED 2026-08-10 (Jeff, 4.4.175)

All three defects confirmed fixed in the running app: clicking a clock loads its grid, panes close
and reopen from the Panels menu, and Reset Layout restores the default arrangement in place without
touching the session.

**Phase 1 is complete and runtime-verified.** The docking shell, layout persistence, the render
guard, context linking and the inline advisor are all live.

**Still open from the audit:** `App.tsx:2023` — the ≡ menu's Reset Layout is still
`() => window.location.reload()` and signs the operator out the same way ours did. Same defect
class, pre-existing, not touched by this work.

---

## 13. Design decisions — RESOLVED (Jeff, 2026-08-10)

**Q1 — timed breaks: Spots pane or Clocks pane?**
**Timed breaks STAY in the Clocks pane.** They belong to a clock, so a station-wide Spots pane
showing one clock's breaks would be confusing. The **Spots pane owns spot categories only** —
station-wide traffic buckets, which is genuinely station-scoped data.

**Q2 — shadow sweep scope?**
**Shell + six panes only**, as recommended. StudioPro's 35 shadows are a separate cosmetic pass with
its own risk; bundling them would make both harder to review.

Q3 (v2 replaces v1's fixed layout?), Q4 (bundle — ANSWERED, accepted §11) and Q5 (spike failure
contingency — moot, it passed) remain as recorded.

---

## 14. Phase 2 — RESULT (2026-08-10, 4.4.176)

Shipped: Spots pane, Jingles pane, `LAYOUT_VERSION` 1 → 2. Verified by Jeff.

### 14.1 The Spots pane is the SHIPPED manager, hosted — not a new pane

§2.1 and Jeff's ruling both described a Spots pane doing category CRUD against
`ether.spotCategories.*`. That pane was started, then abandoned mid-build: `src/components/Spots.tsx`
— the shipped **Spots & Promos** manager, on the main menu since long before this project — already
owned `addCat` / `saveCat` / `removeCat`, including the same confirm-with-consequences delete text
the Clocks card used.

Building the specified pane would have produced a **third editor for one table** (Spots & Promos,
the ClocksTab card, and the new pane). The deviation delivers the ruling's substance — the Clocks
pane no longer manages categories, the Spots surface does — without the duplicate.

Cost of the miss: one component written and deleted. **The search that would have prevented it is
the one CLAUDE.md already mandates** ("search for prior implementations first"). It was run against
`ClocksTab` and the design doc, not against the feature name.

`Spots.tsx` gained exactly one optional prop, `onMutated`. Unhosted it is unchanged.

### 14.2 What did NOT move

| Thing | Lives | Why |
|---|---|---|
| Spot categories | Spots pane | Station-wide |
| **Timed breaks** | **Clocks pane, untouched** | A break belongs to its clock (Jeff's ruling, §13) |

`hideSpotCategories` is passed by the **docking shell alone** — confirmed across all four
`<ClocksTab>` call sites. The tabbed view, both popouts and v1's Fixed layout keep the card, because
none of them has a Spots pane to send you to.

The clock editor still receives the category list: the segment picker, break defaults, break rows
and the **⚠ 0 eligible spots** warning (v4.4.83) all name categories. That warning is computed in
`ClocksTab` from the `spots` table, so `spotCatsProp` is in its loader's deps — a category change in
the Spots pane re-checks it. A warning whose only job is to be true must not go stale.

### 14.3 Jingles

`JinglesPanel` hosted via the same optional-prop pattern. It self-fetches pools, overlay songs and
the fallback; only its two writes to the hub-owned `categories` table (`assignCategory`, `setHours`)
call `onMutated`. The JINGLES push-up remains the canonical imaging home per CLAUDE.md — this is the
same panel beside the clocks it feeds, not a rival surface.

### 14.4 Layout v2 — the fallback is now tested, not reasoned about

Parse/serialize moved to `src/components/schedule/layoutStore.ts` (pure: no React, no window, no
IPC) with **6 tests**, including the exact v1 payload 4.4.174 wrote, a future-version payload, and
every corrupt shape.

The reason it is tested rather than argued: **this branch had never executed.** v1 was the only
version that had ever existed, so no operator had ever loaded a stale layout — and this release
fires the path on every install at once. A branch whose first execution is simultaneous across the
fleet is not one to verify by reading.

Version lives **inside** the payload, not in the KV key, so an upgrade overwrites the old layout
instead of orphaning a row per version forever.

### 14.5 Default layout: three columns, five panes

Spots and Jingles open as **tabs** in the Categories group (`direction: 'within'`, `inactive: true`
— both confirmed against dockview's shipped typings, not assumed). Five columns at the 220px floor
needs 1100px before any pane is usable, and both are surfaces consulted *while* building a clock.
Opening them rather than leaving them shut also stops the Panels button reading "2 hidden" on a
fresh layout — announcing a problem that isn't one.

### 14.6 Carried forward

- `spotCatCounts` in `ClocksTab` is now read only by the hidden card: dead in the shell, live in the
  tabbed view. Left alone deliberately — removing it would touch both paths for no user-visible gain.
- Rotation Analytics remains a link, not a pane (Phase 3).

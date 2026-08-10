# Schedule Manager — design
**Date:** 2026-08-10 · **Status:** DESIGN ONLY — no code written, nothing changed. For Jeff's review.
**Scope:** one workspace where Shows, Clocks and Categories are edited together, with context linking and an inline rotation-goals verdict. Additive; nothing about generation or playout changes.

---

## 0. Three corrections to the brief, before anything else

### 0.1 They are not three separate navigations — they are already one component with three tabs

`Schedule → Clocks / Shows & Dayparts / Categories` all fire the **same** panel and differ only by a tab hint:

```js
// electron/main.js:2403-2405
{ label: "Clocks",           click: () => { send("nav:clocks"); send("nav:scheduler-tab:clocks"); } },
{ label: "Shows & Dayparts", click: () => { send("nav:clocks"); send("nav:scheduler-tab:shows"); } },
{ label: "Categories",       click: () => { send("nav:clocks"); send("nav:scheduler-tab:categories"); } },
```
```jsx
// src/App.tsx:2678
{panel === "clocks" && <Scheduler defaultTab={schedulerTab} />}
```

**This makes the project smaller and safer than the brief assumes.** It is not a merge of three surfaces; it is **tabs → simultaneous panes** inside one component that already owns all three.

### 0.2 The clock editor you named is dead code

`src/components/ClockEditor.tsx` (755 lines) has **no importer anywhere in `src/`** — same condition as the `MenuBar` removed today. The real clock editor is **`ClocksTab`, an inner component of `Scheduler.tsx` at line 784**.

Designing against `ClockEditor.tsx` would have produced a hub wired to a component the product never renders. Recommend deleting it in the same sweep as the `MenuBar` cleanup (separate, trivial).

### 0.3 There is a *second* Shows editor

`ProgramLog.tsx:1444` defines `ShowsDaypartsModal` — a full shows/dayparts editor in a popup, reached from `ProgramLog.tsx:941` ("⚙ Shows & Dayparts"). So shows are editable in **two** places today with two implementations.

The hub must not become the third. §6 addresses this.

---

## 1. Inventory — what exists and will be composed

### 1.1 `src/components/Scheduler.tsx` — 1,679 lines, contains all three editors

| Inner component | Line | Owns (state) | Writes via |
|---|---|---|---|
| `ShowsTab` | 150 | `shows`, `clocks`, `editing` | `ether.shows.updateById` (:174, :194), `.create` (:179), `.deleteById` (:200) |
| `CategoriesTab` | 313 | `cats`, `editing`, scan state | `ether.categories.updateById` (:367), `.create` (:372), `.delete` (:391) |
| `ClocksTab` | 784 | `clocks`, `selected`, `slots`, `cats`, `spotCats`, `breaks`, `spotCatCounts`, `breakEligible` | `ether.spotCategories.*` (:840-855), `ether.clockBreaks.*` (:934-942), slot writes |

Props already present (`:73-82`):
```ts
defaultTab?: "shows" | "categories" | "clocks";
embedded?: boolean;   // omits wrapper chrome (title, Create-Show, tab bar)
```

**`embedded` is the hosting affordance the hub needs, and it already exists and is already exercised** — `PopoutRenderer.tsx:130/133/136` renders each tab as its own popout window, and `App.tsx:4054` embeds one in the programming panel. The hub is, in effect, those three popouts in one window with links between them.

### 1.2 The advisor — how goal data reaches the renderer today

```
electron/library-health.js  goalCheck(db, sid)          ← per-clock target vs slots (Phase 1)
        └─ computeStation() → snapshot.goals
electron/library-health.js:470   computeAll() every 120 s
electron/main.js:596        ipcMain.handle("library-health:get") → _libHealth.snapshot()
src/components/HealthMonitor.tsx:293   polls that handle every 30 s
```

**This is a whole-station, pull-based snapshot on main's own 120-second cadence.** It is the correct source of truth — and it cannot satisfy "editing a clock updates its advisor verdict live" as-is: an edit would take up to 120 s to appear. §3.3 solves this without a second implementation.

### 1.3 Write paths — shared with the remote web editor

The tabs write through the ordinary sync-handler IPC (`window.ether.<table>.create/updateById/delete`). The dashboard's remote edits arrive on a different rail and converge on the same tables:

```
dashboard → POST /api/cmd → SSE /api/cmd-stream → install execCmd → applyDbMutation
desktop   → pushCcTable(...) → POST /api/account/data/sync   (App.tsx:935)
```

`App.tsx:935` pushes `["categories","clocks","clock_slots","shows","spots"]` on mount and on a periodic refresh. **Scheduler's own edits do not push the mirror** — they rely on that refresh. The hub must preserve exactly this, and must not introduce a fourth write path.

---

## 2. What the hub is

A new panel, `schedulehub`, rendering a **fixed three-pane workspace**:

```
┌─────────────────────┬──────────────────────────────┬────────────────────┐
│ SHOWS               │ CLOCK                        │ CATEGORIES         │
│ which clock airs    │ the hour grid for the        │ targets + library  │
│ when                │ selected show's clock        │ depth              │
│                     │                              │                    │
│ ▸ Morning Drive     │  ⓘ Feel Good target 4/hr,    │ Feel Good  4/hr    │
│   Open Format ●     │    11 slots — over by 7      │   37 songs · thin  │
│ ▸ Overnight         │                              │ Hits       4/hr ●  │
│                     │  [hour grid]                 │   9 songs          │
└─────────────────────┴──────────────────────────────┴────────────────────┘
                                    → Open in Rotation Analytics
```

**Panes are hosted, not reimplemented** — each is the existing `ShowsTab` / `ClocksTab` / `CategoriesTab`, rendered with `embedded`.

---

## 3. Shared state — the hard part, designed explicitly

### 3.1 The problem the brief correctly identifies

Today each tab is mounted alone, so independent fetching is invisible. Put all three on screen at once and it becomes three bugs:

- `clocks` is fetched by **both** `ShowsTab` (:151) and `ClocksTab` (:784)
- `cats` is fetched by **both** `CategoriesTab` (:313) and `ClocksTab` (:787)
- An edit in one pane leaves the others showing stale data until remount

### 3.2 The design: one hub store, one refresh path

A hub-scoped store (`useScheduleHub`) owns the shared entities and the selection, and is the **only** thing that fetches them:

```
                    ┌──────────────────────────────┐
                    │  useScheduleHub (hub-scoped) │
                    │  shows, clocks, categories   │
                    │  selection {showId, clockId, │
                    │             categoryId}      │
                    │  advisor (goalCheck result)  │
                    │  revision: number            │
                    └───────────┬──────────────────┘
                 ┌──────────────┼──────────────┐
             ShowsPane      ClockPane     CategoriesPane
                 └──────────────┴──────────────┘
                         onMutated()  ──► refresh()  ──► revision++
```

Rules:
1. **One fetcher.** The store loads shows, clocks, categories, clock_slots. Panes receive them as props and never fetch shared entities themselves.
2. **One refresh path.** Any pane that writes calls `onMutated(tables)`. The store re-reads and bumps `revision`. There is no per-pane invalidation and no cross-pane messaging.
3. **Writes stay where they are.** Panes keep calling the same `ether.<table>.*` IPC. The store is a *read* cache and a selection bus — it is deliberately **not** a write layer, because the write paths are shared with the remote editor (§5) and must not fork.
4. **Selection is state, not navigation.** Selecting a category does not change panels; it sets `selection.categoryId`, and panes derive highlighting from it.

### 3.3 Live advisor without a second implementation

The brief requires "same numbers, never a second implementation" — and the current path is a 120-second station-wide sense (§1.2). Those conflict.

**Resolution: expose the existing function on demand; do not copy it.**

```
NEW: ipcMain.handle("library-health:goals", (_, stationId) => _libHealth.goalCheck(db, stationId))
```

`goalCheck` is already exported from the factory (done in Phase 1 for the bench). This adds an on-demand entry point to **the same function** — one implementation, two cadences:

| Consumer | Path | Cadence |
|---|---|---|
| Station Health | `library-health:get` → snapshot.goals | 120 s sense, 30 s poll |
| Schedule Manager | `library-health:goals` → `goalCheck()` | on mount + after any clock/category mutation |

Cost measured: `goalCheck` is a handful of indexed reads (Phase 1 diag returned in well under the 108 ms the whole analytics snapshot took). Safe to call per edit; it must **not** be called per keystroke — only on committed mutations.

### 3.4 Context linking, derived not stored

| Interaction | Mechanism |
|---|---|
| Select a category → highlight clocks that use it | derive from already-loaded `clock_slots`; no fetch |
| Select a category → show library depth | from `snapshot.depth` (existing `depthCheck`), already in the health snapshot |
| Select a show → focus its clock | `selection.clockId = show.clock_id` |
| Edit a clock → advisor updates | `onMutated(["clock_slots"])` → refresh + `library-health:goals` |

---

## 4. Composition — what each pane needs

| Pane | Host as | Modification required |
|---|---|---|
| Shows | `ShowsTab` | **Yes** — see 4.1 |
| Clock | `ClocksTab` | **Yes** — see 4.2 |
| Categories | `CategoriesTab` | **Yes** — see 4.3 |

The three are **inner, non-exported** components of `Scheduler.tsx`. That is the single structural blocker.

**4.0 — Export the three inner components.** Either export them from `Scheduler.tsx`, or (preferred) move each into its own file — `ShowsTab.tsx`, `ClocksTab.tsx`, `CategoriesTab.tsx` — with `Scheduler.tsx` re-exporting so **the existing tabbed panel keeps working byte-identically** (§5). This is a move, not a rewrite: no logic changes.

**4.1 `ShowsTab`** — accept optional `shows`/`clocks` props and `onMutated`; when absent, fall back to fetching itself (so the legacy tab is untouched). Accept `selectedShowId` + `onSelectShow`.

**4.2 `ClocksTab`** — same prop-or-fetch pattern for `clocks`/`cats`. Accept `clockId` as a controlled selection (it currently owns `selected` internally, :785). Accept an optional `advisor` prop to render the inline verdict; when absent, render nothing (legacy tab unchanged).

**4.3 `CategoriesTab`** — same for `cats`; accept `selectedCategoryId` + `onSelectCategory`, and an optional `depth` prop for the library-depth facts.

**Every modification is additive and optional-prop-shaped.** With no props supplied, all three behave exactly as today — which is what keeps §5 true.

---

## 5. Additive — what must keep working

| Must not break | Why it holds |
|---|---|
| `Schedule → Clocks / Shows / Categories` menu items | Unchanged. `<Scheduler defaultTab=…>` still mounts and still owns the tab bar |
| The three **popout windows** (`PopoutRenderer.tsx:130/133/136`) | Unchanged — they render `<Scheduler embedded>`, which still exists |
| The embedded programming panel (`App.tsx:4054`) | Unchanged |
| **Remote web editing** (`app.ether-technologies.com`) | The hub adds **no write path**. Panes call the same `ether.<table>.*` IPC; `applyDbMutation` and the `/api/cmd` → SSE rail are untouched; `pushCcTable` (App.tsx:935) keeps mirroring the same five tables |
| **Live deck editing / rotation** | The hub touches no engine, queue, deck or `generated_schedule` state. It edits `shows`, `clocks`, `clock_slots`, `categories`, `clock_breaks` only — schema the daemon reads but this surface never writes at playout time |
| Generation / playout | Nothing. No change to `_generateDayRows`, `scheduler-core`, `loggen`, or any write path they use |

**The hub is a second door onto the same rooms.** v1 ships alongside the tabbed panel; neither replaces the other. If the hub proves out, retiring the tab bar is a later, separate decision.

---

## 6. Conflicts with standing rulings and audit findings

**6.1 — Renderer debt (audit §2.6).** The audit found *"no data layer — every component calls `(window as any).ether.invoke` directly"*, and named a typed IPC layer as refactor #3. A hub store is exactly that pattern, but for one feature.

**Flagged, not designed over:** `useScheduleHub` should be the **first instance** of that data layer, not a fourth ad-hoc pattern. It should be a plain typed module (`src/lib/scheduleData.ts`) that the store consumes — so the next feature can reuse it. If you'd rather keep v1 minimal, the alternative is an untyped hub store, and the debt grows. **Recommend the typed module; it is perhaps 60 extra lines.**

**6.2 — `App.tsx` is 6,072 lines** (after today's `MenuBar` removal). The audit's refactor #4 is decomposing it. The hub must add **only** a route line and an import — the store and panes live in their own files. No hub logic in `App.tsx`.

**6.3 — Two Shows editors (§0.3).** `ShowsDaypartsModal` (`ProgramLog.tsx:1444`) is a parallel implementation. The hub hosting `ShowsTab` makes it the **third** surface for editing shows, though only the second implementation. Not a blocker for v1, but it is the "doors before rooms" hazard inverted — too many doors onto one room, each behaving slightly differently. **Recommend: after the hub ships, point `ShowsDaypartsModal` at `ShowsTab` and delete its duplicate logic.** Out of scope for v1; recorded so it is not forgotten.

**6.4 — No conflict with the clock-law ruling or the goal-driven arc.** This is an editing surface over existing schema. It changes no selection logic. The advisor is read-only and reuses `goalCheck`.

**6.5 — Dead code found during inventory:** `ClockEditor.tsx` (755 lines, no importer). Recommend deletion; not part of this build.

---

## 7. Deliberately cut from v1

**No docking, no drag-resize, no saved layouts.** Fixed three-pane grid, CSS only.

**What adding `dockview` later would cost**, if ever wanted:
- **Dependency:** ~50 KB gzipped, its own CSS, and a theme to match the existing dark tokens. The renderer bundle is already 2.49 MB and warned about at build time.
- **State:** docking implies persisted layouts, which implies a layout store, migration of saved layouts across versions, and a "reset layout" path. The canvas system already has `resetLayout` — two layout systems would then exist.
- **Coupling:** panes become independently mountable/unmountable, so the hub store must tolerate a pane not existing. The v1 design already keeps panes prop-driven and stateless-ish, so this is the cheap part.
- **Honest estimate:** ~2–3 days for docking itself, plus an ongoing tax on every future pane. **Not worth it until an operator asks for it**, and the fixed layout tells us whether they do.

**Rotation Analytics is linked, not embedded.** A button that routes to the existing panel. Embedding it is v2.

---

## 8. Phased build plan

### Phase A — extraction, zero behaviour change (½ day)
Move `ShowsTab` / `ClocksTab` / `CategoriesTab` into their own files; `Scheduler.tsx` imports and re-exports them. **No logic touched.**
*Gate:* the tabbed panel, all three popouts, and the embedded programming panel behave identically. Screenshot diff of each.

### Phase B — the store (1 day)
`src/lib/scheduleData.ts` (typed reads) + `useScheduleHub` (entities, selection, `revision`, `onMutated`). Not yet wired to any UI.
*Gate:* unit-testable pure parts benched; no UI change at all.

### Phase C — the hub, read-only (1 day)
New panel `schedulehub`, three panes fed from the store, selection linking working, **editing still routed through each pane's existing write calls**. Advisor shown from `library-health:goals`.
*Gate:* a clock edit refreshes the other panes and the verdict within one refresh cycle.

### Phase D — doors + help (½ day)
Menubar `Schedule → Schedule Manager`, hamburger NAVIGATE entry, `nav:schedulehub` → panels map, `docs/help-schedule-manager.md`, HelpPanel entry.
*Gate:* reachable from **both** menus — the failure that cost us two rounds today.

**v1 = A + B + C + D.** Roughly three days.

---

## 9. Test plan

**Regression — the additive promise**
1. `Schedule → Clocks / Shows / Categories`: each still opens the tabbed panel on the right tab.
2. All three popout windows still open and edit correctly.
3. The embedded programming panel (`App.tsx:4054`) unchanged.
4. **Remote editing:** edit a category on `app.ether-technologies.com` → confirm it lands locally; edit locally → confirm it appears on the dashboard after the refresh. Same before and after.
5. **Live decks:** with automation running, add a song to a deck and edit rotation while the hub is open. Both must work, and the hub must not disturb either.

**Hub behaviour**
6. Select a category → clocks using it highlight; its depth facts show.
7. Select a show → the clock pane focuses that show's clock.
8. Add a music slot to a clock → the advisor verdict updates without a manual refresh, and matches Station Health → Rotation goals **exactly**.
9. Delete a category used by a clock → both other panes reflect it.
10. Open the hub with no shows / no clocks / no categories — three honest empty states, no crash.

**Gates**
`npx tsc --noEmit` (2 baseline) · `node --check` on touched main files · `npm run build` · `npm run check:audio-isolation` · the audiod smokes · `scripts/smoke-goal-advisor.js` (the advisor must not have drifted) · `scripts/prove-of-regen-fix.js` (clock law intact).

---

## 10. Decisions — RESOLVED (Jeff, 2026-08-10)

| # | Question | Answer |
|---|---|---|
| 1 | Typed data module, or untyped hub store? | **Typed data module now** — `src/lib/scheduleData.ts` in Phase B. First instance of the audit's refactor #3 |
| 2 | Delete `ClockEditor.tsx`? | **Yes** — deleted in Phase A (755 dead lines) |
| 3 | `ShowsDaypartsModal` (ProgramLog)? | **Keep for now**, retire in v2 |
| 4 | Hub replaces the tab bar, or coexists? | **Coexist** — so Phase A's re-export shim is permanent, not temporary |
| 5 | Who owns "Create Show"? | **The Shows pane** |

### ✅ Phase A COMPLETE — 2026-08-10

`Scheduler.tsx` **1,679 → 245 lines**. Three tab bodies moved verbatim into `src/components/scheduler/`:

| File | Lines | Source range |
|---|---|---|
| `types.ts` | 33 | Show / Category / Clock / ClockSlot |
| `shared.ts` | 31 | HOURS, DAYS, CLOCK_SLOT_TYPE_OPTIONS, fmtHour, fmtClockPos |
| `ShowsTab.tsx` | 170 | 148-305 |
| `CategoriesTab.tsx` | 163 | 311-462 |
| `ClocksTab.tsx` | 1,066 | 605-674 + 677-759 + 782-1679 (TalkPicker, SegmentPicker, ClocksTab) |

**Byte-identity verified by diff, not asserted:** `ShowsTab`, `CategoriesTab`, `TalkPicker`, `SegmentPicker` IDENTICAL; `ClocksTab` identical apart from one trailing newline. Extraction was done by a script copying exact line ranges — no hand-editing of any moved body.

`Scheduler.tsx` is now a compatibility shim: it keeps the tab chrome, `useSwipe`, and the dead `ClockWheel` island, imports the three tabs, and **re-exports them plus the types** so the hub has one import site per tab. Duplicate constant definitions were deleted rather than left in both files, so the two copies cannot drift.

**Deliberately not moved:** `SLOT_TYPES`, `slotColor`, `slotLabel`, `ClockWheel`, `ClockSkeleton`. These are a dead island — `ClockWheel` is the only consumer of `slotColor`/`slotLabel` and is itself never rendered, and `ClocksTab` defines its own local `slotColor` at (pre-split) line 1107. Left untouched to keep Phase A a pure move; flagged for a later sweep.

**Gates:** `tsc --noEmit` 2 baseline · `npm run build` ✓ · `check:audio-isolation` ✓ · 50 unit tests ✓ · goal-advisor ✓ · parity fuzz ✓.

**Not yet verified at runtime** — no app launch. The tabbed panel, the three popouts and the embedded programming panel need a visual check before Phase B.

---

## 10b. Original open questions (for the record)

1. **§6.1 — typed data module now, or untyped store?** I recommend typed; it is the audit's refactor #3 arriving one feature at a time.
2. **§0.2 / §6.5 — delete `ClockEditor.tsx`** (755 dead lines) in the same sweep?
3. **§6.3 — is `ShowsDaypartsModal` in ProgramLog still wanted?** If not, the hub makes it redundant and it can be retired in v2.
4. **Does the hub replace the tab bar eventually, or coexist permanently?** v1 coexists either way; the answer only affects whether Phase A's re-export is temporary or permanent.
5. **Which pane owns "Create Show"?** Currently the tabbed wrapper's chrome, omitted by `embedded`. The hub needs its own affordance.

---

## 11. Compliance

- **Design only.** No code written, no files changed.
- **Composition over rebuild** — every pane is the existing component; all modifications listed in §4 are additive optional props.
- **Assumptions corrected, not built over** — §0.1, §0.2, §0.3.
- **Conflicts surfaced** — §6, including the audit's renderer-debt finding rather than quietly adding a fourth pattern.
- **Nothing about generation or playout changes**, and the remote-editing and live-deck constraints are addressed explicitly in §5.

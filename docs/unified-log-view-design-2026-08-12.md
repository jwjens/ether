# Unified Log View — schedule, as-run and editing in one place

**Date:** 2026-08-12 · **Status:** DESIGN ONLY — no code written, nothing changed.
**Builds on:** the spreadsheet day view shipped in 4.4.200 (`BroadcastCalendar` on `DataGrid`), manual
log editing (4.4.196), and the designation/Phase B work (4.4.201).
**Governing docs:** `docs/manual-log-editing-design-2026-08-10.md`,
`docs/schedule-manager-v2-design-2026-08-10.md` §4.1, `docs/help-logs.md`.

---

## 0. THREE FINDINGS THAT SHAPE THE WHOLE DESIGN

Read these before the layout sections. Two of them mean the brief's item 6 ("the log includes played
rows — no separate Play Log page") cannot be built as stated today.

### 0.1 `play_log` has NO link back to `generated_schedule`

`audiod/playlog.js:41`, in the row the daemon inserts on every air:

```js
scheduled_log_id: null, show_name: null, category_code: null, programming_row_id: null,
```

Both foreign-key columns exist in the schema and are **hardcoded null on every write**. So there is
no key joining "what aired" to "what was scheduled". The only shared surface is
`file_path` + `played_at` vs `scheduled_at` — a **fuzzy, time-proximity match**.

**Why that matters more than usual here:** `play_log` is the as-run affidavit
(`docs/help-logs.md` — Export CSV, BMI, ASCAP; `file_path` is the v19 affidavit join key). A view
that fuzzy-matches airs to scheduled rows and presents the result as one merged log is inventing a
correspondence the data does not contain, in the one place where being wrong has a legal shape.

**Recommendation — Phase 0, and it is small:** populate `programming_row_id` at air time. The daemon
*already knows* the row: `engine.js` tracks `generated_schedule.id` per deck (`this.deckSchedId`,
the Phase-1 shadow stamp) and uses it to stamp `state`/`played_at`. Passing that same id into
`logPlay()` turns every subsequent design decision from a heuristic into an exact join. Nothing else
in this document is as valuable per line of code.

### 0.2 `state` and `played_at` are LOCAL-ONLY and do not sync

`synced-tables.js:324-327` marks `state`, `played_at`, `seq` and `source` as `local-only`, so
`serializePayload` strips them from every mutation, both directions. That was the right call — a
playhead must not CRDT-merge.

**The consequence for a unified view once sync is on:** a machine that syncs the schedule down gets
the **rows** but not the **outcome**. Every row on the non-designated machine will read **PENDING**,
forever, including rows that aired hours ago on the designated machine.

This lands squarely on the stated goal for 4.4.201 ("dev does not generate — it syncs down.
Calendars should match"). The *calendars* will match. The **Status column will not**, and on dev it
will be wrong rather than merely absent.

**Options, for Jeff to pick (§8.1):**

- **A. Accept and label it.** On a machine that is not the designated generator, the Status column
  shows **"—" / "not observed here"** rather than PENDING. Honest, zero schema change, and the view
  stops claiming knowledge it does not have.
- **B. Sync the as-run separately.** `play_log` *is* synced (it is in the registry and not
  `syncExcluded`). Pull status from `play_log` rather than from `generated_schedule.state` — which
  requires 0.1's join key to be exact.
- **C. Make `state` syncable.** Rejected in this document: it reintroduces exactly the last-write-wins
  playhead fight the local-only decision was made to avoid.

**B is the recommendation, and it depends on 0.1.** That is the second reason Phase 0 comes first.

### 0.3 There are already three log surfaces, and this would be the fourth

| Surface | What it is | State |
|---|---|---|
| Calendar day view | the spreadsheet log — plan + editing | **shipped 4.4.200** |
| `ProgramLog.tsx` | hour-block programming view (~1,470 lines) | shipped, older |
| Play Log page | as-run + affidavit/BMI/ASCAP exports (`help-logs.md`) | shipped |

Building a *new* "Unified Log View" page alongside these makes the problem it is meant to solve
worse — four doors into the same data, which is the failure `docs/help-jingles.md` and the
doors-before-rooms rule already record twice.

**Recommendation: this is the Calendar growing up, not a new page.** The 4.4.200 day view already has
the columns, the badges, the hour markers, the drag editing, sorting and resizing. The unified view is
that view plus status, filters and the week shell — and then `ProgramLog` is retired or redirected to
it. **The exports stay where they are** (§6).

---

## 1. Layout

One page, two zones, no new door. Route: the existing Calendar.

```
┌─ WEEK ─────────────────────────────────────────────────────────────────────┐
│  ‹  Mon 11 Aug – Sun 17 Aug  ›            [Today]   Station: halloVeen      │
│  ┌──────┬──────┬──────┬──────┬──────┬──────┬──────┐                        │
│  │ MON  │ TUE  │ WED  │ THU  │ FRI  │ SAT  │ SUN  │  ← compact, one row    │
│  │ 288  │ 288  │ 291  │ 286  │ 290  │ 12   │  —   │    items scheduled     │
│  │ ▓▓▓▓ │ ▓▓▓▓ │ ▓▓▓▒ │ ▓▓▒▒ │ ░░░░ │ ░░░░ │      │  ← aired / pending bar │
│  └──────┴──────┴──────┴──────┴──────┴──────┴──────┘                        │
└────────────────────────────────────────────────────────────────────────────┘
┌─ DAY — Wednesday 13 August ────────────────────────────────────────────────┐
│ [✓ Played] [✓ Pending] [✓ Missed] [ Yours only ]   🔍 search   [Export CSV]│
│                                                                            │
│ TIME    TYPE    TITLE                    ARTIST         CATEGORY   STATUS  │
│ ⏤ 2:00 PM ⏤                                                               │
│ 2:00 PM  Song   Dancing Queen            ABBA           Gold       PLAYED  │
│ 2:03 PM  Song   Footloose                Kenny Loggins  Gold       PLAYED  │
│ 2:07 PM  Spot   Acme Motors 30s          —              Spots      PLAYED  │
│ 2:08 PM  Song   YOURS Landslide          Fleetwood Mac  Gold       PENDING │
│ …                                                                          │
└────────────────────────────────────────────────────────────────────────────┘
```

The week strip is **compact and non-scrolling** — seven cells, a count, and a two-tone bar showing
aired vs remaining. Clicking a day loads it below; the week strip stays put. That is the "expand a
day" behaviour in item 9, without a navigation jump.

**Why the day is below and not a modal:** the operator's question is nearly always "what is happening
in this hour" with "which week am I in" as context. Both visible at once, no mode change.

---

## 2. Columns

Unchanged from 4.4.200, because they already work and consistency is the point:

| Column | Width | Notes |
|---|---|---|
| Time | 86 | mono; `▶` marks the row on air |
| Type | 96 | Song / Spot / Jingle / Sweeper / Voice / Cart, from `content_class` |
| Title | 340 | carries the **YOURS** badge; double-click to edit (non-music rows only) |
| Artist | 220 | double-click to edit (non-music rows only) |
| Category | 160 | double-click → dropdown |
| **Status** | 110 | **new behaviour — §4** |
| (controls) | 64 | 📌 pin/release · ✕ delete |

Thin muted type bar on the left edge; zebra rows; 38px/14px; hour separators. All shipped.

**YOURS is not a status, and the brief lists it as one.** A row can be *yours* **and** *played*. They
are different axes: ownership (who put it there) versus outcome (what happened to it). Merging them
into one column loses one of them — most often "this aired", which is the one that matters. So:
**YOURS stays a badge on Title; Status carries PLAYED / PENDING / MISSED / PLAYING only.** Filtering
by "Yours only" is a filter, not a status value (§7).

---

## 3. Hour separators

As shipped: `⏤ 2:00 PM ⏤` full-width, emitted when the hour changes between consecutive displayed
rows, and **hidden under any non-time sort** — grouping by hour is meaningless when rows are ordered
by artist. Unchanged.

---

## 4. Status — what actually aired

### 4.1 Values

| Value | Source | Meaning |
|---|---|---|
| **PLAYED** | `generated_schedule.state='played'` | it aired |
| **PLAYING** | `state='playing'` | on air now |
| **MISSED** | `state='missed'` | scheduled, did not air |
| **PENDING** | `state='pending'` or null | still to come |
| **—** | see §0.2 | this machine did not observe this row |

`missed` is real and already written: the log-reader stamps skipped-past rows when it is BEHIND
(`engine.js:1087`, day-bounded) and the auto-fitter stamps a last-resort drop
(`docs/design-auto-fitter-2026-07-30.md` §3.3). It is not a decorative state.

### 4.2 MISSED is the most valuable cell on the page

PLAYED and PENDING are largely predictable. **MISSED is the one an operator cannot get anywhere else
today** — it is the difference between the plan and the transmitter, and it is currently visible only
as a log line that scrolls past. Rows with MISSED should be visually distinct (a muted red status,
not a red row — a red row on a busy day is noise) and reachable by filter in one click.

### 4.3 Off-log airs

Things air that were never scheduled: hand-loads before the flip, emergency floor fills, jockey
inserts. Those exist in `play_log` with **no** scheduled row.

**They must be visible or the view is not a log.** Shown as their own rows at their `played_at` time,
status **PLAYED**, type from `play_log.content_class`, and marked **OFF-LOG** where the YOURS badge
would sit. Never silently merged into a nearby scheduled row.

**This requires §0.1.** Without `programming_row_id`, "which airs had no scheduled row" is itself a
fuzzy question, and the view would invent off-log rows for airs that were simply matched badly.

### 4.4 The line this view must not cross

**This view is not the affidavit and must never be presented as one.** The affidavit is `play_log`,
exported from the Play Log page, and it stays there (§6). This view is an operator's working picture
that *includes* as-run information. If the two ever disagree, `play_log` is right.

That sentence belongs in the help entry, verbatim.

---

## 5. Editing

Unchanged from 4.4.196/4.4.199/4.4.200 — it already works and is the reason the day view exists:

- **drag to swap** two rows (never a ripple; §3 Layer 4 of the manual-log-editing design)
- **📌 pin / release** — operator ownership, which Generate must not undo
- **✕ delete** — leaves a gap the next Generate refills
- **double-click** Title/Artist (non-music rows only) and Category
- **amber rule warnings** — shown, never blocking

**New constraints this view introduces:**

1. **An aired row is read-only.** Already enforced in the UI *and* in the main process
   (`_guardEditable`). With PLAYED rows now always on screen rather than scrolled past, this guard
   goes from occasional to constant — it must stay in the main process, not become a UI-only check.
2. **Off-log rows are read-only, entirely.** They are `play_log` records of things that happened.
   There is no such thing as editing them.
3. **Drag stays gated on the time sort** (4.4.200) and must now *also* be gated when a filter is
   hiding rows — dragging row A onto row B while rows are hidden between them is a swap the operator
   cannot see the consequences of. **Filters on → drag off**, with the same visible note pattern the
   sort gate uses.

That third point is new and is the main editing risk in this feature.

---

## 6. Play log integration — what actually gets replaced

**Nothing is deleted. One page absorbs a second page's *view*, not its *exports*.**

| Today | After |
|---|---|
| Play Log page — the as-run list | absorbed: PLAYED rows and off-log rows appear here |
| Play Log page — Export CSV / BMI / ASCAP | **stays exactly where it is** |
| Traffic — scheduled spots, aired or not | **stays** — a different question, reconciliation not as-run |
| `ProgramLog.tsx` — hour blocks | retire or redirect here (§8.4) |

The exports stay because they are *documents with byte contracts* (`docs/help-logs.md`: twelve
columns, fixed order), consumed by advertisers and PROs. Moving them under a view whose row set
changes with a filter is how a filtered affidavit gets emailed to an advertiser. **The CSV in item 8
is a different artefact** — see §8 below.

---

## 7. Filters and search

A single row above the grid, all client-side over the loaded day:

- **Played** / **Pending** / **Missed** — three independent toggles, all on by default
- **Yours only** — the ownership axis (§2)
- **Search** — matches Title, Artist and Category, case-insensitive, as you type

**Rules:**

1. **The count must always say what is hidden.** `288 items · 12 hidden by filter` — a filtered view
   that looks like a complete one is how an operator concludes a song is missing from their log.
2. **Filters do not survive a day change.** Carrying "Missed only" into tomorrow shows an empty day
   and reads as a broken calendar.
3. **Filters gate dragging** (§5.3).
4. **No filter can hide an off-log air while claiming to show Played.** Off-log rows are PLAYED.

---

## 8. Export

`DataGrid` already has CSV from the column definitions (`csv.ts`, byte contract tested in
`csv.test.ts`). Reuse it — do not write a second exporter.

**It must be labelled for what it is: a view export, not an affidavit.** Filename
`log-view-<station>-<date>.csv`, and the button sits next to the filters so its scope reads as "what
is on screen". `csv.rows` must be passed **the displayed rows** so the file matches the screen, and
the header block should carry the active filters as a comment line.

If an operator wants the affidavit, they want the Play Log page, and the empty state and help entry
should say so by name.

---

## 9. Week navigation

- `‹` / `›` step one week; **Today** returns.
- Seven compact cells: day name, date, item count, and an aired/pending bar.
- Clicking a day loads it below without leaving the page.
- The current day is marked; a day with **any MISSED row** carries a small marker on the week strip —
  that is the one thing worth surfacing at week level.
- Week data is counts only (`COUNT(*)` + `SUM(state='played')` per day), not rows. A week of four
  stations at ~290 rows/day is ~8,000 rows and must never be loaded to draw seven bars.

---

## 10. Performance

`DataGrid` does not virtualise, deliberately, with a stated revisit point of **~2,000 rows in one
grid** (`DataGrid.tsx` header). A day is ~290 rows — comfortably inside it. **Do not add a "whole
week" row view**: that is ~2,000 rows and lands exactly on the deferred threshold. Week stays counts;
day stays rows. If a week-of-rows view is ever wanted, virtualisation is the prerequisite, not an
optimisation.

---

## 11. Phased build plan

**Phase 0 — the join key.** Populate `programming_row_id` on every `play_log` write from the id the
engine already holds. Nothing user-visible. Everything else depends on it, and it is the smallest
piece here.

**Phase 1 — Status column.** Read `state`, render PLAYED / PLAYING / MISSED / PENDING, and **"—"**
where this machine did not observe the row (§0.2 option A, until B is possible). Day view only. This
alone delivers items 2 and 4 and is independently useful.

**Phase 2 — Filters, search, view CSV.** Items 7 and 8. Includes the hidden-count rule and the
drag-gating.

**Phase 3 — Off-log airs.** Item 6's remaining half. Requires Phase 0 to be landed and verified on a
real day.

**Phase 4 — Week shell.** Items 1 and 9: the compact strip above the day, counts only.

**Phase 5 — Retire `ProgramLog`.** Only after 1–4 are proven, and only with a redirect. Removing a
door people use before its replacement is proven is how a feature "disappears".

---

## 12. Open questions for Jeff

1. **§0.2 — status on a synced-down machine.** A (label it "not observed here"), B (read status from
   `play_log`, needs Phase 0), or C (sync `state` — not recommended)? **Recommendation: A now, B once
   Phase 0 lands.**
2. **§0.3 — is this the Calendar, or a new page?** **Recommendation: the Calendar.** A new page makes
   four doors onto one dataset.
3. **§6 — does `ProgramLog` retire?** It is ~1,470 lines and predates all of this. Recommendation:
   retire in Phase 5, redirect first.
4. **§5.3 — filters gate dragging.** Agreed, or would you rather dragging stayed live and the filter
   cleared itself on drag start?
5. **Does the week strip need per-station rows** (four stations at once), or does it follow the active
   station like everything else? Recommendation: follow the active station; a four-station week grid
   is a different feature.

---

## 13. Compliance

- **Doors before rooms** — no new door; the Calendar absorbs. `ProgramLog` is redirected, not deleted,
  and only after the replacement is proven.
- **Never rebuild what exists** — `DataGrid` for the grid, `csv.ts` for the export, the 4.4.196–200
  editing path unchanged, `play_log` exports untouched.
- **Honest state** — Status shows what was observed, "—" where it was not, and the view says out loud
  that it is not the affidavit. Filters always declare what they hide.
- **No new migration** unless Phase 0 needs one; it should not — `programming_row_id` already exists
  in `play_log`.
- **Ships with its help entry** (`docs/help-unified-log.md`), including the affidavit sentence from
  §4.4 verbatim.

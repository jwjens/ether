# Imaging slice 1 — the surface, read-only. Proposal
2026-09-07 · governed by `docs/imaging-model-redesign-2026-09-06.md` §1 and ruling 5 ("the door is IMAGING")

Nothing built. Read-only investigation, measured against the live profile DB
(`ETH-STN-BAA8-E056-6FC8`, opened readonly) plus source.

---

## 0 · What the data actually holds today — this decides the columns

| view | source | today |
|---|---|---|
| RACK | `library_asset` | **64 SWEEPER** (all with a length), **5 ANNOUNCEMENT** (all five with **no** `duration_ms`), 3 SPOT (not imaging) |
| RACK · pool | `songs.jingle_category_id` | 64 of 64 pooled, **0 unpooled** |
| POOLS | `jingle_categories` | **exactly one pool per station**, type `SWP` |
| ASSIGNMENTS | `categories.overlay_*` | halloVeen: **1** category assigned (`pool`), 1 unassigned. Open Format: **10 unassigned, none assigned** |
| ON DECK | `generated_schedule` | halloVeen **2,895** SWP rows ahead; Christmas in Jully 5,710; **Open Format and Magical Forest: none** |

### Two of the six RACK columns do not exist

The list was: name, type, length, run dates, hour mask, pool membership.

- **RUN DATES — no such column, for any imaging asset.** `library_asset` has none; `asset_sweeper_meta`
  is `(asset_uuid, sweeper_category_id)` only. Dates exist on `asset_spot_meta` (SPOTs, not imaging).
  Announcements have `days` + `trigger_time` — a weekday mask and a clock time, not a run window.
- **HOUR MASK — exists, but not on the asset.** It is `categories.overlay_active_hours`, a 24-bit mask
  on the **assignment** (`electron/main.js:8477` gates the seam hour with it). Hours are a property of
  *category → pool*, not of a cut.

Per the standing rule — *nothing renders unless it is wired; if a column has no data yet, do not draw
the control* — **RACK ships four columns: NAME · TYPE · LENGTH · POOL.** The hour mask appears where it
actually lives, in ASSIGNMENTS. Run dates appear nowhere until a slice adds the column.

---

## 1 · The nav change

`src/App.tsx`, the NAVIGATE list (~line 2965) gains one entry beside Library and Schedule:

```
{ key: "imaging", emoji: "📻", label: "Imaging",
  action: () => setPanel("imaging"), active: panel === "imaging" }
```

Same shape as the eight already there — usage-tracked star, active border, drawer closes on click.
**Top-level destination, not a tab.**

**The push-up stays and becomes a door.** `progPanel === "jingles"` keeps mounting
`<SweepersPanel stationId={lpStationId} />` (App.tsx:4720) exactly as today — it remains the place
where pools and assignments are *edited*. It gains one link: "Open IMAGING →", which calls
`setPanel("imaging")` and closes the dock. The push-up is not duplicated into IMAGING and IMAGING does
not replace it.

## 2 · The route

`src/App.tsx` router (beside `{panel === "rotation" && <RotationAnalytics />}`, ~line 3161):

```
{panel === "imaging" && <ImagingPanel />}
```

One new component, `src/components/ImagingPanel.tsx`, holding five tabs — RACK · POOLS · ASSIGNMENTS ·
ON DECK · RULES — and nothing else. Station comes from `useActiveStation()`; it renders nothing and
says so until the station resolves (the `?? 1` rule from the processor pop-out).

**No pop-out in this slice.** The `openPopoutWindow` registry would take four lines and I have not
proposed it, because the requirement is canonical-nav reachability and that is the hamburger. Say the
word and it is trivial to add.

## 3 · What each view reads

**RACK** — one row per imaging asset, 69 rows today.
```sql
SELECT la.type, la.title, la.duration_ms, jc.name AS pool
  FROM library_asset la
  JOIN songs s          ON s.uuid = la.uuid
  LEFT JOIN jingle_categories jc ON jc.id = s.jingle_category_id
 WHERE la.type IN ('SWEEPER','ANNOUNCEMENT')
   AND la.deleted_at IS NULL AND s.deleted_at IS NULL
 ORDER BY la.type, la.title
```
Same join SweepersPanel already uses (`SweepersPanel.tsx:90`), so it is a proven path, not a new one.
LENGTH renders "—" for the five announcements that have no `duration_ms` — the value is absent, and
saying so is the honest render. No audition, no waveform, no MARK: those are slice 2.
**Empty state:** "No imaging in the library. Import cuts through SWEEPERS → ADD IMAGING."

**POOLS** — `jingle_categories` for the station, plus a member count from `songs.jingle_category_id`
and the list of music categories pointing at each pool. One row today. Read-only.
**Empty state:** "No pools. A pool groups cuts so a category can draw from them in rotation."

**ASSIGNMENTS** — the existing grid, lifted. See §5: this is the one place the two rules collide.
**Empty state:** "No music categories yet."

**ON DECK** — the jock view, active station, from `generated_schedule`. The pairing is confirmed in
the data: **a placed sweeper carries the same `scheduled_at` as the song it precedes**, with
`song_id`, `title`, `lead_in_sec` and `jingle_category_id` written at Generate time
(`electron/main.js:8496-8505`). So the cut is named, not the pool:

```
19:20:11   SWP  audiocoffee-halloween-impact-167297 06   lead 2s
           →    Bring Me To Life
19:24:07   SWP  audiocoffee-halloween-impact-167297 03   lead 2s
           →    Oogie Boogie's Song
```

Window: the next N seams from now (proposing 25, one screen). Read-only — no swap, no kill; that is
slice 5.

**RULES** — a placeholder naming what it will hold (segue bans: where a produced cut may not go) and
stating plainly that nothing is configured and bans are not built. No controls drawn.

## 4 · ON DECK when there is no generated log ahead

This is not one empty state, it is **three**, and telling them apart is most of the value ON DECK adds —
Open Format has ten categories and not one assignment, which is exactly the condition that makes a
station silent-of-imaging while looking fine.

1. **Nothing generated.** No `generated_schedule` rows ahead at all →
   *"Nothing is scheduled past <time>. Generate a day in the Calendar."*
2. **Log generated, no imaging placed.** Music rows ahead, zero SWP rows →
   *"N songs scheduled through <time>, no imaging placed."* plus the actual reason, read from the same
   tables: every music category unassigned **and** no station fallback pool
   (`overlay_fallback_category_id` in `station_config_kv`) → *"No category has an overlay assigned and
   there is no fallback pool. Assign one in ASSIGNMENTS."*
3. **Log + imaging.** The list.

State 2 is the one that earns the view. It is also, today, the true state of two of the four stations.

## 5 · Two rulings needed before building

**A · ASSIGNMENTS: "lifted not rewritten" vs "read-only means read-only".**
`SweepersPanel` is an *editor* — it patches `categories`, creates and deletes pools, writes the
fallback key. Lifting it as-is puts writes on a surface ruled read-only.

- **Proposed:** two new props, `section?: "assignments" | "pools"` and `readOnly?: boolean`. The
  component splits cleanly — its two top-level blocks are already `{/* ── Category assignments (the
  core) ── */}` at line 181 and `{/* ── Sweeper pools ── */}` at line 258. Same queries, same markup,
  same LEAD column; inputs disabled and write handlers unreachable when `readOnly`. Editing stays in
  the push-up. That is a lift, not a rewrite, and IMAGING cannot write.
- **Alternative:** a separate read-only table in ImagingPanel. Truer to "no writes", but it is a second
  component that can drift from the editor — the exact failure the "one home" rule exists to prevent.

**B · Does RACK include the 5 ANNOUNCEMENT assets?** They are imaging by type and none has a length.
Including them makes LENGTH read "—" on five of 69 rows; excluding them makes RACK sweepers-only and
the TYPE column pointless in slice 1. Proposing to include them.

## 6 · What is not being built

No engine change, no schema change, no migration, no writes, no `chain_type`, no marks, no bans, no
ON DECK overrides, no waveform or audition, no rename of `jingle_categories`. Nothing in this slice can
affect air: every query is a SELECT and the only files touched are `App.tsx` (two lines), a new
`ImagingPanel.tsx`, two props on `SweepersPanel.tsx`, and `docs/help-imaging.md`.

## 7 · Help

`docs/help-imaging.md`, flat, to the `help-sweepers.md` template: what imaging is, the five views, the
vocabulary the later slices need (post, dry, chain type, ban) marked as not yet built, and the door —
hamburger → Imaging, or SWEEPERS → Open IMAGING.

---

*Read-only survey run with `scripts/diag-imaging-slice1-readonly.js` (one-shot, gitignored, not
committed — say if it should be kept).*

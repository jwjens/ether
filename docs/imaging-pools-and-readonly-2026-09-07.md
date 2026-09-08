# POOLS is showing the wrong thing · and read-only is showing dead controls
2026-09-07 · read-only investigation · nothing changed

Two questions from the 4.6.13 screenshot. The first one surfaced a data-model conflict with the
ruling recorded alongside it, so that is reported before anything is proposed.

---

## 1 · What POOLS is actually querying

**It is rendering two things and you are seeing the second one.** The POOLS section of
`SweepersPanel` is, top to bottom:

1. the **pool grid** — `tabPools`, one row per pool, with LEAD-IN, UNDERLAP and an "N in pool" count
2. the **membership editor** — `Sweepers (64)`, a flat list of every cut with a per-item pool dropdown

Line 331 onward is (2). It is not a pool view at all; it is the *assignment* control, one row per cut.
In read-only it renders as 64 disabled dropdowns, which is what the screenshot shows. The pool grid is
above it and is one line tall, because there is exactly one pool per station.

Its queries:

| what | call | station filter |
|---|---|---|
| pools | `jingleCategories.list(stationId)` | **yes** |
| cuts | `SELECT … FROM library_asset la JOIN songs s ON s.uuid = la.uuid WHERE la.type='SWEEPER'` | **no** — deliberately global |

The unfiltered cut list is correct and matches the ruling: one shared set of sweepers, like the song
library.

### But pool membership is NOT per station, and the data proves it

`songs.jingle_category_id` is **a single INTEGER on the shared song row** — the only membership column
there is. `jingle_categories` rows are per station. So a cut points at exactly **one** pool, and that
pool belongs to exactly **one** station.

Every pool in the profile:

| pool id | name | owner |
|---|---|---|
| 1 | Christmas | Open Format |
| 3 | Halloween | halloVeen |
| 2 | Christmas | Magical Forest |
| 4 | Summer Christmas | Christmas in Jully |

Where the 64 shared cuts point:

| points at | pool | owner | cuts |
|---|---|---|---|
| 4 | Summer Christmas | Christmas in Jully | **33** |
| 1 | Christmas | Open Format | **19** |
| 3 | Halloween | halloVeen | **12** |

What each station's POOLS view can therefore show:

| station | pools | cuts in *its* pools |
|---|---|---|
| Open Format | 1 | 19 |
| halloVeen | 1 | **12** |
| Magical Forest | 1 | **0** |
| Christmas in Jully | 1 | 33 |

**The ruling and the schema disagree.** "Each station assigns and pools them differently" is true of
*assignments* (`categories.overlay_*` is per station) and true of *availability* (the cut list is
global). It is **not currently possible for pooling**: putting a cut into halloVeen's Halloween pool
takes it out of Christmas in Jully's Summer Christmas pool, because there is one column and it holds
one value. Right now the 64 cuts are partitioned across three stations rather than shared by them.

I am not proposing a fix for that here — it is a schema change (a per-station membership table, or a
station column on the membership) and it belongs in its own slice with your ruling on it. Flagging it
because **any POOLS design built now will be built on top of it.**

### A second, quieter bug from the same cause

RACK's pool column joins `jingle_categories` with **no station filter**, so on halloVeen it prints
"Summer Christmas" and "Christmas" — pool names belonging to other stations — for 52 of 64 rows. That
is a surface asserting a membership this station does not have.

### What POOLS should query and show

Read-only, and grouped by pool instead of a flat list of cuts:

```sql
-- the pools this station owns
SELECT id, name, lead_in_sec FROM jingle_categories
 WHERE station_id = ? AND deleted_at IS NULL ORDER BY sort_order, name;

-- what is in each of them, from the shared library
SELECT s.jingle_category_id AS pool_id, la.title, la.duration_ms
  FROM library_asset la JOIN songs s ON s.uuid = la.uuid
  JOIN jingle_categories jc ON jc.id = s.jingle_category_id AND jc.station_id = ?
 WHERE la.type='SWEEPER' AND la.deleted_at IS NULL AND s.deleted_at IS NULL
 ORDER BY la.title;
```

- **one block per pool**, its cuts listed under it, with the count — Halloween (12) on halloVeen
- **one closing line** naming what is available but not in any of this station's pools: *"52 more cuts
  in the shared library, not in this station's pools"* — honest about the shared set without claiming
  they are pooled here
- **empty pool:** *"No cuts in this pool yet."* **No pools:** *"No pools. A pool groups cuts so a
  category can draw from them in rotation."*
- and RACK's pool column gains `AND jc.station_id = ?`, printing "—" where the cut is not in one of
  this station's pools

The flat 64-row list with dropdowns is an **editor**. Where it belongs depends on question 2.

---

## 2 · Read-only is rendering dead controls

You are right, and the rule that says so is one of yours: a control that renders and does nothing is
the defect. My implementation disabled every input rather than not drawing it, which produces exactly
the surface you have spent two days removing. Choosing "disabled" over "not rendered" was my error,
not a consequence of the read-only ruling.

Two ways out. **I recommend B.**

### A · Render values, not controls

ASSIGNMENTS and POOLS show text — "Power Gold → Halloween · lead 2s · 06:00-19:00" — with no inputs at
all, and a line saying where to change it. Strictly read-only, and no dead control anywhere.

- **Cost:** a second render path inside `SweepersPanel` — a text branch beside the control branch for
  every field. More code in the file, and two renderings of the same values that can drift in what
  they *say* even though the data is one source.
- **And it leaves the surface unable to do the thing an operator will reach for the moment they see
  it.** IMAGING would be a place you look at assignments and then leave.

### B · ASSIGNMENTS and POOLS are editable in IMAGING

Drop `readOnly` for those two views. They are the same component, so there is exactly one
implementation and one set of write handlers — the duplication worth fearing is two *implementations*
that can disagree, and two doors onto one component is not that. This is also what the governing
design already says: §1.2 of the redesign has the push-up becoming *"a shortcut INTO it rather than the
thing itself."*

- **What "read-only" was actually protecting** was new write paths and anything touching air: no
  marks, no bans, no ON DECK overrides, no engine change, no schema change. Editing an assignment is
  an existing write that already runs from the push-up and already only affects the next Generate.
  Moving which door it is reached through adds no risk that is not already taken.
- **RACK, ON DECK and RULES stay genuinely read-only** — their writes are slices 2, 5 and 4. Nothing
  there renders a disabled control; there are no controls.
- **The push-up:** keep it. Mid-show, a push-up is faster than a destination, and it renders the same
  component. Your call whether it stays a full editor or becomes a link — I would keep it as-is,
  because it costs nothing and it is what people already reach for.

**Recommendation: B**, with the read-only guard kept in the component (it stays useful, and it is the
thing that makes RACK-adjacent views safe later), simply not applied to these two views.

---

## Status

Nothing built. Question 1 needs a decision on the per-station pooling conflict before POOLS is
rebuilt; question 2 needs A or B.

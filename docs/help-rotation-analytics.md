---
feature: rotation-analytics
title: Rotation Analytics
summary: See how your rotation is actually behaving — spins vs target, artist burn, turnover, and how many log rows carry a recorded pick reason. Read-only; it never changes what airs.
where: ≡ Menu → Rotation Analytics (opens in its own window) · Schedule → Rotation Analytics in the menubar · or as a pane in Schedule Manager
since: 4.4.169 (sortable/resizable tables and the Schedule Manager pane, 4.4.177)
audience: programmer
tour: true
---

# Rotation Analytics

## What it is

Five questions a PD asks about rotation, answered from the log itself:

- **Spins** — how often is each category airing, against the target you declared?
- **Hourly grid** — which hours does each category own?
- **Burn** — which artists are on too often, and how tightly spaced?
- **Turnover** — how much of the library is actually in play, or is a handful of songs carrying it?
- **Why** — how many rows in the log carry a recorded reason for their pick?

It reports only. Nothing in this panel changes what plays.

## Reading it

### Spins per hour — actual vs target

| Column | Meaning |
|---|---|
| **Target/hr** | The `spins/hr` you set on the category. **—** means no target declared |
| **Actual/hr** | What the log actually contains, averaged over the window |
| **Δ/hr** | Actual minus target. Amber at ±1 or more |
| **Share** | This category's percentage of all music. Amber at 50% or more |

A category with **no target shows —** and is never counted as a miss. Not declaring a goal is a
legitimate choice, and the panel treats it as one.

A **share of 50% or more** is worth a look. If one category is most of your day, that is your format
whether you intended it or not.

### Artist burn

**Tightest gap** is the closest any two airings of that artist came. It is compared against **your
station's own artist-separation rule**, not an invented number — so `INSIDE RULE` means the scheduler
had to break your rule, which happens when the fill ladder runs out of compliant songs.

A high spin count with comfortable spacing is a format. A low count with a 15-minute gap is a
listener complaint waiting to happen.

### Turnover

| Column | Meaning |
|---|---|
| **Library** | Eligible songs in the category |
| **Used** | How many distinct songs actually aired |
| **Coverage** | Used ÷ Library. Low coverage means most of the category never plays |
| **Spins/song** | Near **1.0** = even rotation. **4+** means a few songs are carrying the category |
| **OFF-CATEGORY** | Songs in the log that are no longer in that category — re-filed, deleted or rotation-disabled since it was generated. A sign the log is stale |

Low coverage plus high spins/song is the classic burn signature: a big library, a small slice of it
actually airing.

### Why was this picked?

Reasons are written **as the log is generated** — the category, how many songs were in the pool, how
many were vetoed and by which rule, and whether any rule had to be relaxed.

This section tells you **how many rows in the window carry a recorded reason** (for example
"412 of 430 rows carry a recorded reason"). The individual reasons are stored on each log row, but
they are not shown on screen yet — not here and not in the Program Log.

**Reasons cannot be reconstructed afterwards.** The vetoed and losing candidates only exist during
the pick, so rows generated before this feature existed show **"0 of N rows carry a reason"** rather
than being given a plausible-sounding guess. Run **Generate** and new rows will carry their reasons.

## Working the tables

The four tables (Spins, Hourly grid, Artist burn, Turnover) are a spreadsheet-style grid:

- **Click a header to sort.** Click again to reverse it.
- **Shift-click a second header** to sort by that as a tiebreak. The little ▲1 ▼2 marks show which
  is first and which is second.
- **Drag the right edge of a header to resize a column.** Your widths are remembered per station, on
  this machine — they are never synced, because how wide your columns are is not your colleague's
  business.
- Tables open in the **same order they always have** — turnover by coverage, worst first, and so on.
  Sorting is something you do, not something done to you on arrival.

The **artist burn** table lists the 25 most-played artists. When there are more, it says so under the
table — and the export still contains every one of them.

## Exports

Each section has its own **Export CSV** button, directly under the table it exports. Files open
directly in Excel, Sheets or Numbers.

**Sorting and resizing do not change the file.** The export is defined by the report, not by how you
happen to be looking at it, so two people exporting the same window get the same file.

## Time range

24 Hours / 7 Days / 30 Days, across the whole panel. Longer ranges are slower on a big library —
30 days on a full station takes a moment. **Refresh** re-reads the log for the current range.

## What it does NOT do

- It does not change rotation. Everything here is a read.
- It does not schedule or re-schedule anything.
- It does not judge your format. A 70% share is reported, not condemned — whether that is right is
  your call.

## In the Schedule Manager

Rotation Analytics is also a **pane** in Schedule Manager, beside Categories, Spots and Sweepers. That
completes the loop in one window: declare a target on a category, shape the clock against the
advisor, then read here what actually aired. It is the same panel — the menu entry still opens it
in its own window.

It takes no part in the editing around it. These numbers are **history**, read from the log; editing
a clock beside it does not change them. Re-run the range with **Refresh** after you generate.

## Related

**Station Health → Library & Rotation → Rotation goals** shows the other half: whether your *clocks*
match your declared targets, before a single song is scheduled. This panel shows what the log actually did.
**Schedule Manager** — the workspace this panel can live in.

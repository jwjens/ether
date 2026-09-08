# Most-scheduled-first, in the Library — proposal
2026-09-08 · **not built**

RACK's songs list is gone, and with it the one genuinely useful thing it had: an order that puts the
songs worth marking at the top. Jeff: *"that's where songs live."* This proposes putting it in the
Library. Nothing is built.

---

## What it is

A sort option in the Library's existing sort control: **"Placed ahead"** — how many times each song
appears in the generated log from now forward, descending.

It answers one question the Library cannot answer today: *which songs actually air?* Alphabetical and
date-added both bury that. On halloVeen the top twelve by this measure carry 44, 43, 33, 31, 30, 28…
placements each, while most of the library carries none.

## Why it belongs there and not in IMAGING

Because it is not about imaging. It is the order you want for **any** per-song work that is worth doing
on the songs that air and not worth doing on the tail: setting the post, fixing a bad cue, checking
loudness, replacing a poor rip. Marking is only the first use.

## The one thing that must not be repeated

**Do not compute it with a correlated subquery.** That is the mistake RACK made and it is measured:
a per-row `COUNT(*)` over `generated_schedule`, under an `ORDER BY`, ran for every row before any
`LIMIT` applied — 1,937 ms on a 5,000-row list, and `LIMIT 200` only reached 1,732 ms.

One grouped query, joined in memory:

```sql
SELECT song_id, COUNT(*) n FROM generated_schedule
 WHERE station_id = ? AND scheduled_at >= strftime('%s','now') AND song_id IS NOT NULL
 GROUP BY song_id
```

That is the whole cost — a few hundred rows regardless of library size. The Library already loads its
page; this is a Map lookup per row.

## Shape

- A sort entry beside the existing ones, labelled **"Placed ahead"**.
- A column, or a small badge on the row, showing the count — because a sort whose key is invisible is a
  mystery. `0` reads as **"not in the log ahead"**, which is information: it means marking that song
  changes nothing today.
- Per **active station**, like everything else about a log. A song heavy on halloVeen may be absent
  from Christmas in Jully.
- Optionally paired with an existing filter so "unmarked, most-scheduled first" is one click — that
  combination is what makes an evening of marking pay for itself.

## What it costs

Small: one grouped query, one Map, one sort entry, one badge. No schema, no migration, no engine.

## What it does not claim

The 1,937 ms figure is measured on a **synthetic** 5,000-row library grown from 64 real cuts; the
timing is real, the data is not. The Library's own render and sort behaviour at that size has **not**
been measured — this proposal assumes it already pages, and that should be checked before building.

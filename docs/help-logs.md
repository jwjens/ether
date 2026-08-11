---
feature: logs-exports
title: Play Log exports (as-run affidavit, BMI, ASCAP)
summary: What each export button produces, which columns an affidavit carries, and why a column can be empty.
where: Menu → Play Log → the export buttons, top right
since: 4.4.180 (as-run affidavit rebuilt)
audience: programmer
tour: true
---

# Play Log exports

Four buttons, four different documents. They are not variations of one file.

| Button | Produces | For |
|---|---|---|
| **Export CSV** | The as-run affidavit — everything that aired, with times and lengths | Advertisers, proof of performance |
| **BMI** | Title, performer, date, time, duration | BMI reporting |
| **ASCAP** | Title, artist, date, start time, duration, source | ASCAP reporting |
| **Export Traffic CSV** (Traffic view) | Every **scheduled spot**, aired or not | Traffic reconciliation |

## The as-run affidavit — Export CSV

Twelve columns, in this order:

**Start Time · End Time · Duration · Date · Title · Artist · Deck · Category · Advertiser · ISCI ·
Cart Number · Status**

- **Start Time** is when it actually aired. **End Time** is Start Time plus its length. **Duration**
  is that length, as M:SS — a thirty-second spot reads `0:30`.
- **Status** is **Aired** on every row. That is not a placeholder: the play log records what played,
  so every line in it aired. If you need *Scheduled* and *Missed*, that is the **Traffic** export —
  it reads the schedule, where a spot that never aired still has a row.
- **The whole period is exported.** Pick 30 Days and you get 30 days. It is not limited to what is
  visible on screen.

### Why a column can be empty

An empty cell means Ether does not know, and it will not invent a value:

| Column | Empty when |
|---|---|
| **Advertiser, ISCI, Cart Number** | The spot's record has no such value. Fill them in on **Spots & Promos** and every export after that carries them. |
| **Category** | The item is not a library song in a category — a jingle, a sweeper or a cart. |
| **End Time, Duration** | The length was never recorded. These stay blank rather than showing `0:00`, which would claim a zero-length airing. |

> **If ISCI and Cart Number are empty across the board**, nothing is broken — those fields have not
> been filled in on your spots yet. They are the two an advertiser is most likely to ask for, so they
> are worth entering once per spot in Spots & Promos.

### What changed in 4.4.180

The old file had eight columns — `Date, Time, Title, Artist, Category, Show, Clock, Deck` — and
three of them could never contain anything:

- **Clock** had no underlying field at all.
- **Show** and **Category** were recorded as empty on every play, always.

It also stopped at **200 rows** no matter which period you picked, which for an affidavit is the
serious one: it silently left airings out of a document whose job is to prove they happened.

Now it runs its own query over the full period, Show and Clock are gone, Category comes from the
song, and Start/End/Duration and the advertiser fields are included.

## Related

**Traffic** — scheduled spots and whether they aired (`docs/help-traffic.md`).
**Spots & Promos** — where Advertiser, ISCI and Cart Number are entered.
**Rotation Analytics** — how rotation behaved, rather than what a single item did.

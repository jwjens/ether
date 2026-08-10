---
feature: traffic
title: Traffic & As-Run
summary: Prove your spots aired. Scheduled vs actual time for every commercial, with advertiser, cart and ISCI — exported as the CSV your billing runs on.
where: Menu → Logs → Traffic tab (keyboard: G)
since: 4.4.166
audience: operator
tour: true
---

# Traffic & As-Run

## What it is

**Traffic** is the affidavit side of your log. Where **Play Log** shows everything that aired, **Traffic**
shows only the **spots** — commercials, promos, PSAs, sponsorships — and answers the one question a
sales department asks: *did the client's spot actually run, and when?*

For every spot the log placed, Traffic shows the time it was **scheduled**, the time it **aired**, the
**difference between them**, and the advertiser identifiers a billing system needs: **cart number**,
**ISCI code**, **advertiser**, **agency** and **length**.

## When to use it

- **End of month, before invoicing** — export the period and send it to whoever bills.
- **A client asks for proof** their spot ran. Export the day, hand them the rows.
- **Something looks wrong** — a stop set that didn't fire shows up as **MISSED** with the exact time it
  should have gone.

## How to get there

Open the menu and choose **Logs** (or press **G**), then click the **Traffic** tab beside the title.
The date buttons — Today / 7 Days / 30 Days / All, or a custom from–to range — control both tabs.

## Reading the table

| Column | What it means |
|---|---|
| **Sched** | When the log placed the spot |
| **Aired** | When it actually played. A dash means it hasn't (yet) |
| **Δ** | Aired minus scheduled, in seconds. Turns amber past two minutes |
| **Status** | **AIRED**, **MISSED**, or **PENDING** (scheduled, not yet due) |
| **Cart / ISCI** | The advertiser's identifiers, from Spots & Promos |
| **Advertiser** | Who is being billed |
| **Len** | Spot length in seconds |

A **Δ of a minute or two is normal** — a spot waits for the song in front of it to finish. A large or
growing Δ means the log is drifting from the clock, which is worth investigating.

**PENDING is not a fault.** If you pick a 7-day range, spots later in the week haven't come due yet. The
**Aired of Due** figure deliberately ignores them, so it never reads as a failure just because you looked
at future days.

## Exporting

Click **Export Traffic CSV**. You get one row per spot for the selected period:

```
Date, Scheduled Time, Actual Time, Delta (s), Status, Cart, ISCI,
Advertiser, Agency, Title, Length (s), Spot Type
```

It opens directly in Excel, Google Sheets or Numbers, and imports into most traffic systems.

The button is greyed out when there are no spots in the period — that is the honest state, not an error.

## "No spots scheduled in this period"

Traffic reads the **generated log**, not your spot library. If this is empty but you have spots loaded:

1. Check your **clock** actually contains **spot breaks** (Clocks → the clock → a break element).
2. Open the **Calendar** and click **Generate** for the day(s) you want.
3. Come back — the spots will be listed with the time they are due.

## Blank advertiser, cart or ISCI

If you see the amber notice saying spots have no identifiers on file, they will still export, but with
those columns blank — which most billing systems will reject. Fill them in under **Spots & Promos**:
select the spot and add the **advertiser**, **cart number** and **ISCI**. Traffic picks them up
immediately; you do not need to regenerate.

## As-Run (all content, not just spots)

The **As-Run** button on the Play Log tab reconciles the *whole* log — music included — showing matched,
missed, unscheduled and pending items with a match percentage. Use Traffic for billing; use As-Run when
you want to see how faithfully the whole day followed the log.

**Unscheduled** means something aired that the log didn't place — a hand-loaded track or a cart fired
live. That is normal in a live-assist shift and is shown so it can't be mistaken for a scheduled element.

## What it does not do (yet)

- It does not **import** reconciliation back into a third-party traffic system — export only.
- It does not generate an invoice. It produces the proof-of-performance an invoice is built from.

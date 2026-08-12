---
feature: designated-generator
title: "Designated generator — which computer builds this station's log"
summary: What the Designated generator rows in the Health Monitor mean, what "None" and "NOT SAVED" tell you, and when to press REFRESH NOW.
where: Health Monitor → per station, under the auto-generate section
since: 4.4.193
audience: operator
tour: true
---

# Designated generator

## What you are seeing

In the **Health Monitor**, under each station:

> **Designated generator** — This machine
> *This machine — checked in 12 min ago*
>
> **Log last extended** — 12/08/2026, 09:41:07

And a **REFRESH NOW** button underneath.

## What it is for

A station's log can be topped up automatically, so you never run out of scheduled music. If your
account runs on more than one computer, they would all happily do that job at once — and two
computers writing the same log is how a schedule ends up with doubled or fighting entries.

So one computer is the **designated generator** for a station. It writes the log. The others watch.

**Designation is never taken automatically.** A machine that is already designated stays designated
until a person changes it. There is no timeout, no election, and no silent handover — those decisions
belong to you, not to a timer.

## Reading the rows

**Designated generator**

| It says | What it means |
|---|---|
| **This machine** | The computer you are sitting at builds this station's log. |
| A computer's name | That computer does it. This one is only watching. |
| **None** | No machine has auto-generated this station yet. This is normal and not a fault. |
| **Bypassed** | The emergency bypass is on for this station — every switched-on machine generates. |

The colour follows the last check-in, not the name: green within 6 hours, amber after that, red after
a day of silence. **Red means the designated computer has stopped watching** — it may be switched
off, asleep, or offline. That station's log will stop being topped up.

**Log last extended** is deliberately separate. A healthy computer generates *nothing* for days while
the runway is long, so an old date here is not a fault on its own. Check the **Designated generator**
row's colour for that.

## "Designation record — NOT SAVED"

If a red row appears saying **NOT SAVED**, this computer could not write the designation record to
its database. It tells you the reason on the same line.

This matters because the record is how the machines tell each other apart. Without it, they cannot
agree on who generates, so the safe reading is: **nobody is reliably designated for this station.**

What to do:

1. Note the reason shown on the row.
2. Fully close and reopen Ether — a database that was mid-repair at startup usually clears here.
3. If it comes back, send the reason text to support. It is also written to the health ledger as
   `station-designation-write-failed`, so a look-back can see exactly when it started.

> This row exists because of a real defect. In 4.4.188–4.4.192 the record could not be written on
> **any** computer, and this panel showed a calm "None" the whole time — identical to the perfectly
> normal "nothing has happened yet". A failure that looks like a healthy state is worse than an
> error, so it now says so out loud.

## REFRESH NOW

Re-reads the designation record and checks in immediately, rather than waiting for the next
half-hourly round. While it works the button reads **REFRESHING…**, and the row updates only when
the read comes back — what you see is always what was actually read, never a guess.

Use it when you have just switched auto-generation on, or when you want to confirm the row on screen
is current. It refreshes **ownership state only** — it does not force a full cloud sync and it does
not generate a log.

If the refresh fails, the reason appears in red on its own line under the row instead of nothing
happening.

### "Auto-gen off – cannot designate"

If **Auto-generate is off** for this station on this computer, the REFRESH NOW button is **greyed
out** and that note sits beside it.

This is not a fault. A computer with auto-generation switched off must never take the designation —
it would then own a station it has been told not to build. So there is genuinely nothing to check
in, and the button says so rather than looking live and doing nothing.

**To designate this computer:** turn **AUTO ON** for the station, then press REFRESH NOW. The row
flips to **This machine** in green and stays there.

The rows keep updating on their own every 30 seconds regardless, so nothing is hidden from you while
the button is greyed out — if another computer takes the designation, you will still see it appear.

## What this does NOT do

- **It does not stop the other computers generating.** In this version designation *reports* who
  should own the job; it does not yet block the others. That enforcement is a later step.
- **It does not switch auto-generation on.** A machine with auto-generation switched off will never
  take the designation — it would own a station it has been told not to build.
- **It is not about who is on air.** Any computer can play out. This is only about who writes the
  schedule ahead of time.

## Related

- **Runway** — the per-station gauge showing how far ahead the log is built. It goes red under a day.
  If a designated machine stops working, the runway is where you will feel it.
- **Health Monitor** — designation changes are written to the health ledger as
  `station-designation-changed`, so you can see when ownership moved and what caused it.

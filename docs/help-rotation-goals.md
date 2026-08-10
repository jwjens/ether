---
feature: rotation-goals
title: Rotation Goals
summary: Declare how often each category should air, and see where your clocks disagree with you. Reports only — it does not change what plays.
where: Menu → Station Health → LIBRARY section → "Rotation goals" · targets are set in Categories
since: 4.4.167
audience: programmer
tour: true
---

# Rotation Goals

## What it is

Every category can carry a **spins per hour** target — how often you want it to air. Ether has always
had the field; nothing ever read it.

**Rotation goals** is the first thing that does. It compares the target you declared against what your
**clocks actually ask for**, and tells you where the two disagree:

> Morning Drive — Gold target 4/hr, 2 slots (under by 2)

It **reports only**. It does not change one thing about what airs. Your clocks still decide the
music exactly as before.

## Why the two can disagree

Today a clock controls rotation *positionally*: if you want Gold four times an hour, you place four
Gold slots. The spins-per-hour field is a *statement of intent* that has never been enforced — so
nothing has kept your clocks and your intent aligned, and they drift apart silently.

This panel is the first place that drift becomes visible.

## Reading it

| What it says | What it means |
|---|---|
| **none declared · 10 categories** | No targets set yet. It shows what your clock actually does instead — e.g. *"Open Format is 73% Feel Good (11 of 15 music slots)"* |
| **12 declared · all clocks match** | Every clock's composition matches its targets |
| **3 mismatches across 2 clocks** | The worst offender is named underneath |

**under by N** — the clock has fewer slots for that category than the target.
**over by N** — it has more.
**not in this clock** — you set a target for a category the clock never uses.

## Setting targets

Menu → **Schedule → Categories** (or the Scheduler panel) → pick a category → set **Spins/hr**.

Start from what your clock already does. If the panel says a clock is *73% Feel Good (11 of 15
slots)*, and that isn't what you intended, it just told you something worth knowing.

A category with **no target — blank or 0 — is never reported.** Not declaring a goal is a legitimate
choice, and this panel treats it as one rather than nagging.

## What it does NOT do

- **It does not change what airs.** Nothing about song selection, separation, dayparting or clock law
  changes. This release is read-only.
- **It does not fill in your targets for you.** It can see that a clock airs Gold three times an hour,
  but it will not write that in as your goal — inferring your intent from geometry would be inventing
  a decision you never made.
- **It does not enforce the goal.** If a clock is under target, the clock still wins. Making goals
  actually drive the log is a later phase.

## Talk and specialty clocks

A clock with no music slots at all is skipped entirely. Reporting "Gold under by 4" against a talk
hour would be technically true and completely useless.

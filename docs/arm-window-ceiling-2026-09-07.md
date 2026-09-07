# Finding #6 — the LEAD control has an invisible ceiling

**Date:** 2026-09-07 · **READ-ONLY.** Nothing changed, nothing built. Proposal only.

---

## 1 · The trap, traced — and a correction to the inventory

**`docs/hidden-decisions-inventory-2026-09-07.md` #6 says a LEAD above 30 means the sweeper "silently
never arms." That is wrong on both counts. It arms, and it fires.** What actually happens is worse in one
respect and better in another: nothing is lost, but the number is silently reduced.

With **LEAD = 40** and segue overlap **5**, on a 3-minute song:

| outgoing `remaining` | what the engine does |
|---|---|
| 180 s … 31 s | `remaining <= _ARM_WINDOW_S` (30) is **false** → falls to the SCHEDULED read-ahead branch (`engine.js:2258`). The grey indicator shows; **not armed** |
| **30 s** | gate passes → `readJingleForSeam` → `_armJingle`. Log line: `SWP ARMED — "…" over deck C seam (lead_in=40s)` |
| **~29.75 s** (next 250 ms tick) | armed branch: `remaining <= j.leadIn + segueOverlap` → `29.75 <= 45` → **true** → `_fireJingle` |

So the sweeper fires at **~30 s** before the outgoing ends, not 45 s. The incoming starts at
`remaining = 5`, so the operator gets **25 seconds of lead having typed 40**.

**Is anything logged?** Yes, and it is the worst possible form: `_armJingle` prints
`lead_in=40s` — **the log asserts the number the engine did not honour.** And `_log` is `console.log`
(`engine.js:173`) in an in-process daemon, so there is no console to read it in.

**Where the ceiling actually bites:** any LEAD **> 30 − segueOverlap**. At your overlap of 5, **anything
above 25 is silently clamped to 25.** The control accepts it, the DB stores it, Generate writes it onto
every placement row, and the engine quietly ignores the excess.

**And the input has no upper bound at all.** `SweepersPanel.tsx:197` is `min={0} step={1}` with no `max`,
and `commitLead` clamps only `Math.max(0, …)`. **You can type 300.** I shipped that today; it is mine.

## 2 · What the arm window is protecting against — no record

`_ARM_WINDOW_S = 30` arrived in **`48c7f1a`, 2026-07-14, "JINGLES overlay v1"** and **has never been
changed.** Searched: the commit message (which describes the lifecycle in detail and never mentions it),
`docs/jingles-overlay-v1-build-proposal-2026-07-14.md`, `docs/jingles-sweepers-v2-design-2026-07-15.md`,
and the whole git history for the identifier. **Nothing states why 30.**

It was almost certainly not a constraint when written: the lead defaults were 5 and 2, so 30 was six times
the largest value anyone could produce. It only became a ceiling on 2026-09-06, when LEAD became an
operator control.

**What it actually does, read from the code:**

- It gates **promotion from SCHEDULED to ARMED** — nothing else. The read-ahead already queries the seam
  *outside* the window (`engine.js:2262-2270`), cached by a `deck:afterTs:beforeTs` signature, so the
  information is fetched early regardless. The window does not save a database read.
- It bounds **how long a sweeper sits ARMED**, and an armed sweeper is exposed to `_jingleSuperseded` —
  cancelled if the air generation changes, the deck stops, or the deck is re-loaded. A skip, a manual
  load, or a top-of-hour cut inside the window cancels it.

**So what breaks if it is larger: more supersessions.** Arm at 90 s and a sweeper is exposed for 90 s of
song during which any operator action retires it. That is a real cost, and it is the only one I can find.
It is not a dead-air risk (a cancelled sweeper leaves the normal rotation untouched) and not a performance
cost (no extra query).

## 3 · The three options

### A · Derive the window from LEAD — it can never be the limit

`_ARM_WINDOW_S` becomes `max(30, leadIn + segueOverlap + margin)`, evaluated per seam from the placement
row the read-ahead already holds.

- **Cost:** the window is no longer a constant, so the SCHEDULED→ARMED moment moves with the setting.
- **What could go wrong on air:** a large LEAD means a long ARMED exposure and more supersessions — the
  §2 cost, now reachable by typing a number. A LEAD of 120 on a 2-minute song would arm at the song's
  start, so essentially any operator action for the whole song cancels the sweeper.
- **Honest verdict:** removes the ceiling completely, and transfers the risk to the operator without
  telling them. The silent clamp becomes a silent cancellation, which is not obviously better.

### B · Make the window settable

A station setting beside LEAD.

- **Cost:** the full delivery chain (kv key, daemon command, poll read, UI) — the same six pieces as
  `segue_overlap_sec`, now proven twice.
- **What could go wrong:** it is a second number that must be kept above the first, so it can be set
  *wrong* — a window of 10 with a LEAD of 20 recreates exactly this bug, now with the operator holding the
  gun. **A setting whose only correct value is "bigger than that other setting" is a trap with a slider
  on it.**
- **Honest verdict:** I would not build this. It exposes an implementation detail as a control.

### C · Bound the LEAD input at what the engine will honour

`max` on the input, and the clamp in `commitLead`, both set to the real ceiling —
`_ARM_WINDOW_S − segueOverlap` — with the limit stated on screen.

- **Cost:** smallest of the three. The renderer needs to know the window, which today it does not — it
  would come from the same `audio:daemon-jingle`/settings path, or be a shared constant.
- **What could go wrong on air:** nothing. It changes no engine behaviour at all; it stops the UI offering
  a number the engine will not honour.
- **The weakness:** it makes the ceiling honest but keeps it arbitrary. You still cannot set a 40-second
  lead, you are just told so.

### The combination I would actually propose

**C plus a widened constant: bound the input, and raise `_ARM_WINDOW_S` to a value that is not a practical
ceiling** — 90 s covers any imaging anyone would place on a seam, and the input then bounds at
`90 − segueOverlap`. This keeps one number in code (documented, filed), makes the control honest, and
does not hand you a second setting whose only job is to not conflict with the first.

**And regardless of which option: `_armJingle` must stop logging a lead it did not honour.** If the engine
clamps, the log and the health event should say the effective value and the requested one.

## 4 · Anywhere else a control's range exceeds what the engine honours

I compared every numeric control's UI range against the clamp applied downstream.

### The one real mismatch — the LEAD input itself

| | |
|---|---|
| **UI accepts** | `min={0}`, **no `max`**; `commitLead` clamps only `Math.max(0, …)` — any positive integer |
| **Engine honours** | up to `_ARM_WINDOW_S − segueOverlap` = **25 s** at your settings |

`SweepersPanel.tsx:197`. Shipped 2026-09-06 — mine.

### A second, same shape

**`SweepersPanel.tsx:264`** — the pool-row lead-in input, `min={0} step={0.5}`, no `max`, clamped only at
zero. It has a worse problem than its range: **nothing reads `jingle_categories.lead_in_sec` at all** —
`_placeJingles` takes its lead from `categories.overlay_lead_in_sec` only. Already filed in `backlog.md`
as decorative; noting it here because it is also unbounded.

### Everything else is correctly bounded

| control | UI range | engine clamp | verdict |
|---|---|---|---|
| Ducker depth | 0 … 40 dB down | `clamp(-60, 0)` | UI narrower ✔ |
| Ducker hold | 0 … 3000 ms | `clamp(0, 5000)` | UI narrower ✔ |
| Ducker release | 50 … 3000 ms | `clamp(1, 5000)` | UI narrower ✔ |
| Ducker attack | 1 … 300 ms | `clamp(1, 1000)` | UI narrower ✔ |
| Ducker threshold | −70 … −10 dBFS | `clamp(-90, 0)` | UI narrower ✔ |
| Target loudness | −30 … −6 LUFS | `clamp(-30, -6)` ×2 | exactly equal ✔ |
| Segue overlap | 0 … 10 s | `clamp(0,10)` in three places | exactly equal ✔ |

**The ducker is the model.** Every one of its five controls is *narrower* than the engine's clamp, so the
UI can never ask for something that will not be honoured. That is the correct direction, and it is already
in the product — the LEAD control is the exception, not the rule.

---

## What this document does not claim

The §1 trace is read from `engine.js:2196-2258` and is arithmetic on those two gates — **I did not set a
LEAD of 40 and watch a seam.** The check that would settle it is a single seam with LEAD 40 and the fire
time observed. The §2 conclusion is an absence of evidence: I searched the origin commit, two design docs
and the full history for the identifier and found no justification, which is not proof none was intended.

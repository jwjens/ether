# REFRESH NOW appears broken — what was actually wrong (4.4.194, 2026-08-12)

**Report (verbatim, Jeff):** *"The REFRESH NOW button flickers because it optimistically shows a
state change that immediately reverts to 'None'. The user sees a button that appears broken – no
feedback, no loading state, no error message."*

**Status:** fixed in 4.4.194. Runtime behaviour **UNVERIFIED** — the gate is Jeff's two-step test
below.

**Files:** `src/lib/designationRow.ts` (new), `src/lib/designationRow.test.ts` (new),
`src/components/HealthMonitor.tsx`, `electron/main.js`, `docs/help-designated-generator.md`.

---

## Confirmed before touching anything

- `designation:status` returns rows for all four stations. The handler works.
- Auto-generation is OFF on every station (station 1 = `"0"`, stations 2–4 absent →
  `parseKvFlag(…, false)` → **definitely off**, not unknown).
- Auto-gen OFF *is* the correct state, and a machine with it off must never take the designation
  (`generation-designation.js` `decide()` → `observe`).
- The problem is the UI.

## What was actually producing the symptom

Three separate causes, all of which had to go.

### 1. One `busy` boolean drove four buttons

`desigBusy` was a single `boolean` and `DesignationRows` is rendered per station with
`busy={desigBusy}`. **Clicking one station's REFRESH NOW put all four buttons into the busy state at
once** — four controls twitching for one click. Now `desigBusy: number | null` holds the station id,
so only the clicked button changes.

### 2. A real revert vector — the poll and the click raced

`loadDesig` runs on a 30-second interval and `refreshDesig` runs on click. Both called `applyDesig`,
which **replaces the whole map**, and whichever *resolved* last won. A poll issued before the click
could land after it and repaint the pre-click rows over the fresh ones — a state change that
immediately reverts.

Fixed with the ticket pattern the auto-generate toggle has used since 4.4.106 (`autoSeq`):
a monotonic `desigSeqNext` issues a sequence number per read, `desigApplied` records the newest one
applied, and a response that has been overtaken is discarded instead of painted.

**One correction to the report, offered as diagnosis and not as a softening:** there is no code on
this path that paints a designation state *before* the read returns — the label change to `…` was
the only pre-read paint, and it is a loading state rather than an optimistic one. The revert Jeff saw
is real; its mechanism is the race above. The fix is sized to the report either way: no paint on this
path now precedes a confirmed read.

### 3. "None" with no reason, next to a button that visibly did nothing

With auto-gen off the tick correctly decides `observe`, writes nothing, and the row stays **None**.
Pressing REFRESH NOW performed a real, successful read that changed nothing visible. **A correct
outcome that is indistinguishable from a dead control is a defect in the product** — the operator
cannot tell them apart, and Jeff didn't.

## What 4.4.194 does

| Required | Delivered |
|---|---|
| 1. No optimistic paint | Sequence guard; rows are only ever the rows the main process just read back. |
| 2. Loading state | Button reads **REFRESHING…** (was a bare `…`, which at local-IPC speed is a flicker, not a state). Per station. |
| 3. Show the actual result | Row repaints from the confirmed read; when it stays **None** it now carries the reason. |
| 4. Auto-gen OFF feedback | Button **disabled**, greyed, `cursor: not-allowed`, tooltip *and* a visible note beside it: **"Auto-gen off – cannot designate"**. |
| 5. Error handling | Per-station errors on their own red line **under** the row, not squeezed onto the end of the button line. Poll failures (which really are global) stay separate from per-click failures. |

### Two decisions worth flagging

**Disabled, not merely tooltipped.** The spec allowed either. Disabled is right here because the
30-second poll keeps the rows current regardless — so disabling the button costs the operator no
information, while a live button that does nothing costs them their confidence in the panel. The
help entry says this explicitly.

**Unreadable is not OFF.** The button is disabled only on a *definite* `false`. If the flag cannot be
read (`null`), the button stays live — guessing OFF would disable the one control that could reveal
what is actually stored. Same rule `kvFlag.ts` was written to enforce.

**The row's reason comes from the decider.** `_desigStatus` now carries `autoOn`, `action` and
`reason` from `decide()`, so the screen states the reason in the decider's own words instead of
re-deriving one from a second read that can disagree with the one that made the decision.

## Why a new file

`src/lib/designationRow.ts` holds every rule above as pure functions; the component just renders
them. This is the precedent `kvFlag.ts` set after the auto-generate toggle shipped broken twice: the
rules that decide what a control says are exactly the rules worth asserting, and they cannot be
asserted through a component that needs a DOM. `designationRow.test.ts` covers 17 cases including
"busy AND blocked" (blocked reason outranks busy text) and "nothing has ticked yet".

## Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors** |
| `npx vitest run` | **174 passed**, 15 files (was 157 — 17 new) |
| `npm run test:designation` | **ALL PASS** |
| `node --check electron/main.js` | OK |

## The gate that has not run — Jeff's test

1. **Auto-gen OFF:** REFRESH NOW is greyed with **"Auto-gen off – cannot designate"** beside it, and
   the row explains why it says None.
2. **Switch AUTO ON, click REFRESH NOW:** button shows **REFRESHING…**, then the row flips to **This
   machine** in green — and stays across the next 30-second poll.

Expect the main-process log to go from `observe 4 · wrote 0` to `designate 1 · wrote 1` for that
station on the click.

## Architecture compliance

- `docs/single-writer-election-design-2026-08-11.md` §0 — Phase A observes and gates nothing.
  Unchanged: this is presentation only, plus three extra fields on an existing status payload. No
  change to `decide()`, to when the tick writes, or to `_autoExtendTick`.
- **Honest UI** — the button no longer implies an action it cannot perform, and the panel no longer
  renders a correct-but-unexplained state as if it were the same as a broken one.
- No watcher, poller, or scheduled task was created; nothing to tear down. The 30s poll is
  pre-existing.

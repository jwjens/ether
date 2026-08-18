# "Clear pending (set baseline)" — does the button exist? Verification + build

**Date:** 2026-08-18 · **Report:** Jeff — both machines on 4.4.225 show Preflight / Push / Pull only;
no screen has ever shown a Clear-pending button, despite reports claiming it was built.

**Jeff's report is correct.** The button was never on any screen. What follows is the evidence, the
verdict, and the build.

---

## 1 · The tree — the handler function exists, the BUTTON does not

| What | Where | Status |
|---|---|---|
| Renderer function `clearPending()` | `src/components/SettingsPanel.tsx:1128` (pre-fix) | **PRESENT** — with confirm text, IPC call, error handling |
| Any JSX binding to it | — | **ABSENT** |

The decisive grep. Before the fix, `clearPending` appeared in the file **exactly once** — its own
definition:

```
grep -n "clearPending" src/components/SettingsPanel.tsx
1128:  const clearPending = async () => {          ← the only hit
```

The panel's rendered button row (`SettingsPanel.tsx:1312-1314`, `MultiMachineSyncSection`, which spans
`1082-1327`) contained exactly three buttons and no fourth:

```jsx
<button … onClick={refresh}>                        PREFLIGHT
<button … onClick={() => run("sync:push-now","push")}>  PUSH NOW
<button … onClick={() => run("sync:pull-now","pull")}>  PULL NOW
```

So the function was an orphan: written, never wired, never rendered. Nothing an operator could click
ever pointed at it.

## 2 · The packaged 4.4.225 asar — the button is absent, the handler is present

Grepped the actual artifact built on 2026-08-17 (`dist-electron/win-unpacked/resources/app.asar`,
263 MB, the tree that produced `Ether Setup 4.4.225.exe`, 195 MB):

| String | Hits | Means |
|---|---|---|
| `Clear pending sync history` (the renderer confirm text) | **0** | the button path is **not in the shipped bundle at all** |
| `PREFLIGHT` | 2 | the three buttons Jeff sees are shipped |
| `PUSH NOW` | 1 | ″ |
| `sync:clear-pending` | **3** | the **main-process handler IS shipped** |
| `sync:set-baseline` | 2 | shipped too |

**Why zero and not one:** an unreferenced local function inside a component is dead code, and the
production minifier drops it. Confirmed independently against the current tree's build — before the
fix, `Clear pending sync history` had **0 hits** in `dist/assets/*.js` while `PREFLIGHT` had 1. The
renderer half was compiled away every time it was built.

## 3 · The handler — real, complete, and already live

`electron/main.js:9287` `ipcMain.handle('sync:clear-pending')` does exactly the job, and does it in the
right order:

1. pauses the sync scheduler if one is running,
2. counts pending and total mutations **before**,
3. in **one transaction**: `setBaseline(db)` **first**, then `DELETE FROM mutations` — the comment at
   `:1125-1127` records why the order matters (baseline-then-wipe; the reverse leaves a window with an
   empty journal and no watermark, which is the state that refills),
4. returns `{ ok, pendingBefore, pendingAfter, totalBefore, baseline, baselineSource }`,
5. resumes the scheduler in `finally`.

Supporting module `electron/sync/baseline.js` — `BASELINE_KEY = "baseline_hlc"` (`:40`), stored in
`system_state`, with `getBaseline` / `setBaseline` / `clearBaseline` / `makeBaselineGate` (`:123`).
There is also a separate `sync:set-baseline` (`main.js:9265`) that sets the watermark **without**
wiping — not the operator path.

## 4 · Verdict

**None of the three offered categories fits exactly, so here is the precise one:**

> **The handler was built, committed and SHIPPED in 4.4.225. The button was never built.** The renderer
> function that would have called it was written but never bound to any element, so the bundler
> discarded it and no screen has ever rendered it.

A working IPC handler with no door. This is the doors-before-rooms failure in its purest form — and it
is why "it's in the code" is not shipped. Any earlier report that the button was built was describing
the function, not a control.

## 5 · Built for real — 2026-08-18

`src/components/SettingsPanel.tsx`, `MultiMachineSyncSection`:

| Requirement | Implementation |
|---|---|
| One button on the sync panel | `CLEAR PENDING…` added to the existing Manual-override row beside PREFLIGHT / PUSH NOW / PULL NOW |
| Sets `baseline_hlc` to now + wipes pending | calls the existing `sync:clear-pending` — one transaction, baseline first. No new backend. |
| **Typed** confirm | arming the button opens an inline panel showing the exact pending count; the operator must type **CLEAR** before `DISCARD BACKLOG` enables. Enter also submits, only on a valid match. |
| Disabled mid-push | `disabled={busy !== null || !pf?.ok}` — `busy` is set by preflight, push and pull, so the journal can never be deleted while a push is still sending those rows. The confirm button carries the same guard. |
| Honest copy | states what is discarded, states that songs / stations / clocks / logs / settings are untouched, states that other machines keep their own history, states it cannot be undone. |

`window.confirm()` was **not** kept: it blocks the renderer, and Jeff specified a typed confirmation for
an irreversible action on a machine that may hold tens of thousands of queued changes.

### The proof it is real this time

The same test that exposed the absence, re-run on the new build:

| String | Before | After |
|---|---|---|
| `Clear pending sync history` / `CLEAR PENDING` | **0 hits** in `dist/assets/*.js` | **1 hit** (`CLEAR PENDING`) |
| `DISCARD BACKLOG` | 0 | **1 hit** |

The control now survives bundling, which is exactly what the orphan never did.

## 6 · Gates

- `npx tsc --noEmit` → **0 errors**
- `npm run build` → clean, and the bundle-string check above
- `clearPending` now has **5** references (definition + 2 call sites + guards), not 1

## 7 · Operational note — OV's 29,226 pending

This is the button's exact job. Sequence when it reaches OV:

1. **Preflight first** and record `pending` / `baseline` — the numbers before.
2. `CLEAR PENDING…` → type `CLEAR` → `DISCARD BACKLOG`.
3. The result line reports `pending N → 0` and the new baseline; Preflight re-runs automatically.

Two things to be clear about before it runs there:

- It is **per-machine**. It discards *this* machine's backlog and sets *this* machine's watermark.
  Running it on OV does not clear anything on OVEVENTS, and vice versa.
- It needs a build that **contains** it. 4.4.225 does not — the artifact check in §2 is the receipt. OV
  cannot use this button until a build carrying it is installed there.

**Runtime UNVERIFIED** — this is a renderer change, so the dev app picks it up on relaunch; acceptance
is Jeff seeing the button in Settings → the multi-machine sync section.

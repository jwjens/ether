# Log-Reader canary toggle — stale state made the write self-perpetuating

**Date:** 2026-07-30 · **Mode:** trace, then fix. `tsc --noEmit` at baseline. **No bump, no commit, no
build** — awaiting authorisation.
**Confirmed by Jeff via DevTools:** `station_config_kv:get-value(4, "log_reader_flip")` →
`{ok: true, value: '0'}`. Main and the DB agree. The button rendered `LOG-READER ON` anyway.

---

## 1. Where the button got its `on` state, and why it could hold `true`

**The chain, as it was:**

```
station_config_kv (truth)
  → invoke("station_config_kv:get-value")            HealthMonitor.tsx:316
  → out[st.stationId] = !!(r && r.ok && …)           :317
  → setFlipFlags(out)                                :319          ← the ONLY writer of the state
  → useEffect(() => refreshFlipFlags(), [refreshFlipFlags])        :322
  → const on = !!flipFlags[st.stationId]             :730          ← what renders
  → onClick={() => toggleFlip(st.stationId, !on)}    :734          ← what gets WRITTEN
```

`refreshFlipFlags` is the **only** path that can correct `flipFlags`. Everything else reads it.

**Three defects in that chain let `true` survive a `'0'`:**

**(a) Whole-map replace, inside a swallowed try.** `setFlipFlags(out)` was the *last* statement in the `try`
(`:312-320`), after an `await` **per station** in the loop. If any single iteration rejected, `catch {}`
(`:320`) swallowed it and **`setFlipFlags` was never called at all** — the previous map survived untouched.
The map legitimately holds `true` right after a successful write of `"1"`. From that moment, one failed
refresh pins it `true` forever, because there is no other corrective path.

**(b) Overlapping runs, last-to-resolve wins.** `refreshFlipFlags` is a `useCallback` keyed `[libHealth]`
(`:321`), and `libHealth` is re-polled — so its identity changes and the effect (`:322`) re-enters. Two runs
can be in flight at once; whichever *resolves* last calls `setFlipFlags(out)` with **its own** snapshot, not
the freshest one. There was no in-flight guard and no unmount guard.

**(c) Unknown was coerced to a definite answer.** `!!flipFlags[...]` (`:730`) turns "never read" and "read
failed" into `false`. The same coercion in the other direction is what makes any wrong value actionable.

**Which of (a)/(b) actually fired on your machine I cannot tell from static analysis, and I'm not going to
claim one.** It doesn't matter for the fix — the change below removes the whole class, including whichever
one it was.

**The amplifier that made it permanent — `toggleFlip(sid, !on)` (`:734`).** The value written was **derived
from what was on screen**. So a stale `true` didn't merely display wrong; it made every click write `'0'`,
which is precisely the value that keeps the state stale. A read-only display bug became a write bug that
defends itself. That is the actual defect, and it is why clicking "harder" could never fix it.

## 2. Did it re-read after writing? **Yes — and that was never the problem.**

`toggleFlip` did `await refreshFlipFlags()` after the write (`:324`). The re-read existed. Three reasons it
couldn't save the control:

1. **The write target was already computed from stale render state before the re-read ran.** The re-read then
   faithfully reported the wrong value that had just been written. Reading back after writing the wrong thing
   confirms the wrong thing.
2. **The write's own verdict was ignored.** `set-local` returns `{ok:false, error}` when it refuses a key
   (`electron/sync/handlers/station_config_kv.js:286`). The return value was never inspected.
3. **The re-read could itself be discarded** — same `catch {}` as (a).

So the missing half was not "read after write". It was **derive the write from a read.**

---

## 3. The fix

`src/components/HealthMonitor.tsx`. Three rules, stated in the code at `:310-318`:

> 1. the write target is computed from a FRESH read of the stored value, never from render state;
> 2. what renders is the value READ BACK AFTER the write — never an assumption that it landed;
> 3. unknown is its own state, and a refused/ignored write is shown, not swallowed.

**`readFlip(sid)` — `:324-330`.** One function, the single source of truth for this control. Returns
`true | false | null`, where `null` means *we could not read it*.

**`refreshFlipFlags` — `:335-341`.** Now merges **per station with a functional update**:

```ts
for (const st of sts) {
  const v = await readFlip(st.stationId);
  setFlipFlags(prev => ({ ...prev, [st.stationId]: v }));
}
```

Kills (a) and (b) together: there is no whole-map replace to skip, so a mid-loop failure can no longer leave a
stale map intact; each station's result is committed as it arrives; overlapping runs merge instead of
clobbering; and one station failing to read no longer resets the others.

**`toggleFlip(sid)` — `:344-367`.** Note the signature: **it takes only the station id.** There is no boolean
argument left for render state to poison.

```ts
const current = await readFlip(sid);                       // truth, now
if (current === null) { … "not writing blind" …; return; } // never write against an unknown
const target = !current;                                   // target derived from the READ
const w = await invoke("station_config_kv:set-local", sid, "log_reader_flip", target ? "1" : "0");
const writeRefused = !w || w.ok === false;                 // the write's verdict is inspected
const after = await readFlip(sid);                         // read back
setFlipFlags(prev => ({ ...prev, [sid]: after }));         // render the STORED value, not the intent
if (writeRefused)      → "write refused: <error>"
else if (after !== target) → "write did not stick — still ON/OFF"
```

The inversion is now structurally impossible: the only input to the write is a fresh read, and the only input
to the render is a fresh read.

**Render — `:729-762`.** Tri-state, no `!!`:

| stored | button |
|---|---|
| `true` | `LOG-READER ON`, purple |
| `false` | `LEGACY` |
| `null` / never read | **`UNKNOWN`**, amber outline |
| in flight | `…`, disabled, wait cursor |

A per-station error line appears in red under the row when a write is refused or doesn't stick. **A stuck
write is now visible instead of silent** — which is the honest-UI point: this control had been lying about
the playout engine of a live station.

## Blast radius

**Renderer display + one local-only KV write.** The control writes exactly one key,
`station_config_kv.log_reader_flip`, through the same `set-local` IPC as before — no new channel, no schema
change, no daemon involvement. `audiod/`, `electron/main.js` and `native/` are **untouched** by this change.

The one behavioural difference on air is the intended one: clicking now actually flips a station's playout
engine, where before it silently rewrote the same value. Once a station does flip, the daemon picks it up
within 5 s via `_logReaderOn()` (`audiod/engine.js:722-734`).

Also unchanged and worth restating, because it affects how the flip appears to behave: the flip engages at the
**next refill**, and `audiod/engine.js:524` only *calls* the refill when `queue.length < 5`. With a queue of 8
that is roughly four songs (~15 minutes) before it takes over.

## Not built

- No change to `_logReaderOn`, `_refillFromLog`, `selectRowForNow` or anything in the daemon.
- The **auto-fitter** — the thing that would shed time toward an anchor automatically instead of you
  crossfading past two songs by hand — is still designed-not-built, and still gated on this flip.
- Not chased: *why* the stale `true` first appeared. The class is removed; the individual cause is now
  unreachable and unobservable.

## Gate

`./node_modules/.bin/tsc --noEmit` → **exactly the 2 accepted-baseline errors** (`OnboardingFlow.tsx:2039`,
`PhoneDesk.tsx:777`). No new errors; none in `HealthMonitor.tsx`.

## Files

```
src/components/HealthMonitor.tsx   :307-367 state + read/write path   ·   :729-762 tri-state render
```

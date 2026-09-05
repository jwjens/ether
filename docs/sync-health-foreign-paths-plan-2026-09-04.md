# 2.3 — the content-level health signal · PLAN

**Status: CURRENT · last verified 2026-09-04 · PLAN ONLY. NOTHING BUILT.**
Follows `docs/sync-ui-manual-control-inbound-notice-2026-09-04.md` §2.3 and
`docs/design-machine-local-paths-2026-09-04.md`. Jeff's rulings of 2026-09-04 are recorded in §0.

---

## 0 · Rulings taken as given

1. **"Later" defers audio only** — rows apply on drain; no staging buffer now; **the dialog must say
   so in those words**. (Affects 2.2, recorded here so the sequence stays honest.)
2. **SYNC NOW lives on the main surface**, near where station state already is. The Settings
   PUSH/PULL stay exactly as they are, as emergency overrides. (2.1.)
3. **A non-zero `foreign` count REPORTS LOUDLY, never blocks.** *"The OV machine kept playing 133
   songs while 382 were foreign, and I'd rather have that than silence."* But it must be
   **impossible to miss** — a visible alarm state on the surface the operator actually looks at, not
   a number in a diagnostics panel.

---

## 1 · The finding that shapes this: the sense already exists and is WRONG

There is no new module to write. `library-health.js` already computes a `materialization` sense per
station. It is the classifier inside it that is defective — `electron/library-health.js:355-360`:

```js
let resolvable = 0, localOnly = 0, r2Only = 0, dead = 0;
…
if (local) { resolvable++; localOnly++; }
else if (s.file_key) { resolvable++; r2Only++; }
else dead++;
```

and `:390-391`:

```js
const materialization = { resolvable, total, r2Only, dead };
const materialLevel = dead > 0 ? 'red' : (r2Only > 0 ? 'yellow' : 'green');
```

**A row with a foreign absolute path and a `file_key` is counted as `resolvable`, labelled `r2Only`,
and rated `yellow`.** That is exactly the OV condition, and it is why the design doc records
`r2Only: 163/163` on a station whose audio was sitting in the music folder under the right name.

Three separate lies in one branch:

- it says **resolvable** — the row could not be aired;
- it says **r2Only** — the bytes were already local;
- it rates **yellow** — an entire station's library was unairable.

**So 2.3 is not "add a signal". It is "stop the existing signal from misreporting", plus surface it.**
That is a smaller change than the previous doc implied and a more important one.

---

## 2 · The classification

Two orthogonal questions, deliberately not collapsed into one enum — collapsing them is what produced
the bug:

### 2a · Can it be aired? (resolution class — one per row)

| class | test | meaning |
|---|---|---|
| `resolves` | `exists(file_path)` | plays today |
| `resolvesElsewhere` | basename found in this machine's music dir | **the resolver tier will save it** (design doc option C) |
| `r2Only` | no local file by either route, but `file_key` present | genuinely needs fetching |
| `dead` | none of the above | unairable, and nothing can fix it automatically |

### 2b · Is the stored path from another machine? (independent flag)

`foreign` = the stored path's **directory does not exist on this machine**.

This is reported **separately**, not as a fifth class, because a row can be both `foreign` and
`resolvesElsewhere` — which is precisely the healthy post-resolver state on OV. Folding them together
would hide the repair working.

**Level:**

```
red    if dead > 0 OR foreign > 0
yellow if r2Only > 0 OR resolvesElsewhere > 0
green  otherwise
```

`foreign > 0` is **red** per ruling 3 — loud, non-blocking. `resolvesElsewhere > 0` is yellow rather
than green because it means rows are only airing thanks to a fallback; that is a real condition an
operator should see, not a silent save.

### 2c · What OV would have read this morning

| today | with this change |
|---|---|
| `resolvable 163/163 · r2Only 163` · **yellow** | `resolves 0 · resolvesElsewhere 163 · foreign 163` · **RED** |

**This is a visible change to a displayed number on every install**, and it is a correction, not a
regression. Worth saying out loud before it lands.

---

## 3 · Implementation

**One file for the logic: `electron/library-health.js`.** It already owns THE PATH RULE (`:483-491`)
and the resolution order. Putting the classifier anywhere else creates a second place that decides
what a path means, which is the disease this whole arc is about.

### 3.1 · Cost — no per-row syscall growth

The sweep already calls `exists()` once per row and its duration is already measured (`sweepMs`,
`:456`). The new tests add **no** per-row syscalls:

- **Basename index:** read the music dir **once per sweep** into a `Set` of lower-cased basenames.
  Membership is then O(1). (Measured on dev: 1,878 files — one directory walk.)
- **Foreign test:** collect the *distinct* `path.dirname()` values (a handful, not one per row),
  `existsSync` each **once**, memoise for the sweep.

Both caches are per-sweep and thrown away, so a file appearing between sweeps is picked up on the
next one rather than being cached as absent.

### 3.2 · Scope — every audio-bearing table, not just `songs`

The current sense reads `songs` only. The OV incident spanned **seven** tables. The classifier
becomes a helper applied to each, so the snapshot carries a per-table breakdown:

`songs` · `announcements` · `spots` · `cart_slots` · `library_asset` · `published_episodes` ·
`voice_tracks`

**`cart_slots` is a deliberate exception to `foreign`.** Cart audio legitimately lives outside the
music dir (measured on dev: 10 of 10 carts under `Downloads`/`Music`, none in the library). A cart
whose path is absent is `dead`, never `foreign`, and must never be rebased — design doc §4 Option A
and test **T-new-4**.

Tables with **no `file_key` column** (`announcements`, `spots`, `cart_slots`, `voice_tracks`,
`published_episodes`) can never be `r2Only`; for them an unresolvable row is `dead` by definition.
That is the schema gap the design doc's Option B is blocked on, and the count makes it visible.

### 3.3 · Shape (additive — existing consumers keep working)

```js
materialization: {
  // unchanged keys, so HealthMonitor.tsx and ScheduleManager.tsx keep reading
  resolvable, total, r2Only, dead, level,
  // new
  resolves, resolvesElsewhere, foreign,
  byTable: { songs: {...}, announcements: {...}, … },
  foreignSample: [ { table, id, title, file_path } ]   // up to 5, for the operator to SEE one
}
```

`foreignSample` matters: *"382 foreign"* is a number, `C:\Users\jensj\Music\…` on a machine that is
not jensj's is an explanation. One glance and the cause is obvious.

### 3.4 · A health event, once per transition

`appendJsonl({ kind: 'foreign-paths', stationId, foreign, byTable })` on the **edge** — when the
count becomes non-zero, or changes materially — not every sweep. The prefetch defect wrote 2,443
identical log lines in two days; this must not repeat that.

---

## 4 · Where the alarm shows — ruling 3's "surface I actually look at"

**Finding: there is no health indicator on the main surface at all.** `library-health:get` is polled
only by `HealthMonitor.tsx:634` and `ScheduleManager.tsx:64` — both behind doors. An alarm that only
exists in the Health Monitor is exactly the diagnostics panel the ruling excludes.

**Proposal — one persistent affordance beside the station name in the top bar**, which is where
station state already lives (`App.tsx:612`, `stationName`) and where the operator already looks:

- **green** — a quiet dot. No chrome, no text.
- **red** — the dot turns red with a short count: **"382 files not on this machine"**. Clicking opens
  the Health Monitor at the materialization sense.
- It is **never** a modal and never blocks air (ruling 3).

**And this is where SYNC NOW goes (2.1, ruling 2)** — the same cluster: station name · sync state ·
SYNC NOW · health dot. One place for "what station am I, is it in sync, is it healthy", all reachable
without opening Settings. That answers the placement question directly: near station state, because
that is what it is about.

---

## 5 · Tests (gates)

| id | assertion |
|---|---|
| **H-1** | a row whose file exists at the stored path → `resolves`, not `foreign` |
| **H-2** | a row with a foreign dir + `file_key` + basename present in music dir → `resolvesElsewhere` **and** `foreign`; **not** counted in `resolvable` (the OV regression) |
| **H-3** | a row with a foreign dir, no basename match, `file_key` present → `r2Only` **and** `foreign` |
| **H-4** | a row with no local file and no `file_key` → `dead` |
| **H-5** | a `cart_slots` row outside the music dir with a missing file → `dead`, **never** `foreign` (T-new-4) |
| **H-6** | `foreign > 0` ⇒ `level === 'red'` |
| **H-7** | the sweep's syscall count does not grow with row count — the basename index is read once |

Fixtures use a temp dir and a synthetic DB; `goalCheck` is already exposed for exactly this kind of
bench (`:626`), so the precedent exists.

---

## 6 · What this deliberately does NOT do

- **Does not repair anything.** Read-only classification. The repair is the resolver tier (option C),
  asked for separately.
- **Does not change the resolvers** in `main.js` or `audiod/engine.js`.
- **Does not touch the sync protocol.** That is the amendment, and it lands after its own doc.
- **Does not block air**, ever (ruling 3).

---

## 7 · OPEN — needs Jeff before building

1. **Is the top-bar dot the right affordance**, or would you rather it live on the board itself?
   §4 is a proposal, and it is the one part of this I am guessing at.
2. **`resolvesElsewhere` as yellow** — agree? It means "airing only because of a fallback", which I
   think you want to see. Green would hide the fact that the resolver is carrying the station.
3. **The displayed-number change in §2c** lands on every install, including OV. Confirm you want it
   in the same change rather than behind a flag.

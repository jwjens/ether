# Sync UI — manual control, inbound notification, and a content-level health signal

**Status: CURRENT · last verified 2026-09-04 · INVESTIGATION + PLAN. NOTHING BUILT.**
Follows the OV incident of 2026-09-04 and `docs/design-machine-local-paths-2026-09-04.md`.

Operator report, verbatim:
1. *"NO MANUAL SYNC BUTTON. After first login there's no way for me to say 'pull now' — I'm stuck
   waiting on whatever the scheduler does."*
2. *"NO NOTIFICATION THAT ANYTHING ARRIVED. When another machine pushes new data or songs, this
   machine gives no sign."*

---

## 1 · What exists today (read-only findings)

### 1.1 · A manual trigger EXISTS — and the operator could not find it

`src/components/SettingsPanel.tsx:1254-1256`:

```jsx
<button onClick={refresh}>PREFLIGHT</button>
<button onClick={() => run("sync:push-now", "push")}>PUSH NOW</button>
<button onClick={() => run("sync:pull-now", "pull")}>PULL NOW</button>
```

Backed by real IPCs — `sync:push-now` (`main.js:10437`) and `sync:pull-now` (`:10453`).

**The report stands as written.** The controls are there; the operator has no way to reach them, so
functionally there is no manual sync. Three things put them out of reach:

- They live in **Settings → Multi-Machine Sync**, below a preflight diagnostics panel, a UUID-identity
  toggle and a CLEAR PENDING danger control.
- They are captioned **"Manual override"**, and the code comment above them reads *"Kept as EMERGENCY
  OVERRIDES, not the normal path — the loop is."* The UI actively tells the operator this is not for
  them.
- Nothing on the main surface — no menu item, no status affordance — points at them.

This is the doors-before-rooms rule: *a feature without an obvious door does not exist to users.*
**The fix is sized to the report — a reachable, ordinary sync control — not a relabel.**

### 1.2 · Nothing whatsoever surfaces inbound activity

The scheduler already tracks everything needed and tells no one:

| what it has | where |
|---|---|
| `appliedTotal` | `sync-scheduler.js:50, 60` |
| **`byTable`** — applied count per table | `:102-107` |
| `pulledToday`, `pushedToday`, `lastSyncAt` | `:92, 195` |
| `sync:initial-complete` event | `:26, 227` — consumed **only** by the onboarding screen |
| `sync:progress` event | preload `:335` |

`byTable` is precisely the shape the operator asked for. It is computed on every drain and thrown
away.

### 1.3 · Rows and audio arrive over TWO different transports

This is the single most important design fact for the notification, and it is easy to get wrong:

- **Rows** (songs, announcements, spots, cart_slots…) arrive as **mutations** through the sync
  scheduler → `byTable`.
- **Audio files** arrive through a **separate** R2 library transfer — `library:sync-r2:download`,
  with its own `…:download:progress` / `…:download:done` events (preload `:153-158`), plus the
  background prefetch in `library-health.js`.

A notification that reads only one of them will lie. *"12 songs incoming"* with no audio is exactly
the OV failure mode: rows present, bytes absent.

### 1.4 · Notification primitives already exist

- `src/components/StreamStatusToast.tsx` — the toast precedent.
- `src/lib/askText.tsx` — a self-mounting, promise-based modal. The pattern for
  "apply now or later?" without inventing anything.

### 1.5 · The tree has known about the path defect since 2026-08-17

`electron/library-health.js:483-491` — THE PATH RULE:

> `songs.file_path` is typed 'blob-ref' in the sync registry, and blob-ref in v0 ships the literal
> absolute path … so a peer's `C:\Users\<them>\Music\...` lands verbatim in this database. Prefetch
> used to hand that straight to fs.mkdirSync, which produced **2,443 logged failures** between
> 2026-08-15 and 2026-08-16.

The prefetch path was hardened then. The **resolvers were not**, and the **sync UI was never told**.

---

## 2 · PLAN — three pieces, not built

### 2.1 · A real sync control

**Where:** the canonical navigation, not Settings. It belongs beside the other things an operator
presses during a shift.

**What it is:** one control — **SYNC NOW** — that does pull-then-push (pull first: receiving before
sending is what an operator means by "sync"), shows live state on the button itself
(`idle → pulling → applying → pushing → done/failed`), and reports a one-line outcome naming what
moved: *"received 12 songs, 3 announcements · sent 4 changes."*

**What it must not be:** silent on failure, or green when it moved nothing. If `sync_enabled` is off,
if no license resolves, or if the backend is unreachable, it says so **in the button's own outcome
line**, not in a console.

**Reuses:** `sync:pull-now`, `sync:push-now`, `sync:preflight`, `sync:get-state`. **No new engine
work.**

**Leave in place:** the Settings panel and its diagnostics. It is the right home for PREFLIGHT,
CLEAR PENDING and the identity toggle. Only the everyday verb moves out.

### 2.2 · The inbound notification

**Trigger:** a drain that applied ≥ 1 row, or an R2 download batch that queued ≥ 1 file.

**Content — the operator's requirement, taken literally.** Rows and audio counted separately,
named by kind, never "sync activity":

> **New data from STUDIO-PC**
> 12 songs · 3 announcements · 1 clock
> 8 audio files (412 MB) still downloading
> **[ Apply now ]  [ Later ]**

- Row counts come from `byTable`, mapped to operator words (`songs` → "songs", `cart_slots` →
  "carts", `generated_schedule` → "log entries"). A table with no friendly name is listed by count
  and its raw name rather than being dropped — an unnamed table is a gap in the map, not a reason to
  hide data.
- The machine name comes from the mutation origin (`pf.mutations.byOrigin` already carries it).
- Audio is a **separate line**, always, even when zero: *"0 audio files"* is information.

**"Apply now or later" — the honest part.** Mutations are already applied when the drain completes;
there is no staging buffer. So the two options must mean something real:

- **Apply now** → run the R2 audio transfer for the newly-referenced rows immediately, and refresh
  the open panels.
- **Later** → defer the *audio transfer* (bandwidth is the real cost, especially mid-show), keep the
  rows, and leave a persistent, dismissible indicator showing what is still pending.

Presenting a choice that does nothing would be worse than no dialog. **If deferring the row apply is
what's actually wanted, that is a scheduler change and a bigger piece of work — flagged as an open
question, §4.**

**Do not interrupt air.** No modal over the board while something is playing: it becomes a toast that
can be opened, with the choice preserved.

### 2.3 · The content-level health signal — *"do the rows I received actually resolve here?"*

**The gap, in one line:** every signal in the sync panel is transport-level. On OV this morning it
would have read *pending 0 · engine running · ever received: **yes*** — green by its own measure —
while all 382 received rows named a directory that machine cannot open.

**The signal to add:** for every audio-bearing table (`songs`, `announcements`, `spots`, `cart_slots`,
`library_asset`, `published_episodes`, `voice_tracks`), classify each row's `file_path`:

| class | meaning |
|---|---|
| **resolves** | the file exists at the stored path |
| **resolves elsewhere** | absent at the stored path, but `music_dir\basename` exists — the resolver tier will save it |
| **foreign** | the path's root is not this machine's, and no local file matches — **the OV condition** |
| **R2-only** | no local file, but a `file_key` exists to fetch by |
| **dead** | no local file, no `file_key`, no basename match — unairable |

Rendered in the sync panel as one line per class, with **foreign** and **dead** loud. A non-zero
**foreign** count is the alarm that did not exist this morning.

**Where the logic goes:** `library-health.js` already owns the path rule and the resolution order
(`:483-491`). This is a query it should expose, not a second implementation — the same defect this
whole arc is about is what happens when two places decide what a path means.

**This is the permanent sense the roadmap asks for** (*build the sense, not the scaffold*) and it
replaces any temptation to diagnose the next occurrence with a hand-written script.

---

## 3 · Sequencing

1. **2.3 first.** It is read-only, it cannot break air, and it is the thing that would have caught
   this incident. It also gives 2.1 and 2.2 an honest number to display.
2. **2.1 next.** Small, reuses existing IPCs, and unblocks the operator immediately.
3. **2.2 last.** It depends on both — the notification's audio line is 2.3's classification, and its
   "apply now" action is 2.1's control.

None of this depends on the resolver tier or the protocol amendment, and none of it conflicts with
them: 2.3's "resolves elsewhere" class is *defined by* the resolver tier, so shipping the resolver
turns that count into a self-healing one rather than changing the signal.

---

## 4 · OPEN — needs Jeff

1. **Does "Later" need to defer the ROW apply, or only the audio?** As built today rows are applied
   on drain with no staging, so only the audio can honestly be deferred. Deferring rows is a
   scheduler change of a different size.
2. **Where does SYNC NOW live** — hamburger menu, or a persistent status affordance that doubles as
   the button?
3. **Should a non-zero `foreign` count block anything**, or only report? On OV it would have been 382
   — loud, but the station was still on air with rotation.

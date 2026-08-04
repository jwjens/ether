# Jukebox Mode — design of record

**Date:** 2026-08-04 · **Status:** DESIGN. Read-only tracing done. **NOTHING BUILT.**
**Requested by:** Jeff · **Context:** OV Halloween park season — public-facing song picking, staff supervised.

---

## 1 · What it is

A **fullscreen takeover of the running app** on the station PC. Monitor and keyboard face the public;
staff supervise. Not a second device, not a second app, not a web page — the same process, the same
engine, the same station.

The public browses and picks. A pick becomes **PLAY NEXT** on the operator's running station.
A corner **SETTINGS** button, gated by the operator's 4-PIN, is the only way out or in to config.

---

## 2 · The five decisions, restated as they will be built

### 2.1 · Fullscreen takeover

A route/overlay inside the existing renderer that occupies the whole window, not a new BrowserWindow.
Reasons: the audio engine, active station and daemon connection are already resolved in this renderer;
a second window would need the whole station-context handshake again, and this session has already paid
for that class of bug twice (command-path station scoping, popout `?? 1`).

Exit is PIN-gated, same gate as settings. Public cannot alt-tab their way to the console by clicking.

### 2.2 · PIN-gated settings overlay

**Reuses the existing user PIN — no new auth, no new storage.**

- `electron/preload.js:264` → `verifyPin(pin, stored)` → `user:verify-pin`
- `users.pin_hash`, stored `salt:sha256` (`SettingsPanel.tsx:3243`, `:3275`)

The overlay asks for a PIN, verifies against the `pin_hash` of users whose role is operator-or-above,
and on success reveals config. On failure it says nothing useful and returns to browse. No PIN is ever
held in component state after verification; the overlay holds a boolean.

**This is a supervision gate, not a security boundary.** A determined person with physical keyboard
access to a Windows box is not stopped by an in-app PIN. Staff supervision is the actual control; the
PIN stops idle curiosity. Saying so plainly here so nobody later mistakes it for hardening.

### 2.3 · Flow, and how it interacts with the deck the operator is running

**Precondition: the operator has engaged MANUAL.** That is Jeff's spec, and it happens to be exactly
what makes this safe, per the governing contract:

> `audiod/engine.js:269-278` — "MANUAL MODE — stop DECIDING, never stop RUNNING … press MANUAL
> mid-song and the song keeps playing, because nothing tells it to stop. Automation stops deciding
> (`_mayDecide()`) and the engine keeps running."
> Governing docs: `docs/design-manual-mode-contract-2026-07-31.md`,
> `docs/manual-mode-dead-air-trace-2026-07-31.md`

So in MANUAL the scheduler is not choosing the next song, and a jukebox pick does not *fight*
automation — it fills the vacancy automation has stopped filling. In AUTO, both would be choosing, and
the jukebox would be racing the rotation. That is why MANUAL is the precondition and not a preference.

**Play-next is expressed through the existing id-addressed queue intents.** The daemon is the single
source of truth; the renderer may not push a queue mirror (`engine-rodio.ts:988-996` — `replaceQueue`
is a deliberate no-op in daemon mode).

- `engine-rodio.ts:610` `queueEnqueue(items)` → `queue:enqueue`
- `engine-rodio.ts:613` `queueMove(qid, "top")` → `queue:move`

A pick is therefore: **enqueue the song, then move its qid to top.** Two existing intents, no new
command, no new path into the engine. The currently-playing song is never touched — a pick lands
*after* it, which is what "play next" means to an operator.

**Honest state, not claimed:** the jukebox's up-next list renders the daemon's queue via the existing
`onQueue` stream. It never renders an optimistic local list. If the daemon didn't take the pick, the
public sees that it didn't.

**If the operator leaves MANUAL while the jukebox is open**, the jukebox must say so — a visible banner
and picks disabled — rather than silently enqueueing into a rotation that will out-vote it. Observed
from the engine-state stream (`_daemonStarted`), never inferred.

### 2.4 · Eligibility — clock as playlist (Jeff's revised call)

**A clock is a category-sequence template.** `clock_slots` (`electron/sync/synced-tables.js:217-241`)
holds `clock_id`, `position`, `slot_type`, `category_id` — an ordered sequence of slots, where music
slots name a category. A clock does not contain songs; it contains an *order of categories*.

Therefore, stated so it is built right:

> **"Clock as playlist" = the UNION of all songs in the DISTINCT categories that clock's music slots
> reference.** Order is discarded — sequence is a scheduling concern, and the jukebox is a browse grid,
> not a rotation. Duplicate category references collapse. Non-music slots (spots, talk breaks) are
> excluded: they name `spot_category_id`, not a music `category_id`, and are not pickable.

Resolution, one query shape:

```
clock_id
  → SELECT DISTINCT category_id FROM clock_slots
      WHERE clock_id = ? AND category_id IS NOT NULL AND deleted_at IS NULL
  → SELECT … FROM songs
      WHERE category_id IN (…) AND deleted_at IS NULL AND file_path IS NOT NULL
```

**Why this over a dedicated allow-list:** Jeff's call, and it is the simpler path — no new table, no new
migration, no second thing to curate. The trade is stated honestly below (§5) rather than hidden.

**Storage of the two settings — code-managed vs user-managed, decided before schema (standing rule):**
these are **user-managed** values (an operator picks them in the overlay) but they are *two scalars*,
not entities. They go in `station_config_kv`, the existing per-station key/value store, exactly as
`proc_local` / `proc_stream` / `station_logo` do:

| key | value |
|---|---|
| `jukebox_source_station_id` | integer, the station whose clock is used |
| `jukebox_source_clock_id` | integer, the clock within it |
| `jukebox_enabled` | `"1"` / `"0"` |

**No migration. No new table.** `station_config_kv` is already registered in `synced-tables.js:49`.

### 2.5 · Cross-station clock selection — and the one real hazard

The overlay has two dropdowns: **station**, then **clock in that station**. `clocks` and `clock_slots`
are `scope: 'station'`, so listing either for any station is a scoped query — cross-station selection
is free.

**The hazard, flagged not buried:** a clock on station 3 references station 3's categories, whose songs
are station 3's rows. Queueing those onto station 2's deck crosses a station boundary. Two things must
hold and must be *verified before build*, not assumed:

1. The song's `file_path` must resolve to a file that exists on this machine. The library
   R2-materialization gate is a known, previously-shipped defect class (half a station's library had
   `file_path` rows pointing at absent local files). **The browse grid must exclude, or visibly mark,
   songs with no local file** — a public-facing pick that produces dead air is the worst possible
   failure here.
2. Queueing a foreign-station song must not violate station scoping in the queue/play-log path.

**Recommendation:** ship v1 with the station dropdown present but defaulted to the operator's active
station, and treat cross-station as verified only once (1) and (2) have runtime receipts.

---

## 3 · UI — TouchTunes-style, built for a stranger's first ten seconds

- **Browse grid** of large album-art tiles. Art comes from the existing resolution path
  (`src/lib/albumArt.ts` → embedded cover; music may fall back to the music store). Missing art gets a
  neutral treatment with the title large — never an empty square.
- **Search** — always visible, large field, keyboard-first. Matches title and artist.
- **A pick** opens a confirm step: cover, title, artist, and one big **PLAY NEXT** button. Confirmation
  matters because the public cannot undo.
- **Up-next queue** visible at all times, rendered from the daemon's queue stream. This is the thing
  that makes a jukebox feel honest: you see your song coming.
- **Big targets** throughout — sized for a touchscreen even though v1 is monitor+keyboard, because the
  same screen may be touched later and nothing about big targets hurts keyboard use.
- **SETTINGS** in a corner, deliberately small and visually quiet. It is the only non-public control.
- **Empty state explains itself**: if no clock is configured, the public screen says the jukebox isn't
  set up, and staff are told to open Settings — not a blank grid.

### Scale — thousands of songs

Jeff's flag is right. A clock referencing broad categories can resolve to thousands of rows.

- The grid **paginates or virtualizes**; it never renders the whole result set at once.
- Search filters **in SQL**, not in a loaded array — the query is `LIMIT`ed and offset-paged.
- Art loads lazily per visible tile, with the existing per-file cache so scrolling back is free.
- The count is shown ("1,284 songs") so staff can tell at a glance that the clock resolved to something
  sane rather than to everything or nothing.

---

## 4 · Payment as a pluggable layer

**Phase 1 is cash/free — the reality is a bucket.** The build must not wait on any integration, and
must not need rework when one arrives.

One interface, one phase-1 implementation:

```ts
interface JukeboxPaymentProvider {
  readonly id: "free" | "clover" | "qr";
  readonly label: string;                       // shown on the confirm step
  /** Called when the public confirms a pick. Resolves ok:true to allow the queue intent. */
  authorize(sel: { songId: number; title: string; artist: string }):
    Promise<{ ok: boolean; reference?: string; declineReason?: string }>;
}
```

- **Phase 1 — `FreeProvider`**: `authorize()` resolves `{ ok: true }` immediately. The confirm button
  reads **PLAY NEXT**. If staff want a suggested donation, that is a line of copy, not code.
- **Phase 2 — Clover**: `authorize()` drives the card reader and resolves on approval. The confirm
  button reads **PAY & PLAY NEXT**.
- **Phase 2 — QR**: `authorize()` shows a QR and polls until paid or cancelled.

**The rule that keeps this clean:** the pick → queue path calls `authorize()` and enqueues **only** on
`ok: true`. Nothing else in the jukebox knows anything about money. Swapping provider is a config value
(`jukebox_payment_provider` in `station_config_kv`, defaulting to `"free"`), not a code change at the
call site.

Deliberately **not** built now: pricing, credits, refunds, receipts, takings reporting. Naming them so
it's clear they were considered and excluded, not forgotten.

---

## 5 · What clock-as-playlist costs, stated honestly

Not objections — Jeff has ruled. Recorded so nobody rediscovers them as surprises:

1. **The playlist moves when programming moves.** Editing a clock for rotation reasons silently changes
   what the public can pick. Mitigation: the overlay shows the resolved category names and song count,
   so the coupling is visible at the moment of configuring.
2. **Category granularity is the only granularity.** There is no "allow this song, deny that one." A
   single unwanted song in an allowed category cannot be excluded without editing rotation.
3. **A clock is an order; the jukebox discards the order.** Nothing breaks, but "the 9am clock" as a
   *playlist* means something different from what it means to the scheduler. §2.4 states the mapping so
   the difference is explicit.

If (2) becomes painful in the park, the escape hatch is additive and does not invalidate this design: a
deny-list of song ids in `station_config_kv`, filtered in the same query. No migration, no rework.

---

## 6 · Architecture compliance

| Rail | How this design complies |
|---|---|
| ONE scheduler | Jukebox never schedules. It enqueues into the daemon's queue and only while automation has stopped deciding (MANUAL). |
| Daemon is single source of truth | Picks go through existing `queue:enqueue` + `queue:move` intents (`engine-rodio.ts:610,613`). No renderer queue mirror — `replaceQueue` stays a no-op. |
| Honest state, observed not claimed | Up-next renders the daemon's queue stream; MANUAL is read from the engine-state stream; no optimistic list. |
| Build the sense, not the scaffold | Ships with: resolved-category names + song count in settings, a count of songs excluded for missing local files, MANUAL-precondition banner, and jukebox picks marked in the play log so staff can see what the public chose. |
| Doors before rooms | Reachable from the canonical hamburger menu, with a help entry. A mode nobody can find does not exist. |
| Station = switchable context | All settings are per-station in `station_config_kv`; the jukebox feeds the *active* station. |
| No new schema without cause | **Zero migrations.** Two scalars in an existing KV table. |

---

## 7a · ANSWERED (Jeff, 2026-08-04) — design APPROVED

1. **Cross-station: RESTRICTED in v1** to the active station's clocks. The station dropdown ships but
   is pinned to the active station until file-availability has a runtime receipt.
2. **Repeat protection: YES** — "not again within N minutes", N configurable
   (`jukebox_repeat_minutes`, default 60).
3. **Queue depth cap: YES** — pending public picks capped (`jukebox_max_pending`, default 12). At the
   cap the public is told the queue is full, not silently refused.
4. **PIN: operator-role-and-above only.**
5. **Exit: corner button AND a staff keyboard chord.**

### UI quality bars — explicit build targets, not aspirations

These are the TouchTunes feel and are acceptance criteria for Slice 1:

- **Search filters LIVE as you type.** No button, no submit. Results narrow on every keystroke and must
  feel instant.
- **Big edge-to-edge album art, 4-5 across.** Art-forward — not a list with thumbnails.
- **Momentum / smooth scroll, lazy art load with no stutter.**
- **Tap art → large confirm card** (big cover, title, artist, one huge PLAY NEXT). Not a small dialog.
- **Dark, high-contrast, touch-sized targets throughout.**

---

## 7 · Open questions — ANSWERED ABOVE (§7a), retained for context

1. **Cross-station songs.** Ship v1 restricted to the active station's clocks (safe), or allow any
   station's clock immediately and accept the file-availability risk? §2.5 recommends restricting, with
   the dropdown present.
2. **Repeat protection.** If ten people pick the same song, does it queue ten times? Recommend: a
   configurable "not again within N minutes" check at pick time, with the public told why.
3. **Queue depth cap.** Is there a maximum number of public picks pending? Without one, a busy hour
   fills the log past the point the operator can steer.
4. **Who can PIN in?** Any user with a PIN, or operator-role-and-above only?
5. **Exit gesture.** PIN overlay reachable only from the corner button, or also from a keyboard chord
   staff can use without walking a stranger through it?

---

## 8 · What would be built, in order

1. **Slice 1 — the room.** Fullscreen route, browse grid over a configured clock, search, up-next from
   the daemon queue, pick → confirm → `queue:enqueue` + `queue:move(top)`. Free provider only.
2. **Slice 2 — the door and the gate.** Hamburger entry, PIN overlay, station+clock dropdowns with
   resolved-category readout and counts, MANUAL-precondition banner, help doc.
3. **Slice 3 — the senses.** Excluded-file count, jukebox-pick marking in the play log, Health Monitor
   visibility.
4. **Later, unblocked by the above.** Clover / QR providers behind the existing interface.

**Nothing starts until §7 is answered and Jeff approves.**

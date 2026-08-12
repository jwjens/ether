# Build report — Manual Log Editing (Fix 2), v4.4.196

**Date:** 2026-08-12 · **Design doc:** `docs/manual-log-editing-design-2026-08-10.md` (followed; three
departures below, all documented) · **Migration:** none, as instructed.

---

## What shipped

| Requirement | Where |
|---|---|
| 1. Mutable log — drag, pin, delete | `BroadcastCalendar.tsx` day detail |
| 2. Safe regeneration — gap-only fill | `_commitDayRows` + `electron/log-edit-core.js` |
| 3. Rule warnings, non-blocking | `checkSeparation()` + `schedule:checkRow` |
| 4. Source tracking | landed `source` column; now written by the editor and read by the UI |
| 5. Non-destructive regenerate | `DELETE … AND source IS NULL` |

---

## THREE DEPARTURES FROM THE DESIGN DOC

The doc is sound and its §1 inventory was accurate. But two of its code snippets, applied verbatim,
would have shipped features that silently did nothing. Both are the same failure mode this codebase
has hit repeatedly: a write or a check that fails quietly and reads as "all clear".

### D1 — `checkSeparation` would have never warned (design §4.3)

The snippet reads:

```js
const artistLast = maps.artistLastTs?.get(row.artist_id);
const songLast   = maps.songLastTs?.get(row.song_id);
const titleLast  = maps.titleLastTs?.get(titleKey);
```

and the proposed IPC passes `buildRestMaps(db, stationId)` as `maps`.

**`buildRestMaps` does not return those keys.** It returns
`{ restByFile, restByArtist, restByTitle }` (`separation-enforce.js:32`), keyed by **file_path**,
**artist_id** and **lowercased title**. The `*LastTs` maps are the *this-run placement* maps that live
on the generate context, not on the rest maps. Every lookup would have been `undefined`, so
`checkSeparation` would have returned `[]` on every call — a warning system that always says "clean".

**Second, deeper problem.** Rest maps come from `play_log` — **aired** history. The design's own test C
is *"move a track next to another by the same artist"* on a **future** day. Neither row has aired, so
neither is in `play_log`. Even with the map names corrected, the checker could not have warned on the
exact scenario the feature exists for.

**Built instead:** the checker reads **both** —

- `neighbours`: the scheduled rows within the widest rule window either side of the target time (the
  future — where a same-day edit's clash actually lives), matched by `song_id`, then artist **name**
  (`generated_schedule` stores artist as text and has no `artist_id`), then title;
- the rest maps, with their real names, for what actually aired.

Same rule windows Generate uses (`buildScheduleCtx`), so a warning means what the generator means —
which was the design's stated intent in §3 Layer 5. One violation per neighbour (strongest first), so
a same-song clash reports once rather than three times.

### D2 — the gap-fill query was missing `deleted_at IS NULL` (design §4.1)

The snippet's `kept` query is:

```sql
SELECT scheduled_at, duration_s FROM generated_schedule
 WHERE station_id = ? AND scheduled_at >= ? AND scheduled_at < ?
```

Deleting a row in the editor is a **soft** delete (`deleted_at` set — correct, so the row remains a
tombstone for sync). Without `deleted_at IS NULL`, a row the operator just deleted still counts as
occupying its slot, so the gap it left could never be refilled. **Delete would appear to work and then
do nothing on the next Generate** — which is the entire point of deleting it (design §3 Layer 4:
"leaves a gap → next Regenerate refills it", and test B).

Added, and called out in the code comment as load-bearing.

### D3 — Move is one transaction, not two updates

The doc specifies the swap (§3 Layer 4) but implies two `generatedSchedule.update` calls from the
renderer. Two separate updates leave a window in which **both rows claim the same `scheduled_at`**,
and the log-reader orders by `scheduled_at` — so a read landing mid-swap could air the wrong row.

Built as one `schedule:moveRow` IPC performing both writes in a single transaction. This is the doc's
design, implemented atomically; it is not a change of approach.

---

## Two design risks, resolved

**§7 risk 2 — daemon hand-load rows becoming permanent.** The doc asks for this to be confirmed, not
assumed. It is **currently dormant**, twice over:

1. The write is gated on `LOG_READER_FLIP` (`engine.js:36`), which ships **OFF**; with the flip off the
   daemon writes no operator rows at all.
2. Those rows are written *at the playhead* — i.e. now — and Generate's window starts at the **next
   top-of-hour** (`effStart`), so they were never inside the delete window anyway.

So no behaviour changes today. When the flip goes on, a jock's hand-load will persist — which the doc
argues is arguably correct. **Flagged for Jeff rather than decided:** if unwanted, the distinct-marker
option (`'operator-edit'`) is still open, and `isOperatorOwned()` is the single place that would change.

**§7 risk 1 — operator rows accumulating into an unhealable day.** Mitigated in v1 as the doc requires:
the day header shows **"N yours — Generate won't touch"**, every such row carries a **YOURS** badge, and
📌 releases it back to machine ownership in one click. A Generate that preserved rows also writes a
`generate-operator-rows-preserved` health event with the kept/skipped counts.

---

## Not built (design §6, deliberately)

Ripple reorder · wiring `seq` for ordering · a new migration · editing `state`/`played_at` from the
renderer · a separate log-editor panel. All as specified.

`state` and `played_at` remain **immutable from the renderer** — they are the daemon's observed record
of what aired and feed the Traffic affidavit. Aired rows (`state` = `played`/`playing`) are guarded in
the main process too, not just hidden in the UI: `_guardEditable` refuses move, pin and delete, so a
stale render cannot edit the past.

---

## Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors** |
| `npx vitest run` | **208 passed**, 17 files (was 180 — 28 new) |
| `node --check` main.js · separation-enforce.js · log-edit-core.js | OK |
| `npm run verify:schema` | **PASS** |
| `npm run check:audio-isolation` | **PASS** |

New tests: `electron/log-edit-core.test.js` (16 — overlap edges, zero-duration rows, gap refill,
input safety) and `electron/separation-check.test.js` (12 — including the self-comparison guard and
the empty-artist case that would otherwise flag every spot).

---

## UNVERIFIED — the design's test plan has not been run

No runtime receipt. Everything above is static plus unit tests. The design's §5 plan A–F needs a real
run, in particular:

- **A** (headline): Generate tomorrow → drag the 3rd item → Generate again → it stays.
- **B**: delete two rows → Generate → the gaps fill, nothing else moves.
- **C**: move a track next to a same-artist track → amber warning appears **and the move applies**.
- **D**: `scripts/prove-of-regen-fix.js` — the cat-1 count must stay 0. Gap-fill is a post-filter and
  cannot pick off-clock, but this proves it.
- **E**: a partly-aired day — played rows read-only, Traffic figures unchanged before and after.
- **F**: pin on station 2, Generate station 3 — station 2 untouched.

---

## Architecture compliance

- **No new migration.** Uses the landed `source` (v34) and `seq` (v33).
- **Clock law untouched.** `_generateDayRows` is not modified. Gap-fill is a post-filter over rows the
  generator already produced, so selection, separation, dayparting and LRP are unchanged.
- **"Do not change what airs."** The log-reader is not touched; ordering stays `scheduled_at`. What
  changed is only which rows Generate is *permitted to destroy*.
- **`source` stays `local-only` in the sync registry** (`synced-tables.js:327`) — ownership is
  per-machine playout state and does not CRDT-merge. Adding it to `PATCHABLE` changes the local write
  only; `serializePayload` still excludes it from every sync payload.
- **Doors before rooms.** Editing lives in the calendar's existing day detail — no new panel. Ships
  with `docs/help-log-editing.md`.
- **Honest state.** Ownership is visible on the row, not implicit. Warnings are shown and overridable.
  The past is read-only in the UI *and* enforced in the main process.

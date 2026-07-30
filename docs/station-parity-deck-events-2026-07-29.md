# Station parity — why deck-event delivery can differ, and whether a 5th station inherits it

**Date:** 2026-07-29 · **Mode:** READ-ONLY. Live DB opened `readOnly: true`, live daemon log read. Nothing changed.
**Question:** Jeff created all four stations the same way, yet the countdown froze on Christmas In July (4). Same
code, same creation path — so the difference is DATA or CREATION ORDER, and every future station inherits it.

---

## Headline — two findings, and only one of them is about station 4

1. **Creation order is real and measurable, but its known consequence is already fixed.** Stations 1-3 were created
   in the *same 4 milliseconds* (install/backfill); station 4 was click-created 18 days later. The concrete thing
   click-created stations never got was **deck rows** — closed by migration v35 + per-station seeding, and all four
   now have 6.
2. **The daemon has TWO different deck-event shapes, and the renderer silently discards one of them.** This is not
   about station 4 specifically — it applies to **any** station that has no automation engine, at any time,
   including future ones. This is the parity defect worth naming.

---

## 1. Row-level diff — stations table, every column

```
id                *DIFFERS*  1  2  3  4
name/callsign     *DIFFERS*  (identity only)
uuid              *DIFFERS*  (identity only)
is_active         *DIFFERS*  1:0  2:0  3:0  4:1        ← 4 is simply the selected station
created_at        *DIFFERS*  1:2026-07-06T17:44:54.376Z
                             2:2026-07-06T17:44:54.379Z   ← 3 ms after 1
                             3:2026-07-06T17:44:54.380Z   ← 1 ms after 2
                             4:2026-07-24T19:31:23.959Z   ← 18 DAYS later
icecast_mount     *DIFFERS*  (identity only)
icecast_bitrate   *DIFFERS*  1:128  2:128  3:128  4:320
updated_at        *DIFFERS*  (all four touched 2026-07-29T18:25:43 — same pass)

frequency, city, state, country, website, icecast_server_url, icecast_password,
icecast_format, deleted_at, icecast_port, audio_device_output, mic_device,
mount_pending_provision, owner_license_key    ← ALL IDENTICAL
```

**There is no flag, type, index or ordinal on the station row that gates behaviour.** `is_active` marks the
selection, not a capability. `icecast_bitrate` 320 vs 128 affects the stream encoder, not deck events.

**The one column that tells the real story is `created_at`:** 1, 2 and 3 were written within 4 ms of each other —
that is a batch, not three clicks. Station 4 is the only one created through the interactive path.

## 2. How the daemon keys per-station state — by integer id, never by position

```js
audiod/ether-audiod.js:56   const engines = new Map();   // stationId → DaemonEngine
audiod/ether-audiod.js:87   function getEngine(stationId) { … engines.set(stationId, e); stations.add(stationId); }
audiod/ether-audiod.js:95   const streams  = new Map();  // stationId → StreamSupervisor
audiod/engine.js:485        this.emit("deck", { stationId: this.stationId, deck: id, … })
electron/main.js:574        sendToAllWindows("audio:daemon-deck", { stationId: m.stationId, … })
```

**Nothing is keyed by creation order, array index, or ordinal.** `Map`/`Set` keyed by the integer `station_id`
throughout, and the id rides on every event. A fourth station is not structurally different from a first — there is
no "slot 4" that behaves differently. **This rules out the index hypothesis outright.**

Confirmed on the live daemon: all four stations were registered the same way, seconds apart.

```
station 1: 2026-07-29T14:02:40.710Z  cmd automationStart
station 2: 2026-07-29T14:03:19.489Z  cmd automationStart
station 3: 2026-07-29T14:03:23.635Z  cmd automationStart
station 4: 2026-07-29T14:03:27.788Z  cmd automationStart
```

Station 4 is engine-owned exactly like 1-3. (`cmd init` appears for none of them — engines are created by
`automationStart` → `start()` → `init()`, not by the separate `init` command.)

## 3. What a click-created station got vs the install batch

Per-station row counts, live DB:

```
table                      s1    s2    s3    s4
deck_configs                6     6     6     6      ← now equal (v35 + seeding)
clocks                      1     1     1     1
shows                       1     1     1     1
separation_rules            5     5     5     5      ← seedStationConfig
metadata_definitions       47    47    47    47      ← seedStationConfig
metadata_vocabulary        35    35    35    35      ← seedStationConfig
generated_schedule      12754 26481 20477 16985
play_log                 3579  7901  7232  3784
station_config_kv          13    13    10    10
```

**Every structural table is at parity.** `stations:create` → `seedStationConfig(db, row.id)` supplies rules,
definitions and vocabulary; decks are now seeded too. The counts that differ (schedule, play_log, clock_slots) are
usage, not setup.

`station_config_kv` differs, but not along a create-path line — it is per-station preference accumulation:

```
s2 missing: canvas_layout_version, last_error, station_logo, tour_done_version
s3 missing: canvas_layout_version, last_error, station_logo, tour_done_version
s4 missing: canvas_layout_version, last_error, station_logo, station_name, tour_done_version
s4 extra:   enforce_separation, overlay_fallback_category_id
```

`last_error` and `tour_done_version` are records of things that happened; `station_logo` is a choice. **One worth
noting in passing: station 4 has no `station_name` key** while 1-3 do — cosmetic here (the `stations.name` column is
the real source), but it is a genuine install-vs-create divergence and the kind of thing that bites later.

**None of these gate deck events.**

## 4. The parity defect — two deck-event shapes, one of which the renderer throws away

The daemon emits deck events from **two different places, with different payloads**:

```js
// A — engine-owned, per deck                      audiod/engine.js:485
this.emit("deck", { stationId, deck: id, state: {…}, ready });

// B — generic full-state snapshot, ~4 Hz          audiod/ether-audiod.js:214
if (tick % 3 === 0 && !engines.has(sid)) {
  broadcast({ event: "deck", stationId: sid, state: JSON.parse(A.audioGetState(sid)) });
}
```

Shape **B has no `deck` field.** The renderer's handler requires one:

```js
src/audio/engine-rodio.ts
  const id = m?.deck as DeckId;
  if (id !== "A" && id !== "B" && id !== "C") return;     // ← B is discarded here, silently
```

So the daemon's own comment — *"only emit the generic full-state deck snapshot for stations WITHOUT an automation
engine"* (`ether-audiod.js:212-213`) — describes a fallback that **cannot work**: those events are broadcast, cross
IPC, reach the renderer, and are dropped on arrival with no log and no counter.

**Consequence, stated plainly:** any station with **no automation engine** (`engines.has(sid) === false` — i.e.
automation has never been started for it, or was stopped) has a deck UI that receives *nothing it can use*. Not
because of its id or its age — because of which emit path it falls under. That is a real parity break between "a
station running automation" and "a station not running automation", and it is invisible.

**It is not the cause of the station-4 freeze**, and I will not claim it is: station 4 was engine-owned throughout
(automation engaged 17:51:42, segue and deck-end logged at 18:16 — `docs/deck-freeze-live-evidence-2026-07-29.md`),
so it was on path A, not B.

## 5. The answer

**What is different about station 4:** its `created_at`. It is the only station created through the interactive
path; 1-3 were written as a batch at install, 4 ms apart. Everything else on its row is identity or preference.

**Was it a missing setup step?** Yes, and the known one is fixed: click-created stations never received
`deck_configs` rows, because the old seeder could not express them (`slot` was the whole primary key) and
`stations:create` never seeded decks. Migration v35 plus per-station seeding closed it, and all four stations now
hold 6 deck rows.

**Is it creation order in the sense of an index or ordinal?** No — receipts in §2. The daemon keys everything by
integer `station_id`; there is no positional handling anywhere in the deck-event path.

**Will a 5th or 6th new station have the same problem?**

- **The deck-rows gap: no.** `stations:create` now seeds decks for the new station at creation, and startup seeds any
  station found without them. A new station is born at parity.
- **The two-shapes gap: yes, and it is not about being new.** Any station — 1st or 6th — that is not running
  automation is on emit path B, whose payload the renderer discards. Start automation and it moves to path A. That
  asymmetry will persist for every station until the generic snapshot either carries a `deck` field or is removed in
  favour of the engine path.
- **The `station_name` kv divergence: probably yes** for click-created stations, since it tracks the same
  install-vs-create split. Harmless today; worth confirming before something starts reading it.

**What I cannot claim:** none of this explains the station-4 countdown freeze. Station 4 was engine-owned and
emitting normally at the moment the UI was frozen. The freeze remains renderer-side and unexplained; the position
resync bounds its damage rather than curing it.

## Scope note

Read-only. Live DB opened `readOnly: true` and closed; daemon log read, not modified. No file in `C:\openair`
changed, nothing committed, nothing built. Diagnostic script lives in the session scratchpad, not the repo.

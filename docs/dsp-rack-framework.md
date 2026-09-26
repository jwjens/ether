# DSP slice 4 — the rack framework (PROPOSAL)

**Status:** proposed 2026-09-26; GO with rulings 1–5; engine BUILT 2026-09-26 (§10); UI BUILT 2026-09-26 (§11).
**Branch:** `log-reader-flip`, dev only. No push, no tag.

**Governing sources:**
- Spec §4, slice 4: *"Generic rack of preallocated slots with bypass, same UI for channels and master.
  Move existing master GEQ, ride and limiter into master slots with no DSP change. Parity harness still
  nulls; master rack shows the same values as the old Processor window."*
- Spec §5, the rack layout: signal-flow strip on top with per-slot IN/bypass and colour; the selected
  slot's editor in the centre; a pinned meter column on the right; the master rack adds the M/S/I/LRA/TP
  panel and ride/limiter GR per branch; a preset bar with current show, Arm, Take and a pending indicator.
  Also: *"Adopt a fixed colour per slot type"* (Lawo: blue EQ, magenta dynamics); *"Keep meters visible
  while editing presets"* (Orban).
- Spec §4 ordering rules 4 (one visual language for channel and master racks), 5 (channel processing is
  pre-fader), 6 (loudness normalization stays at program level) and 7 (all settings keyed by station
  UUID).
- `docs/dsp-rt-callback.md` (the Params block, the only way parameters reach the callback).
- `docs/dsp-meter-bus.md` and `docs/dsp-loudness-meter.md` (the meter, GR and loudness components, built
  to move into the rack unchanged).
- **Jeff's ruling:** this is a live instrument an operator looks at while on air, in the Wheatstone
  Strata / Virtual Strata language — not a settings page.

---

## Summary

1. **A rack is an ordered, fixed-capacity list of slots.** Each slot holds one module (type, params,
   bypass) or nothing.
   - The master rack has three sections: **PGM** (pre-split: the GEQ), then **MONITOR** and **STREAM**
     (per branch: ride → limiter), linkable exactly as today.
   - Channel racks (slices 5–6) use the same document and the same component, with a different module set.
2. **Storage.** One JSON document per station in `station_config_kv` (`rack_master`), plus
   `rack_presets` and `rack_preset_active`. That table is already per station, already synced and already
   read by the daemon.
   - **The `proc_*` / `eq_master` keys are read as the seed, not migrated by a numbered transformer.**
   - The ride/limiter/EQ values are also **written through** to those legacy keys, because a running
     daemon does not reload on auto-update and older installs on the same account still read them.
   - Schema stays at v61.
3. **Delivery.** The engine receives the rack as **part of the existing Params block**: typed,
   fixed-size, `Copy`, through the Slice 1 command path. The legacy `SetProcessorParams` / `SetProcessing`
   / `SetEq` commands are rewritten to edit that same block, so there is **no second write path**.
4. **No DSP change.**
   - Ride and limiter are the same code, split at the multiply that already separates them.
   - A flat or bypassed GEQ takes the path it takes today.
   - The harness must null 43/43.
5. **The Processor pop-out is rebuilt as the rack.** It has a signal-flow strip, the slot editor, and a
   pinned meter column reusing the Slice 2/3 components unchanged. The preset bar is Arm → Take, and
   recall applies immediately (the master has no ON channels to protect).
6. **The type rule.** A loudness module has no representation in a channel rack's type, in Rust or in TS.
   A compile-fail test and a `@ts-expect-error` prove it.
7. **Found while designing.** The master EQ path is unscoped and is never re-applied at engine start
   (§8). The rack fixes it as a side effect; it is called out separately.

---

## 1 · The rack model

### 1.1 The document (what is stored)

```jsonc
// station_config_kv key "rack_master" — one per station
{
  "v": 1,
  "link": true,                        // MONITOR and STREAM carry identical modules (today's proc_split = false)
  "sections": {
    "pgm":    [ { "id": "s-geq", "module": { "type": "geq", "bands": [0,0,0,0,0,0,0,0,0,0] }, "in": true } ],
    "local":  [ { "id": "s-ride",  "module": { "type": "ride",    "target": -14, "rate": 1.5, "clamp": 12 }, "in": true },
                { "id": "s-lim",   "module": { "type": "limiter", "ceiling": -1.0, "release": 120 },        "in": true } ],
    "stream": [ /* same shape; ignored while link = true (the engine is handed "local" twice, as today) */ ]
  }
}
```

- **Capacity is fixed:** `MASTER_SLOTS = 4` per section, `CHANNEL_SLOTS = 6` per channel rack (the spec's
  Trim → Filters → Gate → EQ → Comp chain plus one spare). A section is an ordered list of at most that
  many slots; an absent slot is **empty**.
- **Channel racks** (slices 5–6) are more keys of the same shape: `rack_ch_<slot>` (e.g. `rack_ch_S1`),
  with sections `{ "ch": [...] }`. **No schema change**: new keys, same document, same component.
- **Per station UUID.** `station_config_kv` is station-scoped in the sync registry
  (`electron/sync/synced-tables.js:999`, `scope: 'station'`). Rows are keyed locally by `station_id` and
  travel on the wire with the station's UUID.
  - Caveat, not introduced here: the known peer-sync defect (it routes by the local integer, memory
    `project_peer_sync_station_uuid`) applies to this table exactly as it already applies to every
    `proc_*` key. The rack neither worsens it nor fixes it; the Tier-2 UUID fix covers it.

### 1.2 Migration: seed, not transformer — and why

When `rack_master` is absent, the rack is **built from** the existing keys:
- `proc_target_lufs`, `proc_ride_rate`, `proc_ride_clamp`, `proc_ceiling_dbtp`, `proc_release_ms`;
- the `proc_stream_*` keys and `proc_split`;
- `eq_master`;
- the shipped constants for anything unset.

The first operator edit writes `rack_master`.

**Write-through.** Every edit also writes the legacy keys for the modules they describe: ride and limiter
per branch, `proc_split`, and `eq_master` for the GEQ.

A numbered transformer is the wrong tool here, for three reasons:
1. **The daemon does not reload on auto-update.** A new renderer can be talking to the previous daemon for
   days (CLAUDE.md, memory `project_audio_daemon`). That daemon reads `proc_*` every 3 s
   (`audiod/engine.js:320`). A transformer that moved the keys would silently hand it the shipped chain.
2. **Mixed-version accounts.** OV and USPH may run older builds against the same synced rows. A
   transformer that runs on one install and syncs to another that doesn't understand `rack_master` is how
   two installs diverge.
3. **It is data in a value, not a schema change.** The migration machinery exists for tables and columns.
   Here schema stays at v61, and `verify:schema` and the transformer chain are untouched.

**When the legacy keys can stop being written:** once every install on the account runs a build that
reads `rack_master`. That is a later, explicit step (§7 Q3).

### 1.3 What the engine receives: one Params block

Slice 1 made `Params` (`native/src/rt.rs:34-71`) the only way operator values reach the callback: the
dispatch thread owns the authoritative copy, applies a command with the same clamps as always, and the
callback adopts the newest block at the top of a buffer. Today it already carries every number the master
rack holds: the `proc_*` scalars, the two live-only bypasses, `eq_bands` and `eq_version`.

The rack **replaces those fields with one typed field**:

```rust
// rt.rs — Copy, fixed-size, no heap: it rides the existing boxed Params block unchanged.
pub(crate) const MASTER_SLOTS: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Slot<M: Copy> { pub module: Option<M>, pub input: bool }   // None = empty slot; input = IN

pub(crate) struct MasterRack {
    pub link: bool,
    pub pgm:    [Slot<PgmModule>; MASTER_SLOTS],
    pub branch: [[Slot<BranchModule>; MASTER_SLOTS]; 2],   // [LOCAL, STREAM]
    pub eq_version: u64,                                   // the GEQ's coefficient recompute trigger, as today
}
```

- **New NAPI:** `audio_set_master_rack(station_id, json)`.
  - It parses the document with serde into these types (**an unknown or misplaced module fails to parse**;
    see §5), applies today's clamps, writes `ctl.params.rack`, and calls `params_changed()`.
  - Returns `{ ok, reason }`, so a refused rack is visible (the `sendError` rule the rack already keeps).
- **The legacy commands** (`SetProcessorParams`, `SetProcessing`, `SetProcessorBypass`, `SetEq`) are kept
  for the previous renderer and daemon, but **rewritten to edit `ctl.params.rack`**. One block, one path.
- **The daemon** reads `rack_master`, or the seed from §1.2, in the same 3 s poll that reads `proc_*`
  today. It calls `audioSetMasterRack` when the document changes, and re-asserts every 15 s as today.
  **This also re-applies the GEQ at engine start**, which today never happens (§8).
- `proc_local` / `proc_stream` (the Settings toggles) stay as they are. They are **branch power**, not
  modules (§7 Q2).
- The live-only bypasses stay live-only (Jeff's 2026-09-07 ruling). The daemon never persists `input =
  false` for a ride or limiter slot; a stored document that says so is loaded with IN forced on, and the
  panel says so. The GEQ's IN *is* persisted: bypassing an EQ is an operator choice, not a test tool.

### 1.4 How the callback runs a rack (and why it stays bit-exact)

**PGM section** (where `eq.process_stereo` runs today, `audio.rs` post-sum / pre-master):
- For each slot in order: a `Geq` slot with `input = true` runs the existing `bus.eq` / `bus.eq_room` pair,
  exactly as now.
- An empty or bypassed slot runs nothing. That is the `active == false` path `eq.rs:240-251` already takes
  for flat bands: a true passthrough, and the spectrum tap still fed.
- With one GEQ slot, IN, the arithmetic is identical to today's.

**Branch sections** (the `run_branch` closure, `audio.rs`):
- The branch's `ProgramProcessor` instance runs **its slots in order**:
  - a `Ride` slot calls the ride's `update_planar` (meter the input, advance the gain) and multiplies the
    lane by the gain;
  - a `Limiter` slot runs the limiter's per-sample loop over the lane.
- Today these are fused in `process_planar` (`program_processor.rs:342-349`) as
  `limiter.process(l[i] * g, r[i] * g)`. Splitting them computes the **same f32 product** into the lane,
  then limits it, so the result is bit-identical.
- **The limiter is pinned as the last slot of a branch.** It is the ceiling guarantee; nothing can be
  placed after it. That is a model rule, not a UI convention (§6).
- `processor_room` and `processor_aux` keep running the LOCAL branch's modules, as they do today (they
  already take the LOCAL parameters, `audio.rs` room and aux blocks).

---

## 2 · The Processor page, rebuilt as the rack

This is a live instrument, laid out as spec §5 describes. It is one component, `Rack`, parameterized by
rack kind. The master rack is the first instance; slice 5's channel racks are the next ones.

```
┌ PRESET BAR ─────────────────────────────────────────────────────────────────────────────────────┐
│ Ether v1 (shipped) ▾  · modified     [ARM ▸ EBU −23]  [TAKE]      pending: target −14→−23 …    │
├ SIGNAL-FLOW STRIP ──────────────────────────────────────────────────────────────┬ METERS ──────┤
│  PGM:  [ GEQ ● ]  →  split  →  MONITOR: [ RIDE ● ][ LIMITER ● ]                  │ IN  (PGM)    │
│                              →  STREAM:  [ RIDE ● ][ LIMITER ● ]   LINKED ⇄      │ OUT MON / STR│
├ EDITOR — "editing: MONITOR · RIDE" ─────────────────────────────────────────────┤ RIDE  ▮      │
│  (the selected slot's controls, touch-sized)                                     │ LIMIT ▮      │
│                                                                                   │ LOUDNESS     │
│                                                                                   │ M S I LRA TP │
└──────────────────────────────────────────────────────────────────────────────────┴──────────────┘
```

- **Signal-flow strip.**
  - One tile per slot, in chain order. Each has an **IN** button (lit = in) and the module's colour; empty
    slots are drawn as dashed outlines.
  - Tapping a tile selects it for the editor. The branch split is drawn, and LINKED/SPLIT sits on the
    split.
  - Each tile carries its own live activity: a GR bar on RIDE and LIMITER (the Slice 3 `GrMeter`, compact),
    and the curve thumbnail on GEQ.
- **Editor.** A persistent header, *"editing: MONITOR · LIMITER"* (spec §5, the Strata/LXE convention:
  the channel is always named).
  - **GEQ:** the existing `MasterEQRack` band editor, reused.
  - **RIDE:** target, rate, clamp.
  - **LIMITER:** ceiling (with the Slice 3 label, *"−1.0 dBTP set · limits at −2.2 dBTP"*) and release,
    plus the read-only look-ahead / oversampling line that the rack shows today.
- **Pinned meter column.** It is always visible, including while editing presets (spec §5, Orban), and
  every piece is reused unchanged:
  - IN = `PeakAvgMeter` on bus PGM;
  - OUT = `PeakAvgMeter` on LOCAL / STREAM;
  - `GrMeter` RIDE + LIMITER per branch;
  - `LoudnessPanel` per branch.
- **Touch-sized.** Targets ≥ 44 px, sliders with ≥ 44 px thumbs, no hover-only affordances. The drag
  handle on a tile is the whole tile (long-press to lift).
- **Colour per slot type**, fixed, the same in the channel racks:

  | Module | Colour token | Why |
  |---|---|---|
  | GEQ / PEQ (EQ) | `--accent-blue` | Lawo convention, spec §5 |
  | Ride (loudness) | `--accent-cyan` | the Slice 3 RIDE meter already uses it |
  | Limiter / Compressor / Gate (dynamics) | **`--accent-magenta`** (new token, light and dark values) | spec §5 "magenta dynamics"; no magenta token exists today (`src/index.css`) |
  | Filters (HPF/LPF, slice 5) | `--accent-green` | distinct from EQ blue |

  Brand purple stays the accent for labels and selection, not a slot colour (the Slice 2 rule).
- **The door.** Master Out → Processor, unchanged. The Master Out **EQ** button (which opens
  `MasterEQRack` today) opens the rack with the GEQ slot selected, so there is one home for the master EQ,
  not two. The help entry is rewritten (§9).

---

## 3 · Modules moved into slots — no DSP change

| Section | Slot | Module | Code it runs | Params, from today |
|---|---|---|---|---|
| PGM | 1 | **GEQ** (10-band, the existing one) | `bus.eq` + `bus.eq_room`, `eq.rs` | `eq_master` bands |
| MONITOR / STREAM | 1 | **Module 1 — loudness ride** | `LoudnessRide`, `program_processor.rs` | target, rate, clamp |
| MONITOR / STREAM | 2 (pinned last) | **Module 2 — true-peak limiter** | `TruePeakLimiter`, `program_processor.rs` | ceiling, release |

**The harness must null 43/43.**
- The current goldens already cover the configurations the rack must reproduce: OFF, LOCAL, STREAM, LINKED,
  SPLIT, and EQ with a non-flat GEQ.
- Slice 4 adds **rack-path renders**: the same six configurations delivered as a rack document through
  `audio_set_master_rack`, asserted **bit-identical** to the existing goldens (not re-captured).

**Presets**, seeded as built-ins (read-only; "Save as" to change one):

| Preset | GEQ | Ride target | Ceiling (set) | Rate / clamp / release | Source |
|---|---|---|---|---|---|
| **Ether v1 (shipped)** — the default | flat | −14 LUFS | −1.0 dBTP | 1.5 dB/s / 12 dB / 120 ms | `ProgramProcessor::new`, `audiod/engine.js:309-311`, `ProcessorRack.tsx SHIPPED` — the exact current constants |
| **Broadcast −24 (ATSC A/85)** | flat | −24 LKFS | −2.0 dBTP | shipped values | A/85: −24 LKFS, −2 dBTP (spec §2 table) |
| **EBU −23 (R128)** | flat | −23 LUFS | −1.0 dBTP | shipped values | R128: −23 LUFS, max −1 dBTP |
| **Stream/Podcast −16** | flat | −16 LUFS | −1.0 dBTP | shipped values | AES TD1008 music −16, ≤ −1 dBTP |
| **Stream −14** | flat | −14 LUFS | −1.0 dBTP | shipped values | Spotify −14 (published) |

- **Only the target and the ceiling come from the standards.** Rate, clamp and release are the shipped
  values; none is invented. The ride's target range is −30…−6 (unchanged), so −24 and −23 are in range.
- ⚠ **The ceilings are the *setting*.** With the ×1.15 margin still in place (Slice 3 ruling 3), each
  limits 1.2 dB lower: the ATSC preset limits at −3.2 dBTP. The Slice 3 label shows this on every recall.
  If the margin changes, these presets need no edit.
- "Stream −14" equals "Ether v1" in every number. Both are listed because the spec lists them; §7 Q4 asks
  whether to keep both.

---

## 4 · Presets: save, save-as, recall, Arm → Take

- **A preset is the whole master rack document** (sections, modules, link), not the five numbers today's
  `proc_presets` holds. The existing user presets in `proc_presets` are converted on read: their five
  numbers become a rack with a flat GEQ.
- **Save** overwrites the active user preset (built-ins cannot be overwritten). **Save as** names a new
  one. Stored in `rack_presets` (JSON array), with the active name in `rack_preset_active`.
- **The "modified" badge is derived, never a flag.** It compares the live rack to the stored preset: the
  rule the rack and the EQ already keep.
- **Arm → Take:**
  - **Arm** loads a preset into a *pending* slot and draws the difference beside the live values
    (*"target −14 → −23, ceiling −1.0 → −1.0"*). Nothing changes on air.
  - **Take** applies it. **Disarm** drops it.
  - A pending indicator stays lit while armed.
- **Recall today applies immediately on Take.** The master rack has no ON channels, so the live-channel
  protection rule has nothing to protect yet. Slice 7's rule ("channels that are ON are protected until
  OFF, with a flashing indicator; stored and applied by the blade") is **reserved**:
  - the Take path goes through one function, `applyPreset(station, rack, { protect })`, whose `protect`
    branch is empty in slice 4;
  - slice 7 fills it without changing the bar.
- **"Current show"** is not shown. There is no show concept in the engine yet (the Slice 3 finding: no
  show-start signal). A field that always reads "—" would be decoration; it arrives with slice 7.

---

## 5 · The type rule: a loudness module is unrepresentable in a channel rack

From the planning session and spec §4 rule 6 (*"Loudness normalization stays at program level"*): not
rejected at runtime, but **absent from the type**.

**Rust** (`native/src/rack.rs`, new):

```rust
/// Modules a master PGM section can hold (pre-split).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum PgmModule { Geq(GeqParams) }

/// Modules a master BRANCH section can hold. The only place a loudness module exists.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum BranchModule { Ride(RideParams), Limiter(LimiterParams) }

/// Modules a CHANNEL rack can hold (slices 5–6). There is no Ride variant — and no way to construct one.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum ChannelModule { /* slice 5: Filters(..), Peq(..) · slice 6: Gate(..), Comp(..) */ }

pub(crate) struct ChannelRack { pub slots: [Slot<ChannelModule>; CHANNEL_SLOTS] }
```

- **Compile-time proof:** a `compile_fail` doctest that tries `ChannelModule::Ride(RideParams::default())`.
  If someone adds the variant, the doc test starts compiling and the build fails.
- **Parse-time proof:** a unit test that parses `{"type":"ride",...}` into a channel slot and asserts the
  serde error. A synced or hand-edited document cannot smuggle one in; the rack is refused with its reason.
- In slice 4 `ChannelModule` has no variants yet, so a `ChannelRack` can only be empty. That is exactly
  what slice 4 promises for channels.

**TypeScript** (`src/components/rack/rackTypes.ts`, new):

```ts
export type GeqModule     = { type: "geq"; bands: number[] };
export type RideModule    = { type: "ride"; target: number; rate: number; clamp: number };   // loudness
export type LimiterModule = { type: "limiter"; ceiling: number; release: number };
// slice 5/6: FilterModule, PeqModule, GateModule, CompModule

export type PgmModule     = GeqModule;
export type BranchModule  = RideModule | LimiterModule;
export type ChannelModule = never; // slice 5: FilterModule | PeqModule; slice 6: | GateModule | CompModule — never RideModule

export interface Slot<M> { id: string; module: M | null; in: boolean }
export interface MasterRackDoc  { v: 1; link: boolean; sections: { pgm: Slot<PgmModule>[]; local: Slot<BranchModule>[]; stream: Slot<BranchModule>[] } }
export interface ChannelRackDoc { v: 1; sections: { ch: Slot<ChannelModule>[] } }
```

- **Compile-time proof:** `rackTypes.typetest.ts`, checked by `tsc --noEmit` (the zero-errors gate):
  ```ts
  const bad: Slot<ChannelModule> = { id: "x", in: true,
    // @ts-expect-error — a loudness module is unrepresentable in a channel rack
    module: { type: "ride", target: -14, rate: 1.5, clamp: 12 } };
  ```
  If `RideModule` ever becomes assignable to `ChannelModule`, the `@ts-expect-error` is unused, and tsc
  fails.
- **The same rule in the UI:** "Add module" on a channel rack draws its menu from `ChannelModule`'s type
  list, so the ride cannot be offered.

---

## 6 · Empty slots, add / remove, reorder

- **Empty slot:**
  - a dashed tile, "empty · add";
  - it runs nothing (a passthrough by construction; the engine sees `module: None`);
  - it is counted in the fixed capacity.
- **Add module:** tap an empty tile. The menu offers exactly what the section's type allows **and** what
  isn't already present where only one instance is allowed:

  | Rack / section | Today (slice 4) | Later |
  |---|---|---|
  | Master PGM | **EQ only**: the GEQ, if it was removed (one instance; it drives the `eq` + `eq_room` pair) | a PEQ or compressor on the master: new DSP, a later slice by name |
  | Master branch | nothing new: Ride and Limiter are present, one of each | none planned |
  | Channel | nothing (`ChannelModule` has no variants yet) | slice 5: Filters, PEQ · slice 6: Gate, Compressor |

- **Remove:** a tile's ⋯ menu. **Ride and Limiter cannot be removed** from a branch, only bypassed with
  the live test tool. A branch without a limiter has no ceiling, and removing the ride is what the
  Settings toggle and bypass already cover. The GEQ can be removed; that is identical to flat.
- **Reorder (drag):**
  - implemented in the framework: long-press, drag, drop; the keyboard alternative is ⋯ → Move left /
    right.
  - Its rules come from the model: a **pinned** slot (the Limiter, last in a branch) cannot move, and
    nothing can be dropped after it.
  - So in slice 4's master rack **nothing can actually be reordered**: PGM holds one module, and a
    branch's order is ride → limiter, pinned. Drag is exercised by the UI test against a synthetic rack,
    and becomes useful with slice 5's channel racks. Saying so plainly is better than a drag handle that
    appears to do nothing.

---

## 7 · Decisions for Jeff

1. **Storage.** `station_config_kv` JSON keys (`rack_master`, `rack_presets`, `rack_preset_active`), seeded
   from the legacy keys and written through to them (recommended, §1.2). The alternative is a new synced
   table keyed by `station_uuid`: schema v62, a registry entry, a transformer. It gives a cleaner UUID
   story, but needs every install on the account upgraded before it is safe.
2. **Branch power.** Are `proc_local` / `proc_stream` ("Process local output" / "Process stream") part of
   a preset? I recommend **no**: a preset shapes the chain, it does not switch processing on air, and
   recalling one should never switch the stream's processing off. They show as the branch's power switch
   on the strip, and stay in Settings.
3. **When the legacy keys stop being written.** After every install on the account runs a rack-aware build.
   An explicit later step, or never?
4. **"Stream −14" vs "Ether v1".** Numerically identical. Keep both (the spec lists both), or keep only
   Ether v1?
5. **GEQ IN persisted.** I recommend yes (an operator choice), while Ride/Limiter bypass stays live-only
   (your 2026-09-07 ruling). Confirm.

---

## 8 · Found while designing (static reading; runtime UNVERIFIED)

The master EQ path, `src/components/MasterOutput.tsx:545-555`:
- **Unscoped load.** `SELECT value FROM station_config_kv WHERE key='eq_master'` has **no station
  filter**. It reads whichever station's row comes first.
- **Unscoped send.** `ether.audio.setEq("master", bands)` passes no station, so `audio:setEq` uses
  `stationId ?? 1` (`electron/main.js:5259-5260`). An EQ change on station 4 goes to station 1's engine.
- **Never re-applied.** Nothing reads `eq_master` into the engine at start: the only reader is that
  component (`grep eq_master`), and the daemon has no EQ poll. After a restart the engine runs flat while
  the panel shows the stored bands.
- The one check that settles it: set a non-flat master EQ on a station that is not station 1, restart,
  and look at the engine's `eq_bands` echo.
- **The rack fixes all three by construction:** the GEQ becomes a slot in the station's rack document, the
  daemon delivers it per station in its poll, and it re-asserts. Called out separately so it is not
  mistaken for a side effect.

---

## 9 · Blast radius, bit-exactness, tests

| Area | Change |
|---|---|
| `native/src/rack.rs` (new) | module enums, `Slot`, `MasterRack`, `ChannelRack`, serde, clamps; the type-rule tests |
| `native/src/rt.rs` | `Params`: the `proc_*` scalars, bypasses and `eq_bands`/`eq_version` replaced by `rack: MasterRack` |
| `native/src/program_processor.rs` | `process_planar` split into `ride_stage` + `limiter_stage` (same arithmetic); the fused call kept as a wrapper for the bench |
| `native/src/audio.rs` | PGM and branch sections run their slots in order; legacy commands edit `ctl.params.rack`; GetLevel echoes from the rack |
| `native/src/lib.rs` | `audio_set_master_rack`; the legacy NAPIs unchanged in signature |
| `native/src/offline_render.rs` | `RenderCfg` may carry a rack document; the rack-path renders |
| `audiod/engine.js`, `ether-audiod.js` | the poll reads `rack_master` (else the seed), `setMasterRack`; the GEQ is now applied from the station's rack |
| `electron/main.js`, `preload.js` | `audio:set-master-rack`; `audio:setEq` gains a required station (the §8 fix) |
| `src/components/rack/` (new) | `Rack`, `SlotStrip`, `SlotTile`, `SlotEditor` (GEQ / RIDE / LIMITER), `PresetBar`, `rackTypes.ts`, `rackModel.ts` (pure: seed, validate, reorder rules, diff for Arm) |
| `src/components/ProcessorRack.tsx`, `PopoutRenderer.tsx`, `MasterOutput.tsx`, `useProcessorParams.ts` | the pop-out renders `Rack`; the Master Out EQ button opens the GEQ slot; the hook becomes `useMasterRack` |
| `src/index.css` | `--accent-magenta` (light and dark) |
| `docs/` | `help-processor-rack.md` (new, replacing the processor sections of `help-audio-processing.md`, which is updated) |

**What stays bit-exact, and what proves it:**
- **Every existing golden, 43/43, untouched.** A station that never opens the rack runs the seed, which is
  its current keys.
- **Rack-path renders** (new): the six processing configurations delivered as rack documents, asserted
  bit-identical to the existing goldens. This proves delivery through the new path changes nothing.
- **Split ride/limiter:** a unit test runs the fused `process_planar` and the two stages over the C-bench
  signals, bit-identical per sample.
- **Empty and bypassed GEQ** equal a flat GEQ on the sample bits.
- **Allocation trap:** 0. The rack is `Copy`, inside the existing boxed Params block.
- **Timing:** C5-style callback median and p99, rack path vs Slice 3's figures.

**What the harness does NOT cover, and needs a UI test** (vitest + React Testing Library, as the meter
components):
- `rackModel` (pure): seed from the legacy keys, including the old `proc_presets` conversion; the pinned
  limiter rule; reorder legality; Arm diff; the derived "modified" badge; link/split mirroring.
- The strip: IN toggles send the rack; selecting a tile names it in the editor header; add-module menus
  offer only what the section's type allows (a channel rack offers nothing in slice 4).
- The preset bar: Arm shows pending without sending; Take sends once; Disarm sends nothing.
- The type tests: `tsc` (the `@ts-expect-error`), `cargo test` (the `compile_fail` doctest and the serde
  rejection).
- **Runtime:** UNVERIFIED until Jeff sees it. The check: the rack shows the same values as the old
  Processor window, and moving a slider moves the same meters.

## What this deliberately does NOT build

- No new DSP: no PEQ, no compressor, no channel racks with modules (slices 5–6).
- No show presets, no live-channel protection, no "current show" (slice 7).
- No change to ride/limiter behaviour or the ×1.15 margin.
- No second parameter path, and no second EQ home.

---

## 10 · Build report — engine (2026-09-26)

**Rulings:**
1. `station_config_kv`, seeded, with write-back, and no migration.
2. The power switches are never part of a preset.
3. Keep writing the legacy keys until the release after this one is on both machines with restarted daemons.
   The removal is its own later slice.
4. No "Stream −14": **"Ether v1 (shipped)" is the default and equals the −14 streaming target.**
5. GEQ IN is saved; ride and limiter bypass stay live-only.

### Built
- **`native/src/rack.rs`** (new):
  - the module enums (`PgmModule`, `BranchModule`, and `ChannelModule`, which has no variants);
  - `Slot`, `MasterRack`, `ChannelRack`, the document types, the parser and validator (limiter pinned
    last, exactly one ride and one limiter per branch, one GEQ), and the legacy clamps;
  - `MasterRack::shipped()` = Ether v1.
- **`rt.rs` Params:** `rack: MasterRack` replaces the 14 `proc_*` scalars, the 4 live bypasses and
  `eq_bands`/`eq_version`. `proc_local` / `proc_stream` (branch power) stay.
- **`audio.rs`:**
  - `apply_params` fills the callback's working values from the rack. The GEQ gets its bands on
    `rack.eq_version` and its IN as `EqChain::bypass`.
  - Each branch runs its slots in order (`process_slots`).
  - The legacy `SetProcessorParams` / `SetProcessing` / `SetProcessorBypass` / `SetEq` edit
    `ctl.params.rack`: one block, one path.
  - `SetMasterRack` keeps the live bypasses the engine is running.
- **`program_processor.rs`:** `process_planar` = `ride_stage` + `limiter_stage`, with the same arithmetic.
- **`eq.rs`:** `bypass` on `EqChain` takes the flat passthrough.
- **`lib.rs`:**
  - `pub mod rack`;
  - `audio_set_master_rack(station, json)` returns `{ok, reason}` (a refused rack says why);
  - the ceiling echo reads the rack.
- **Daemon (`engine.js`):** the poll reads THIS station's `rack_master`, or seeds from the legacy keys
  (`audiod/rack-seed.js`). It delivers the rack whenever it changes, and on every engine start, with
  processing on or off. A non-flat GEQ re-asserts every 15 s. `ether-audiod.js` gets the `setMasterRack`
  command.
- **Main:**
  - `rack:get`, and `rack:set`, which delivers to the engine FIRST and stores `rack_master` plus the
    legacy write-back only if the engine accepted it;
  - `audio:setEq` refuses a call that names no station;
  - preload `getRack` / `setRack`.
- **`MasterOutput.tsx`:** the master EQ reads THIS station's `eq_master` (re-read on a station switch) and
  sends its station.
- **Tests:**
  - `audiod/smoke-rack-eq.js` (17): a band change on station N reaches station N's engine and nothing
    reaches station 1; a fresh engine re-applies with processing off; `rack_master` wins over the seed;
    write-back round-trips.
  - The rack-path null (`offline_render` `via_rack`): settings scrambled, then delivered ONLY as a rack
    document through the callback's command queue.
  - The type rules.
  - `npm run test:rust` now also runs `cargo test --doc`.

### Receipts
- **Rack path vs the EXISTING goldens:** `[rack-null] 43/43 renders bit-exact through the rack path to the
  EXISTING goldens · 0 allocations inside the callback`.
- **The original null:** 43/43 bit-exact, trap 0. **NAPI:** 43/43 bit-exact through the freshly built
  `.node` (`d1e7e8a2…5da6`); the tracked `.node` is untouched (`4876be79…4aa8c`).
- **Split = fused:** ride → limiter as two slots, bit-identical to the fused chain in 16 cases (4 bypass
  combinations × 4 block sizes × 60 s).
- **Bypassed GEQ:** a non-flat GEQ with its slot OUT is bit-identical to a flat GEQ.
- **Type rule:**
  - compile-time: `rack::ChannelModule - compile fail ... ok`, pinned to **E0599**, beside a compiling
    `rack::BranchModule` twin;
  - parse-time: *"`ride` is not a channel module"*, and a ride in PGM gives *"unknown variant `ride`,
    expected `geq`"*.
- **Timing** (final run):
  - callback median **0.081 ms**, p99 **0.137 ms**, worst **0.303 ms** per 10 ms buffer, 0 allocations;
  - Slice 2 test: 0.077 / 0.214 ms;
  - C5: one instance 0.031 ms, two 0.062 ms.
- **`npm run test:rust`:** 52 + 7 + 2 doctests pass.
- **Other gates:** tsc 0; vitest 443; leak guard 13/13; meter-contract 30/30; rack-eq 17/17; all no-audio
  smokes pass (`smoke-topofhour` fails exactly as at 4.6.49).

### Deviations and findings, stated
- **`crate-type = ["cdylib", "rlib"]`** (`native/Cargo.toml`, tracked as `native/cargo.toml`). Rustdoc
  `compile_fail` tests need an rlib, and `trybuild` isn't available offline.
  - This changes the DLL's **bytes** with no source change (`4b07e9e6…` → `eee24425…`), but the **audio is
    bit-identical**: 43/43 through that build.
- **`BusState` keeps its processor scalars as the callback's working copy**, filled from the rack at
  adoption. The design said the rack "replaces" them; it does in the Params block (the one path), and the
  callback, harness and tests keep reading the working copy they always read.
- **A test fixed, not the product.** `a_param_block_never_changes_mid_buffer` was racy: its liveness half
  passed with 2 of 1 000 buffers in the Slice 3 run, and failed with 0 in the first Slice 4 run. The
  sender now keeps one block in flight, giving about 1 450 / 1 450 buffers, stable across three runs. The
  property under test (a block never changes mid-buffer) is unchanged, and held in every run.
- **Found:** `OnAirDeck.tsx:90` and `MicDeck.tsx:67` call `setEq` with **no station**. Main treats every
  `setEq` as the master EQ, so these deck and mic EQ controls were changing **station 1's master GEQ**.
  They are now refused, and main logs `[EQ] audio:setEq refused — no station named`. Not changed further;
  those controls need their own decision.
- **Write-back limitation:** `eq_master` carries the GEQ's bands even when its slot is OUT, because the
  legacy key cannot express IN. An older build would show and apply those bands.

---

## 11 · Build report — UI (2026-09-26)

### Built
- **`src/components/rack/`:**
  - `rackTypes.ts`, the typed document. `ChannelModule = never` today; slices 5–6 widen it, never to `RideModule`.
  - `rackTypes.typetest.ts`, the TS type rule, as `@ts-expect-error` under `tsc`.
  - `rackModel.ts`, pure: the shipped chain and built-in presets; the derived "modified" badge; the Arm
    diff; legacy `proc_presets` conversion; link/split; pinning, reorder, add and remove rules; slot colours;
    the would-ride projection. 9 vitest cases.
  - `Rack.tsx`, the Processor window as the rack:
    - the preset bar (active preset, derived "· modified", Arm → shows what TAKE would change → TAKE /
      DISARM, SAVE, SAVE AS);
    - the signal-flow strip (PGM → split LINKED/SPLIT → MONITOR / STREAM), with a colour per slot type, IN
      per tile (GEQ saved; ride/limiter = the live bypass), and live GR on the tiles;
    - the editor ("editing: MONITOR · RIDE"): GEQ = ten touch faders over the live spectrum with IN and
      FLAT; RIDE; LIMITER with the ceiling label;
    - the pinned meter column: IN/OUT `PeakAvgMeter`, `GrMeter` ×2 per branch, `LoudnessPanel` per branch,
      all unchanged Slice 2/3 components;
    - touch-sized controls (≥ 44 px).
- **`src/hooks/useMasterRack.ts`:**
  - rack:get / rack:set, with a 120 ms coalesce on slider drags;
  - a refused rack shows its reason and the panel returns to what is running;
  - presets are stored as `rack_presets` / `rack_preset_active`;
  - `applyPreset(station, rack, { protect })` is the one place a preset is applied. Its `protect` branch
    (slice 7) is empty.
- **`useProcessorParams.ts`** is trimmed to meters, the observed live bypass, and the split flag. **Its
  processor-number and preset writers are removed**, so the rack is the one writer.
  - The bypass now travels on a new bypass-only route (`audio:set-processor-bypass`, preload
    `setProcessorBypass`). The old combined call re-sent the branch's numbers from state loaded at mount,
    which after a rack edit would have overwritten the rack in the engine.
- **Master Out:**
  - The EQ row is the GEQ slot's **door** (OPEN → the rack with the GEQ selected) and **lamp** (the rack's
    GEQ is IN and not flat, refreshed when any window saves the rack).
  - `MasterEQRack.tsx` and `ProcessorRack.tsx` are **deleted**: one EQ home, one Processor page.
  - Processor OPEN opens the rack.
- **`src/index.css`:** `--slot-eq`, `--slot-loudness`, `--slot-dynamics`, `--slot-filter` in all four theme
  blocks.
  - **Deviation:** the proposal named `--accent-blue` / `--accent-cyan` / `--accent-magenta`, but this theme
    maps `--accent-blue` and `--accent-cyan` both to the brand purple. EQ and loudness would have been the
    same colour as each other and as the brand accent, so the slot colours are real hues on their own tokens.
- **Help:**
  - `docs/help-processor-rack.md` (new);
  - `help-loudness-meter.md` points at the rack's meter column;
  - `help-audio-processing.md` points at the rack.
- **`smoke-rack-eq.js` §4** now asserts the UI invariant: Master Out neither reads nor writes the EQ; its
  button opens the rack at the GEQ; the rack writes through setRack with its station.

### Receipts
- `tsc --noEmit` 0 errors, including the type-rule typetest. The negative check: with the directive
  removed, tsc fails with *TS2322 … "ride" … is not assignable to type 'null'*.
- vitest: 35 files / 452 tests, including rackModel 9 and loudnessWire 5.
- `smoke-rack-eq` 18/18. `smoke-meter-contract` 30/30. undefined-calls, preload-bridge and ipc-contract
  PASS. Leak guard 13/13.
- **Runtime: UNVERIFIED** — Jeff verifies on screen.

### Deviations, stated
- **No React component tests.** `@testing-library/react` and jsdom are not installed, and adding
  dependencies is a decision of its own. The rules the proposal listed for UI tests (seed and legacy
  conversion, pinned limiter, reorder legality, Arm diff, derived "modified", link/split) are in `rackModel`
  and covered by vitest. The components are verified on screen.
- **Drag-to-reorder is not wired to pointer gestures.** Nothing in the master rack can move (the proposal
  said so), and a drag handle that does nothing would be decoration. `canMove` / `moveSlot` are built and
  tested, ready for slice 5's channel racks. The tile's ⋯ menu says why nothing moves.
- **Found (not fixed):** the daemon's `procmeters` event defines `stream` twice (`ether-audiod.js`
  `local: …, stream: !!lv.proc_stream,` and later `stream: { …branch object… }`). The second wins, so the
  stream-power boolean never reaches the renderer. The rack shows branch activity from the meter bus
  (`gr.<branch>.run`) instead.

// ── rackTypes — the rack document, typed (Slice 4, docs/dsp-rack-framework.md §1.1, §5) ────────────────────
//
// The same model as native/src/rack.rs. THE TYPE RULE: a loudness module (the ride) is unrepresentable in a
// channel rack. `ChannelModule` does not include `RideModule` — today it is `never` (slice 4 has no channel
// modules); slices 5–6 widen it to filters / PEQ / gate / compressor, and never to the ride. The proof is
// rackTypes.typetest.ts, checked by `tsc --noEmit` (the zero-errors gate).

export type GeqModule = { type: "geq"; bands: number[] };
/** LOUDNESS — the program-level ride. Master branch racks only. */
export type RideModule = { type: "ride"; target: number; rate: number; clamp: number };
export type LimiterModule = { type: "limiter"; ceiling: number; release: number };

/** What a master PGM (pre-split) slot can hold. */
export type PgmModule = GeqModule;
/** What a master BRANCH (monitor / stream) slot can hold — the only home of a loudness module. */
export type BranchModule = RideModule | LimiterModule;
/** What a CHANNEL rack slot can hold. Slice 5: FilterModule | PeqModule; slice 6: | GateModule | CompModule.
 *  Never RideModule. */
export type ChannelModule = never;

export type AnyModule = PgmModule | BranchModule;
export type ModuleType = AnyModule["type"];

export interface Slot<M> { id: string; module: M | null; in: boolean }

export interface MasterRackDoc {
  v: 1;
  /** MONITOR and STREAM carry identical modules (the stream section is ignored while linked). */
  link: boolean;
  sections: { pgm: Slot<PgmModule>[]; local: Slot<BranchModule>[]; stream: Slot<BranchModule>[] };
}
export interface ChannelRackDoc { v: 1; sections: { ch: Slot<ChannelModule>[] } }

export type SectionName = "pgm" | "local" | "stream";

/** A preset is the whole master rack (Jeff's slice 4 ruling 2: never the processing on/off switches). */
export interface RackPreset { name: string; doc: MasterRackDoc; builtIn?: boolean }

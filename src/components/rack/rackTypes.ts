// ── rackTypes — the rack document, typed (Slice 4, docs/dsp-rack-framework.md §1.1, §5) ────────────────────
//
// The same model as native/src/rack.rs. THE TYPE RULE: a loudness module (the ride) is unrepresentable in a
// channel rack. `ChannelModule` does not include `RideModule` — slice 5 makes it filters / PEQ, slice 6 adds
// gate / compressor, and never the ride. The proof is
// rackTypes.typetest.ts, checked by `tsc --noEmit` (the zero-errors gate).

export type GeqModule = { type: "geq"; bands: number[] };
/** LOUDNESS — the program-level ride. Master branch racks only. */
export type RideModule = { type: "ride"; target: number; rate: number; clamp: number };
export type LimiterModule = { type: "limiter"; ceiling: number; release: number };

/** What a master PGM (pre-split) slot can hold. */
export type PgmModule = GeqModule;
/** What a master BRANCH (monitor / stream) slot can hold — the only home of a loudness module. */
export type BranchModule = RideModule | LimiterModule;
/** SLICE 5 — Filters: a 24 dB/oct high-pass and low-pass, each with its own IN (docs/dsp-channel-rack-eq.md §1). */
export type FilterStage = { in: boolean; freq: number };
export type FilterModule = { type: "filters"; hpf: FilterStage; lpf: FilterStage };
/** SLICE 5 — the 4-band parametric EQ. `shelf` is honoured on bands 1 and 4 only. */
export type PeqBand = { freq: number; gain: number; width: number; shelf?: boolean };
export type PeqModule = { type: "peq"; bands: [PeqBand, PeqBand, PeqBand, PeqBand] };
/** SLICE 6 — the expander/gate (ratio = 1:ratio) and the RMS soft-knee compressor. dB / ms. */
export type GateModule = { type: "gate"; threshold: number; ratio: number; depth: number; attack: number; hold: number; release: number; hysteresis: number };
export type CompModule = { type: "comp"; threshold: number; ratio: number; attack: number; release: number; makeup: number; knee: number };
/** What a CHANNEL rack slot can hold. Slice 5: FilterModule | PeqModule; slice 6: | GateModule | CompModule.
 *  Never RideModule. */
export type ChannelModule = FilterModule | PeqModule | GateModule | CompModule;
export type ChannelModuleType = ChannelModule["type"];

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

// ── The TS half of the Slice 4 type rule — checked by `tsc --noEmit` (the zero-errors gate) ────────────
//
// A loudness module is unrepresentable in a channel rack. Each @ts-expect-error below MUST be an error: if
// RideModule ever becomes assignable to a channel slot, the directive is unused and tsc fails the build.
// The twins without the directive prove the same shapes ARE accepted where they belong, so the errors cannot
// be a typo. docs/dsp-rack-framework.md §5. Never imported at runtime.
import type { Slot, ChannelModule, BranchModule, PgmModule, ChannelRackDoc } from "./rackTypes";

const ride = { type: "ride", target: -14, rate: 1.5, clamp: 12 } as const;

export const inBranch: Slot<BranchModule> = { id: "b", in: true, module: ride };

export const inChannel: Slot<ChannelModule> = {
  id: "c", in: true,
  // @ts-expect-error — a loudness module is unrepresentable in a channel rack
  module: ride,
};

export const inPgm: Slot<PgmModule> = {
  id: "p", in: true,
  // @ts-expect-error — the ride is per branch (post-split), not in the PGM section either
  module: ride,
};

export const emptyChannelRack: ChannelRackDoc = { v: 1, sections: { ch: [{ id: "c0", in: true, module: null }] } };

// SLICE 5 — the channel modules ARE accepted in a channel slot (so the error above is about the ride, not the slot).
export const filtersInChannel: Slot<ChannelModule> = { id: "f", in: false, module: { type: "filters", hpf: { in: true, freq: 80 }, lpf: { in: false, freq: 18000 } } };
// SLICE 6 — a channel compressor is channel DYNAMICS, never a master branch module (and a ride never a channel one).
export const compInChannel: Slot<ChannelModule> = { id: "k", in: false, module: { type: "comp", threshold: -20, ratio: 3, attack: 10, release: 150, makeup: 0, knee: 6 } };
export const compInBranch: Slot<BranchModule> = {
  id: "k2", in: true,
  // @ts-expect-error — a channel compressor is not a branch module
  module: { type: "comp", threshold: -20, ratio: 3, attack: 10, release: 150, makeup: 0, knee: 6 },
};
export const peqInBranch: Slot<BranchModule> = {
  id: "q", in: true,
  // @ts-expect-error — and a channel EQ is not a branch module
  module: { type: "peq", bands: [{ freq: 100, gain: 0, width: 1 }, { freq: 400, gain: 0, width: 1 }, { freq: 2500, gain: 0, width: 1 }, { freq: 8000, gain: 0, width: 1 }] },
};

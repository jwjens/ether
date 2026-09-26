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

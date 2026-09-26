// ── rackModel — the rack's rules, pure (Slice 4, docs/dsp-rack-framework.md §3, §4, §6) ──────────────────
//
// No React, no IPC. Everything the rack UI decides — the shipped chain and the built-in presets, the derived
// "modified" badge, what Arm would change, link/split, which slots can move / be removed / be added, the
// colour per slot type — lives here and is pinned by rackModel.test.ts. The ENGINE enforces the same rules
// (native/src/rack.rs); this module keeps the UI from ever offering an action the engine would refuse.
import type {
  MasterRackDoc, Slot, BranchModule, PgmModule, AnyModule, ModuleType, SectionName, RackPreset,
} from "./rackTypes";

/** The shipped chain — the exact constants ProgramProcessor::new, the daemon and the old Processor window used. */
export const SHIPPED = { target: -14, rate: 1.5, clamp: 12, ceiling: -1.0, release: 120 } as const;

export function branchSlots(p: { target: number; rate: number; clamp: number; ceiling: number; release: number }): Slot<BranchModule>[] {
  return [
    { id: "s-ride", module: { type: "ride", target: p.target, rate: p.rate, clamp: p.clamp }, in: true },
    { id: "s-lim", module: { type: "limiter", ceiling: p.ceiling, release: p.release }, in: true },
  ];
}

export function makeRack(o: { target?: number; ceiling?: number; bands?: number[] } = {}): MasterRackDoc {
  const p = { ...SHIPPED, target: o.target ?? SHIPPED.target, ceiling: o.ceiling ?? SHIPPED.ceiling };
  return {
    v: 1, link: true,
    sections: {
      pgm: [{ id: "s-geq", module: { type: "geq", bands: o.bands ? [...o.bands] : new Array(10).fill(0) }, in: true }],
      local: branchSlots(p),
      stream: branchSlots(p),
    },
  };
}

/** THE BUILT-IN PRESETS. Only the target and the ceiling come from each standard; rate, clamp and release are
 *  the shipped values (none invented). "Ether v1 (shipped)" is the default — and it IS the −14 LUFS
 *  streaming target, so there is no separate "Stream −14" (Jeff's slice 4 ruling 4). The ceilings are the
 *  SETTING: with the limiter's detection margin each limits ~1.2 dB lower (the ceiling label says where). */
export const BUILT_IN_PRESETS: RackPreset[] = [
  { name: "Ether v1 (shipped)", doc: makeRack(), builtIn: true },
  { name: "Broadcast −24 (ATSC A/85)", doc: makeRack({ target: -24, ceiling: -2.0 }), builtIn: true },
  { name: "EBU −23 (R128)", doc: makeRack({ target: -23, ceiling: -1.0 }), builtIn: true },
  { name: "Stream/Podcast −16", doc: makeRack({ target: -16, ceiling: -1.0 }), builtIn: true },
];
export const DEFAULT_PRESET = BUILT_IN_PRESETS[0].name;

/** The section a branch actually runs: while linked, the stream runs the monitor's modules. */
export function effectiveSection(doc: MasterRackDoc, s: SectionName): Slot<AnyModule>[] {
  if (s === "stream" && doc.link) return doc.sections.local;
  return doc.sections[s] as Slot<AnyModule>[];
}

export function findModule<T extends ModuleType>(slots: Slot<AnyModule>[], type: T): Extract<AnyModule, { type: T }> | null {
  const s = slots.find(x => x.module && x.module.type === type);
  return (s ? s.module : null) as Extract<AnyModule, { type: T }> | null;
}

/** Comparable form: module values and IN in slot order, link, and the stream only when split. Slot ids and a
 *  linked stream copy are not part of what the rack IS. */
function canonical(doc: MasterRackDoc): string {
  const sec = (slots: Slot<AnyModule>[]) => slots.map(s => ({ m: s.module, in: s.in }));
  return JSON.stringify({
    link: doc.link, pgm: sec(doc.sections.pgm), local: sec(doc.sections.local),
    stream: doc.link ? null : sec(doc.sections.stream),
  });
}
/** The "modified" badge — DERIVED from the live rack vs the preset, never a flag. */
export function racksEqual(a: MasterRackDoc, b: MasterRackDoc): boolean { return canonical(a) === canonical(b); }

const MINUS = "−";
const n1 = (v: number) => (v < 0 ? MINUS : "") + Math.abs(v).toFixed(1).replace(/\.0$/, ".0");

/** What Arm → Take would change, in operator words. Empty = the preset is what is running. */
export function diffRacks(live: MasterRackDoc, next: MasterRackDoc): string[] {
  const out: string[] = [];
  const branches: [SectionName, string][] = next.link && live.link ? [["local", "both"]] : [["local", "monitor"], ["stream", "stream"]];
  for (const [s, label] of branches) {
    const a = effectiveSection(live, s), b = effectiveSection(next, s);
    const ra = findModule(a, "ride"), rb = findModule(b, "ride");
    const la = findModule(a, "limiter"), lb = findModule(b, "limiter");
    if (ra && rb && ra.target !== rb.target) out.push(`${label}: target ${n1(ra.target)} → ${n1(rb.target)} LUFS`);
    if (ra && rb && ra.rate !== rb.rate) out.push(`${label}: ride rate ${ra.rate} → ${rb.rate} dB/s`);
    if (ra && rb && ra.clamp !== rb.clamp) out.push(`${label}: ride clamp ${ra.clamp} → ${rb.clamp} dB`);
    if (la && lb && la.ceiling !== lb.ceiling) out.push(`${label}: ceiling ${n1(la.ceiling)} → ${n1(lb.ceiling)} dBTP`);
    if (la && lb && la.release !== lb.release) out.push(`${label}: release ${la.release} → ${lb.release} ms`);
  }
  if (live.link !== next.link) out.push(next.link ? "monitor and stream LINKED" : "monitor and stream SPLIT");
  const ga = findModule(live.sections.pgm as Slot<AnyModule>[], "geq"), gb = findModule(next.sections.pgm as Slot<AnyModule>[], "geq");
  const ia = live.sections.pgm.find(s => s.module?.type === "geq")?.in, ib = next.sections.pgm.find(s => s.module?.type === "geq")?.in;
  if (JSON.stringify(ga?.bands ?? null) !== JSON.stringify(gb?.bands ?? null)) out.push(gb ? (gb.bands.some(g => Math.abs(g) > 0.05) ? "GEQ bands change" : "GEQ → flat") : "GEQ removed");
  if (ga && gb && ia !== ib) out.push(`GEQ ${ib ? "IN" : "OUT"}`);
  return out;
}

/** Old presets (`proc_presets`: five numbers for one branch) as rack presets with a flat GEQ. */
export function convertLegacyPresets(raw: string | null | undefined): RackPreset[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(x => x && typeof x.name === "string" && x.params && !x.builtIn).map(x => {
      const p = x.params;
      const doc = makeRack({ target: Number(p.targetLufs ?? SHIPPED.target), ceiling: Number(p.ceilingDbtp ?? SHIPPED.ceiling) });
      const set = (s: Slot<BranchModule>[]) => s.map(sl => sl.module?.type === "ride"
        ? { ...sl, module: { ...sl.module, rate: Number(p.rideRate ?? SHIPPED.rate), clamp: Number(p.rideClamp ?? SHIPPED.clamp) } }
        : sl.module?.type === "limiter" ? { ...sl, module: { ...sl.module, release: Number(p.releaseMs ?? SHIPPED.release) } } : sl);
      doc.sections.local = set(doc.sections.local); doc.sections.stream = set(doc.sections.stream);
      return { name: x.name as string, doc };
    });
  } catch { return []; }
}

/** Replace one slot's module values (the editor), keeping the linked stream mirrored. */
export function editModule(doc: MasterRackDoc, s: SectionName, slotId: string, patch: Partial<AnyModule>): MasterRackDoc {
  const next: MasterRackDoc = JSON.parse(JSON.stringify(doc));
  const target = s === "stream" && next.link ? "local" : s;
  next.sections[target] = (next.sections[target] as Slot<AnyModule>[]).map(sl =>
    sl.id === slotId && sl.module ? { ...sl, module: { ...sl.module, ...patch } as AnyModule } : sl) as any;
  if (next.link) next.sections.stream = JSON.parse(JSON.stringify(next.sections.local));
  return next;
}

/** GEQ IN is SAVED (ruling 5). Ride and limiter IN are the live-only bypasses — never through this. */
export function setGeqIn(doc: MasterRackDoc, on: boolean): MasterRackDoc {
  const next: MasterRackDoc = JSON.parse(JSON.stringify(doc));
  next.sections.pgm = next.sections.pgm.map(sl => sl.module?.type === "geq" ? { ...sl, in: on } : sl);
  return next;
}

/** Split or link. Splitting changes nothing by itself: the stream starts as a copy of what the monitor runs. */
export function setLink(doc: MasterRackDoc, link: boolean): MasterRackDoc {
  const next: MasterRackDoc = JSON.parse(JSON.stringify(doc));
  next.link = link;
  next.sections.stream = JSON.parse(JSON.stringify(next.sections.local));
  return next;
}

// ── Slots: pinning, reorder, add, remove (§6) ─────────────────────────────────────────────────────────────
export const MASTER_SLOTS = 4;

/** A slot that can never move: the limiter, last in a branch — it is the ceiling guarantee. */
export function isPinned(slot: Slot<AnyModule>): boolean { return slot.module?.type === "limiter"; }

/** Can the slot at `from` move to `to`? Nothing moves past or onto a pinned slot, and a pinned slot never moves. */
export function canMove(slots: Slot<AnyModule>[], from: number, to: number): boolean {
  if (from === to || from < 0 || to < 0 || from >= slots.length || to >= slots.length) return false;
  if (isPinned(slots[from])) return false;
  const pin = slots.findIndex(isPinned);
  if (pin >= 0 && to >= pin) return false;
  return true;
}
export function moveSlot<T>(slots: Slot<T>[], from: number, to: number): Slot<T>[] {
  const next = [...slots];
  const [s] = next.splice(from, 1);
  next.splice(to, 0, s);
  return next;
}

/** A module that cannot be removed: the ride and the limiter (a branch without its limiter has no ceiling). */
export function canRemove(slot: Slot<AnyModule>): boolean { return slot.module?.type === "geq"; }

/** What "add module" offers in a section TODAY. PGM: the GEQ, if it was removed (one instance — it drives the
 *  air and room EQ pair). Branches: nothing (ride and limiter are always present). Channel racks: nothing yet
 *  (slices 5–6). */
export function addableModules(doc: MasterRackDoc, s: SectionName | "channel"): ModuleType[] {
  if (s === "pgm") return doc.sections.pgm.some(x => x.module?.type === "geq") ? [] : ["geq"];
  return [];
}
export function addGeq(doc: MasterRackDoc): MasterRackDoc {
  const next: MasterRackDoc = JSON.parse(JSON.stringify(doc));
  if (next.sections.pgm.some(x => x.module?.type === "geq") || next.sections.pgm.length >= MASTER_SLOTS) return next;
  next.sections.pgm.push({ id: "s-geq", module: { type: "geq", bands: new Array(10).fill(0) }, in: true });
  return next;
}
export function removeSlot(doc: MasterRackDoc, s: SectionName, slotId: string): MasterRackDoc {
  const next: MasterRackDoc = JSON.parse(JSON.stringify(doc));
  const sec = next.sections[s] as Slot<AnyModule>[];
  const slot = sec.find(x => x.id === slotId);
  if (!slot || !canRemove(slot)) return next;
  (next.sections as any)[s] = sec.filter(x => x.id !== slotId);
  return next;
}

// ── One visual language (§2): a fixed colour per slot TYPE, the same in the channel racks ────────────────
export const SLOT_COLOR: Record<string, string> = {
  geq: "var(--slot-eq)",              // EQ (Lawo convention, spec §5)
  peq: "var(--slot-eq)",              // slice 5
  filters: "var(--slot-filter)",      // slice 5
  ride: "var(--slot-loudness)",       // loudness
  limiter: "var(--slot-dynamics)",    // dynamics (spec §5 "magenta dynamics")
  gate: "var(--slot-dynamics)",       // slice 6
  comp: "var(--slot-dynamics)",       // slice 6
};
export const SLOT_LABEL: Record<ModuleType, string> = { geq: "GEQ", ride: "RIDE", limiter: "LIMITER" };

/** What the ride WOULD apply at this input loudness if it were not bypassed — a projection, labelled as one. */
export function wouldRide(doc: MasterRackDoc, s: "local" | "stream", inLufs: number | null | undefined): number | null {
  if (typeof inLufs !== "number" || !Number.isFinite(inLufs) || inLufs <= -69) return null;
  const r = findModule(effectiveSection(doc, s), "ride");
  if (!r) return null;
  return Math.max(-r.clamp, Math.min(r.clamp, r.target - inLufs));
}

export type { PgmModule, BranchModule };

// ── channelRack — a fader's channel rack, its rules, pure (Slice 5, docs/dsp-channel-rack-eq.md §4) ────────
//
// No React, no IPC. What the channel rack UI may do — add (Filters and PEQ, one of each, from the channel
// module list only, so the ride can never be offered), remove, reorder (nothing is pinned in a channel rack),
// IN/OUT, edit — lives here and is pinned by channelRack.test.ts. The engine enforces the same (rack.rs).
//
// RULINGS: a newly ADDED module starts OUT (Jeff's slice 5 ruling 5 — adding changes nothing on air until IN
// is pressed). Filters go before the PEQ (the spec's Trim → Filters → Gate → EQ → Comp) and can be dragged after it.
import type { ChannelRackDoc, ChannelModule, ChannelModuleType, FilterModule, PeqModule, GateModule, CompModule, Slot } from "./rackTypes";
import { clampChannelModule } from "./eqMath";

/** The engine's faders, in engine slot order (rack-seed.js CHANNEL_SLOTS, audio.rs deck_index). */
export const CHANNEL_SLOTS = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"] as const;
export type ChannelSlot = typeof CHANNEL_SLOTS[number];
export const isChannelSlot = (s: string): s is ChannelSlot => (CHANNEL_SLOTS as readonly string[]).includes(s);
/** A channel rack holds at most this many slots (rack.rs CHANNEL_SLOTS). */
export const CHANNEL_RACK_SLOTS = 4;

export const CHANNEL_LABEL: Record<ChannelModuleType, string> = { filters: "FILTERS", gate: "GATE", peq: "PEQ", comp: "COMP" };
/** What Add offers — the channel module list, in the spec's signal order (Filters → Gate → PEQ → Comp; slice 6).
 *  There is no "ride" here, and the type makes one unrepresentable. */
export const CHANNEL_MODULE_TYPES: ChannelModuleType[] = ["filters", "gate", "peq", "comp"];
const ORDER: Record<ChannelModuleType, number> = { filters: 0, gate: 1, peq: 2, comp: 3 };

export const emptyChannelRack = (): ChannelRackDoc => ({ v: 1, sections: { ch: [] } });

/** The values a new module starts with (shown as its current values; the module itself starts OUT). */
export function newModule(t: ChannelModuleType): ChannelModule {
  if (t === "filters") return { type: "filters", hpf: { in: true, freq: 80 }, lpf: { in: false, freq: 18000 } };
  // SLICE 6 — a new gate / compressor starts at the Voice values (ruling 8), OUT (ruling 9).
  if (t === "gate") return { ...VOICE_GATE };
  if (t === "comp") return { ...VOICE_COMP };
  return { type: "peq", bands: [
    { freq: 100, gain: 0, width: 1, shelf: false }, { freq: 400, gain: 0, width: 1 },
    { freq: 2500, gain: 0, width: 1 }, { freq: 8000, gain: 0, width: 1, shelf: false },
  ] };
}

const clone = (d: ChannelRackDoc): ChannelRackDoc => JSON.parse(JSON.stringify(d));
const has = (d: ChannelRackDoc, t: ChannelModuleType) => d.sections.ch.some(s => s.module?.type === t);

/** What Add offers now: each channel module type not already in the rack (one of each), while there is room. */
export function channelAddable(d: ChannelRackDoc): ChannelModuleType[] {
  if (d.sections.ch.length >= CHANNEL_RACK_SLOTS) return [];
  return CHANNEL_MODULE_TYPES.filter(t => !has(d, t));
}
/** Add a module, OUT (ruling 9). It goes in its place in the spec's order — in front of the first module that comes
 *  after it (Filters → Gate → PEQ → Comp); an operator can still drag it anywhere. */
export function addChannelModule(d: ChannelRackDoc, t: ChannelModuleType): ChannelRackDoc {
  if (!channelAddable(d).includes(t)) return d;
  const next = clone(d);
  const slot: Slot<ChannelModule> = { id: `c-${t}`, module: newModule(t), in: false };
  const at = next.sections.ch.findIndex(s => s.module && ORDER[s.module.type] > ORDER[t]);
  if (at >= 0) next.sections.ch.splice(at, 0, slot); else next.sections.ch.push(slot);
  return next;
}
export function removeChannelSlot(d: ChannelRackDoc, id: string): ChannelRackDoc {
  const next = clone(d);
  next.sections.ch = next.sections.ch.filter(s => s.id !== id);
  return next;
}
/** Nothing is pinned in a channel rack: any slot may move anywhere inside it. */
export function canMoveChannel(d: ChannelRackDoc, from: number, to: number): boolean {
  const n = d.sections.ch.length;
  return from !== to && from >= 0 && to >= 0 && from < n && to < n;
}
export function moveChannelSlot(d: ChannelRackDoc, from: number, to: number): ChannelRackDoc {
  if (!canMoveChannel(d, from, to)) return d;
  const next = clone(d);
  const [s] = next.sections.ch.splice(from, 1);
  next.sections.ch.splice(to, 0, s);
  return next;
}
export function setChannelIn(d: ChannelRackDoc, id: string, on: boolean): ChannelRackDoc {
  const next = clone(d);
  next.sections.ch = next.sections.ch.map(s => (s.id === id ? { ...s, in: on } : s));
  return next;
}
/** Replace a slot's module (clamped to the engine's ranges, so the panel never shows a value the engine won't run). */
export function editChannelModule(d: ChannelRackDoc, id: string, m: ChannelModule): ChannelRackDoc {
  const next = clone(d);
  next.sections.ch = next.sections.ch.map(s => (s.id === id && s.module ? { ...s, module: clampChannelModule(m) } : s));
  return next;
}
export function findChannel<T extends ChannelModuleType>(d: ChannelRackDoc, t: T): Slot<Extract<ChannelModule, { type: T }>> | null {
  return (d.sections.ch.find(s => s.module?.type === t) ?? null) as Slot<Extract<ChannelModule, { type: T }>> | null;
}
/** Does anything in this rack run? (a module present AND IN) — the EQ door's lamp. rack-seed.js channelRackActive. */
export function channelRackActive(d: ChannelRackDoc | null | undefined): boolean {
  return !!d && Array.isArray(d.sections?.ch) && d.sections.ch.some(s => !!s.module && s.in !== false);
}
/** Does anything in this rack actually change the sound? (IN, and a filter IN or a band away from 0 dB) */
export function channelRackAudible(d: ChannelRackDoc | null | undefined): boolean {
  if (!d) return false;
  return d.sections.ch.some(s => {
    if (!s.in || !s.module) return false;
    if (s.module.type === "filters") return (s.module as FilterModule).hpf.in || (s.module as FilterModule).lpf.in;
    if (s.module.type === "gate" || s.module.type === "comp") return true;   // level-dependent: it acts
    return (s.module as PeqModule).bands.some(b => Math.abs(b.gain) > 1e-6);
  });
}

// ── SLICE 5b — resets. Each returns a new document; the caller sends it through rack:set like any edit, so the
// engine crossfades it (20 ms) — a reset never clicks.

/** FLAT: every PEQ band to 0 dB; frequency, width and shelf are kept (and the PEQ's IN is untouched). */
export function flatPeq(d: ChannelRackDoc): ChannelRackDoc {
  const next = clone(d);
  next.sections.ch = next.sections.ch.map(s => (s.module?.type === "peq"
    ? { ...s, module: { ...s.module, bands: s.module.bands.map(b => ({ ...b, gain: 0 })) as PeqModule["bands"] } }
    : s));
  return next;
}
/** The Filters RESET: HPF and LPF both OUT, at the new-module frequencies (80 Hz / 18 kHz). The module's IN is kept. */
export const FILTERS_RESET: FilterModule = { type: "filters", hpf: { in: false, freq: 80 }, lpf: { in: false, freq: 18000 } };
export function resetFilters(d: ChannelRackDoc): ChannelRackDoc {
  const next = clone(d);
  next.sections.ch = next.sections.ch.map(s => (s.module?.type === "filters" ? { ...s, module: { ...FILTERS_RESET, hpf: { ...FILTERS_RESET.hpf }, lpf: { ...FILTERS_RESET.lpf } } } : s));
  return next;
}
/** CLEAR RACK: the empty rack — the fader is untouched again. (The UI confirms first.) */
export function clearChannelRack(_d: ChannelRackDoc): ChannelRackDoc { return emptyChannelRack(); }

// ── SLICE 6 — channel presets (docs/dsp-channel-dynamics.md §3) ──────────────────────────────────────────────
/** The Voice starting point (Jeff's ruling 8) — adjust by ear. */
export const VOICE_GATE: GateModule = { type: "gate", threshold: -45, ratio: 4, depth: 15, attack: 1, hold: 100, release: 150, hysteresis: 3 };
export const VOICE_COMP: CompModule = { type: "comp", threshold: -20, ratio: 3, attack: 10, release: 150, makeup: 0, knee: 6 };
export interface ChannelPreset { name: string; doc: ChannelRackDoc; builtIn?: boolean }
/** The built-ins. OFF = the EMPTY rack (ruling 6: nothing runs, bit-identical). VOICE's modules are IN — taking a
 *  preset switches its modules IN (ruling 9); adding one module still starts it OUT. */
export const BUILT_IN_CHANNEL_PRESETS: ChannelPreset[] = [
  { name: "Voice", builtIn: true, doc: { v: 1, sections: { ch: [
    { id: "c-filters", in: true, module: { type: "filters", hpf: { in: true, freq: 80 }, lpf: { in: false, freq: 18000 } } },
    { id: "c-gate", in: true, module: { ...VOICE_GATE } },
    { id: "c-peq", in: true, module: { type: "peq", bands: [
      { freq: 100, gain: 0, width: 1, shelf: false }, { freq: 400, gain: 0, width: 1 }, { freq: 2500, gain: 0, width: 1 }, { freq: 8000, gain: 0, width: 1, shelf: false }] } },
    { id: "c-comp", in: true, module: { ...VOICE_COMP } },
  ] } } },
  { name: "Off", builtIn: true, doc: { v: 1, sections: { ch: [] } } },
];
/** Two channel racks are the same rack (module values and IN, in order; slot ids ignored). */
export function channelRacksEqual(a: ChannelRackDoc, b: ChannelRackDoc): boolean {
  const k = (d: ChannelRackDoc) => JSON.stringify(d.sections.ch.map(s => ({ m: s.module, in: s.in })));
  return k(a) === k(b);
}

/** The rack name rack:get / rack:set take for a fader. */
export const rackName = (slot: ChannelSlot) => `ch:${slot}`;

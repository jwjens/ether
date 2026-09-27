// showPresets.ts — SLICE 7: the board side of show presets (docs/dsp-show-presets.md).
//
// Pure: what a Take would change (the Arm preview) and whether the live board still matches the current show
// ("· modified", derived value by value — never a flag). The blade (audiod/show-presets.js) owns the real state:
// which channels are waiting, the levels, the current show. The Arm preview uses the blade's live rule on what the
// board shows (Jeff's ruling 1: live = ON; for A/B/C ON = playing); the Take's own answer says what actually waited.
import { boardName } from "./boardName";

export const SHOW_SLOTS = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"] as const;
export const ROTATION = new Set(["A", "B", "C"]);
export const FLAT = "Flat";

export interface ShowChannel {
  enabled?: boolean; type?: string; kind?: string; fader?: number; on?: boolean;
  duck?: boolean; duckable?: boolean; roomLevel?: number; rack?: any;
}
export interface ShowDuck { depthDb: number; thresholdDb: number; attackMs: number; holdMs: number; releaseMs: number }
export interface ShowMaster { rack?: any; fader?: number; duck?: ShowDuck; monitorLevel?: number }
export interface ShowPreset {
  v: 1; name: string; stationUuid: string; savedAt: string | null; builtIn?: boolean;
  board: { channels: Record<string, ShowChannel>; master: ShowMaster };
}
/** The blade's state (show:state). */
export interface ShowState {
  current: string | null;
  armed: string | null;
  pending: { slot: string; show: string }[];
  levels: Record<string, number>;
  unavailable?: string;
}
export const EMPTY_SHOW_STATE: ShowState = { current: null, armed: null, pending: [], levels: {} };

/** `where` is what the operator reads (the board letter — ONE NAME PER FADER); `slot` is the engine slot it is about. */
export interface ShowChange { where: string; what: string; from: string; to: string; slot?: string }

const LEVEL_EPS = 0.005;
const pct = (v: number | undefined) => (v == null ? "—" : v <= 0.0005 ? "−∞" : `${(20 * Math.log10(v)).toFixed(1)} dB`);
const yn = (v: boolean | undefined) => (v == null ? "—" : v ? "on" : "off");

/** A rack document compared by what runs: module ids are the UI's bookkeeping, not sound. */
export function rackKey(doc: any): string {
  if (!doc) return "";
  const strip = (x: any): any => Array.isArray(x) ? x.map(strip)
    : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "id").sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, strip(v)]))
    : x;
  return JSON.stringify(strip(doc));
}
const rackWords = (doc: any): string => {
  const mods = (doc?.sections?.ch || doc?.sections?.pgm || []).filter((s: any) => s?.module);
  if (!mods.length) return "empty";
  return mods.map((s: any) => `${String(s.module.type).toUpperCase()}${s.in === false ? " (out)" : ""}`).join(" · ");
};

/**
 * Every value the preset names that differs from the live board. A field the preset does not name is not compared
 * (Flat names faders and racks, not layout). `live` is a snapshot of the board (show:snapshot).
 */
export function diffShow(live: ShowPreset | null, preset: ShowPreset | null, name: (slot: string) => string = (s) => boardName(s)): ShowChange[] {
  if (!live || !preset) return [];
  const out: ShowChange[] = [];
  const lc = live.board.channels, pc = preset.board.channels;
  for (const slot of SHOW_SLOTS) {
    const p = pc[slot]; if (!p) continue;
    const l = lc[slot] || {};
    const w = `Ch ${name(slot)}`;
    if (p.enabled !== undefined && !ROTATION.has(slot) && !!p.enabled !== !!l.enabled) out.push({ where: w, slot, what: "on the board", from: yn(l.enabled), to: yn(p.enabled) });
    if (p.enabled === false) continue;
    if (p.kind !== undefined && !ROTATION.has(slot) && (p.kind || "") !== (l.kind || "")) out.push({ where: w, slot, what: "source", from: l.kind || "—", to: p.kind || "—" });
    if (p.fader != null && Math.abs(p.fader - (l.fader ?? 1)) > LEVEL_EPS) out.push({ where: w, slot, what: "fader", from: pct(l.fader ?? 1), to: pct(p.fader) });
    if (p.duck !== undefined && !ROTATION.has(slot) && !!p.duck !== !!l.duck) out.push({ where: w, slot, what: "duck", from: yn(l.duck), to: yn(p.duck) });
    if (p.duckable !== undefined && !!p.duckable !== (l.duckable ?? true)) out.push({ where: w, slot, what: "ducks under sources", from: yn(l.duckable ?? true), to: yn(p.duckable) });
    if (p.roomLevel != null && Math.abs(p.roomLevel - (l.roomLevel ?? -1)) > LEVEL_EPS) out.push({ where: w, slot, what: "room level", from: l.roomLevel == null ? "—" : `${Math.round(l.roomLevel * 100)}%`, to: `${Math.round(p.roomLevel * 100)}%` });
    if (p.rack && rackKey(p.rack) !== rackKey(l.rack || { v: 1, sections: { ch: [] } })) out.push({ where: w, slot, what: "channel rack", from: rackWords(l.rack), to: rackWords(p.rack) });
  }
  const pm = preset.board.master || {}, lm = live.board.master || {};
  if (pm.fader != null && Math.abs(pm.fader - (lm.fader ?? 1)) > LEVEL_EPS) out.push({ where: "Master", what: "fader", from: pct(lm.fader ?? 1), to: pct(pm.fader) });
  if (pm.monitorLevel != null && Math.abs(pm.monitorLevel - (lm.monitorLevel ?? -1)) > LEVEL_EPS) out.push({ where: "Master", what: "monitor level", from: lm.monitorLevel == null ? "—" : `${Math.round(lm.monitorLevel * 100)}%`, to: `${Math.round(pm.monitorLevel * 100)}%` });
  if (pm.duck) {
    const ld = lm.duck;
    const same = ld && (Object.keys(pm.duck) as (keyof ShowDuck)[]).every(k => Math.abs(pm.duck![k] - ld[k]) < 1e-6);
    if (!same) out.push({ where: "Master", what: "ducker", from: ld ? `${ld.depthDb} dB` : "—", to: `${pm.duck.depthDb} dB · ${pm.duck.thresholdDb} dBFS · ${pm.duck.attackMs}/${pm.duck.holdMs}/${pm.duck.releaseMs} ms` });
  }
  if (pm.rack && rackKey(pm.rack) !== rackKey(lm.rack)) out.push({ where: "Master", what: "master rack", from: "as running", to: rackWords(pm.rack) });
  return out;
}

/** "· modified": the board no longer matches the show last Taken. */
export function isModified(live: ShowPreset | null, current: ShowPreset | null): boolean {
  return diffShow(live, current).length > 0;
}

/**
 * The live rule on what the board shows (ruling 1): A/B/C live while PLAYING; every other channel live while ON.
 * `deckStatus` = A/B/C status; `channelOn` = the stored ON for the others. Only slots on the board count.
 */
export function liveSlots(onBoard: string[], deckStatus: Record<string, string | undefined>, channelOn: Record<string, boolean | undefined>): string[] {
  return onBoard.filter(s => ROTATION.has(s) ? deckStatus[s] === "playing" : channelOn[s] !== false);
}

/** The Arm preview: what a Take would change, split into "now" and "waits (live)". */
export function armPreview(changes: ShowChange[], live: string[]): { now: ShowChange[]; waits: ShowChange[]; waitingSlots: string[] } {
  const isWaiting = (c: ShowChange) => !!c.slot && live.includes(c.slot);
  const waits = changes.filter(isWaiting);
  return { now: changes.filter(c => !isWaiting(c)), waits, waitingSlots: [...new Set(waits.map(c => c.slot as string))] };
}

/** The strip's PENDING: which show this slot is waiting for, from the blade's state (never local state). */
export function pendingFor(state: ShowState, slot: string): string | null {
  return state.pending.find(p => p.slot === slot)?.show ?? null;
}

// faderLaw — THE ONE CONSOLE FADER LAW (Jeff, 2026-10-11). Every fader in Ether — channel faders, MASTER, MONITOR, the
// station MONITOR strips and every AUX/local row — maps its travel to gain HERE, and nowhere else.
//
// THE LAW IS A SETTING (Jeff, 2026-10-13, docs/fader-handling-plan-2026-10-13.md, option A): "The scale and travel are
// visible settings, nothing in code." Its points live in Preferences (station_config_kv `fader_law`, written once with
// FADER_LAW_START below — the same pattern as the ducker), and every window draws with what is saved (useFaderTop loads
// it and calls setFaderLaw). FADER_LAW_START is only what Preferences is given the first time.
//
// ONE CURVE, A TOP PER FADER GROUP (Jeff, 2026-10-11, second ruling): "MASTER and MONITOR top out at unity (0 dB at the
// top of travel, same curve below). Channel faders and AUX rows keep +10 dB at the top. The maximum for each fader group
// is a visible setting." The curve's shape is fixed; it is slid so its top sits at the group's maximum:
//
//   travel:          0%   3%    10%   17.5%  25%   50%   75%   100%   (the starting law, option A)
//   top +10 (chan):  off  −60   −40   −30    −20   −10   0     +10      ← unity at 75%
//   top   0 (MASTER):off  −70   −50   −40    −30   −20   −10   0        ← unity at the top
//
// Between the points the curve is straight in dB: −20…+10 is 75 % of the travel, every dB 2.5 % wide (Behringer X32:
// 62.5 %, Wheatstone LXE ≈ 60 % at 2 % per dB). Below the first point it falls 30 dB more, then off.
//
// WHAT IS STORED IS GAIN, NEVER A POSITION. board_levels, aux_monitor_levels, monitor_volume and master_monitor_volume
// hold linear gain, so the law (and a group's maximum) only decide where a fader is DRAWN for that gain — nothing saved
// changes level when either changes (faderLaw.test.ts pins it with station 2's saved board).

export interface LawPoint { pos: number; db: number }

/** What Preferences is given the first time (option A): the curve's points with its top at +10 dB (position 0…1, dB).
 *  Position 0 is OFF (−∞), handled separately. audiod/board-state.js FADER_START carries the same points. */
export const FADER_LAW_START: readonly LawPoint[] = [
  { pos: 0.03, db: -60 },
  { pos: 0.10, db: -40 },
  { pos: 0.175, db: -30 },
  { pos: 0.25, db: -20 },
  { pos: 0.50, db: -10 },
  { pos: 0.75, db: 0 },
  { pos: 1.00, db: 10 },
];
const BASE_TOP_DB = 10;

/** A law Preferences may hold: 2–16 points, position and dB both rising, the last point at 100 % and +10 dB (a group's
 *  top slides it), every position inside (0, 1]. Returns the reason it is not, or null. */
export function lawProblem(pts: unknown): string | null {
  if (!Array.isArray(pts) || pts.length < 2 || pts.length > 16) return "The law needs 2 to 16 points.";
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as LawPoint;
    if (!p || !Number.isFinite(p.pos) || !Number.isFinite(p.db)) return `Point ${i + 1} is not a position and a dB.`;
    if (!(p.pos > 0 && p.pos <= 1)) return `Point ${i + 1}: the position must be above 0 % and at most 100 %.`;
    if (p.db < -120 || p.db > BASE_TOP_DB) return `Point ${i + 1}: the dB must be between −120 and +10.`;
    if (i > 0 && !(p.pos > (pts[i - 1] as LawPoint).pos && p.db > (pts[i - 1] as LawPoint).db)) return `Point ${i + 1} must be above point ${i} in both position and dB.`;
  }
  const last = pts[pts.length - 1] as LawPoint;
  if (last.pos !== 1 || last.db !== BASE_TOP_DB) return "The last point must be 100 % = +10 dB (each group's maximum slides the curve).";
  return null;
}

/** The law every fader draws with: Preferences' saved points (setFaderLaw), the starting law until they are read. */
let LAW: readonly LawPoint[] = FADER_LAW_START;
export function setFaderLaw(pts: readonly LawPoint[] | null | undefined): boolean {
  if (!pts || lawProblem(pts)) return false;
  LAW = pts.map(p => ({ pos: p.pos, db: p.db }));
  return true;
}
export function faderLaw(): readonly LawPoint[] { return LAW; }
/** The starting points (the tests pin them). */
export const FADER_LAW = FADER_LAW_START;

/** HOW A FADER FEELS (Jeff, 2026-10-13): Shift+drag divides the movement by `fine`; the wheel steps `wheelDb`; arrow keys
 *  step `arrowDb`, Shift+arrow `arrowFineDb`. Preferences' values (station_config_kv fader_fine_factor,
 *  fader_wheel_step_db, fader_arrow_step_db, fader_arrow_fine_step_db), written once with these starting values. */
export interface FaderFeel { fine: number; wheelDb: number; arrowDb: number; arrowFineDb: number }
export const FADER_FEEL_START: FaderFeel = { fine: 10, wheelDb: 0.5, arrowDb: 0.5, arrowFineDb: 0.1 };
let FEEL: FaderFeel = { ...FADER_FEEL_START };
export function setFaderFeel(f: { [K in keyof FaderFeel]?: number | null } | null | undefined) {
  if (!f) return;
  const ok = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  FEEL = {
    fine: ok(f.fine, 1, 100) ? f.fine as number : FEEL.fine,
    wheelDb: ok(f.wheelDb, 0.01, 10) ? f.wheelDb as number : FEEL.wheelDb,
    arrowDb: ok(f.arrowDb, 0.01, 10) ? f.arrowDb as number : FEEL.arrowDb,
    arrowFineDb: ok(f.arrowFineDb, 0.01, 10) ? f.arrowFineDb as number : FEEL.arrowFineDb,
  };
}
export function faderFeel(): FaderFeel { return FEEL; }

/** The fader groups and the default top of each (the visible settings; electron/main.js board:sound-settings). */
export type FaderGroup = "channel" | "aux" | "master" | "monitor";
export const DEFAULT_TOP_DB: Record<FaderGroup, number> = { channel: 10, aux: 10, master: 0, monitor: 0 };

/** The most any fader can ever be set to (the engine's own ceiling): +10 dB. A group's setting can only lower it. */
export const MAX_GAIN_DB = 10;
export const MAX_GAIN = Math.pow(10, MAX_GAIN_DB / 20);

const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(g);

function baseDb(p: number): number {
  if (p <= 0) return -Infinity;
  const first = LAW[0];
  if (p < first.pos) return first.db - (first.pos - p) / first.pos * 30;
  for (let i = 1; i < LAW.length; i++) {
    const a = LAW[i - 1], b = LAW[i];
    if (p <= b.pos) return a.db + (b.db - a.db) * (p - a.pos) / (b.pos - a.pos);
  }
  return LAW[LAW.length - 1].db;
}
function basePos(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const first = LAW[0];
  if (db <= first.db - 30) return 0;
  if (db < first.db) return Math.max(0, first.pos - (first.db - db) / 30 * first.pos);
  for (let i = 1; i < LAW.length; i++) {
    const a = LAW[i - 1], b = LAW[i];
    if (db <= b.db) return a.pos + (b.pos - a.pos) * (db - a.db) / (b.db - a.db);
  }
  return 1;
}
const clampTop = (topDb: number) => (Number.isFinite(topDb) ? Math.min(MAX_GAIN_DB, topDb) : BASE_TOP_DB);

/** Fader travel (0…1) → dB, for a fader whose top is `topDb`. 0 → −Infinity (off). */
export function posToDb(pos: number, topDb: number = BASE_TOP_DB): number {
  const p = Math.max(0, Math.min(1, pos));
  const d = baseDb(p);
  return d === -Infinity ? d : d + (clampTop(topDb) - BASE_TOP_DB);
}

/** Fader travel (0…1) → linear gain (what the engine and every store hold). */
export function posToGain(pos: number, topDb: number = BASE_TOP_DB): number {
  const db = posToDb(pos, topDb);
  return db === -Infinity ? 0 : dbToGain(db);
}

/** dB → fader travel (0…1). The exact inverse of posToDb; a level above the top draws at the top. */
export function dbToPos(db: number, topDb: number = BASE_TOP_DB): number {
  if (!Number.isFinite(db)) return 0;
  return basePos(db - (clampTop(topDb) - BASE_TOP_DB));
}

/** Linear gain → fader travel (0…1): where a stored gain is DRAWN. */
export function gainToPos(gain: number, topDb: number = BASE_TOP_DB): number {
  if (!(gain > 0)) return 0;
  return dbToPos(gainToDb(gain), topDb);
}

/** The most a fader of this group can send (its top). */
export function topGain(topDb: number = BASE_TOP_DB): number { return dbToGain(clampTop(topDb)); }

/** Where unity (0 dB) sits on a fader whose top is `topDb`. */
export function unityPos(topDb: number = BASE_TOP_DB): number { return dbToPos(0, topDb); }
/** Unity on the default (channel) curve — 75%. */
export const UNITY_POS = 0.75;

/** A gain as the scale reads it: "+4.0 dB", "0.0 dB", "−16.3 dB", "off". */
export function formatDb(gain: number): string {
  if (!(gain > 0)) return "off";
  const db = gainToDb(gain);
  if (db <= -99.95) return "off";
  return `${db > 0.05 ? "+" : db < -0.05 ? "−" : ""}${Math.abs(db).toFixed(1)} dB`;
}

/** The scale marks for a fader whose top is `topDb`: label + travel, unity flagged. */
export function faderMarks(topDb: number = BASE_TOP_DB): { label: string; pos: number; unity?: boolean }[] {
  const shift = clampTop(topDb) - BASE_TOP_DB;
  const fmt = (d: number) => (d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : "0");
  const marks = LAW.slice().reverse().map(p => ({ label: fmt(p.db + shift), pos: p.pos, unity: p.db + shift === 0 }));
  // A top off the 10 dB grid (say +6): unity is still marked, where it falls.
  const u = unityPos(topDb);
  if (!marks.some(m => m.unity) && u > 0 && u <= 1) marks.push({ label: "0", pos: u, unity: true });
  marks.push({ label: "∞", pos: 0, unity: false });
  return marks.sort((a, b) => b.pos - a.pos);
}
/** The default (channel) scale, on the starting law. */
export const FADER_MARKS = faderMarks(BASE_TOP_DB);

/** One step of `stepDb` up (dir +1) or down (−1) from `gain`, on the step grid (−5.3 → −5.0 → −4.5 with 0.5), held at
 *  the group's top; below the bottom of the travel it is off, and a step up from off lands on the travel's lowest step. */
export function stepGain(gain: number, dir: 1 | -1, stepDb: number, topDb: number = BASE_TOP_DB): number {
  const top = clampTop(topDb);
  const floorDb = posToDb(1e-6, topDb);
  if (!(gain > 0)) return dir > 0 ? dbToGain(Math.ceil(floorDb / stepDb) * stepDb) : 0;
  const cur = gainToDb(gain);
  const k = cur / stepDb;
  let next = (dir > 0 ? Math.floor(k + 1e-9) + 1 : Math.ceil(k - 1e-9) - 1) * stepDb;
  if (next > top) next = top;
  if (next < floorDb) return 0;
  return dbToGain(next);
}

/** What someone typed as a level: "-5", "−5", "-5 dB", "+3.5", "0", "off", "-inf". null = not a level. */
export function parseDbInput(text: string): number | null {
  const t = String(text || "").trim().toLowerCase().replace(/\u2212/g, "-").replace(/db$/, "").trim();
  if (t === "off" || t === "-inf" || t === "\u221e" || t === "-\u221e") return -Infinity;
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

// faderLaw — THE ONE CONSOLE FADER LAW (Jeff, 2026-10-11). Every fader in Ether — channel faders, MASTER, MONITOR, the
// station MONITOR strips and every AUX/local row — maps its travel to gain HERE, and nowhere else.
//
// ONE CURVE, A TOP PER FADER GROUP (Jeff, 2026-10-11, second ruling): "MASTER and MONITOR top out at unity (0 dB at the
// top of travel, same curve below). Channel faders and AUX rows keep +10 dB at the top. The maximum for each fader group
// is a visible setting." The curve's shape is fixed; it is slid so its top sits at the group's maximum:
//
//   travel:          0%   5%    15%   25%   35%   50%   75%   100%
//   top +10 (chan):  off  −60   −40   −30   −20   −10   0     +10      ← unity at 75%
//   top   0 (MASTER):off  −70   −50   −40   −30   −20   −10   0        ← unity at the top
//
// Between the points the curve is straight in dB, so the whole travel is usable. Below 5% it falls 30 dB more, then off.
//
// WHAT IS STORED IS GAIN, NEVER A POSITION. board_levels, aux_monitor_levels, monitor_volume and master_monitor_volume
// hold linear gain, so the law (and a group's maximum) only decide where a fader is DRAWN for that gain — nothing saved
// changes level when either changes (faderLaw.test.ts pins it with station 2's saved board).

export interface LawPoint { pos: number; db: number }

/** The curve's points with its top at +10 dB (position 0…1, dB). Position 0 is OFF (−∞), handled separately. */
export const FADER_LAW: readonly LawPoint[] = [
  { pos: 0.05, db: -60 },
  { pos: 0.15, db: -40 },
  { pos: 0.25, db: -30 },
  { pos: 0.35, db: -20 },
  { pos: 0.50, db: -10 },
  { pos: 0.75, db: 0 },
  { pos: 1.00, db: 10 },
];
const BASE_TOP_DB = 10;

/** The fader groups and the default top of each (the visible settings; electron/main.js board:sound-settings). */
export type FaderGroup = "channel" | "aux" | "master" | "monitor";
export const DEFAULT_TOP_DB: Record<FaderGroup, number> = { channel: 10, aux: 10, master: 0, monitor: 0 };

/** The most any fader can ever be set to (the engine's own ceiling): +10 dB. A group's setting can only lower it. */
export const MAX_GAIN_DB = 10;
export const MAX_GAIN = Math.pow(10, MAX_GAIN_DB / 20);

const dbToGain = (db: number) => Math.pow(10, db / 20);
const gainToDb = (g: number) => 20 * Math.log10(g);

function baseDb(p: number): number {
  if (p <= 0) return -Infinity;
  const first = FADER_LAW[0];
  if (p < first.pos) return first.db - (first.pos - p) / first.pos * 30;
  for (let i = 1; i < FADER_LAW.length; i++) {
    const a = FADER_LAW[i - 1], b = FADER_LAW[i];
    if (p <= b.pos) return a.db + (b.db - a.db) * (p - a.pos) / (b.pos - a.pos);
  }
  return FADER_LAW[FADER_LAW.length - 1].db;
}
function basePos(db: number): number {
  if (!Number.isFinite(db) || db <= -90) return 0;
  const first = FADER_LAW[0];
  if (db < first.db) return Math.max(0, first.pos - (first.db - db) / 30 * first.pos);
  for (let i = 1; i < FADER_LAW.length; i++) {
    const a = FADER_LAW[i - 1], b = FADER_LAW[i];
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
  const marks = FADER_LAW.slice().reverse().map(p => ({ label: fmt(p.db + shift), pos: p.pos, unity: p.db + shift === 0 }));
  // A top off the 10 dB grid (say +6): unity is still marked, where it falls.
  const u = unityPos(topDb);
  if (!marks.some(m => m.unity) && u > 0 && u <= 1) marks.push({ label: "0", pos: u, unity: true });
  marks.push({ label: "∞", pos: 0, unity: false });
  return marks.sort((a, b) => b.pos - a.pos);
}
/** The default (channel) scale. */
export const FADER_MARKS = faderMarks(BASE_TOP_DB);

// faderLaw — THE ONE CONSOLE FADER LAW (Jeff, 2026-10-11). Every fader in Ether — channel faders, MASTER, MONITOR, the
// station MONITOR strips and every AUX/local row — maps its travel to gain HERE, and nowhere else.
//
//   travel:  0%   5%    15%   25%   35%   50%   ~75%     100%
//   dB:      off  −60   −40   −30   −20   −10   0 unity  +10
//
// Between the points the law is straight in dB (so a centimetre of travel is the same number of dB within a segment),
// which keeps the whole travel usable: the old channel law put −30 dB at the halfway mark, the old linear MASTER/MONITOR
// law put −6 dB there, and either way half the fader was dead or crowded.
//
// WHAT IS STORED IS GAIN, NEVER A POSITION. board_levels, aux_monitor_levels, monitor_volume and master_monitor_volume
// all hold linear gain, so this law only decides where a fader is DRAWN for that gain — nothing already saved changes
// level when the law changes (faderLaw.test.ts pins it with station 2's saved board).

export interface LawPoint { pos: number; db: number }

/** The law's points (position 0…1, dB). Position 0 is OFF (−∞), handled separately. */
export const FADER_LAW: readonly LawPoint[] = [
  { pos: 0.05, db: -60 },
  { pos: 0.15, db: -40 },
  { pos: 0.25, db: -30 },
  { pos: 0.35, db: -20 },
  { pos: 0.50, db: -10 },
  { pos: 0.75, db: 0 },
  { pos: 1.00, db: 10 },
];

/** The most any fader can be set to: +10 dB. */
export const MAX_GAIN_DB = 10;
export const MAX_GAIN = Math.pow(10, MAX_GAIN_DB / 20);
/** Unity (0 dB) sits here on every fader. */
export const UNITY_POS = 0.75;

const dbToGain = (db: number) => Math.pow(10, db / 20);
const gainToDb = (g: number) => 20 * Math.log10(g);

/** Fader travel (0…1) → dB. 0 → −Infinity (off). Below the first point the law falls straight to off. */
export function posToDb(pos: number): number {
  const p = Math.max(0, Math.min(1, pos));
  if (p <= 0) return -Infinity;
  const first = FADER_LAW[0];
  if (p < first.pos) {
    // The bottom 5%: −60 dB at 5% down to −90 dB just above 0, then off. Keeps the very bottom usable as a fade-out.
    return first.db - (first.pos - p) / first.pos * 30;
  }
  for (let i = 1; i < FADER_LAW.length; i++) {
    const a = FADER_LAW[i - 1], b = FADER_LAW[i];
    if (p <= b.pos) return a.db + (b.db - a.db) * (p - a.pos) / (b.pos - a.pos);
  }
  return FADER_LAW[FADER_LAW.length - 1].db;
}

/** Fader travel (0…1) → linear gain (what the engine and every store hold). */
export function posToGain(pos: number): number {
  const db = posToDb(pos);
  return db === -Infinity ? 0 : dbToGain(db);
}

/** dB → fader travel (0…1). The exact inverse of posToDb. */
export function dbToPos(db: number): number {
  if (!Number.isFinite(db) || db <= -90) return 0;
  const first = FADER_LAW[0];
  if (db < first.db) return Math.max(0, first.pos - (first.db - db) / 30 * first.pos);
  for (let i = 1; i < FADER_LAW.length; i++) {
    const a = FADER_LAW[i - 1], b = FADER_LAW[i];
    if (db <= b.db) return a.pos + (b.pos - a.pos) * (db - a.db) / (b.db - a.db);
  }
  return 1;
}

/** Linear gain → fader travel (0…1): where a stored gain is DRAWN. */
export function gainToPos(gain: number): number {
  if (!(gain > 0)) return 0;
  return dbToPos(gainToDb(Math.min(gain, MAX_GAIN)));
}

/** A gain as the scale reads it: "+4.0 dB", "0.0 dB", "−16.3 dB", "off". */
export function formatDb(gain: number): string {
  if (!(gain > 0)) return "off";
  const db = gainToDb(gain);
  if (db <= -89.95) return "off";
  return `${db > 0.05 ? "+" : db < -0.05 ? "−" : ""}${Math.abs(db).toFixed(1)} dB`;
}

/** The scale marks drawn on every fader: label + travel. */
export const FADER_MARKS: readonly { label: string; pos: number; unity?: boolean }[] = [
  { label: "+10", pos: 1.0 },
  { label: "0", pos: UNITY_POS, unity: true },
  { label: "−10", pos: 0.50 },
  { label: "−20", pos: 0.35 },
  { label: "−30", pos: 0.25 },
  { label: "−40", pos: 0.15 },
  { label: "−60", pos: 0.05 },
  { label: "∞", pos: 0 },
];

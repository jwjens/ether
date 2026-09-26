// micMigration.ts — the mic moves into the engine (docs/dsp-mic-in-engine.md §3). Pure; pinned by micMigration.test.ts.
//
// Before: a board channel of TYPE "mic" (MicChannel — getUserMedia → the browser's default output, never on air),
// either on a lettered slot or on the dedicated "mic" slot (which has no engine slot at all). After: a mic is a
// SOURCE channel patched to "mic" (faders are generic — ruling 1).
//
// NEVER STRAND A USER: a mic on a source slot (D–F, S1–S5) becomes that same slot, re-typed. A mic anywhere else
// moves to the FIRST FREE source slot. If there is none it is left exactly as it was, and the board shows it
// with the reason — it is never silently dropped.
import type { DeckConfig } from "../components/DeckConfigurator";

export const MIC_SOURCE_SLOTS = ["D", "E", "F", "S1", "S2", "S3", "S4", "S5"];

export type MicMove = { from: string; to: string | null };

export function migrateMicDecks(configs: DeckConfig[]): { next: DeckConfig[]; moves: MicMove[] } {
  const next: DeckConfig[] = configs.map(c => ({ ...c }));
  const moves: MicMove[] = [];
  const taken = new Set(next.filter(c => c.type !== "mic").map(c => c.slot));
  for (const c of configs) {
    if (c.type !== "mic") continue;
    const i = next.findIndex(x => x.slot === c.slot);
    if (MIC_SOURCE_SLOTS.includes(c.slot)) {
      next[i] = { ...next[i], type: "source", kind: "mic" as any, label: c.label || "MIC" };
      taken.add(c.slot);
      moves.push({ from: c.slot, to: c.slot });
      continue;
    }
    const free = MIC_SOURCE_SLOTS.find(s => !taken.has(s) && !next.some(x => x.slot === s && x.type !== "mic"));
    if (!free) { moves.push({ from: c.slot, to: null }); continue; }
    taken.add(free);
    // the old row is kept but disabled (a synced table: removing rows is a separate, deliberate act)
    next[i] = { ...next[i], enabled: false };
    const target: DeckConfig = { ...c, slot: free, type: "source", kind: "mic" as any, label: c.label || "MIC", enabled: c.enabled, channelOn: true };
    const j = next.findIndex(x => x.slot === free);
    if (j >= 0) next[j] = target; else next.push(target);
    moves.push({ from: c.slot, to: free });
  }
  return { next, moves };
}

/** Match a browser input label to an engine (WASAPI) device name. Chromium adds a USB id suffix
 *  ("Microphone (Shure MV7) (14ed:1012)") and "Default - " / "Communications - " prefixes; the engine's name
 *  has neither. Exact after normalising, or no match — a wrong mic on air is worse than none. */
export function matchDeviceLabel(label: string, names: string[]): string | null {
  const norm = (s: string) => s.replace(/^(default|communications)\s*-\s*/i, "").replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "").trim().toLowerCase();
  const want = norm(label || "");
  if (!want) return null;
  const hits = names.filter(n => norm(n) === want);
  return hits.length === 1 ? hits[0] : null;
}

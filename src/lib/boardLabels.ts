// boardLabels — list labels that name a channel, built with the one-name helper (src/lib/boardName.ts).
// Audit 25/26 (docs/help-audit-2026-09-27.md): the Wild meter picker and Preferences → Mic Inputs showed the engine
// slot ids S1–S5. `name` is useBoardName() in a component (the station's own board order).

/** The meter channel taps in engine order (meterStore CH_INDEX keys). */
const CHANNELS = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"];
const BUSES = ["PGM", "LOCAL", "STREAM", "MONITOR", "ROOM", "AUX"];

/** The Wild meter's choices. Keys stay the engine ids (what the picker stores); only the labels use board names. */
export function wildChoices(name: (slot: string) => string, channels: readonly string[] = CHANNELS, buses: readonly string[] = BUSES): { key: string; label: string }[] {
  return [
    ...buses.map(b => ({ key: `bus:${b}`, label: `${b} (bus, post-fader)` })),
    ...channels.map(c => {
      const n = /^[A-F]$/.test(c) ? `Deck ${c}` : name(c);
      return { key: `ch:${c}`, label: `${n} (channel, pre-fader)` };
    }),
  ];
}

export interface MicRowConfig { slot: string; enabled?: boolean | number; type?: string; kind?: string; label?: string | null }

/** Preferences → Mic Inputs rows: every enabled source channel patched to Mic, then any slot that still holds a stored
 *  patch (so a patch can always be removed). `heading` is what the row is called on screen. */
export function micChannelRows(configs: readonly MicRowConfig[], patchSlots: readonly string[], name: (slot: string) => string): { slot: string; heading: string }[] {
  const rows = configs.filter(c => c.enabled && c.type === "source" && c.kind === "mic")
    .map(c => ({ slot: String(c.slot), heading: c.label ? `${name(String(c.slot))} · ${c.label}` : name(String(c.slot)) }));
  for (const s of patchSlots) if (!rows.some(r => r.slot === s)) rows.push({ slot: s, heading: `${name(s)} · not a mic channel` });
  return rows;
}

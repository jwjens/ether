// useMicMigration.ts — the one-time move of the old browser mic into the engine (docs/dsp-mic-in-engine.md §3).
// Run by App ONLY (one window writes). Idempotent: a board with no "mic"-type channel and no unpatched mic
// channel does nothing.
//
//   1. BOARD (deck_configs, station-wide): every "mic"-type channel becomes a source channel patched to Mic —
//      same slot if it is a source slot, else the first free one (micMigration.ts; never silently dropped).
//   2. DEVICE (machine-local): the old channel remembered a BROWSER deviceId (localStorage ether_mic_device_<slot>),
//      not a device name. Its label is matched to the engine's device names (matchDeviceLabel — exact after
//      normalising, or nothing). Matched → patched (input 1, 0 dB). Not matched → left unpatched; the strip says
//      "no input — Preferences → Audio". Never a guess.
//   3. The old mic EQ settings (eq_deck_mic) are NOT carried over (Jeff's ruling 5).
import { useEffect, useRef } from "react";
import type { DeckConfig, DeckType } from "../components/DeckConfigurator";
import { queryScoped } from "../db/stationScoped";
import { migrateMicDecks, matchDeviceLabel } from "../lib/micMigration";

/** THIS station's deck rows, read here — never a hook's list, which can still hold the previous station's rows
 *  for a moment after a switch (writing those back would copy one station's board onto another). */
async function readBoard(stationId: number): Promise<DeckConfig[]> {
  const rows = await queryScoped<{ slot: string; type: string; label: string; color: string; enabled: number; purpose: string; kind: string; address: string | null; duck: number; channel_on: number }>(
    "SELECT slot, type, label, color, enabled, COALESCE(purpose,'') as purpose, COALESCE(kind,'') as kind, address, COALESCE(duck,0) as duck, COALESCE(channel_on,1) as channel_on FROM deck_configs ORDER BY slot",
    [], stationId);
  return rows.map(r => ({ ...r, type: r.type as DeckType, enabled: r.enabled === 1, kind: (r.kind || "") as any, duck: r.duck === 1, channelOn: r.channel_on === 1 }));
}

export function useMicMigration(stationId: number | null | undefined, ready: boolean) {
  const done = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (stationId == null || !ready || done.current.has(stationId)) return;
    done.current.add(stationId);
    (async () => {
      const api = (window as any).ether?.audio;
      let configs: DeckConfig[];
      try { configs = await readBoard(stationId); } catch (e) { console.warn("[mic-migrate] could not read the board:", e); return; }
      const { next, moves } = migrateMicDecks(configs);
      if (moves.length) {
        // write only the rows that changed, each to THIS station by slot (updateBySlot creates a missing row)
        for (const c of next) {
          const was = configs.find(x => x.slot === c.slot);
          if (was && JSON.stringify(was) === JSON.stringify(c)) continue;
          const r = await (window as any).ether?.deckConfigs?.updateBySlot?.(stationId, c.slot, {
            type: c.type, label: c.label, color: c.color, enabled: c.enabled ? 1 : 0, purpose: c.purpose || "",
            channel_on: (c.channelOn ?? true) ? 1 : 0, kind: c.kind || "", address: c.address ?? null, duck: c.duck ? 1 : 0,
          });
          if (r && r.ok === false) { console.warn(`[mic-migrate] ${c.slot} not saved:`, r.error); return; }
        }
        for (const m of moves) {
          console.log(m.to ? `[mic-migrate] mic channel ${m.from} → source channel ${m.to} patched to Mic`
                           : `[mic-migrate] mic channel ${m.from} could NOT move — no free source slot (it stays on the board, saying so)`);
        }
      }
      // Device seeds: every mic channel now on a source slot (moved, or already a mic source) with no patch yet.
      const micSlots: { slot: string; from: string }[] = [
        ...moves.filter(m => m.to).map(m => ({ slot: m.to as string, from: m.from })),
        ...next.filter(c => c.enabled && c.type === "source" && c.kind === "mic" && !moves.some(m => m.to === c.slot)).map(c => ({ slot: c.slot, from: c.slot })),
      ];
      if (!micSlots.length || !api?.getMicInputs) return;
      const have = await api.getMicInputs(stationId).catch(() => null);
      const patched: Record<string, unknown> = (have && have.patches) || {};
      const names: string[] = ((await api.listInputDevices?.().catch(() => [])) || []).map((d: any) => d.name);
      let labels: MediaDeviceInfo[] = [];
      try { labels = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput"); } catch { /* no labels → nothing to match */ }
      for (const { slot, from } of micSlots) {
        if (patched[slot]) continue;
        let id = "";
        try { id = localStorage.getItem(`ether_mic_device_${from}`) || ""; } catch { /* none */ }
        const label = labels.find(d => d.deviceId === id)?.label || "";
        const device = id ? matchDeviceLabel(label, names) : null;
        if (!device) {
          if (id) console.log(`[mic-migrate] ${slot}: the old browser device "${label || id}" has no exact match among this computer's engine inputs — left unpatched (Preferences → Audio)`);
          continue;
        }
        const r = await api.setMicInput(stationId, slot, { device, channel: 1, gainDb: 0 }).catch((e: any) => ({ ok: false, reason: String(e) }));
        console.log(r && r.ok ? `[mic-migrate] ${slot}: patched to "${device}" (input 1, 0 dB)` : `[mic-migrate] ${slot}: patch to "${device}" not applied — ${r && r.reason}`);
      }
    })();
  }, [stationId, ready]);
}

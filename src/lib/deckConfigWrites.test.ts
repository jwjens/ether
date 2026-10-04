import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as W from "./deckConfigWrites";
import type { DeckConfig } from "../components/DeckConfigurator";

// RC5 (OV station 2, 2026-10-04 04:00:04Z): Source E was CUT by a local full-board save — 9 deck_configs rows
// written in one burst, only updated_at moving in the synced payload (channel_on is not a synced column). Every
// board window used to save EVERY row from its in-memory state, channel_on included, so a window holding a stale
// "E off" re-cut E on its next save of anything.

const row = (slot: string, extra: Partial<DeckConfig> = {}): DeckConfig =>
  ({ slot, type: "source", label: `Source ${slot}`, color: "#8868D8", enabled: true, purpose: "", kind: "announcement",
     address: null, duck: false, channelOn: true, ...extra } as DeckConfig);

/** A fake main process: the deck_configs rows of one station, written only through update-by-slot. */
function fakeMain(initial: DeckConfig[]) {
  const db = new Map<string, Record<string, unknown>>();
  for (const c of initial) db.set(c.slot, { ...c, channel_on: c.channelOn ? 1 : 0 });
  const calls: { stationId: any; slot: string; patch: Record<string, unknown> }[] = [];
  const api: W.DeckConfigsApi = {
    updateBySlot: async (stationId, slot, patch) => {
      calls.push({ stationId, slot, patch });
      db.set(slot, { ...(db.get(slot) || {}), ...patch });
      return { ok: true, row: db.get(slot) };
    },
  };
  return { db, calls, api };
}

const BOARD = ["A", "B", "C", "D", "E", "F", "S1", "S2", "S3"].map(s => row(s));

describe("cutting / uncutting ONE channel writes only that channel's row", () => {
  it("cut E → exactly one update-by-slot call, for E, carrying only channel_on", async () => {
    const m = fakeMain(BOARD);
    await W.writeChannelOn(m.api, 2, "E", false);
    expect(m.calls).toEqual([{ stationId: 2, slot: "E", patch: { channel_on: 0 } }]);
    expect(m.db.get("E")!.channel_on).toBe(0);
  });

  it("uncut E → exactly one update-by-slot call, for E", async () => {
    const m = fakeMain(BOARD.map(c => (c.slot === "E" ? { ...c, channelOn: false } : c)));
    await W.writeChannelOn(m.api, 2, "E", true);
    expect(m.calls).toEqual([{ stationId: 2, slot: "E", patch: { channel_on: 1 } }]);
  });

  it("a failed write is reported, not swallowed", async () => {
    const api: W.DeckConfigsApi = { updateBySlot: async () => ({ ok: false, error: "boom" }) };
    await expect(W.writeChannelOn(api, 2, "D", false)).rejects.toThrow(/D.*boom/);
  });
});

describe("a whole-board save never writes channel_on", () => {
  it("the bulk row patch carries no channel_on", () => {
    expect(W.bulkRowPatch(row("E", { channelOn: false }))).not.toHaveProperty("channel_on");
    expect(W.bulkRowPatch(row("E", { channelOn: true }))).not.toHaveProperty("channel_on");
  });

  it("a stale window's Apply does not re-cut a channel another window turned ON", async () => {
    // Window 1 loaded the board while E was cut; window 2 then turned E on (the row now says ON).
    const stale = BOARD.map(c => (c.slot === "E" ? { ...c, channelOn: false } : c));
    const m = fakeMain(BOARD);                                   // the row: E ON
    const failed = await W.writeBoard(m.api, 2, stale);          // window 1 saves the whole board
    expect(failed).toEqual([]);
    expect(m.db.get("E")!.channel_on).toBe(1);                   // E is still ON
    expect(m.calls.some(c => "channel_on" in c.patch)).toBe(false);
  });

  it("a whole-board save still writes everything else (the patch point travels)", async () => {
    const m = fakeMain(BOARD);
    await W.writeBoard(m.api, 2, BOARD.map(c => (c.slot === "D" ? { ...c, kind: "jingle" as any, duck: true } : c)));
    expect(m.db.get("D")).toMatchObject({ kind: "jingle", duck: 1, enabled: 1, type: "source" });
    expect(m.calls.map(c => c.slot)).toEqual(BOARD.map(c => c.slot));
  });
});

// The renderer wiring (React hooks; no DOM in this suite, so pinned by source contract like electron/main.js).
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

describe("the board's ON lamp is wired to the single-row writer", () => {
  const fader = src("components/FaderSection.tsx");
  const body = (name: string) => {
    const i = fader.indexOf(`const ${name} = useCallback(`);
    expect(i).toBeGreaterThan(-1);
    return fader.slice(i, fader.indexOf("}, [", i));
  };

  it("onSetSourceChannelOn writes through setChannelOn, never the whole-board save", () => {
    const b = body("onSetSourceChannelOn");
    expect(b).toMatch(/setChannelOn\(slot, on\)/);
    expect(b).not.toMatch(/saveDeckConfigs/);
  });

  it("useDeckConfig exposes setChannelOn over update-by-slot (writeChannelOn)", () => {
    const dc = src("components/DeckConfigurator.tsx");
    expect(dc).toMatch(/const setChannelOn = [^;]*writeChannelOn\(/);
    expect(dc).toMatch(/return \{ configs, save, enabled, setChannelOn \}/);
  });

  it("the preload still exposes deck_configs:update-by-slot as deckConfigs.updateBySlot", () => {
    const pre = readFileSync(join(__dirname, "..", "..", "electron", "preload-handlers.js"), "utf8");
    expect(pre).toMatch(/updateBySlot:\s*\(stationId, slot, patch\)\s*=>\s*ipcRenderer\.invoke\('deck_configs:update-by-slot',\s*stationId, slot, patch\)/);
  });
});

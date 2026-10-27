// The board's "−" removes a source channel in one action, and it stays removed (2026-10-27).
// Jeff: "the "−" (Remove source channel) button does nothing for a source channel that has an input patched. Seen on
// ovowforestmusic: SOURCE G (Link input …) and SOURCE H (Park patch "park:N" …) can't be removed." src/lib/removeSourceChannel.ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { removeSourceChannel, removedSlots, type RemoveDeps } from "./removeSourceChannel";
import { boardSlots } from "./boardSlots";
import { linkNeedsPatch } from "./linkPairing";
import type { DeckConfig } from "../components/DeckConfigurator";

const row = (slot: string, extra: Partial<DeckConfig> = {}): DeckConfig =>
  ({ slot, type: slot <= "C" && slot.length === 1 ? "music" : "source", label: slot, color: "#000", enabled: true, kind: "", ...extra } as DeckConfig);
const BOARD = () => [row("A"), row("B"), row("C"), row("D", { kind: "announcement" as any }), row("G", { kind: "link" as any }), row("H", { kind: "mic" as any })];

// A fake machine: the stored rows, this machine's input patches, the Link input, and what the engine reports per slot.
function machine(configs: DeckConfig[], opts: { patches?: Record<string, { device: string }>; linkSlot?: string | null; live?: string[];
  refusePatch?: string; refuseLink?: string } = {}) {
  const m = {
    configs, patches: { ...(opts.patches || {}) }, linkSlot: opts.linkSlot ?? null, live: new Set(opts.live || []),
    calls: [] as string[], saves: 0,
    deps(slot: string): RemoveDeps {
      return {
        configs: m.configs,
        save: async (c) => { m.saves++; m.configs = c; },
        micPatch: m.patches[slot] ?? null,
        clearMicPatch: async () => { m.calls.push(`clearMicPatch ${slot}`); if (opts.refusePatch) return { ok: false, reason: opts.refusePatch };
          delete m.patches[slot]; if (m.linkSlot !== slot) m.live.delete(slot); return { ok: true }; },
        linkInputSlot: m.linkSlot,
        releaseLink: async () => { m.calls.push("releaseLink"); if (opts.refuseLink) return { ok: false, reason: opts.refuseLink };
          if (m.linkSlot) m.live.delete(m.linkSlot); m.linkSlot = null; return { ok: true }; },
        stopDeck: async () => { m.calls.push(`stopDeck ${slot}`); },
      };
    },
    // What every window's board shows: config order + the engine's live slots, minus what the operator removed.
    board(engineLive?: string[]) { return boardSlots(m.configs.filter(c => c.enabled).map(c => c.slot), engineLive ?? [...m.live], removedSlots(m.configs)); },
  };
  return m;
}

describe("removing a Link-patched channel (SOURCE G)", () => {
  it("is gone, the Link input is released, and it does not come back after a level update or a config reload", async () => {
    const m = machine(BOARD(), { linkSlot: "G", live: ["A", "B", "G"] });
    expect(m.board()).toContain("G");
    expect(await removeSourceChannel("G", m.deps("G"))).toEqual({ ok: true });
    expect(m.calls).toContain("releaseLink");
    expect(m.linkSlot).toBeNull();
    expect(m.board()).not.toContain("G");
    expect(m.board(["A", "B", "G"])).not.toContain("G");                    // a level frame that still reports G
    const reloaded = JSON.parse(JSON.stringify(m.configs));                 // the rows as re-read from the database
    expect(boardSlots(reloaded.filter((c: DeckConfig) => c.enabled).map((c: DeckConfig) => c.slot), ["G"], removedSlots(reloaded))).not.toContain("G");
  });
  it("the Link auto-patch never re-patches it: a removed (disabled) Link channel needs no patch", () => {
    const base = { isLink: true, cfgLoaded: true, daemon: true, slot: "G", inputSlot: null };
    expect(linkNeedsPatch({ ...base, enabled: true })).toBe(true);           // an enabled Link fader still patches itself
    expect(linkNeedsPatch({ ...base, enabled: false })).toBe(false);
  });
  it("the row is marked OFF BEFORE the Link is released, so no window can re-patch it in between", async () => {
    const m = machine(BOARD(), { linkSlot: "G", live: ["G"] });
    let rowAtRelease: DeckConfig | undefined;
    const d = m.deps("G");
    await removeSourceChannel("G", { ...d, releaseLink: async () => { rowAtRelease = m.configs.find(c => c.slot === "G"); return d.releaseLink(); } });
    expect(rowAtRelease?.enabled).toBe(false);
  });
});

describe("removing a Park-patched channel (SOURCE H, park:2)", () => {
  it("is gone, the patch is cleared, and nothing brings it back", async () => {
    const m = machine(BOARD(), { patches: { H: { device: "park:2" } }, live: ["A", "H"] });
    expect(await removeSourceChannel("H", m.deps("H"))).toEqual({ ok: true });
    expect(m.calls).toContain("clearMicPatch H");
    expect(m.patches.H).toBeUndefined();
    expect(m.board()).not.toContain("H");
    expect(m.board(["A", "H"])).not.toContain("H");
  });
  it("a Park page sync cannot re-assign it: the patch (mic_input_<slot>) is written ONLY by Ether's own mic:set, machine-local", () => {
    const root = path.join(__dirname, "..", "..");
    const files: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!["node_modules", "tests"].includes(e.name)) walk(p); }
      else if (/\.(js|ts|tsx)$/.test(e.name) && !/\.test\.|smoke-/.test(e.name)) files.push(p); } };
    for (const d of ["electron", "audiod", "src"]) walk(path.join(root, d));
    // any write of a mic_input_ key: SetLocal/Upsert with micKey(...) or a "mic_input_" literal
    const writers = files.filter(f => /stationConfigKv(SetLocal|Upsert\w*)\([^;\n]*(micKey\(|["'`]mic_input_)/.test(fs.readFileSync(f, "utf8")))
      .map(f => path.relative(root, f).split(path.sep).join("/"));
    expect(writers).toEqual(["electron/main.js"]);
    const main = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");
    const set = main.slice(main.indexOf('ipcMain.handle("mic:set"'), main.indexOf('ipcMain.handle("mic:state"'));
    expect(set).toMatch(/stationConfigKvSetLocal\(getDb\(\), sid, MicInput\.micKey\(slot\)/);
    expect(fs.readFileSync(path.join(root, "electron", "sync", "handlers", "station_config_kv.js"), "utf8"))
      .toMatch(/LOCAL_ONLY_PREFIXES = \[[^\]]*'mic_input_'/);                // it never syncs in from anywhere
  });
});

describe("removing a slot that has no config row", () => {
  it("is gone and stays gone — a row {slot, enabled:false} is added", async () => {
    const m = machine([row("A"), row("B"), row("C")], { live: ["A", "S3"] });
    expect(m.board()).toContain("S3");                                      // the engine carries it; the board made up a row
    expect(await removeSourceChannel("S3", m.deps("S3"))).toEqual({ ok: true });
    const r = m.configs.find(c => c.slot === "S3");
    expect(r).toMatchObject({ slot: "S3", enabled: false, type: "source" });
    expect(m.board(["A", "S3"])).not.toContain("S3");
  });
});

describe("removing an idle channel", () => {
  it("is unchanged: its row goes OFF, nothing is unpatched or released", async () => {
    const m = machine(BOARD(), { live: ["A"] });
    const before = JSON.parse(JSON.stringify(m.configs));
    expect(await removeSourceChannel("D", m.deps("D"))).toEqual({ ok: true });
    expect(m.configs).toEqual(before.map((c: DeckConfig) => (c.slot === "D" ? { ...c, enabled: false } : c)));   // what the old handler saved
    expect(m.calls).toEqual(["stopDeck D"]);
    expect(m.board()).not.toContain("D");
  });
  it("touches no other channel: another channel's Link and patches stay as they were", async () => {
    const m = machine(BOARD(), { linkSlot: "G", patches: { H: { device: "park:1" } }, live: ["A", "G", "H"] });
    await removeSourceChannel("D", m.deps("D"));
    expect(m.linkSlot).toBe("G");
    expect(m.patches.H).toEqual({ device: "park:1" });
    expect(m.calls).toEqual(["stopDeck D"]);
  });
});

describe("a refused step shows its reason — never a silent no-op", () => {
  it("the engine refuses to unpatch: the row is put back, the channel stays, and the reason says why", async () => {
    const m = machine(BOARD(), { patches: { H: { device: "park:2" } }, live: ["H"], refusePatch: "the engine did not take the patch" });
    const r = await removeSourceChannel("H", m.deps("H"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not removed — its input \(park:2\) could not be unpatched: the engine did not take the patch/);
    expect(m.configs.find(c => c.slot === "H")?.enabled).toBe(true);
    expect(m.board()).toContain("H");
  });
  it("the engine refuses to release the Link: the same", async () => {
    const m = machine(BOARD(), { linkSlot: "G", live: ["G"], refuseLink: "no answer from the engine" });
    const r = await removeSourceChannel("G", m.deps("G"));
    expect(r).toEqual({ ok: false, reason: "not removed — the Link input could not be released: no answer from the engine" });
    expect(m.board()).toContain("G");
  });
  it("the board shows that reason on the channel", () => {
    const fs_ = fs.readFileSync(path.join(__dirname, "..", "components", "FaderSection.tsx"), "utf8");
    expect(fs_).toMatch(/if \(!r\.ok\) \{[^\n]*setRemoveErr\(prev => \(\{ \.\.\.prev, \[slot\]: r\.reason/);
    expect(fs_).toMatch(/removeError=\{removeErr\[slot\] \|\| null\}/);
    expect(fs.readFileSync(path.join(__dirname, "..", "components", "SourceChannelStrip.tsx"), "utf8"))
      .toMatch(/\{removeError && <div style=\{\{ fontSize: 8, color: TONE\.bad \}\}>⚠ \{removeError\}<\/div>\}/);
  });
});

describe("the board uses it", () => {
  it("FaderSection's remove button calls removeSourceChannel, and both boards drop removed slots", () => {
    const fs_ = fs.readFileSync(path.join(__dirname, "..", "components", "FaderSection.tsx"), "utf8");
    expect(fs_).toMatch(/const r = await removeSourceChannel\(slot, \{/);
    expect(fs_).toMatch(/boardSlots\(configuredOrder as any, engineSlots, removedSlots\(deckConfigs\)\)/);
    expect(fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8")).toMatch(/boardSlots\(configuredOrder, engineSlots, removedSlots\(deckConfigs\)\)/);
    expect(fs.readFileSync(path.join(__dirname, "..", "components", "SourceChannelStrip.tsx"), "utf8")).toMatch(/linkNeedsPatch\(\{ isLink, enabled: config\.enabled,/);
  });
  it("the CART rule still holds: a live slot the config does not mention is always on the board", () => {
    expect(boardSlots(["A", "B", "C"], ["A", "CART"], ["G"])).toContain("CART");
  });
});

// THE A/B/C VIEW (Jeff, 2026-10-28): collapsed into one strip that is the playing deck's own fader, or expanded; never a
// level or what plays; saved per computer and in show presets.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { shownDeck, viewOrder, parseDecksView, COLLAPSED_SLOT, BOARD_VIEW_KEY } from "./deckView";

const require = createRequire(import.meta.url);
const S = require("../../audiod/show-presets.js");
const KV = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "sync", "handlers", "station_config_kv.js"), "utf8");
const FS = fs.readFileSync(path.join(__dirname, "..", "components", "FaderSection.tsx"), "utf8");
const idle = { A: "idle", B: "idle", C: "idle" } as const;

describe("which deck the collapsed strip shows", () => {
  it("A plays → A; B starts (crossfade, A still playing) → B; then C; then back to A", () => {
    let shown = shownDeck(null, idle, { A: "playing", B: "idle", C: "idle" });
    expect(shown).toBe("A");
    shown = shownDeck(shown, { A: "playing", B: "idle", C: "idle" }, { A: "playing", B: "playing", C: "idle" });
    expect(shown).toBe("B");
    shown = shownDeck(shown, { A: "playing", B: "playing", C: "idle" }, { A: "idle", B: "playing", C: "idle" });
    expect(shown).toBe("B");
    shown = shownDeck(shown, { A: "idle", B: "playing", C: "idle" }, { A: "idle", B: "playing", C: "playing" });
    expect(shown).toBe("C");
    shown = shownDeck(shown, { A: "idle", B: "playing", C: "playing" }, { A: "playing", B: "idle", C: "playing" });
    expect(shown).toBe("A");
  });
  it("nothing playing keeps the last deck; the shown deck stopped while another plays → that one", () => {
    expect(shownDeck("C", idle, idle)).toBe("C");
    expect(shownDeck("A", { A: "playing", B: "playing", C: "idle" }, { A: "idle", B: "playing", C: "idle" })).toBe("B");
  });
});

describe("the board's order", () => {
  it("collapsed: A, B and C become one strip where A was; the rest unchanged", () => {
    expect(viewOrder(["A", "B", "C", "D", "S1"], "collapsed")).toEqual([COLLAPSED_SLOT, "D", "S1"]);
    expect(viewOrder(["A", "B", "C", "D", "S1"], "expanded")).toEqual(["A", "B", "C", "D", "S1"]);
  });
  it("anything but 'collapsed' is expanded (the board as it has always been)", () => {
    expect(parseDecksView(null)).toBe("expanded");
    expect(parseDecksView("collapsed")).toBe("collapsed");
  });
});

describe("collapsing never changes a level or what plays", () => {
  it("all three deck strips stay mounted; only which one is visible changes", () => {
    expect(FS).toMatch(/\{DECKS\.map\(d => \(\s*<div key=\{d\} data-decks-face=\{d\}[\s\S]{0,200}display: d === shown \? "flex" : "none"[\s\S]{0,40}\{renderSlot\(d\)\}/);
  });
  it("the two view buttons only set the view", () => {
    expect(FS).toMatch(/onClick=\{\(\) => setDecksView\("expanded"\)\}/);
    expect(FS).toMatch(/onClick=\{\(\) => setDecksView\("collapsed"\)\}/);
    const hook = fs.readFileSync(path.join(__dirname, "..", "hooks", "useDecksView.ts"), "utf8");
    expect(hook).not.toMatch(/setVolume|audio\.|deckCrossfade|deckOff|play\(/);
  });
});

describe("saved per computer, and in show presets", () => {
  it("the setting is this computer's (local-only, never synced)", () => {
    expect(BOARD_VIEW_KEY).toBe(S.BOARD_VIEW_KEY);
    expect(KV).toMatch(/LOCAL_ONLY_PREFIXES = \[[^\]]*'board_view_'/);
  });
  it("Save takes the view into the preset; a preset survives the whitelist with it", () => {
    const get = (k: string) => (k === BOARD_VIEW_KEY ? "collapsed" : undefined);
    const p = S.snapshotBoard({ name: "Morning", stationUuid: "u", deckConfigs: [], get, levels: {} });
    expect(p.board.view).toEqual({ decks: "collapsed" });
    expect(S.sanitizePreset(p).stripped).toEqual([]);
    expect(S.sanitizePreset({ ...p, board: { ...p.board, view: { decks: "sideways" } } }).stripped).toContain("board.view (not collapsed / expanded)");
  });
  it("a Take of the preset sets it on this computer (a local write), never as a synced key", () => {
    const preset = { v: 1, name: "Morning", stationUuid: "u", board: { channels: {}, master: {}, view: { decks: "collapsed" } } };
    const plan = S.planStoreWrites(S.storeWrites(preset, [], true), () => undefined);
    expect(plan.local).toEqual([[BOARD_VIEW_KEY, "collapsed"]]);
    expect(plan.kv.map(([k]: [string]) => k)).not.toContain(BOARD_VIEW_KEY);
  });
  it("a channel landing on OFF later (not the Take) does not touch the view", () => {
    const preset = { v: 1, name: "Morning", stationUuid: "u", board: { channels: {}, master: {}, view: { decks: "expanded" } } };
    expect(S.planStoreWrites(S.storeWrites(preset, [], false), () => undefined).local).toEqual([]);
  });
  it("main writes the preset's view locally and tells every board", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "main.js"), "utf8");
    expect(main).toMatch(/for \(const \[key, value\] of plan\.local \|\| \[\]\) \{\s*try \{ require\("\.\/sync\/handlers\/station_config_kv"\)\.stationConfigKvSetLocal\(db, sid, key, value\); _boardViewChanged\(sid, value\); \}/);
  });
});

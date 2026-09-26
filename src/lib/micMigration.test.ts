import { describe, it, expect } from "vitest";
import { migrateMicDecks, matchDeviceLabel } from "./micMigration";
import type { DeckConfig } from "../components/DeckConfigurator";

const row = (slot: string, type: any, extra: Partial<DeckConfig> = {}): DeckConfig =>
  ({ slot, type, label: "", color: "#888", enabled: true, purpose: "", kind: "" as any, address: null, duck: false, channelOn: true, ...extra } as DeckConfig);

// docs/dsp-mic-in-engine.md §3 — the mic moves into the engine without stranding anyone.
describe("migrateMicDecks", () => {
  it("a mic on a source slot stays there, re-typed as a source patched to mic", () => {
    const { next, moves } = migrateMicDecks([row("A", "music"), row("E", "mic", { label: "HOST" })]);
    expect(next.find(c => c.slot === "E")).toMatchObject({ type: "source", kind: "mic", label: "HOST", enabled: true });
    expect(moves).toEqual([{ from: "E", to: "E" }]);
  });

  it("the dedicated 'mic' slot moves to the first free source slot; the old row is disabled, not deleted", () => {
    const { next, moves } = migrateMicDecks([row("A", "music"), row("B", "music"), row("C", "music"), row("D", "source", { kind: "jukebox" as any }), row("mic", "mic")]);
    expect(moves).toEqual([{ from: "mic", to: "E" }]);
    expect(next.find(c => c.slot === "E")).toMatchObject({ type: "source", kind: "mic", label: "MIC", enabled: true });
    expect(next.find(c => c.slot === "mic")).toMatchObject({ enabled: false });
    expect(next.find(c => c.slot === "D")).toMatchObject({ kind: "jukebox" });   // an occupied slot is never taken
  });

  it("with no free source slot the mic is LEFT AS IT WAS and reported — never silently dropped", () => {
    const full = ["D", "E", "F", "S1", "S2", "S3", "S4", "S5"].map(s => row(s, "source", { kind: "announcement" as any }));
    const { next, moves } = migrateMicDecks([...full, row("mic", "mic")]);
    expect(moves).toEqual([{ from: "mic", to: null }]);
    expect(next.find(c => c.slot === "mic")).toMatchObject({ type: "mic", enabled: true });
  });

  it("two mics get two different slots; a board with no mic is unchanged", () => {
    const { moves } = migrateMicDecks([row("mic", "mic"), row("C", "mic")]);
    expect(moves.map(m => m.to).sort()).toEqual(["D", "E"]);
    const plain = [row("A", "music"), row("D", "source")];
    expect(migrateMicDecks(plain)).toEqual({ next: plain, moves: [] });
  });
});

describe("matchDeviceLabel", () => {
  const names = ["Microphone (Shure MV7)", "Line In (Focusrite USB (2- 2i2))", "Microphone (Realtek(R) Audio)"];
  it("matches a browser label to the engine name, ignoring the USB id and the Default/Communications prefix", () => {
    expect(matchDeviceLabel("Microphone (Shure MV7) (14ed:1012)", names)).toBe("Microphone (Shure MV7)");
    expect(matchDeviceLabel("Default - Microphone (Realtek(R) Audio)", names)).toBe("Microphone (Realtek(R) Audio)");
    expect(matchDeviceLabel("Communications - Line In (Focusrite USB (2- 2i2)) (1235:8210)", names)).toBe("Line In (Focusrite USB (2- 2i2))");
  });
  it("no confident match → null (never a guess: a wrong mic on air is worse than none)", () => {
    expect(matchDeviceLabel("Microphone (Blue Yeti)", names)).toBeNull();
    expect(matchDeviceLabel("", names)).toBeNull();
    expect(matchDeviceLabel("Microphone (X)", ["Microphone (X)", "microphone (x)"])).toBeNull();
  });
});

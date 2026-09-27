import { describe, it, expect } from "vitest";
import { boardName, boardNames, DEFAULT_BOARD_ORDER } from "./boardName";

describe("one name per fader — the board letter", () => {
  it("S1 is G on the default board (A–F, CART, S1–S5), and S1–S5 are G–K", () => {
    expect(boardName("S1")).toBe("G");
    expect(["S1", "S2", "S3", "S4", "S5"].map(s => boardName(s, DEFAULT_BOARD_ORDER))).toEqual(["G", "H", "I", "J", "K"]);
    expect(boardName("D")).toBe("D");
    expect(boardName("CART")).toBe("CART");
  });

  it("follows deck_configs when the board's order changes", () => {
    // a board that lists S2 before S1 names them in that order
    expect(boardNames(["A", "B", "C", "D", "E", "F", "S2", "S1"])).toMatchObject({ S2: "G", S1: "H" });
    // A–F are reserved even where this board has no row for them: S1 never takes E (it would collide the day E is
    // added). This used to expect S1 → E — the same "name it on its own" rule that produced G H I J J.
    expect(boardNames(["A", "B", "C", "D", "S1", "S2"])).toMatchObject({ S1: "G", S2: "H" });
  });

  it("never gives two faders the same name, and never shows an engine id", () => {
    const n = boardNames(["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"]);
    const names = Object.values(n);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some(x => /^S\d/.test(x))).toBe(false);
  });

  it("a slot the order doesn't list is named from the completed order — never on its own", () => {
    expect(boardName("S3", ["A", "B", "C"])).toBe("I");
    expect(boardName("S4", ["A", "B", "C"])).not.toBe(boardName("S5", ["A", "B", "C"]));
  });
});

// REGRESSION (Jeff's screen, 2026-09-26): the rack tab row read "G H I J J". Real deck_configs shapes from this
// machine — gaps (no CART / S4 / S5 rows) and disabled rows — must never produce two faders with one name.
describe("one name per fader — real deck_configs shapes", () => {
  const ENGINE = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"];
  // [slot, enabled] exactly as station 2 (halloVeen) stores them: no CART, S4 or S5 row; F and S2/S3 disabled.
  const halloVeen = ["A", "B", "C", "D", "E", "F", "S1", "S2", "S3"];
  const openFormat = ["A", "B", "C", "D", "E", "F", "S1", "S2"];
  const legacy = ["A", "B", "C", "D", "E", "F"];   // stations 3/4/9: no source slots at all
  for (const [name, rows] of [["halloVeen", halloVeen], ["Open Format", openFormat], ["legacy (no S rows)", legacy], ["empty", []]] as const) {
    it(`${name}: all 12 engine slots get 12 different names, none an engine id`, () => {
      const names = ENGINE.map(s => boardName(s, rows as readonly string[]));
      expect(new Set(names).size).toBe(12);
      expect(names.some(n => /^S\d/.test(n))).toBe(false);
    });
  }
  it("halloVeen's rack tab row reads G H I J K for S1–S5 (it read G H I J J)", () => {
    expect(["S1", "S2", "S3", "S4", "S5"].map(s => boardName(s, halloVeen))).toEqual(["G", "H", "I", "J", "K"]);
  });
});

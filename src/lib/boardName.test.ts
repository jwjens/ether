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
    // a board with no E/F rows: the first source slot takes the first free letter
    expect(boardNames(["A", "B", "C", "D", "S1", "S2"])).toMatchObject({ S1: "E", S2: "F" });
    // a board that lists S2 before S1 names them in that order
    expect(boardNames(["A", "B", "C", "S2", "S1"])).toMatchObject({ S2: "D", S1: "E" });
  });

  it("never gives two faders the same name, and never shows an engine id", () => {
    const n = boardNames(["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"]);
    const names = Object.values(n);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some(x => /^S\d/.test(x))).toBe(false);
  });

  it("a slot the order doesn't list is named as if it came last", () => {
    expect(boardName("S3", ["A", "B", "C"])).toBe("D");
  });
});

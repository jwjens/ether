import { describe, it, expect } from "vitest";
import { boardSlots } from "./boardSlots";

// THE CONSTRAINT. Everything else in this arc can drift back; this is what makes "on air but
// invisible" fail a test instead of shipping. docs/on-air-but-invisible-slot-enumeration-2026-09-03.md
describe("boardSlots — a slot the engine carries is always on the board", () => {
  it("puts every live engine slot on the board, even with no config row", () => {
    // The real case: CART has no deck_configs row and never had one.
    const board = boardSlots(["A", "B", "C", "D"], ["A", "B", "C", "CART"]);
    for (const id of ["A", "B", "C", "CART"]) expect(board).toContain(id);
  });

  it("holds for EVERY engine slot id, whatever the configuration says", () => {
    const engine = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"];
    for (const configured of [[], ["A"], ["A", "B", "C"], ["D", "E", "F"], ["S5"]]) {
      const board = boardSlots(configured, engine);
      for (const id of engine) {
        expect(board, `engine slot ${id} missing from the board for config ${JSON.stringify(configured)}`)
          .toContain(id);
      }
    }
  });

  it("keeps the operator's order and appends what the config did not mention", () => {
    expect(boardSlots(["C", "A", "B"], ["A", "B", "C", "CART"])).toEqual(["C", "A", "B", "CART"]);
  });

  it("never renders a slot twice", () => {
    const board = boardSlots(["A", "A", "B"], ["B", "B", "CART", "CART"]);
    expect(board).toEqual(["A", "B", "CART"]);
    expect(new Set(board).size).toBe(board.length);
  });

  it("shows a configured slot the engine is not carrying — config still decides the console", () => {
    // An enabled channel with nothing loaded keeps its strip; the engine's list only ADDS.
    expect(boardSlots(["A", "B", "C", "F"], ["A"])).toContain("F");
  });

  it("an idle engine slot nobody configured stays off the board", () => {
    // engineLive is already filtered to slots carrying audio, so this is the caller's contract:
    // the board does not sprout twelve empty strips.
    expect(boardSlots(["A", "B"], [])).toEqual(["A", "B"]);
  });
});

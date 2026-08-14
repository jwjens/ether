// Finding the active station inside the health snapshot.
//
// This failed silently and totally on 2026-08-13: the Runway card read "— no active show" while the
// chart beside it read 17.1d for the same station at the same moment, and Rotation Goals said "no
// categories" when the station had two. The snapshot was correct throughout — the lookup simply did
// not match, so every card fell back to unknown.
import { describe, it, expect } from "vitest";
import { stationFrom, designationFor } from "./healthData";

const snap = {
  stations: [
    { stationId: 1, name: "Open Format", runway: { days: 24.1, hours: null } },
    { stationId: 2, name: "halloVeen", runway: { days: 17.1, hours: null } },
  ],
} as any;

describe("stationFrom", () => {
  it("finds the station by id", () => {
    expect(stationFrom(snap, 2)?.name).toBe("halloVeen");
  });

  it("MATCHES ACROSS TYPES — 2 and \"2\" are the same station", () => {
    // The snapshot is built in the main process where ids are SQLite INTEGERs; the renderer's id has
    // travelled through IPC and app state. `2 === "2"` is false, and the failure is invisible: the
    // panel renders every card as unknown while the data sits right there in the snapshot.
    expect(stationFrom(snap, "2" as any)?.name).toBe("halloVeen");
    expect(stationFrom({ stations: [{ stationId: "2", name: "halloVeen" }] } as any, 2)?.name).toBe("halloVeen");
  });

  it("returns null rather than the WRONG station", () => {
    expect(stationFrom(snap, 99)).toBe(null);
  });

  it("never matches on null or undefined", () => {
    // Otherwise a not-yet-resolved station id would silently adopt whichever station sorted first.
    expect(stationFrom(snap, null)).toBe(null);
    expect(stationFrom(snap, undefined)).toBe(null);
    expect(stationFrom({ stations: [{ stationId: null, name: "X" }] } as any, null as any)).toBe(null);
  });

  it("survives a missing or malformed snapshot", () => {
    expect(stationFrom(null, 2)).toBe(null);
    expect(stationFrom({} as any, 2)).toBe(null);
    expect(stationFrom({ stations: "nope" } as any, 2)).toBe(null);
  });
});

describe("designationFor", () => {
  const rows = [{ stationId: 1, state: "mine" }, { stationId: 2, state: "other" }] as any;

  it("finds by id, across types", () => {
    expect(designationFor(rows, 2)?.state).toBe("other");
    expect(designationFor(rows, "2" as any)?.state).toBe("other");
  });

  it("returns null for an unknown or absent id", () => {
    expect(designationFor(rows, 99)).toBe(null);
    expect(designationFor(rows, null)).toBe(null);
    expect(designationFor([], 1)).toBe(null);
  });
});

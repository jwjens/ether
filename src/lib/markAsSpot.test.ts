// fix 10 (docs/help-audit-2026-09-27.md): "Mark as Spot" on a deck or in Up Next (the shared song menu) only flipped
// content_class — no category dialog and no spots record, so a break could never pull it. It now opens the same
// dialog the Library uses, and both confirm through one function (markAsSpot) that tags the track AND creates the
// spots record in the chosen category. Driven here against a fake `ether` that records every write.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { markAsSpot } from "./markAsSpot";

function fakeEther() {
  const calls: { op: string; args: any[] }[] = [];
  const ether = {
    songs: { updateById: async (...a: any[]) => { calls.push({ op: "songs.updateById", args: a }); return { ok: true }; } },
    spots: { create: async (...a: any[]) => { calls.push({ op: "spots.create", args: a }); return { ok: true }; } },
    spotCategories: { create: async (...a: any[]) => { calls.push({ op: "spotCategories.create", args: a }); return { ok: true, row: { id: 77 } }; } },
    audio: { getFileDuration: async () => 29.6 },
  };
  return { ether, calls };
}
const song = { id: 12, title: "Acme :30", file_path: "C:/audio/acme30.mp3" };

describe("Mark as Spot creates the record a break pulls (audit 10)", () => {
  it("existing category: tags SPOT and creates the spot in that category with the real length", async () => {
    const { ether, calls } = fakeEther();
    const r = await markAsSpot(ether, { stationId: 3, song, catId: 5, newCat: "", type: "commercial" });
    expect(r.ok).toBe(true);
    expect(calls.find(c => c.op === "songs.updateById")!.args).toEqual([12, { content_class: "SPOT" }]);
    expect(calls.find(c => c.op === "spots.create")!.args[0]).toMatchObject({
      station_id: 3, title: "Acme :30", file_path: "C:/audio/acme30.mp3", spot_type: "commercial", spot_category_id: 5, is_active: 1, length_sec: 30,
    });
  });
  it("new category name: creates the category first and files the spot in it", async () => {
    const { ether, calls } = fakeEther();
    await markAsSpot(ether, { stationId: 3, song, catId: null, newCat: " Local Sponsors ", type: "promo" });
    expect(calls[0]).toEqual({ op: "spotCategories.create", args: [{ station_id: 3, name: "Local Sponsors", color: "#fbbf24" }] });
    expect(calls.find(c => c.op === "spots.create")!.args[0]).toMatchObject({ spot_category_id: 77, spot_type: "promo" });
  });
  it("no category: writes nothing", async () => {
    const { ether, calls } = fakeEther();
    const r = await markAsSpot(ether, { stationId: 3, song, catId: null, newCat: "", type: "commercial" });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
  it("the shared song menu opens the dialog instead of only flipping the class; the Library uses the same dialog", () => {
    const menu = fs.readFileSync(path.join(__dirname, "songActions.tsx"), "utf8");
    expect(menu).not.toMatch(/setClass\(cls === "SPOT" \? "MUSIC" : "SPOT"\)/);
    expect(menu).toMatch(/<SpotMarkDialog/);
    const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    expect(app).toMatch(/<SpotMarkDialog/);
    expect(app).not.toMatch(/const confirmSpotMark/);
  });
});

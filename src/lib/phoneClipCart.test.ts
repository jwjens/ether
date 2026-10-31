// Phone Desk (dead-controls item 4): send to CART reached no listener; the input list asked a handler that doesn't exist.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstEmptyCartSlot, sendClipToCart } from "./phoneClipCart";

const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
const deps = (rows: any[], over: any = {}) => ({
  stationId: 3, total: 4,
  list: vi.fn(async () => ({ rows })),
  importIntoLibrary: vi.fn(async () => "D:/Catalogue/phone_clip.wav"),
  upsert: vi.fn(async () => ({ ok: true })),
  notify: vi.fn(),
  ...over,
});

describe("Phone Desk → CART", () => {
  it("the first cart with no audio", () => {
    expect(firstEmptyCartSlot([{ slot_number: 0, file_path: "a" }, { slot_number: 1, file_path: "" }], 4)).toBe(1);
    expect(firstEmptyCartSlot([], 4)).toBe(0);
    expect(firstEmptyCartSlot([0, 1, 2, 3].map(i => ({ slot_number: i, file_path: "x" })), 4)).toBeNull();
  });
  it("copies the clip into the catalogue and writes that path to the cart, then tells the wall", async () => {
    const d = deps([{ slot_number: 0, file_path: "a.mp3" }]);
    const r = await sendClipToCart("C:/AppData/phone-recordings/phone_clip.wav", "Phone Clip 3:15", d);
    expect(r).toMatchObject({ ok: true, slot: 1 });
    expect(d.upsert).toHaveBeenCalledWith(3, 1, { title: "Phone Clip 3:15", file_path: "D:/Catalogue/phone_clip.wav" });
    expect(d.notify).toHaveBeenCalled();
  });
  it("a full wall is said, and nothing is overwritten", async () => {
    const d = deps([0, 1, 2, 3].map(i => ({ slot_number: i, file_path: "x" })));
    const r = await sendClipToCart("c.wav", "t", d);
    expect(r.ok).toBe(false);
    expect(d.upsert).not.toHaveBeenCalled();
  });
  it("Phone Desk uses it (no dead event), the wall reloads on it, and the input list is the browser's", () => {
    const pd = read("src/components/PhoneDesk.tsx");
    expect(pd).not.toMatch(/CustomEvent\("ether:phone-clip"/);
    expect(pd).toMatch(/await toCart\(filePath, title\)/);
    expect(pd).not.toMatch(/invoke<AudioDevice\[\]>\("get_audio_devices"\)/);
    expect(read("src/components/DeckConfigurator.tsx")).toMatch(/addEventListener\("ether:cart-slots-changed"/);
  });
});

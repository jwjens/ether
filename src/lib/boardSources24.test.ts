// Board sources (dead-controls item 24): the GUEST strip's meter is fed, and the Announcement source says what it does.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guestSlot, guestLevelFrom } from "./guestLevel";
import { sourceKindMeta } from "./sourceKinds";

const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

describe("GUEST strip meter", () => {
  it("guest n reports on the slot the strip's ON and fader already use (E, F, …)", () => {
    expect(guestSlot(0)).toBe("E");
    expect(guestSlot(1)).toBe("F");
  });
  it("level is the guest's audio, 0..1; a muted guest reads 0", () => {
    expect(guestLevelFrom(new Uint8Array(128), false)).toBe(0);
    expect(guestLevelFrom(new Uint8Array(128).fill(64), false)).toBeCloseTo(0.5);
    expect(guestLevelFrom(new Uint8Array(128).fill(255), false)).toBe(1);
    expect(guestLevelFrom(new Uint8Array(128).fill(64), true)).toBe(0);
  });
  it("Show+'s guest layer sends it to every window, and main relays it", () => {
    expect(read("src/components/ShowPlus.tsx")).toMatch(/dispatchCrossWindow\("ether:guest-level", \{ slot: m\.slot, level: guestLevelFrom\(m\.buf, m\.muted\) \}\)/);
    expect(read("electron/main.js")).toMatch(/UI_BROADCAST_ALLOWED = new Set\(\[[^\]]*"ether:guest-level"/);
    expect(read("src/components/FaderSection.tsx")).toMatch(/addEventListener\("ether:guest-level"/);
  });
});

describe("Announcement source", () => {
  it("no longer says nothing fires — announcements air on a channel dialled to Announcement", () => {
    const s = sourceKindMeta("announcement")!.state;
    expect(s).not.toMatch(/nothing fires/);
    expect(s).toMatch(/Announcements air on this channel/);
    expect(read("electron/main.js")).toMatch(/AND type = 'source' AND kind = 'announcement'/);
  });
});

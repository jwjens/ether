// The listen-live address is built in ONE place and both Settings → Broadcast and Stream Manager show it (Jeff, 2026-10-31).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { listenerPageUrl, LISTENER_BASE_URL } from "./listenerPage";

describe("the station's listen-live page", () => {
  it("is an address only when the page is turned on and has one", () => {
    expect(listenerPageUrl({ public_enabled: true, slug: "halloveen" })).toBe(`${LISTENER_BASE_URL}/halloveen`);
    expect(listenerPageUrl({ public_enabled: false, slug: "halloveen" })).toBe(null);
    expect(listenerPageUrl({ public_enabled: true, slug: "  " })).toBe(null);
    expect(listenerPageUrl(null)).toBe(null);
  });
  it("Settings and Stream Manager both read it from here", () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", "components", f), "utf8");
    for (const f of ["SettingsPanel.tsx", "StreamManager.tsx"]) {
      expect(read(f), f).toMatch(/listenerPageUrl\(/);
      expect(read(f), f).not.toMatch(/listen\.ether-technologies\.com"/);
    }
  });
});

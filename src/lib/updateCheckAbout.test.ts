// Item 28: Help → Check for Updates said nothing when up to date and the card never came back after "Later".
// Item 29: About said "free, open-source" and What's New was a stale hard-coded "1.5.2 March 2026" list.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
describe("Check for Updates answers", () => {
  it("the menu check is manual: card un-dismissed, up to date / couldn't check is said", () => {
    const u = read("components/Updater.tsx");
    expect(read("App.tsx")).toMatch(/updater\.checkForUpdate\?\.\(true\)/);
    expect(u).toMatch(/if \(manual\) \{ setDismissed\(false\);/);
    expect(u).toMatch(/is up to date\./);
    expect(read("../electron/main.js")).toMatch(/return \{ available: false, current, error:/);
  });
});
describe("About is truthful", () => {
  it("no 'free, open-source'; What's New reads this version's real release notes", () => {
    const a = read("components/AboutPanel.tsx");
    expect(a).not.toMatch(/free, open-source/);
    expect(a).not.toMatch(/const CHANGELOG/);
    expect(a).toMatch(/invoke\("updater:release-notes-of", version\)/);
  });
});

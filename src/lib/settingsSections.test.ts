// Remote Link, Jukebox, Park page and Audio Devices each have their own section in Settings (Jeff, 2026-10-28: "let make
// remote its own section under settings", "jukebox as well", "park page its own menu under settings as well as audio
// devices"). Each section's content moved as it was; only its menu entry is new.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SP = fs.readFileSync(path.join(__dirname, "..", "components", "SettingsPanel.tsx"), "utf8");
const menu = (id: string, label: string) => new RegExp(String.raw`\{ id: "${id}",\s+label: "${label}",`);
const section = (cat: string, title: string) => new RegExp(String.raw`category="${cat}"[\s\S]{0,400}?title="${title}"`);

describe("Settings: Remote Link, Jukebox, Park Page and Audio Devices are their own sections", () => {
  it("each has a menu entry", () => {
    expect(SP).toMatch(menu("remote", "Remote Link"));
    expect(SP).toMatch(menu("jukebox", "Jukebox"));
    expect(SP).toMatch(menu("park", "Park Page"));
    expect(SP).toMatch(menu("devices", "Audio Devices"));
  });
  it("each section lives under its own entry", () => {
    expect(SP).toMatch(section("remote", "Remote Link"));
    expect(SP).toMatch(section("jukebox", "Jukebox"));
    expect(SP).toMatch(section("park", "Park page — Listen"));
    expect(SP).toMatch(section("park", "Park page — Hold to talk"));
    expect(SP).toMatch(section("devices", "Audio Devices"));
  });
  it("the board's Remote Link doors open the Remote Link section", () => {
    const rl = fs.readFileSync(path.join(__dirname, "..", "hooks", "useRemoteLink.ts"), "utf8");
    expect(rl).toMatch(/detail: \{ category: "remote" \}/);
    expect(rl).toMatch(/`remote:\$\{Date\.now\(\)\}`/);
  });
});

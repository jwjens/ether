// fix 22 (docs/help-audit-2026-09-27.md): Backup & Restore contradicted itself — the one switch said "Your setup and
// your audio, both directions", while Audio transfer (and the help, docs/help-backup-and-restore.md) says audio comes
// down on its own and goes up only when you press "Send just the audio". The switch's sentence now says the same.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("the backup switch doesn't promise audio goes up on its own (audit 22)", () => {
  it("the switch sentence names the manual send", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "components", "SettingsPanel.tsx"), "utf8");
    const at = src.indexOf('aria-label="Keep my stuff synced"');
    const sentence = src.slice(src.lastIndexOf("<div style={{ minWidth: 240", at), at);
    expect(sentence.length).toBeGreaterThan(50);
    expect(sentence).not.toMatch(/your audio, both directions/);
    expect(sentence).toMatch(/Send just the audio/);
  });
});

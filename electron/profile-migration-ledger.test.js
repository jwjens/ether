// fix 21 (docs/help-audit-2026-09-27.md): a refused / failed profile migration was written only to the console —
// nothing an operator can see (profile:list carries it but nothing calls profile:list). It now becomes a line in the
// health ledger (health-events.jsonl), which the Health Monitor's timeline already reads (health:recent-events), as a
// red "profile-migration-failed" event carrying the reason.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
const { migrationLedgerEvent } = require("./profile-migrate");
import { eventLevel } from "../src/components/health/healthUtils";

describe("a failed profile migration reaches the Health Monitor (audit 21)", () => {
  it("refused → a red ledger event with the reason; anything else → no event", () => {
    const e = migrationLedgerEvent({ status: "refused", reason: "legacy DB is locked" });
    expect(e).toEqual({ kind: "profile-migration-failed", reason: "legacy DB is locked" });
    expect(eventLevel(e.kind)).toBe("red");
    for (const st of ["not-run", "migrated", "already", "nothing-to-migrate"]) expect(migrationLedgerEvent({ status: st })).toBeNull();
    expect(migrationLedgerEvent(null)).toBeNull();
  });
  it("main.js writes it to the ledger once the profile is resolved", () => {
    const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
    const resolved = main.indexOf("const ACTIVE_PROFILE = P.resolveActive(");
    const write = main.indexOf("migrationLedgerEvent(PROFILE_MIGRATION)");
    expect(resolved).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(resolved);
    expect(main.slice(write, write + 300)).toMatch(/_healthEvent\(/);
  });
});

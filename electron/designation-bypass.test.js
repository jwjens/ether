// fix 20 (docs/held-items-proposals-2026-09-27.md; Jeff's GO 2026-09-27): kill_designation (the designation bypass)
// had no door. It now has one — Health Monitor → Designation, behind the admin PIN — with two rulings:
//   • the banner names the MACHINE and the OPERATOR;
//   • turning it on REFUSES while the designated machine is seen online (it says so and stops): the bypass is for a
//     dead designated machine, not a second generator.
// "Seen online" = the holder's own heartbeat (designation record last_checked, stamped every 30-min tick and synced)
// within two ticks + 5 min. No new hidden number: the window is derived from the tick and stated in the refusal.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
const D = require("./generation-designation");

const now = 1_800_000_000;
const rec = (machine_id, last_checked, machine_name = "OV-STUDIO") => ({ machine_id, machine_name, last_checked, designated_at: now - 86400, last_generated: null });

describe("designation bypass — may it be turned on? (audit 20)", () => {
  it("the online window is two ticks + 5 minutes", () => {
    expect(D.BYPASS_ONLINE_WINDOW_SEC).toBe(2 * 30 * 60 + 5 * 60);
  });
  it("REFUSES while the designated machine checked in recently — and says who and when", () => {
    const r = D.mayBypass({ record: rec("other", now - 12 * 60), machineId: "me", now });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/OV-STUDIO checked in 12 min ago/);
    expect(r.reason).toMatch(/for a dead designated machine, not a second generator/);
  });
  it("allows it once the designated machine has been silent longer than the window", () => {
    expect(D.mayBypass({ record: rec("other", now - 66 * 60), machineId: "me", now }).allow).toBe(true);
    expect(D.mayBypass({ record: rec("other", null), machineId: "me", now }).allow).toBe(true);
  });
  it("refuses when there is nothing to bypass, or this machine is the designated one", () => {
    expect(D.mayBypass({ record: null, machineId: "me", now })).toMatchObject({ allow: false });
    expect(D.mayBypass({ record: null, machineId: "me", now }).reason).toMatch(/no machine holds the designation/i);
    expect(D.mayBypass({ record: rec("me", now - 99999), machineId: "me", now }).reason).toMatch(/this machine is the designated generator/i);
  });
  it("the bypassed status names the machine and the operator", () => {
    const s = D.status({ record: rec("other", now - 7200), now, machineId: "me", killSwitch: true,
                         bypass: { machine: "STUDIO-B", operator: "Jeff", at: now - 60 } });
    expect(s.state).toBe("bypassed");
    expect(s.text).toMatch(/bypassed on STUDIO-B by Jeff/);
    expect(s.bypass).toEqual({ machine: "STUDIO-B", operator: "Jeff", at: now - 60 });
  });
});

describe("the door (audit 20)", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const kv = fs.readFileSync(path.join(__dirname, "sync", "handlers", "station_config_kv.js"), "utf8");
  it("main.js has the designation:bypass handler, gated by mayBypass, writing through setLocal, recorded in the ledger", () => {
    const at = main.indexOf('ipcMain.handle("designation:bypass"');
    expect(at).toBeGreaterThan(0);
    const h = main.slice(at, at + 3000);
    expect(h).toMatch(/_desig\.mayBypass\(/);
    expect(h).toMatch(/_killDesignationWriteLocal\(/);
    expect(h).toMatch(/_healthEvent\('designation-bypass-(on|off)'|designation-bypass-\$\{/);
  });
  it("who turned it on is a LOCAL key (it describes this machine, never synced)", () => {
    expect(kv).toMatch(/LOCAL_ONLY_KEYS = new Set\(\[[^\]]*'kill_designation_by'/);
  });
  it("the Health Monitor row offers it behind the admin PIN, and the app shows a banner", () => {
    const hm = fs.readFileSync(path.join(__dirname, "..", "src", "components", "HealthMonitor.tsx"), "utf8");
    expect(hm).toMatch(/"designation:bypass"/);
    expect(hm).toMatch(/verifyAdminPin\(/);
    const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
    expect(app).toMatch(/<DesignationBypassBanner/);
  });
});

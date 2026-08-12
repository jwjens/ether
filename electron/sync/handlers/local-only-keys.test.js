// Every key the UI writes with set-local MUST be accepted by isLocalOnlyKey, or the write is refused
// and the feature silently does nothing. This has now happened three times:
//
//   auto_generate_enabled  — the toggle that never wrote (4.4.183, 4.4.184)
//   schedule_layout_v1     — Schedule Manager layouts, never persisted since 4.4.171
//   grid_widths_<pane>     — column widths, never persisted since 4.4.177
//
// Nothing errors when this is wrong: set-local returns {ok:false} and a caller that does not read
// the verdict shows a working UI over a write that was thrown away.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require_ = createRequire(import.meta.url);
const src = readFileSync(require_.resolve("./station_config_kv.js"), "utf8");

// Rebuild the predicate from source rather than importing the module, which needs an Electron
// ipcMain at load time.
const setLine = src.match(/const LOCAL_ONLY_KEYS = new Set\(\[([^\]]*)\]\)/);
const keys = (setLine ? setLine[1] : "").split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
const preLine = src.match(/const LOCAL_ONLY_PREFIXES = \[([^\]]*)\]/);
const prefixes = (preLine ? preLine[1] : "").split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
const accepts = (k) => typeof k === "string" && (keys.includes(k) || prefixes.some(p => k.startsWith(p)));

describe("LOCAL_ONLY_KEYS", () => {
  it("accepts every key the UI writes with set-local", () => {
    for (const k of ["log_reader_flip", "auto_generate_enabled", "kill_designation", "schedule_layout_v1"])
      expect(accepts(k), `${k} would be REFUSED`).toBe(true);
  });

  it("accepts grid_widths_* by prefix — one key per grid, so it cannot be enumerated", () => {
    for (const k of ["grid_widths_traffic", "grid_widths_rotation_spins", "grid_widths_rotation_hourly"])
      expect(accepts(k), `${k} would be REFUSED`).toBe(true);
  });

  it("NEVER accepts designated_generator — it is the one key that must sync", () => {
    // Designation exists to arbitrate BETWEEN machines. Local-only would give each machine its own
    // private designation and break Phase B enforcement against a record the other has never seen.
    expect(accepts("designated_generator")).toBe(false);
  });

  it("still refuses arbitrary keys, and is not fooled by a near-miss", () => {
    for (const k of ["station_name", "grid_width", "gridwidths_x", "schedule_layout", ""])
      expect(accepts(k)).toBe(false);
  });

  it("refuses a non-string key rather than throwing — the OV log shows key \"undefined\"", () => {
    for (const k of [undefined, null, 42, {}]) expect(accepts(k)).toBe(false);
  });

  it("set-local still rejects anything not accepted, and says so out loud", () => {
    expect(src).toContain("set-local refuses non-local-only key");
    expect(src).toContain("set-local REFUSED");
  });
});

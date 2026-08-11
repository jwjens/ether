// Every key the UI writes with set-local MUST be in LOCAL_ONLY_KEYS, or set-local refuses it and the
// toggle silently does nothing. That is exactly how the auto-generate switch shipped broken twice
// (4.4.183, 4.4.184): the UI wrote, the write was rejected, and the button snapped back.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require_ = createRequire(import.meta.url);
const src = readFileSync(require_.resolve("./station_config_kv.js"), "utf8");

describe("LOCAL_ONLY_KEYS", () => {
  const line = src.match(/const LOCAL_ONLY_KEYS = new Set\(\[([^\]]*)\]\)/);
  const keys = (line ? line[1] : "").split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);

  it("contains every key the Health Monitor toggles", () => {
    for (const k of ["log_reader_flip", "auto_generate_enabled"]) expect(keys).toContain(k);
  });

  it("set-local still refuses anything not listed", () => {
    expect(src).toContain("set-local refuses non-local-only key");
  });
});

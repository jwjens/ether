// Both stream paths take the station's Icecast bitrate (docs/audio-numbers-audit-2026-10-11.md). Before 2026-10-11 the
// in-process (fallback) path hard-coded 128k whatever the station was set to.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const SA = require_("./stream-args.js");
const mainSrc = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

describe("the Icecast bitrate", () => {
  it("is the station's setting", () => {
    expect(SA.icecastBitrateOf({ icecast_bitrate: 192 })).toBe(192);
    expect(SA.icecastBitrateOf({ icecast_bitrate: "96" })).toBe(96);
  });
  it("falls back only to the column's own default when unset", () => {
    expect(SA.icecastBitrateOf({})).toBe(128);
    expect(SA.icecastBitrateOf({ icecast_bitrate: 0 })).toBe(128);
  });
  it("reaches the in-process encoder's arguments", () => {
    const a = SA.programBusEncoderArgs({ port: 5000, sampleRate: 44100, bitrateKbps: 192, url: "icecast://x" });
    expect(a[a.indexOf("-b:a") + 1]).toBe("192k");
    expect(a[a.indexOf("-i") + 1]).toBe("tcp://127.0.0.1:5000");
  });
  it("no stream path in main hard-codes the MP3 bitrate any more", () => {
    expect(/'-c:a', 'libmp3lame', '-b:a', '128k'/.test(mainSrc)).toBe(false);
    expect((mainSrc.match(/icecastBitrateOf\(station\)/g) || []).length).toBe(2);   // the daemon path and the in-process path
  });
});

// audiod/listen.test.js — the Park page Listen sender (2026-10-13). Settings are validated, never invented; the ffmpeg
// line uses exactly them; the lease stops the encoder when nobody renews it; stop never leaves a process behind.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { ListenSender, checkConfig, ffmpegArgs } = require_("./listen.js");

const good = { url: "rtsps://station:t@stream.example:8322/park/abc", which: 3, bitrateKbps: 64, frameMs: 20, leaseSec: 60 };

describe("listen config", () => {
  it("accepts the station's settings as given", () => {
    expect(checkConfig(good)).toEqual({ ok: true, cfg: { url: good.url, which: 3, bitrate: 64, frameMs: 20, leaseSec: 60 } });
  });
  it("refuses a missing choice of speaker output — never guesses one", () => {
    expect(checkConfig({ ...good, which: 0 }).ok).toBe(false);
    expect(checkConfig({ ...good, which: undefined }).ok).toBe(false);
  });
  it("refuses an Opus frame length Opus does not have, and a silly bitrate", () => {
    expect(checkConfig({ ...good, frameMs: 15 }).ok).toBe(false);
    expect(checkConfig({ ...good, bitrateKbps: 0 }).ok).toBe(false);
    expect(checkConfig({ ...good, url: "http://x" }).ok).toBe(false);
  });
  it("the ffmpeg line reads the listen port and uses exactly the settings", () => {
    const a = ffmpegArgs(5555, checkConfig(good).cfg).join(" ");
    expect(a).toContain("-i tcp://127.0.0.1:5555");
    expect(a).toContain("-c:a libopus -b:a 64k -frame_duration 20");
    expect(a).toContain("-f rtsp -rtsp_transport tcp " + good.url);
  });
});

describe("listen sender lease", () => {
  const fakeTimers = () => { const q = []; return { q, setTimeout: (fn, ms) => { const h = { fn, ms }; q.push(h); return h; }, clearTimeout: (h) => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); } }; };
  const addon = { audioGetListenPort: () => 0, audioSetListenSource: () => {}, audioGetListenConnected: () => false };
  it("no engine port → an honest error, nothing spawned", () => {
    const s = new ListenSender(2, addon, () => {}, fakeTimers());
    expect(s.start(good)).toEqual({ ok: false, error: "Audio engine not ready — no listen port." });
    expect(s.proc).toBe(null);
  });
  it("the lease ends → stopped, with the reason", () => {
    const t = fakeTimers();
    const seen = [];
    const s = new ListenSender(2, { ...addon, audioGetListenPort: () => 5555 }, (st) => seen.push(st), t);
    s._spawn = () => { s.state = "live"; };           // no real ffmpeg in a unit test
    expect(s.start(good).ok).toBe(true);
    const lease = t.q.find(h => h.ms === 60000);
    expect(lease).toBeTruthy();
    lease.fn();
    expect(s.armed).toBe(false);
    expect(s.state).toBe("idle");
    expect(seen.at(-1).errorMsg).toMatch(/lease ended/);
  });
});

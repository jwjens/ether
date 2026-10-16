// electron/park-talk.test.js — Hold to talk's settings and state (2026-10-16).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const T = require_("./park-talk.js");

const kv = (o) => (k) => o[k];

describe("settings", () => {
  it("off until every number is set; Jeff's starting values make it ready", () => {
    const empty = T.readSettings(kv({}));
    expect(empty.ready).toBe(false);
    expect(empty.missing).toEqual(["park_talk_max_sec", "park_talk_echo_cancel", "park_talk_noise_suppress", "park_talk_auto_gain"]);
    const store = {};
    for (const [k, v] of T.seedWrites(kv(store))) store[k] = v;
    const s = T.readSettings(kv(store));
    expect(s).toMatchObject({ ready: true, maxSec: 20, echo: true, noise: true, agc: false });
    expect(s.names).toEqual({ 1: "Park Mic 1", 2: "Park Mic 2" });
    expect(Object.keys(store).some(k => /limit/.test(k))).toBe(false);   // no limiter is written (Jeff, 2026-10-16)
  });
  it("a set value is never overwritten by the starting values", () => {
    expect(T.seedWrites(kv({ park_talk_max_sec: "15", park_talk_echo_cancel: "0", park_talk_noise_suppress: "1", park_talk_auto_gain: "1" }))).toEqual([]);
  });
  it("the user's names are what the phone shows", () => {
    expect(T.readSettings(kv({ park_mic_1_name: "Front gate", park_mic_2_name: " Staff " })).names).toEqual({ 1: "Front gate", 2: "Staff" });
  });
});

describe("which fader", () => {
  it("finds each Park mic's fader among the mic patches; a sound-card mic is not a Park mic", () => {
    const r = T.micFaders({ D: { device: "park:1" }, S2: { device: "Microphone (USB)" }, F: { device: "park:2" } });
    expect(r.faders).toEqual({ 1: "D", 2: "F" });
    expect(r.conflicts).toEqual({});
    expect(T.micFaders({ D: { device: "park:1" }, E: { device: "park:1" } }).conflicts).toEqual({ 1: ["D", "E"] });
    expect(T.parkMicOf("park:3")).toBeNull();
  });
});

describe("refusals and who/when", () => {
  const ready = T.readSettings(kv({ park_talk_max_sec: "20", park_talk_echo_cancel: "1", park_talk_noise_suppress: "1", park_talk_auto_gain: "0" }));
  it("lock, setup, fader and engine are each named", () => {
    expect(T.refusal({ locked: true, settings: ready, fader: "D", daemon: true })).toBe("Controls locked by the studio");
    expect(T.refusal({ locked: false, settings: T.readSettings(kv({})), fader: "D", daemon: true })).toMatch(/isn't set up/);
    expect(T.refusal({ locked: false, settings: ready, fader: null, daemon: true })).toMatch(/isn't on a fader/);
    expect(T.refusal({ locked: false, settings: ready, fader: "D", daemon: false })).toMatch(/audio engine/);
    expect(T.refusal({ locked: false, settings: ready, fader: "D", daemon: true })).toBeNull();
  });
  it("the last-talk line", () => {
    const f = () => "8:42 PM";
    expect(T.lastLine({ by: "Ryan", at: "2026-10-16T03:42:00Z", sec: 14.2, how: "released" }, f)).toBe("Last: Ryan, 8:42 PM, 14 s");
    expect(T.lastLine({ by: "Ryan", at: "2026-10-16T03:42:00Z", sec: 20, how: "limit" }, f)).toBe("Last: Ryan, 8:42 PM, 20 s, cut at the limit");
    expect(T.lastLine({ by: "Ryan", at: "2026-10-16T03:42:00Z", sec: 3, how: "ether" }, f)).toBe("Last: Ryan, 8:42 PM, 3 s, stopped in Ether");
    expect(T.parseLast("nope")).toBeNull();
  });
});

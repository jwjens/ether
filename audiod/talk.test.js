// audiod/talk.test.js — Park mic warm lines and the talk switch (2026-10-16), under Jeff's standing rule: the user is in
// charge of on and off; nothing here ends a talk by itself (no timer, no lease, no silence); green = the line is open.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
const require_ = createRequire(import.meta.url);
const { ParkTalk, checkWarm, checkTalk, ffmpegArgs, RETRY_MS } = require_("./talk.js");

const W1 = "a1b2c3d4e5f60718", W2 = "0f0e0d0c0b0a0908";
const URL1 = "rtsps://station:t@stream.example:8322/park/abc/w/" + W1;

function fakeTimers() {
  let now = 1000, seq = 0; const due = new Map();
  return {
    t: { setTimeout: (fn, ms) => { const id = ++seq; due.set(id, { fn, at: now + ms }); return id; }, clearTimeout: (id) => due.delete(id), now: () => now },
    advance(ms) { const end = now + ms; for (;;) { const next = [...due].sort((a, b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > end) break; now = next[1].at; due.delete(next[0]); next[1].fn(); } now = end; },
  };
}
function harness() {
  const ft = fakeTimers(), events = [], procs = [], written = { 1: [], 2: [] };
  const spawn = (args) => { const p = new EventEmitter(); p.args = args; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => p.emit("close"); procs.push(p); return p; };
  const connect = (port) => { const s = new EventEmitter(); s.destroyed = false; s.write = (b) => written[port === 5001 ? 1 : 2].push(b.length); s.destroy = () => { s.destroyed = true; }; return s; };
  const A = { audioGetParkMicPort: (_s, m) => (m === 1 ? 5001 : 5002) };
  const pt = new ParkTalk(7, A, (e) => events.push(e), { timers: ft.t, spawn, connect });
  return { pt, ft, events, procs, written };
}
const frame = () => Buffer.alloc(3840);   // 20 ms at 48 kHz mono f32 — silence or voice, the switch never looks

describe("checks and the ffmpeg line", () => {
  it("lines and talks are validated, never invented", () => {
    expect(checkWarm({ warmId: W1, url: URL1, leaseSec: 20 }).ok).toBe(true);
    expect(checkWarm({ warmId: "x", url: URL1, leaseSec: 20 }).ok).toBe(false);
    expect(checkTalk({ mic: 3, warmId: W1 }).ok).toBe(false);
    expect(checkTalk({ mic: 1, warmId: W1 }).ok).toBe(true);
  });
  it("reads the phone's relay path with least delay, to a pipe, mono 48 kHz f32le", () => {
    const a = ffmpegArgs(URL1).join(" ");
    expect(a).toContain(`-rtsp_transport tcp -i ${URL1}`);
    expect(a).toContain("-max_delay 0 -reorder_queue_size 0");
    expect(a).toContain("-af aresample=48000 -ac 1 -flush_packets 1 -f f32le pipe:1");
  });
});

describe("warm lines", () => {
  it("a read that fails is tried again, quietly, until the phone is there (never gives up)", () => {
    const { pt, ft, procs } = harness();
    pt.warm({ warmId: W1, url: URL1, leaseSec: 20 });
    for (let i = 0; i < 5; i++) { procs.at(-1).emit("close"); ft.advance(RETRY_MS); }
    expect(procs.length).toBe(6);
    expect(pt.lines.size).toBe(1);
  });
  it("a line nobody talks on is cleaned up when its phone stops renewing", () => {
    const { pt, ft } = harness();
    pt.warm({ warmId: W1, url: URL1, leaseSec: 20 });
    ft.advance(20001);
    expect(pt.lines.size).toBe(0);
  });
});

describe("the talk switch — the user is in charge of on and off", () => {
  it("ON passes exactly that phone's audio into its Park mic; other phones go nowhere; OFF stops it", () => {
    const { pt, procs, written, events } = harness();
    pt.warm({ warmId: W1, url: URL1, leaseSec: 20 });
    pt.warm({ warmId: W2, url: URL1.replace(W1, W2), leaseSec: 20 });
    const [p1, p2] = procs;
    p1.stdout.emit("data", frame());                 // muted, before a talk: the line is open, the audio goes nowhere
    expect(written[1].length).toBe(0);
    expect(pt.on({ mic: 1, warmId: W1, talkId: "t1", by: "Ryan" })).toEqual({ ok: true, open: true });   // green at once
    p1.stdout.emit("data", frame());
    p2.stdout.emit("data", frame());
    expect(written[1]).toEqual([3840]);
    expect(events.at(-1)).toMatchObject({ state: "on", receiving: true, by: "Ryan" });
    pt.off(1, "released");
    p1.stdout.emit("data", frame());
    expect(written[1]).toEqual([3840]);
    expect(events.at(-1)).toMatchObject({ state: "idle", endedHow: "released" });
  });
  it("NEVER ends by itself: an hour of silence and no renewals, still on", () => {
    const { pt, ft, procs, events } = harness();
    pt.warm({ warmId: W1, url: URL1, leaseSec: 20 });
    procs[0].stdout.emit("data", frame());
    pt.on({ mic: 1, warmId: W1, talkId: "t1", by: "Ryan" });
    ft.advance(60 * 60 * 1000);                      // nobody says anything, the phone renews nothing
    expect(pt.status()[0].state).toBe("on");
    expect(events.some(e => e.state === "idle")).toBe(false);
    expect(pt.lines.size).toBe(1);                   // the line in a talk is kept
  });
  it("a line that drops during a talk keeps the talk ON, says the line is not open, and is retried", () => {
    const { pt, ft, procs, events } = harness();
    pt.warm({ warmId: W1, url: URL1, leaseSec: 20 });
    procs[0].stdout.emit("data", frame());
    pt.on({ mic: 1, warmId: W1, talkId: "t1", by: "Ryan" });
    procs[0].emit("close");                          // the line dropped
    expect(events.at(-1)).toMatchObject({ state: "on", lineOpen: false });
    ft.advance(RETRY_MS);
    procs.at(-1).stdout.emit("data", frame());       // back
    expect(events.at(-1)).toMatchObject({ state: "on", lineOpen: true });
  });
  it("STOP in Ether and the studio lock end it, and say so; turning the phone's mic off never ends a talk", () => {
    const { pt, events } = harness();
    pt.warm({ warmId: W1, url: URL1, leaseSec: 20 });
    pt.on({ mic: 1, warmId: W1, talkId: "t1", by: "Ryan" });
    expect(pt.unwarm(W1)).toMatchObject({ kept: "in a talk" });
    pt.off(1, "ether");
    expect(events.at(-1)).toMatchObject({ state: "idle", endedHow: "ether" });
    pt.on({ mic: 1, warmId: W1, talkId: "t2", by: "Ryan" });
    pt.off(1, "locked");
    expect(events.at(-1)).toMatchObject({ state: "idle", endedHow: "locked" });
  });
});

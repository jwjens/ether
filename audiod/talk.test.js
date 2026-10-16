// audiod/talk.test.js — the Park mic receiver (Hold to talk, 2026-10-16). Settings are validated, never invented; the
// ffmpeg line writes exactly the engine's Park mic format into its port; the station itself ends a talk at the longest
// talk and at the lease; a renewal never restarts the receiver; a new talk replaces the old one.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { TalkReceiver, checkTalk, ffmpegArgs } = require_("./talk.js");

const good = { mic: 1, url: "rtsps://station:t@stream.example:8322/park/abc/talk1", limitSec: 20, leaseSec: 30, talkId: "t1", by: "Ryan" };

function fakeTimers() {
  let now = 1000, seq = 0; const due = new Map();
  return {
    t: { setTimeout: (fn, ms) => { const id = ++seq; due.set(id, { fn, at: now + ms }); return id; }, clearTimeout: (id) => due.delete(id), now: () => now },
    advance(ms) { now += ms; for (const [id, d] of [...due].sort((a, b) => a[1].at - b[1].at)) if (d.at <= now && due.has(id)) { due.delete(id); d.fn(); } },
  };
}
function receiver(timers) {
  const events = [];
  const A = { audioGetParkMicPort: (_s, m) => (m === 1 ? 5555 : 5556) };
  const r = new TalkReceiver(7, 1, A, (s) => events.push(s), timers.t);
  r.spawned = 0; r._spawn = function () { this.spawned++; this.proc = { kill() {} }; this.state = "connecting"; this._emit(); };
  return { r, events };
}

describe("talk config", () => {
  it("accepts the station's settings as given", () => {
    expect(checkTalk(good)).toEqual({ ok: true, cfg: { mic: 1, url: good.url, limitSec: 20, leaseSec: 30, talkId: "t1", by: "Ryan" } });
  });
  it("refuses a Park mic that does not exist, a missing longest talk, a missing relay", () => {
    expect(checkTalk({ ...good, mic: 3 }).ok).toBe(false);
    expect(checkTalk({ ...good, limitSec: undefined }).ok).toBe(false);
    expect(checkTalk({ ...good, limitSec: 0 }).ok).toBe(false);
    expect(checkTalk({ ...good, url: "http://x" }).ok).toBe(false);
  });
  it("the ffmpeg line reads the relay and writes mono 48 kHz f32le into the Park mic's port", () => {
    const a = ffmpegArgs(5555, checkTalk(good).cfg).join(" ");
    expect(a).toContain(`-rtsp_transport tcp -i ${good.url}`);
    expect(a).toContain("-af aresample=48000 -ac 1 -flush_packets 1 -f f32le tcp://127.0.0.1:5555");
    expect(a).toContain("-max_delay 0 -reorder_queue_size 0");
  });
});

describe("the receiver", () => {
  it("stops by itself at the longest talk, whatever the server does", () => {
    const ft = fakeTimers(); const { r, events } = receiver(ft);
    expect(r.start(good).ok).toBe(true);
    ft.advance(15000); r.start(good);              // a renewal at 15 s
    ft.advance(5000);                               // 20 s
    expect(r.state).toBe("idle");
    expect(events.at(-1).endedHow).toBe("limit");
    expect(r.spawned).toBe(1);                      // the renewal did not restart it
  });
  it("stops when the lease is not renewed (a phone that vanished)", () => {
    const ft = fakeTimers(); const { r, events } = receiver(ft);
    r.start({ ...good, limitSec: 120, leaseSec: 10 });
    ft.advance(10000);
    expect(r.state).toBe("idle");
    expect(events.at(-1).endedHow).toBe("lease");
  });
  it("Stop in Ether ends it and says so; a new talk replaces the old one", () => {
    const ft = fakeTimers(); const { r, events } = receiver(ft);
    r.start(good);
    r.start({ ...good, talkId: "t2", by: "Maria" });
    expect(r.spawned).toBe(2);
    expect(r.status().by).toBe("Maria");
    r.stop("ether");
    expect(events.at(-1).endedHow).toBe("ether");
    expect(r.stop("ether").was).toBe(false);        // stopping an idle mic is not a second event
  });
  it("no Park mic port (engine not ready) is an error, never a silent success", () => {
    const ft = fakeTimers();
    const r = new TalkReceiver(7, 1, { audioGetParkMicPort: () => 0 }, () => {}, ft.t);
    expect(r.start(good).ok).toBe(false);
    expect(r.state).toBe("error");
  });
});

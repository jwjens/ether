// web-remote slice 4 (docs/web-remote-design-2026-09-16.md §4): "Restart" is a STREAM restart on the target machine —
// stream:stop-live → wait until the stream is no longer live (or 2 s) → stream:go-live. Automation is never touched;
// the song keeps playing through the encoder restart. stop-live deletes _streamIntent and go-live re-sets it.
// The result is the stream's REAL end state: in daemon mode go-live answers ok as soon as ffmpeg is spawned and an
// Icecast 403 only shows up afterwards as the stream's `error` state, so the restart confirms (live | error) before
// it reports.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { restartStream, confirmLive, STOP_WAIT_MS, CONFIRM_MS } from "./streamRestart";

function fakeStream(script: { states: string[]; goLive?: any; stop?: any; error?: string | null }) {
  const calls: string[] = [];
  let t = 0; let i = 0;
  const io = {
    stopLive: async () => { calls.push("stop"); return script.stop ?? { ok: true }; },
    goLive: async () => { calls.push("go"); return script.goLive ?? { ok: true }; },
    status: async () => { const s = script.states[Math.min(i, script.states.length - 1)]; i++; calls.push("status:" + s); return { state: s, error: script.error ?? null }; },
    sleep: async (ms: number) => { t += ms; },
    now: () => t,
  };
  return { io, calls, elapsed: () => t };
}

describe("stream:restart (slice 4)", () => {
  it("stop → waits until NOT live → go-live → confirmed live → ok", async () => {
    const f = fakeStream({ states: ["live", "live", "idle", "connecting", "live"] });
    const r = await restartStream(f.io);
    expect(r).toEqual({ ok: true, error: null });
    expect(f.calls.filter(c => c === "stop" || c === "go")).toEqual(["stop", "go"]);
    expect(f.calls.indexOf("go")).toBeGreaterThan(f.calls.indexOf("status:idle"));
  });
  it("the stream never leaves live → go-live anyway after 2 s (never hangs)", async () => {
    const f = fakeStream({ states: ["live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live", "live"] });
    const r = await restartStream(f.io);
    expect(STOP_WAIT_MS).toBe(2000);
    expect(f.calls).toContain("go");
    expect(r.ok).toBe(true);    // it is live again afterwards
  });
  it("an Icecast refusal after go-live is the result (403 → ok:false with the reason)", async () => {
    const f = fakeStream({ states: ["idle", "connecting", "error"], error: "403 Forbidden — mount in use" });
    expect(await restartStream(f.io)).toEqual({ ok: false, error: "403 Forbidden — mount in use" });
  });
  it("go-live itself refused → ok:false, no confirm wait", async () => {
    const f = fakeStream({ states: ["idle"], goLive: { ok: false, error: "station 7 not found" } });
    expect(await restartStream(f.io)).toEqual({ ok: false, error: "station 7 not found" });
  });
  it("still connecting when the confirm window closes → not reported as success", async () => {
    const f = fakeStream({ states: ["idle", ...Array(200).fill("connecting")] });
    const r = await restartStream(f.io);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(new RegExp(`not confirmed live within ${CONFIRM_MS / 1000} s`));
  });
  it("confirmLive on its own reports the state it lands in", async () => {
    expect(await confirmLive(fakeStream({ states: ["connecting", "live"] }).io)).toEqual({ ok: true, error: null });
  });
  it("App's stream:restart case uses it, is station-scoped, and never touches automation", () => {
    const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    const at = app.indexOf('case "stream:restart":');
    expect(at).toBeGreaterThan(0);
    const body = app.slice(at, app.indexOf("break;", at));
    expect(body).toMatch(/restartStream\(/);
    expect(body).not.toMatch(/automation|setAutoAdv|writeAutoAdv/);
    const routing = fs.readFileSync(path.join(__dirname, "cmd-routing.ts"), "utf8");
    expect(routing).toMatch(/"stream:restart"/);
  });
});

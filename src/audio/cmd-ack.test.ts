// web-remote slice 5 (docs/web-remote-design-2026-09-16.md §5): no silent success. After any station-scoped command
// this machine ACCEPTED runs, it POSTs /api/cmd/ack {cmd_id, station_uuid, machine_id, ok, error} with the REAL result
// — a daemon refusal, go-live's error, a skipped branch ("non-active station") or a throw is ok:false with the reason.
// Best-effort: it never throws and is never awaited by playout.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { outcomeOf, ackBody, postCmdAck, ACK_TIMEOUT_MS } from "./cmd-ack";

describe("outcomeOf — every result shape execCmd sees", () => {
  it("nothing returned / ok → ok", () => {
    expect(outcomeOf(undefined)).toEqual({ ok: true, error: null });
    expect(outcomeOf({ ok: true, server: "x" })).toEqual({ ok: true, error: null });
    expect(outcomeOf({ ok: true, result: { ok: true } })).toEqual({ ok: true, error: null });
  });
  it("an IPC refusal, and a daemon command's own refusal inside result, are ok:false with the reason", () => {
    expect(outcomeOf({ ok: false, error: "403 Forbidden" })).toEqual({ ok: false, error: "403 Forbidden" });
    expect(outcomeOf({ ok: true, result: { ok: false, reason: "no deck ready" } })).toEqual({ ok: false, error: "no deck ready" });
    expect(outcomeOf({ ok: false })).toEqual({ ok: false, error: "failed (no reason given)" });
  });
});

describe("the ack", () => {
  it("body is exactly {cmd_id, station_uuid, machine_id, ok, error}", () => {
    expect(ackBody({ cmd_id: "c1", station_uuid: "s1", other: 1 }, "m1", { ok: false, error: "403" }))
      .toEqual({ cmd_id: "c1", station_uuid: "s1", machine_id: "m1", ok: false, error: "403" });
    expect(ackBody({}, null, { ok: true, error: null })).toEqual({ cmd_id: null, station_uuid: null, machine_id: null, ok: true, error: null });
  });
  it("POSTs JSON with the license key; a failing / hanging backend never throws", async () => {
    const seen: any[] = [];
    const okFetch = async (url: string, init: any) => { seen.push({ url, init }); return { ok: true } as any; };
    expect(await postCmdAck(okFetch as any, "https://b/api/cmd/ack", "KEY", { ok: true })).toBe(true);
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.headers["x-license-key"]).toBe("KEY");
    expect(JSON.parse(seen[0].init.body)).toEqual({ ok: true });
    expect(await postCmdAck((async () => { throw new Error("offline"); }) as any, "u", "KEY", {})).toBe(false);
    expect(await postCmdAck((async () => ({ ok: false, status: 404 })) as any, "u", "KEY", {})).toBe(false);
    expect(await postCmdAck(okFetch as any, "u", "", {})).toBe(false);     // no key → nothing sent
    expect(ACK_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});

describe("execCmd acks what really happened (App.tsx)", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
  const at = app.indexOf("const execCmd = async (cmd: string, data: any) => {");
  const exec = app.slice(at, app.indexOf("let es: EventSource | null = null;", at));
  it("acks accepted station-scoped commands in a finally, without awaiting", () => {
    expect(exec).toMatch(/finally \{[\s\S]*?if \(accepted\)[\s\S]*?void postCmdAck\(/);
    expect(exec).toMatch(/\/api\/cmd\/ack/);
  });
  it("skipped branches are refusals (ok:false), not silent successes", () => {
    expect(exec).not.toMatch(/console\.log\("\[RemoteCmd\] (deck:load|queue:enqueue|queue:reorder|cart:fire) skipped/);
    expect(exec).toMatch(/refuse\("deck:load skipped — non-active station/);
  });
  it("daemon results and go-live's answer feed the outcome", () => {
    expect(exec).toMatch(/const o = outcomeOf\(r\);/);
    expect(exec).toMatch(/outcome = await confirmLive\(/);
  });
});

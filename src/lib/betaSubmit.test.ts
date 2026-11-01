// Settings → Beta Program & Feedback: "received" only when the server stored it; every failure says so in plain words.
import { describe, it, expect } from "vitest";
import { readAnswer, submitForm, mailtoFor } from "./betaSubmit";

const res = (status: number, body: unknown, bad = false) =>
  ({ status, json: async () => { if (bad) throw new Error("not json"); return body; } }) as unknown as Response;

describe("readAnswer", () => {
  it("201 { ok, id } is received", () => {
    expect(readAnswer(201, { ok: true, id: 7 })).toEqual({ ok: true, id: 7 });
  });
  it("a 2xx without ok:true is NOT received", () => {
    const r = readAnswer(200, { hello: 1 });
    expect(r.ok).toBe(false);
  });
  it("400 names the fields in plain words", () => {
    const r = readAnswer(400, { error: "invalid", fields: ["contact_email_invalid", "station_name_required"] });
    expect(r).toMatchObject({ ok: false, kind: "invalid" });
    if (!r.ok) {
      expect(r.message).toContain("email address");
      expect(r.message).toContain("Station name is required");
    }
  });
  it("404 (the route missing — what every send got before 2026-11-01) is a failure, not success", () => {
    const r = readAnswer(404, null);
    expect(r).toMatchObject({ ok: false, kind: "server" });
    if (!r.ok) expect(r.message).toContain("404");
  });
  it("429 says too many, not sent", () => {
    expect(readAnswer(429, { error: "too_many_requests" })).toMatchObject({ ok: false, kind: "rate" });
  });
});

describe("submitForm", () => {
  it("posts JSON and reads the answer", async () => {
    let seen: any = null;
    const f = (async (url: string, init: any) => { seen = { url, init }; return res(201, { ok: true, id: 3 }); }) as unknown as typeof fetch;
    const r = await submitForm("https://x.test/feedback", { a: 1 }, f);
    expect(r).toEqual({ ok: true, id: 3 });
    expect(seen.init.method).toBe("POST");
    expect(JSON.parse(seen.init.body)).toEqual({ a: 1 });
  });
  it("a network error never throws; it is a 'network' failure", async () => {
    const f = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    expect(await submitForm("u", {}, f)).toMatchObject({ ok: false, kind: "network" });
  });
  it("a non-JSON error page is a failure with its status", async () => {
    const f = (async () => res(502, null, true)) as unknown as typeof fetch;
    const r = await submitForm("u", {}, f);
    expect(r).toMatchObject({ ok: false, kind: "server" });
  });
});

describe("mailtoFor", () => {
  it("drops empty lines and encodes", () => {
    const m = mailtoFor("a@b.test", "Hi there", { feedback: "x & y", from: "" });
    expect(m.startsWith("mailto:a@b.test?subject=Hi%20there&body=")).toBe(true);
    expect(decodeURIComponent(m.split("body=")[1])).toBe("feedback: x & y");
  });
});

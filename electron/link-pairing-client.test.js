// Remote Link pairing, desktop side (Jeff's ruling, 2026-10-04): the link key is never copied or typed by hand.
// The client the main process uses against the backend's /api/link — mocked fetch, real request shapes.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { createLinkPairingClient, normalizeCode, formatCode } = require_("./link-pairing-client.js");

const KEY = "a".repeat(64);
function mockFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    const path = url.replace("https://api.test", "");
    const h = routes[`${init.method || "GET"} ${path}`];
    const [status, body] = h ? h(calls[calls.length - 1]) : [404, { error: "not_found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetch, calls };
}
const client = (routes, extra = {}) => {
  const m = mockFetch(routes);
  return { m, c: createLinkPairingClient({ fetch: m.fetch, baseUrl: "https://api.test", getJwt: () => "JWT", canWrite: () => true, ...extra }) };
};

describe("codes, as the receiver types them", () => {
  it("normalises loose typing to the 8 symbols and formats XXXX-XXXX", () => {
    expect(normalizeCode(" k7qd 2xmf ")).toBe("K7QD2XMF");
    expect(formatCode("K7QD2XMF")).toBe("K7QD-2XMF");
    expect(normalizeCode("K7QD-2XM0")).toBe(null);   // 0 is not in the alphabet
    expect(normalizeCode("K7QD")).toBe(null);
  });
});

describe("same account", () => {
  it("lists the account's OTHER machines, never this one", async () => {
    const { c, m } = client({ "GET /api/link/machines": () => [200, { machines: [
      { machine_id: "me", machine_name: "OVEVENTS", published: true, fingerprint: "AAAA-1111", key_id: 2 },
      { machine_id: "ov", machine_name: "ovowforestmusic", published: true, fingerprint: "BBBB-2222", key_id: 3 },
      { machine_id: "van", machine_name: "Van", published: false, fingerprint: null, key_id: null }] }] });
    const r = await c.listMachines({ thisMachine: "me" });
    expect(r.ok).toBe(true);
    expect(r.machines.map(x => x.machineId)).toEqual(["ov", "van"]);
    expect(r.machines[0]).toMatchObject({ name: "ovowforestmusic", published: true, fingerprint: "BBBB-2222", keyId: 3 });
    expect(m.calls[0].headers.Authorization).toBe("Bearer JWT");
  });
  it("fetches a picked machine's key as the fader's `from` (via: account)", async () => {
    const { c } = client({ "GET /api/link/key/ov": () => [200, { machine_id: "ov", machine_name: "ovowforestmusic", key: KEY, key_id: 3, fingerprint: "BBBB-2222" }] });
    const r = await c.fetchKey("ov");
    expect(r).toMatchObject({ ok: true, from: { machine: "ov", name: "ovowforestmusic", keyId: 3, key: KEY, via: "account" } });
  });
  it("a machine that has not published says so in words", async () => {
    const { c } = client({ "GET /api/link/key/van": () => [404, { error: "no_published_key" }] });
    const r = await c.fetchKey("van");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/has not shared its link key yet/i);
  });
  it("publishes this machine's key (and re-publishes after Replace key)", async () => {
    const { c, m } = client({ "PUT /api/link/key": () => [200, { ok: true, fingerprint: "AAAA-1111" }] });
    const r = await c.publishKey({ machineId: "me", machineName: "OVEVENTS", key: { key: KEY, id: 4 } });
    expect(r.ok).toBe(true);
    expect(m.calls[0]).toMatchObject({ method: "PUT", body: { machine_id: "me", machine_name: "OVEVENTS", key: KEY, key_id: 4 } });
  });
});

describe("guest code", () => {
  it("sender: makes a code for this machine's key", async () => {
    const { c, m } = client({ "POST /api/link/pair-code": () => [200, { code: "K7QD-2XMF", expires_at: "2026-10-04T23:10:00.000Z" }] });
    const r = await c.createCode({ machineId: "me", machineName: "OVEVENTS", key: { key: KEY, id: 4 } });
    expect(r).toMatchObject({ ok: true, code: "K7QD-2XMF", expiresAt: "2026-10-04T23:10:00.000Z" });
    expect(m.calls[0].body).toMatchObject({ machine_id: "me", key: KEY, key_id: 4 });
  });
  it("receiver: redeems a code into the fader's `from` (via: code)", async () => {
    const { c, m } = client({ "POST /api/link/pair-redeem": () => [200, { machine_id: "ov", machine_name: "ovowforestmusic", key: KEY, key_id: 3, fingerprint: "BBBB-2222" }] });
    const r = await c.redeemCode("k7qd 2xmf");
    expect(r).toMatchObject({ ok: true, from: { machine: "ov", keyId: 3, key: KEY, via: "code" } });
    expect(m.calls[0].body).toEqual({ code: "K7QD-2XMF" });
  });
  it("a wrong / expired / used code is refused in words, and a malformed one never leaves the machine", async () => {
    const { c, m } = client({ "POST /api/link/pair-redeem": () => [404, { error: "code_invalid_or_expired" }] });
    expect((await c.redeemCode("K7QD-2XMF")).reason).toMatch(/wrong, has expired, or was already used/i);
    const bad = await c.redeemCode("hello");
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/8 characters/);
    expect(m.calls.length).toBe(1);
  });
});

describe("guards", () => {
  it("signed out → no request, a plain reason", async () => {
    const { c, m } = client({}, { getJwt: () => null });
    const r = await c.listMachines({ thisMachine: "me" });
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toMatch(/sign in/i);
    expect(m.calls.length).toBe(0);
  });
  it("a dev build may READ but never WRITE production (etherBackend canWriteProduction)", async () => {
    const { c, m } = client({ "GET /api/link/key/ov": () => [200, { machine_id: "ov", machine_name: "x", key: KEY, key_id: 1 }] }, { canWrite: () => false });
    expect((await c.fetchKey("ov")).ok).toBe(true);
    for (const r of [await c.publishKey({ machineId: "me", machineName: "x", key: { key: KEY, id: 1 } }),
                     await c.createCode({ machineId: "me", machineName: "x", key: { key: KEY, id: 1 } }),
                     await c.redeemCode("K7QD-2XMF")]) {
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/development build/i);
    }
    expect(m.calls.length).toBe(1);   // only the read
  });
  it("401 from the backend → sign in again, in words", async () => {
    const { c } = client({ "GET /api/link/machines": () => [401, { error: "invalid_token" }] });
    expect((await c.listMachines({ thisMachine: "me" })).reason).toMatch(/sign in/i);
  });
});

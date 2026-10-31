// Build C (Jeff, 2026-10-30): Remote Access & Website — port 4242 on this computer's network. electron/local-remote.js.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const LR = require_("./local-remote");
const read = (p) => readFileSync(join(__dirname, "..", p), "utf8");

async function serve(deps) {
  const r = await LR.startLocalRemote(deps, { port: 0 });
  const base = `http://127.0.0.1:${r.server.address().port}`;
  return { base, close: () => r.server.close() };
}
const deps = (over = {}) => ({
  nowPlaying: async () => ({ station: "halloVeen", title: "T", artist: "A", playing: true, updatedAt: "2026-10-31T16:00:00.000Z" }),
  upNext: () => [{ title: "N1", artist: "B" }],
  code: () => "123456",
  runCmd: async (cmd) => ({ ok: true, error: null, ran: cmd }),
  ...over,
});

describe("/now-playing.json", () => {
  it("answers anyone, read-only, with CORS", async () => {
    const s = await serve(deps());
    const r = await fetch(`${s.base}/now-playing.json`);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(await r.json()).toEqual({ station: "halloVeen", title: "T", artist: "A", playing: true, updatedAt: "2026-10-31T16:00:00.000Z" });
    s.close();
  });
});

describe("the phone remote", () => {
  it("the page loads and needs no outside file", async () => {
    const s = await serve(deps());
    const html = await (await fetch(`${s.base}/`)).text();
    expect(html).toMatch(/ETHER REMOTE/);
    expect(html).not.toMatch(/https?:\/\//);
    for (const c of ["skip", "stop_all", "automation_on", "automation_off"]) expect(html).toContain(`cmd('${c}')`);
    s.close();
  });
  it("state and commands need the 6-digit code", async () => {
    const ran = [];
    const s = await serve(deps({ runCmd: async (c) => { ran.push(c); return { ok: true, error: null }; } }));
    expect((await fetch(`${s.base}/api/state`)).status).toBe(401);
    expect((await fetch(`${s.base}/api/cmd`, { method: "POST", headers: { "x-ether-code": "000000" }, body: JSON.stringify({ cmd: "skip" }) })).status).toBe(401);
    expect(ran).toEqual([]);
    const st = await (await fetch(`${s.base}/api/state`, { headers: { "x-ether-code": "123456" } })).json();
    expect(st).toMatchObject({ ok: true, nowPlaying: { title: "T" }, upNext: [{ title: "N1", artist: "B" }] });
    const r = await (await fetch(`${s.base}/api/cmd`, { method: "POST", headers: { "x-ether-code": "123456" }, body: JSON.stringify({ cmd: "skip" }) })).json();
    expect(r.ok).toBe(true);
    expect(ran).toEqual(["skip"]);
    s.close();
  });
  it("only Skip, Stop all and AUTO on/off (Jeff's answer 2a)", async () => {
    const s = await serve(deps());
    const r = await fetch(`${s.base}/api/cmd`, { method: "POST", headers: { "x-ether-code": "123456" }, body: JSON.stringify({ cmd: "go_live" }) });
    expect(r.status).toBe(400);
    expect([...LR.COMMANDS].sort()).toEqual(["automation_off", "automation_on", "skip", "stop_all"]);
    s.close();
  });
  it("after 5 wrong codes in a minute the address is refused, even with the right code", async () => {
    const s = await serve(deps());
    for (let i = 0; i < 5; i++) await fetch(`${s.base}/api/state`, { headers: { "x-ether-code": "999999" } });
    expect((await fetch(`${s.base}/api/state`, { headers: { "x-ether-code": "123456" } })).status).toBe(429);
    s.close();
  });
  it("codes are 6 digits; comparison is exact", () => {
    for (let i = 0; i < 20; i++) expect(LR.newCode()).toMatch(/^\d{6}$/);
    expect(LR.sameCode("012345", "012345")).toBe(true);
    expect(LR.sameCode("12345", "012345")).toBe(false);
    expect(LR.sameCode("", "")).toBe(false);
  });
  it("a taken port is reported, never thrown", async () => {
    const a = await LR.startLocalRemote(deps(), { port: 0 });
    const b = await LR.startLocalRemote(deps(), { port: a.server.address().port });
    expect(b.ok).toBe(false);
    a.server.close();
  });
});

describe("wiring", () => {
  it("main serves it and relays commands to the window; the window runs them through execCmd without a web ack", () => {
    const main = read("electron/main.js"), app = read("src/App.tsx");
    expect(main).toMatch(/require\("\.\/local-remote"\)\.startLocalRemote\(/);
    expect(main).toMatch(/mainWindow\.webContents\.send\("local-remote:cmd", \{ id, cmd \}\)/);
    expect(app).toMatch(/execCmd\(p\.cmd, \{ target_machine_id: machineIdRef\.current, _local: true \}\)/);
    expect(app).toMatch(/if \(accepted && !data\?\._local\)/);
  });
  it("Settings says 'on your network' and points public sites to the listener page and embed (answer 3a)", () => {
    const s = read("src/components/SettingsPanel.tsx");
    expect(s).toMatch(/Now playing, on your network/);
    expect(s).toMatch(/A public website on the internet can't reach this computer's network address/);
  });
});

describe("artist photos for the on-air deck (item 17)", () => {
  it("only https images from Wikipedia/Wikimedia and Apple artwork", () => {
    expect(LR.imgProxyTarget("https://upload.wikimedia.org/a.jpg")).toBe("https://upload.wikimedia.org/a.jpg");
    expect(LR.imgProxyTarget("https://is1-ssl.mzstatic.com/image/x/3000x3000bb.jpg")).toMatch(/mzstatic/);
    expect(LR.imgProxyTarget("http://upload.wikimedia.org/a.jpg")).toBe(null);
    expect(LR.imgProxyTarget("https://evil.example/wikimedia.org")).toBe(null);
    expect(LR.imgProxyTarget("https://169.254.169.254/latest")).toBe(null);
  });
  it("serves the image with CORS; refuses non-images", async () => {
    const png = Buffer.from([137, 80, 78, 71]);
    const s = await serve(deps({ fetchImpl: async (u) => ({ ok: true, status: 200, headers: new Map([["content-type", u.includes("html") ? "text/html" : "image/png"]]), arrayBuffer: async () => png }) }));
    const r = await fetch(`${s.base}/api/img-proxy?url=${encodeURIComponent("https://upload.wikimedia.org/x.png")}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    expect((await fetch(`${s.base}/api/img-proxy?url=${encodeURIComponent("https://upload.wikimedia.org/x.html")}`)).status).toBe(502);
    expect((await fetch(`${s.base}/api/img-proxy?url=${encodeURIComponent("https://example.com/x.png")}`)).status).toBe(400);
    s.close();
  });
});


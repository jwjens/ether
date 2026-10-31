// Tools → Stream Manager drives and shows the ONE real stream (Jeff, 2026-10-30). electron/stream-manager.js.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const SM = require_("./stream-manager");
const read = (p) => readFileSync(join(__dirname, "..", p), "utf8");

describe("Stream Manager status and settings", () => {
  it("shows the encoder's own state; uptime only while live; no status = OFF AIR", () => {
    expect(SM.statusOf({ state: "live", uptimeSec: 65, bitrate: 127.9, errorMsg: null })).toEqual({ state: "live", errorMsg: null, uptimeSec: 65, bitrateKbps: 127.9 });
    expect(SM.statusOf({ state: "error", uptimeSec: 9, errorMsg: "Auth failed (401)" })).toMatchObject({ state: "error", uptimeSec: null, errorMsg: "Auth failed (401)" });
    expect(SM.statusOf({ statusState: "connecting" }).state).toBe("connecting");   // the in-process stream state
    expect(SM.statusOf(null).state).toBe("idle");
  });
  it("the station's own stream fields, as ON AIR reads them — the password is never sent, only whether one is set", () => {
    const s = SM.settingsOf({ id: 2, uuid: "u-2", name: "HalloVeen", icecast_server_url: " stream.x.com ", icecast_mount: "/halloveen", icecast_password: "secret", icecast_bitrate: 192 });
    expect(s).toEqual({ stationId: 2, stationUuid: "u-2", stationName: "HalloVeen", server: "stream.x.com", mount: "/halloveen", bitrateKbps: 192, hasPassword: true, port: 8000 });
    expect(JSON.stringify(s)).not.toContain("secret");
  });
  it("a save patches only the four stream fields; blank password keeps the old one; mount gets its slash", () => {
    expect(SM.patchFrom({ server: " a.com ", mount: "live", password: "", bitrateKbps: 128 })).toEqual({ icecast_server_url: "a.com", icecast_mount: "/live", icecast_bitrate: 128 });
    expect(SM.patchFrom({ password: "new" })).toEqual({ icecast_password: "new" });
  });
});

describe("listeners from the Icecast server's status page", () => {
  const page = { icestats: { source: [
    { listenurl: "http://stream.x.com:8000/ov", listeners: 12 },
    { listenurl: "http://stream.x.com:8000/halloveen", listeners: 3 },
  ] } };
  it("reads that mount's count, matching the whole path", () => {
    expect(SM.listenersFor(page, "/halloveen")).toBe(3);
    expect(SM.listenersFor(page, "/hallo")).toBe(null);
    expect(SM.listenersFor({ icestats: { source: { listenurl: "http://h:8000/ov", listeners: 0 } } }, "/ov")).toBe(0);   // one source = an object
    expect(SM.listenersFor({ icestats: {} }, "/ov")).toBe(null);
  });
  it("asks http://<server>:8000/status-json.xsl; failures are said, never invented", async () => {
    let asked = "";
    const ok = await SM.fetchListeners({ server: "stream.x.com", mount: "/ov", fetchImpl: async (u) => { asked = u; return { ok: true, json: async () => page }; } });
    expect(asked).toBe("http://stream.x.com:8000/status-json.xsl");
    expect(ok).toEqual({ ok: true, listeners: 12 });
    expect(await SM.fetchListeners({ server: "s", mount: "/ov", fetchImpl: async () => ({ ok: false, status: 404 }) })).toEqual({ ok: false, error: "the server answered 404" });
    expect((await SM.fetchListeners({ server: "s", mount: "/ov", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } })).ok).toBe(false);
    expect(await SM.fetchListeners({ server: "", mount: "/ov" })).toEqual({ ok: false, error: "no server or mount set" });
  });
});

describe("one real stream, two doors", () => {
  const main = read("electron/main.js");
  it("ON AIR and Stream Manager start and stop the same stream", () => {
    expect(main).toMatch(/ipcMain\.handle\('stream:go-live', \(_, args = \{\}\) => streamGoLive\(args\)\);/);
    expect(main).toMatch(/ipcMain\.handle\('stream:stop-live', \(_, args = \{\}\) => streamStopLive\(args\)\);/);
    expect(main).toMatch(/ipcMain\.handle\("stream_start", \(\) => streamGoLive\(\{\}\)\);/);
  });
  it("the old stubs are gone: status and health come from the encoder", () => {
    expect(main).not.toMatch(/Streaming stubs/);
    expect(main).not.toMatch(/let streamActive = false/);
    expect(main).toMatch(/audiodClient\.cmd\("streamStatus", \{ stationId: sid \}\)/);
  });
  it("the screen uses go-live / stop-live and saves on the station, not the old stream_settings row", () => {
    const ui = read("src/components/StreamManager.tsx");
    expect(ui).toMatch(/invoke\("stream:go-live", \{ stationId \}\)/);
    expect(ui).toMatch(/invoke\("stream:stop-live", \{ stationId \}\)/);
    expect(ui).toMatch(/invoke\("stream-manager:save", stationId/);
    expect(ui).not.toMatch(/stream_settings/);
  });
});

describe("a failing stream says why and can be stopped (HalloVeen check, 2026-10-31)", () => {
  const { repeatedFailureMsg } = require_("../audiod/stream");
  it("after repeated failures the server's reason is kept, with what Ether does next", () => {
    expect(repeatedFailureMsg("Forbidden (403)")).toMatch(/^The server refused the stream \(403\): another computer may be sending to this mount/);
    expect(repeatedFailureMsg("Connection refused")).toBe("Connection refused. Ether tries again every 30 seconds; press Stop to end it.");
    expect(repeatedFailureMsg(null)).toMatch(/^The stream could not connect\./);
    const both = read("electron/main.js") + read("audiod/stream.js");
    expect(both).not.toMatch(/Streaming failed after repeated ffmpeg restarts/);
  });
  it("a stopped stream shows no error; Stop is offered in ERROR (Ether keeps retrying until Stop)", () => {
    expect(SM.statusOf({ statusState: "idle", errorMsg: "old" }).errorMsg).toBe(null);
    expect(read("src/components/StreamManager.tsx")).toMatch(/const running = status\.state !== "idle";/);
  });
  it("the daemon's stop clears the error", () => {
    const { StreamSupervisor } = require_("../audiod/stream");
    const s = Object.create(StreamSupervisor.prototype); s._emit = () => {}; s.errorMsg = "x"; s.proc = null;
    s.stop(); expect(s.errorMsg).toBe(null); expect(s.statusState).toBe("idle");
  });
});

describe("the server's own port (item 20)", () => {
  const { serverAndPort } = require_("../audiod/stream");
  it("uses the port written in the address; 8000 when none is", () => {
    expect(serverAndPort("44.244.52.207")).toEqual({ host: "44.244.52.207", port: 8000 });
    expect(serverAndPort("stream.ether-technologies.com:8443")).toEqual({ host: "stream.ether-technologies.com", port: 8443 });
    expect(serverAndPort(" https://stream.x.com:8443/ov ")).toEqual({ host: "stream.x.com", port: 8443 });
  });
  it("the encoder's address, Stream Manager and the listener count all use it", async () => {
    const { StreamSupervisor } = require_("../audiod/stream");
    const s = Object.create(StreamSupervisor.prototype);
    Object.assign(s, { getPort: () => 0, _emit: () => {} });
    expect(SM.settingsOf({ id: 1, icecast_server_url: "stream.x.com:8443", icecast_mount: "/ov" })).toMatchObject({ server: "stream.x.com", port: 8443 });
    let asked = "";
    await SM.fetchListeners({ server: "stream.x.com", mount: "/ov", port: 8443, fetchImpl: async (u) => { asked = u; return { ok: true, json: async () => ({ icestats: {} }) }; } });
    expect(asked).toBe("http://stream.x.com:8443/status-json.xsl");
    expect(read("audiod/stream.js")).toMatch(/const sp = serverAndPort\(server, config\.icecastPort \|\| 8000\);\s*this\.url = `icecast:\/\/source:\$\{pw\}@\$\{sp\.host\}:\$\{sp\.port\}\$\{mount\}`/);
    expect(read("electron/main.js")).not.toMatch(/@\$\{server\}:8000\$\{mount\}/);
  });
});


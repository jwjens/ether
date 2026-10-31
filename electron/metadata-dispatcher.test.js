// Build B (Jeff, 2026-10-30): Stream Metadata Outputs — every song that starts on a station goes out as "Artist - Title"
// to that station's enabled outputs, from main. electron/metadata-dispatcher.js.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const MD = require_("./metadata-dispatcher");
const read = (p) => readFileSync(join(__dirname, "..", p), "utf8");

function server(handler) {
  return new Promise(res => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => res(s)); });
}

describe("what each output is sent", () => {
  it("Artist - Title; just the title when there is no artist", () => {
    expect(MD.songText({ artist: "Britney Spears", title: "...Baby One More Time" })).toBe("Britney Spears - ...Baby One More Time");
    expect(MD.songText({ title: "Station ID" })).toBe("Station ID");
  });
  it("an Icecast output on this station's stream uses Stream Manager's server, mount and source password", () => {
    expect(MD.resolveIcecast({ useStationStream: true }, { icecast_server_url: " 44.244.52.207 ", icecast_port: 8000, icecast_mount: "/halloween", icecast_password: "pw" }))
      .toEqual({ host: "44.244.52.207", port: 8000, mount: "/halloween", adminUser: "source", adminPass: "pw", useHttps: false });
    expect(() => MD.resolveIcecast({ useStationStream: true }, { icecast_server_url: "h", icecast_port: null })).toThrow(/no port set/);
    expect(() => MD.resolveIcecast({ useStationStream: true }, { icecast_server_url: "" })).toThrow(/no stream server/);
    const own = { host: "h", port: 9000, mount: "/x", adminUser: "admin", adminPass: "a" };
    expect(MD.resolveIcecast(own, null)).toBe(own);
  });
});

describe("real pushes (a local server stands in for Icecast / a webhook)", () => {
  it("Icecast: GET /admin/metadata?mount=…&mode=updinfo&song=… with the login", async () => {
    let got = null;
    const s = await server((req, res) => { got = { url: req.url, auth: req.headers.authorization }; res.end("ok"); });
    await MD.pushIcecast({ host: "127.0.0.1", port: s.address().port, mount: "/halloween", adminUser: "source", adminPass: "pw" }, { artist: "A", title: "T & U" });
    s.close();
    expect(got.url).toBe("/admin/metadata?mount=%2Fhalloween&mode=updinfo&song=A%20-%20T%20%26%20U");
    expect(got.auth).toBe("Basic " + Buffer.from("source:pw").toString("base64"));
  });
  it("Icecast refusing (e.g. 401) is an error with the server's answer, never a silent OK", async () => {
    const s = await server((req, res) => { res.statusCode = 401; res.end("Authentication Required"); });
    await expect(MD.pushIcecast({ host: "127.0.0.1", port: s.address().port, mount: "/m" }, { title: "T" })).rejects.toThrow(/HTTP 401/);
    s.close();
  });
  it("webhook: POSTs JSON title/artist", async () => {
    let body = "";
    const s = await server((req, res) => { req.on("data", d => body += d); req.on("end", () => res.end("ok")); });
    await MD.pushWebhook({ url: `http://127.0.0.1:${s.address().port}/np` }, { artist: "A", title: "T" });
    s.close();
    expect(JSON.parse(body)).toMatchObject({ title: "T", artist: "A" });
  });
});

describe("dispatch: the station's enabled outputs only; each row records what it sent and how it went", () => {
  it("sends to station 2's enabled outputs, records ok / the error, and Test re-sends the last song", async () => {
    let hits = 0;
    const s = await server((req, res) => { hits++; res.end("ok"); });
    const port = s.address().port;
    const rows = [
      { id: 1, station_id: 2, name: "hook", type: "webhook", enabled: 1, config_json: JSON.stringify({ url: `http://127.0.0.1:${port}/` }) },
      { id: 2, station_id: 2, name: "broken", type: "webhook", enabled: 1, config_json: JSON.stringify({ url: "http://127.0.0.1:1/" }) },
      { id: 3, station_id: 2, name: "off", type: "webhook", enabled: 0, config_json: "{}" },
      { id: 4, station_id: 9, name: "other station", type: "webhook", enabled: 1, config_json: JSON.stringify({ url: `http://127.0.0.1:${port}/` }) },
    ];
    const results = {};
    const db = { prepare: (sql) => ({
      all: (sid) => rows.filter(r => r.station_id === sid && (!/enabled = 1/.test(sql) || r.enabled)),
      get: (id) => rows.find(r => r.id === id),
      run: (status, err, _at, sent, id) => { results[id] = { status, err, sent }; },
    }) };
    MD._setDb(() => db);
    await MD.dispatch(2, { artist: "A", title: "T" });
    expect(hits).toBe(1);
    expect(results[1]).toEqual({ status: "ok", err: "", sent: "A - T" });
    expect(results[2].status).toBe("error");
    expect(results[3]).toBeUndefined();
    expect(results[4]).toBeUndefined();
    expect(await MD.testPush(1)).toEqual({ ok: true, sent: "A - T" });
    expect(hits).toBe(2);
    s.close();
  });
});

describe("wiring", () => {
  const main = read("electron/main.js");
  it("main installs it and sends on the daemon's playstart (and once per song without the daemon)", () => {
    expect(main).toMatch(/_metadataOut\.installMetadataDispatcher\(ipcMain, getDb\)/);
    expect(main).toMatch(/_metadataOut\?\.dispatch\(m\.stationId, \{ title: m\.title, artist: m\.artist \}\)/);
    expect(main).toMatch(/if \(!AUDIO_DAEMON && _metadataOut/);
  });
  it("preload exposes it; the screen asks for the active station's outputs", () => {
    expect(read("electron/preload.js")).toMatch(/listTargets:\s*\(stationId\)\s*=> ipcRenderer\.invoke\("metadata:list-targets", stationId\)/);
    expect(read("src/components/SettingsPanel.tsx")).toMatch(/<StreamMetadataPanel stationId=\{stationId \?\? null\} \/>/);
  });
  it("no surprise output seeded from the old stream_settings row; the table is local (not synced)", () => {
    expect(read("electron/metadata-dispatcher.js")).not.toMatch(/FROM stream_settings/);
    expect(read("electron/sync/synced-tables.js")).not.toMatch(/stream_metadata_targets/);
  });
});

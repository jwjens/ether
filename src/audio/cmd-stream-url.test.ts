// web-remote slice 2 (docs/web-remote-design-2026-09-16.md §2): the desktop tells the command bus WHICH MACHINE is
// on each SSE connection — `&machine_id=<id>` beside `?key=<license>` — so the backend can deliver a station
// control to the one machine sourcing the stream. The connect waits for the machine id exactly as it waits for the
// key: no id yet → no URL → retry (a connection without an id could never be a target).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { cmdStreamUrl } from "./cmd-routing";

const BASE = "https://backend.example/api/cmd-stream";

describe("cmdStreamUrl (slice 2)", () => {
  it("key + machine id → both on the URL, encoded", () => {
    expect(cmdStreamUrl(BASE, "ETH-AB/12", "mid 7")).toBe(`${BASE}?key=ETH-AB%2F12&machine_id=mid%207`);
  });
  it("no key, or no machine id yet → null (the caller retries; it never connects without an id)", () => {
    expect(cmdStreamUrl(BASE, null, "mid-1")).toBeNull();
    expect(cmdStreamUrl(BASE, "", "mid-1")).toBeNull();
    expect(cmdStreamUrl(BASE, "KEY", null)).toBeNull();
    expect(cmdStreamUrl(BASE, "KEY", "  ")).toBeNull();
  });
  it("App's connect builds its URL with cmdStreamUrl from machineIdRef and retries while it is null", () => {
    const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    const at = app.indexOf("const connect = () => {");
    const connect = app.slice(at, app.indexOf("es = new EventSource(url);", at));
    expect(connect).toMatch(/cmdStreamUrl\(STREAM_BASE, apiKeyRef\.current, machineIdRef\.current\)/);
    expect(connect).toMatch(/if \(!url\) \{[\s\S]*?reconnectTimer = setTimeout\(connect, 1500\);[\s\S]*?return;/);
    // the id is re-asked on each retry while missing, so one empty read at boot can't keep the channel down for ever
    expect(connect).toMatch(/if \(!machineIdRef\.current\) \{[\s\S]*?identity\?\.get\?\.\(\)/);
  });
});

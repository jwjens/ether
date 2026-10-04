// THE DUCKER WENT STALE until it was toggled off and on (OV, 2026-10-04). A daemon that has just (re)started holds
// no duck flags — every channel off — while the board still shows DUCK ON; only the operator's toggle re-sent them.
// The fix: re-arm every station's ducker on EVERY daemon connect, sent to the daemon explicitly (at boot the connect
// handler runs before AUDIO_DAEMON is decided). main.js only loads under Electron, so this is a source contract.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
// Normalised: a Windows checkout (core.autocrlf) has CRLF, and the contract is about code, not line endings.
const src = fs.readFileSync(path.join(here, "main.js"), "utf8").replace(/\r\n/g, "\n");

describe("ducker re-arm on daemon connect", () => {
  it("the connect handler re-arms the duckers, to the daemon", () => {
    const handler = /audiodClient\.setConnectedHandler\(\(\) => \{([\s\S]*?)\n  \}\);/.exec(src);
    expect(handler).toBeTruthy();
    expect(handler[1]).toMatch(/armAllStationDuckers\("daemon-connect", \{ daemon: true \}\)/);
    // …and AFTER the in-process-fallback early return, so it never drives a daemon that is not on air.
    const body = handler[1];
    expect(body.indexOf("armAllStationDuckers")).toBeGreaterThan(body.indexOf("_armInProcessHandover(); return;"));
  });

  it("armAllStationDuckers routes by opts.daemon, not only by the AUDIO_DAEMON global", () => {
    const fn = /function armAllStationDuckers\(reason, opts\) \{([\s\S]*?)\n\}\n/.exec(src);
    expect(fn).toBeTruthy();
    expect(fn[1]).toMatch(/const toDaemon = \(opts && opts\.daemon != null\) \? !!opts\.daemon : AUDIO_DAEMON;/);
    // Every daemon send in it goes by toDaemon, and none is left on the global.
    expect((fn[1].match(/if \(toDaemon\)/g) || []).length).toBe(3);
    expect(/if \(AUDIO_DAEMON\)/.test(fn[1])).toBe(false);
    // and a dropped connection mid-arm is caught, not an unhandled rejection
    expect((fn[1].match(/audiodClient\.cmd\([^;]*\)\.catch\(/g) || []).length).toBe(3);
  });
});

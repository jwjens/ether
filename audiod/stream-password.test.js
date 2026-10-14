// C (Jeff, 2026-10-13): the encoder re-reads the station's saved Icecast password on every (re)connect, so changing it
// in Station settings first and on the server second never drops a station on its next automatic reconnect.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { StreamSupervisor, withPassword } = require_("./stream.js");

describe("stream password re-read", () => {
  it("swaps only the password part of the URL", () => {
    expect(withPassword("icecast://source:hackme@1.2.3.4:8000/ov", "N3w-pass")).toBe("icecast://source:N3w-pass@1.2.3.4:8000/ov");
    expect(withPassword("icecast://source:hackme@1.2.3.4:8000/ov", "")).toBe("icecast://source:hackme@1.2.3.4:8000/ov");
    expect(withPassword("icecast://source:hackme@1.2.3.4:8000/ov", null)).toBe("icecast://source:hackme@1.2.3.4:8000/ov");
  });
  it("every spawn uses the password saved at that moment", () => {
    let saved = "first";
    const s = new StreamSupervisor(1, () => 0, () => {}, () => saved);
    s.url = "icecast://source:hackme@h:8000/m";
    s._kill = () => {};
    const urls = [];
    const cp = require_("child_process");
    const real = cp.spawn;
    cp.spawn = (_b, args) => { urls.push(args[args.length - 1]); const e = new (require_("events"))(); e.stderr = new (require_("events"))(); return e; };
    try { s._spawn(1); saved = "second"; s._spawn(1); saved = null; s._spawn(1); } finally { cp.spawn = real; }
    expect(urls).toEqual(["icecast://source:first@h:8000/m", "icecast://source:second@h:8000/m", "icecast://source:second@h:8000/m"]);
  });
});

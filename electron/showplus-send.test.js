// Show+ DAW "To Deck" (Jeff, 2026-10-30): the mix is written to a real file and handed to the deck load.
// electron/showplus-send.js.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { sendMixToDeck, sendFileName, KEEP_MS } = require_("./showplus-send");

/** A minimal valid WAV header + a few samples. */
function wav() {
  const b = Buffer.alloc(52);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(44, 4); b.write("WAVE", 8, "ascii"); b.write("fmt ", 12, "ascii");
  return new Uint8Array(b);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "showplus-send-"));

describe("Show+ DAW → deck", () => {
  it("writes the mix as a file and loads that file on the chosen deck, for the window's station", async () => {
    const dir = tmp(); const calls = [];
    const r = await sendMixToDeck({ deck: "b", wav: wav(), stationId: 3 },
      { dir, fs, now: 1000, load: async (...a) => { calls.push(a); return true; } });
    expect(r.ok).toBe(true);
    expect(r.deck).toBe("B");
    expect(fs.existsSync(r.filePath)).toBe(true);
    expect(path.basename(r.filePath)).toBe(sendFileName(1000));
    expect(calls).toEqual([["B", r.filePath, "Show+ Mix", "", 0, 3]]);
  });

  it("refuses a deck automation does not own, an empty mix and anything that is not a WAV — and loads nothing", async () => {
    const dir = tmp(); let loads = 0; const load = async () => { loads++; return true; };
    expect((await sendMixToDeck({ deck: "D", wav: wav() }, { dir, fs, load })).reason).toBe("deck-not-allowed");
    expect((await sendMixToDeck({ deck: "A", wav: new Uint8Array() }, { dir, fs, load })).reason).toBe("nothing-to-send");
    expect((await sendMixToDeck({ deck: "A", wav: new Uint8Array(60) }, { dir, fs, load })).reason).toBe("not-a-wav");
    expect(loads).toBe(0);
  });

  it("says so when the deck load fails", async () => {
    const r = await sendMixToDeck({ deck: "A", wav: wav() }, { dir: tmp(), fs, load: async () => false });
    expect(r).toMatchObject({ ok: false, reason: "load-failed" });
  });

  it("removes sends older than a week, never the new one or other files", async () => {
    const dir = tmp(); const now = 10 * KEEP_MS;
    fs.writeFileSync(path.join(dir, sendFileName(now - KEEP_MS - 1)), "old");
    fs.writeFileSync(path.join(dir, sendFileName(now - 1000)), "recent");
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
    const r = await sendMixToDeck({ deck: "A", wav: wav() }, { dir, fs, now, load: async () => true });
    expect(fs.readdirSync(dir).sort()).toEqual([path.basename(r.filePath), sendFileName(now - 1000), "notes.txt"].sort());
  });
});

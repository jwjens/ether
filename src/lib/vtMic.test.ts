// Build D (Jeff, 2026-10-30): the voice-tracking mic is saved and Voice Tracker records from it, in the main window and
// its pop-out; if it's gone, the default mic is used and the screen says so.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { openVtMic } from "./vtMic";

const fake = { id: "s" } as unknown as MediaStream;
const err = (name: string) => Object.assign(new Error(name), { name });

describe("opening the voice-tracking mic", () => {
  it("opens exactly the picked mic", async () => {
    const asked: any[] = [];
    const r = await openVtMic("mic-1", async c => { asked.push(c); return fake; });
    expect(r.fellBack).toBe(false);
    expect(asked).toEqual([{ audio: { deviceId: { exact: "mic-1" } } }]);
  });
  it("no pick = the default mic", async () => {
    const asked: any[] = [];
    expect((await openVtMic("", async c => { asked.push(c); return fake; })).fellBack).toBe(false);
    expect(asked).toEqual([{ audio: true }]);
  });
  it("picked mic unplugged → the default mic, and it says it fell back", async () => {
    for (const name of ["OverconstrainedError", "NotFoundError"]) {
      const asked: any[] = [];
      const r = await openVtMic("gone", async c => { asked.push(c); if ((c as any).audio?.deviceId) throw err(name); return fake; });
      expect(r).toEqual({ stream: fake, fellBack: true });
      expect(asked[1]).toEqual({ audio: true });
    }
  });
  it("a refused permission is not hidden behind the default mic", async () => {
    await expect(openVtMic("mic-1", async () => { throw err("NotAllowedError"); })).rejects.toThrow("NotAllowedError");
  });
});

describe("the pick is saved and both Voice Tracker windows use it", () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", "components", f), "utf8");
  it("Settings saves the click (it used to change only the screen)", () => {
    const s = read("SettingsPanel.tsx");
    expect(s).toMatch(/onClick=\{\(\) => selectVtMic\(d\.deviceId\)\}/);
    expect(s).toMatch(/useState<string>\(\(\) => getVtMic\(\)\)/);
  });
  it("Voice Tracker reads the saved mic itself, so the pop-out (which passes nothing) uses it too", () => {
    const v = read("VoiceTracker.tsx");
    expect(v).toMatch(/openVtMic\(inputDeviceId \|\| getVtMic\(\)/);
    expect(read("PopoutRenderer.tsx")).toMatch(/<VoiceTracker \/>/);
  });
});

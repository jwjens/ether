// Every audio picker on screen does what it says (Jeff, 2026-10-27: "Remove the dead "Where music plays" picker in
// Settings → Audio. Rename "Cue / headphone output" to say it is the Track Editor preview player, so the PFL picker is
// the only cue picker."). docs/audio-output-selectors-wiring-2026-10-27.md.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), "utf8");
const all: string[] = [];
(function walk(d: string) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name)) all.push(p);
  }
})(SRC);
const filesMatching = (re: RegExp) => all.filter(p => re.test(fs.readFileSync(p, "utf8"))).map(p => path.basename(p)).sort();

describe("Settings → Audio: no picker that lights up and does nothing", () => {
  const settings = read("components", "SettingsPanel.tsx");
  it("the dead \"Where music plays\" output picker is gone (it only set on-screen state)", () => {
    expect(settings).not.toMatch(/setCurrentOutput|currentOutput/);
    expect(settings).not.toMatch(/>Where music plays</);
    expect(fs.existsSync(path.join(SRC, "components", "AudioDevices.tsx"))).toBe(false);   // the unrendered copy
    expect(filesMatching(/>\s*Where music plays/)).toEqual([]);
  });
  it("it points to where a station's output really is set: the Patch Bay (docs/ether-audio-patch-bay-plan.md step 1)", () => {
    expect(settings).toMatch(/Patch Bay/);
    expect(settings).not.toMatch(/Station Monitors → OUTPUT/);
  });
});

describe("the PFL picker is the only cue picker", () => {
  const settings = read("components", "SettingsPanel.tsx");
  it("\"Cue / headphone output\" is now the Track Editor preview player, and says it is not the cue", () => {
    expect(filesMatching(/Cue \/ headphone output/)).toEqual([]);
    expect(settings).toMatch(/>Track Editor preview player</);
    expect(settings).toMatch(/This is not the cue: PFL has its own device/);
    expect(settings).not.toMatch(/>CUE<\/span>/);
  });
  it("its setting is read only by the Track Editor's preview (browser audio), never by the engine", () => {
    expect(filesMatching(/ether_cue_device/)).toEqual(["SettingsPanel.tsx", "TrackEditor.tsx"]);
    expect(read("components", "TrackEditor.tsx")).toMatch(/setSinkId\(cueDeviceId \|\| ""\)/);
  });
});

// THE PATCH BAY, OUTPUTS (Jeff, 2026-10-27, Outputs answer 1: "in one place only"; answer 3: "AUX moves into Outputs").
describe("every output is patched in one place: the Patch Bay", () => {
  it("no screen sets the Master, Cue or Aux device any other way", () => {
    expect(filesMatching(/audio\?\.setOutputDevice\?\.\(|audio\.setOutputDevice\(/)).toEqual([]);
    expect(filesMatching(/audio\?\.setCueDevice\?\.\(|audio\.setCueDevice\(/)).toEqual([]);
    expect(filesMatching(/audio\?\.setAuxDevice\?\.\(|audio\.setAuxDevice\(/)).toEqual([]);
    expect(filesMatching(/"station_config_kv:set-local", [^,]+, "(audio_output_device|aux_monitor_device|pfl_cue_device)"/)).toEqual([]);
  });
  it("the Patch Bay is the one writer, and every old picker's place points to it", () => {
    expect(filesMatching(/patchBay\?\.set\?\.\(/)).toEqual(["PatchBay.tsx"]);
    for (const f of ["StationMonitorMixer.tsx", "AuxMonitorSlots.tsx", "PflSettings.tsx"]) expect(read("components", f)).toMatch(/<PatchBayPointer /);
  });
  it("its doors: the native menu (Patch Bay) and a Patch Bay button where each old picker was; it replaces Audio Routing", () => {
    expect(fs.readFileSync(path.join(SRC, "..", "electron", "main.js"), "utf8")).toMatch(/label: "Patch Bay", click: \(\) => menuNav\("nav:multioutput", "multioutput"\)/);
    expect(read("components", "PatchBayPointer.tsx")).toMatch(/"window:popout", "multioutput"/);
    expect(read("components", "PopoutRenderer.tsx")).toMatch(/case "multioutput":\s+content = <PatchBay \/>/);
  });
});

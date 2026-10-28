// THE WINDOW NEVER WRITES A BOARD VALUE IT DIDN'T GET FROM THE OPERATOR (Jeff, 2026-10-12;
// docs/station-monitor-zeroed-at-attach-2026-10-12.md). Every startup / attach / mount write the audit found, held out.
// The engine's attach path is proven at runtime by src/audio/attach-restore-sequence.test.ts; these are the mount effects
// in React components this suite cannot render, so their SOURCE is guarded — a write coming back fails here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
/** The body of the first useEffect whose text contains `marker` (to its closing `}, [` deps). */
function effectWith(file: string, marker: string): string {
  const s = src(file);
  const at = s.indexOf(marker);
  if (at < 0) throw new Error(`${file}: marker not found: ${marker}`);
  const start = s.lastIndexOf("useEffect(", at);
  const end = s.indexOf("}, [", at);
  return s.slice(start, end);
}

describe("no board writes on startup, attach or mount", () => {
  it("engine attach: no station MONITOR zero, no MASTER re-assert, no segue re-push", () => {
    const e = src("audio/engine-rodio.ts");
    expect(e).not.toMatch(/assertMonitorSilence|reassertMaster|operatorMasterLevel|noteOperatorMonitor|pushSegueOverlap/);
  });
  it("App: the segue overlap load only displays; the CART cut is never pushed on mount", () => {
    expect(effectWith("App.tsx", 'find(x => x.key === "segue_overlap_sec")')).not.toMatch(/setSegueOverlap\?\.\(|engine/);
    const a = src("App.tsx");
    expect(a).not.toMatch(/getDeck\("CART" as any\) as any\)\?\.setMuted/);
    expect(effectWith("App.tsx", "ether:cartChannelOn:")).not.toMatch(/setMuted|audio\?*\.set/);
  });
  it("FaderSection: the jukebox cut is read, not sent, on mount", () => {
    expect(effectWith("components/FaderSection.tsx", '"jukebox_channel_on"')).not.toMatch(/setMuted|setVolume/);
  });
  it("DuckerSection: opening the panel sends nothing", () => {
    expect(effectWith("components/DuckerSection.tsx", "stationConfigKv.list(stationId)")).not.toMatch(/push\(|setDuckParams/);
  });
  // The Audio Routing panel was replaced by the Patch Bay (docs/ether-audio-patch-bay-plan.md step 1). Opening it reads; only
  // a click on a crosspoint sends.
  it("PatchBay: no output patch is sent on open", () => {
    expect(effectWith("components/PatchBay.tsx", "ether?.patchBay?.get?.(s.id)")).not.toMatch(/patchBay\?\.set|setOutputDevice/);
    expect(effectWith("components/PatchBay.tsx", "ether?.patchBay?.state?.(s.id)")).not.toMatch(/patchBay\?\.set|setOutputDevice/);
  });
  it("MONITOR faders: no localStorage placeholder, nothing sent on mount", () => {
    const m = src("components/MasterOutput.tsx"), b = src("components/BroadcastMonitor.tsx");
    expect(m).not.toMatch(/ether_monitor_vol/);
    expect(b).not.toMatch(/ether_monitor_vol|0\.8'\)/);
    expect(effectWith("components/MasterOutput.tsx", "setMonitorVol(monitorLevel())")).not.toMatch(/applyMonitor|setMasterMonitorVolume/);
  });
  it("useMicMigration: the old browser mic is handed over once and forgotten", () => {
    expect(src("hooks/useMicMigration.ts")).toMatch(/localStorage\.removeItem\(`ether_mic_device_\$\{from\}`\)/);
  });
  it("AuxMonitorSlots: saved rows are read at their real level (a row above 0 dB is not pulled to 1 by the next save)", () => {
    const s = src("components/AuxMonitorSlots.tsx");
    expect(s).not.toMatch(/map\[k\] = Math\.max\(0, Math\.min\(1, n\)\)/);
    expect(s).toMatch(/map\[k\] = Math\.max\(0, Math\.min\(MAX_GAIN, n\)\)/);
  });
});

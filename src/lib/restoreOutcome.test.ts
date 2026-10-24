// The restore screen shows the download job's real count (docs/halloveen-join-61-file-errors-2026-10-23.md).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { restoreOutcome } from "./restoreOutcome";

describe("restoreOutcome", () => {
  it("the jensj work PC's restore is a success, not 'no music could be downloaded'", () => {
    // Shaped like that restore: 612 in the cloud list, 61 of them entries for deleted songs that were never uploaded.
    // The split between pulled and already-here is illustrative; the PC's own counts were never logged.
    const o = restoreOutcome({ downloaded: 216, alreadyLocal: 335, remoteFiles: 612, errors: 0, prunedFromManifest: 61 });
    expect(o.ok).toBe(true);
    if (o.ok) expect(o.sub).toBe("216 files downloaded · 335 already here · 61 old cloud-list entries cleaned up");
  });

  it("a Retry that finds everything already here is a success", () => {
    const o = restoreOutcome({ downloaded: 0, alreadyLocal: 551, remoteFiles: 551, errors: 0 });
    expect(o.ok).toBe(true);
    if (o.ok) expect(o.sub).toBe("0 files downloaded · 551 already here");
  });

  it("real errors are counted as skipped files", () => {
    const o = restoreOutcome({ downloaded: 10, errors: 2 });
    expect(o).toEqual({ ok: true, sub: "10 files downloaded · 2 files skipped" });
  });

  it("nothing at all on this machine is a failure, with the error count", () => {
    const o = restoreOutcome({ downloaded: 0, alreadyLocal: 0, remoteFiles: 40, errors: 40 });
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.message).toMatch(/no music could be downloaded from the cloud \(40 file errors\)/);
  });

  it("a fatal job error names the reason", () => {
    const o = restoreOutcome({ fatal: "fetch failed", downloaded: 0, errors: 1 });
    expect(o).toEqual({ ok: false, message: "Your station database was restored, but the music download failed: fetch failed" });
  });

  it("stalled and cancelled keep their own messages", () => {
    expect(restoreOutcome({ stalled: true }).ok).toBe(false);
    const c = restoreOutcome({ aborted: true, downloaded: 5 });
    expect(c).toEqual({ ok: false, message: "Music download was cancelled before it finished." });
  });

  it("OnboardingFlow takes its verdict from restoreOutcome and never reads result.done", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "components", "OnboardingFlow.tsx"), "utf8");
    expect(src).toMatch(/restoreOutcome\(result\)/);
    expect(src).not.toMatch(/result\?\.done/);
  });

  it("downloadCatalogue really returns the fields restoreOutcome reads", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "audio-library-r2.js"), "utf8");
    const start = src.indexOf("async function downloadCatalogue");
    const body = src.slice(start, src.indexOf("result.elapsedMs", start));
    for (const f of ["downloaded:", "alreadyLocal:", "remoteFiles:", "errors:", "prunedFromManifest"]) expect(body).toContain(f);
  });
});

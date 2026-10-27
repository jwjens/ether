// An isolated launch (ETHER_SMOKE=1 + --user-data-dir) never touches the live app (2026-10-27, the 4.6.66 release check:
// a second launch on the on-air computer lost the single-instance lock and quit with no startup log, because main.js
// replaced its --user-data-dir with the real Roaming\Ether; isolated mode had the same redirect and shared the live
// engine's pipe). electron/main.js, before the single-instance lock.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const at = (s) => { const i = main.indexOf(s); expect(i, `missing: ${s}`).toBeGreaterThan(-1); return i; };

describe("isolated launch: its own folders and its own engine pipe", () => {
  it("is decided before userData is set, and only from BOTH ETHER_SMOKE=1 and an explicit --user-data-dir", () => {
    const decl = at("const SMOKE_ISOLATED = process.env.ETHER_SMOKE === '1' && app.commandLine.hasSwitch('user-data-dir');");
    expect(decl).toBeLessThan(at('const _newUserData = path.join(_appData, "Ether");'));
    expect(main.match(/const SMOKE_ISOLATED =/g)).toHaveLength(1);
  });
  it("keeps its own --user-data-dir; only a normal launch is redirected to Roaming\\Ether", () => {
    const block = main.slice(at("if (SMOKE_ISOLATED) {\n  try { app.setPath(\"userData\""), at('const _appData = app.getPath("appData");'));
    expect(block).toMatch(/app\.setPath\("userData", app\.commandLine\.getSwitchValue\('user-data-dir'\)\)/);
    expect(block).toMatch(/\} else try \{\n  $/);                                          // the redirect is the else branch
  });
  it("gets its own engine pipe, set before the engine client computes its endpoint", () => {
    const set = at("process.env.ETHER_AUDIOD_PIPE = process.platform === \"win32\"");
    expect(main.slice(set, set + 200)).toMatch(/ether-audiod-smoke-\$\{process\.pid\}/);
    expect(set).toBeLessThan(at('require("./audio-daemon-client")'));
    // and an explicit pipe from the caller wins
    expect(main.slice(set - 120, set)).toMatch(/if \(!process\.env\.ETHER_AUDIOD_PIPE\) \{/);
  });
  it("the engine client and the daemon both take the pipe from ETHER_AUDIOD_PIPE", () => {
    expect(fs.readFileSync(path.join(__dirname, "audio-daemon-client.js"), "utf8")).toMatch(/if \(process\.env\.ETHER_AUDIOD_PIPE\) return process\.env\.ETHER_AUDIOD_PIPE;/);
    expect(fs.readFileSync(path.join(__dirname, "..", "audiod", "ether-audiod.js"), "utf8")).toMatch(/if \(process\.env\.ETHER_AUDIOD_PIPE\) return process\.env\.ETHER_AUDIOD_PIPE;/);
  });
  // (2026-10-27, 4.6.66: the release check must show the queue filling from today's log in the side-by-side launch.)
  it("ETHER_SMOKE_FILL_STATION: its own engine fills that station's queue (fill — nothing plays), and PASS needs items", () => {
    const blk = main.slice(at("const fillSid = Number(process.env.ETHER_SMOKE_FILL_STATION || 0);"), at("finishSmoke(rootKids > 0"));
    expect(blk).toMatch(/audiodClient\.cmd\("fill", \{ stationId: fillSid \}\)/);
    expect(blk).not.toMatch(/automationStart|startStream/);
    const fin = main.slice(at("finishSmoke(rootKids > 0"), at("finishSmoke(rootKids > 0") + 200);
    expect(fin).toMatch(/&& \(!fillSid \|\| fillN > 0\)/);
  });
  it("fill mode waits for the daemon handover before judging daemon_started (cold stage boots in-process for ~5 s)", () => {
    const wait = at("for (let i = 0; i < 80 && AUDIO_DAEMON !== true; i++) await new Promise(r => setTimeout(r, 250));");
    expect(wait).toBeLessThan(at("const daemonStarted = AUDIO_DAEMON === true;"));
    expect(main.slice(wait - 200, wait)).toMatch(/if \(Number\(process\.env\.ETHER_SMOKE_FILL_STATION \|\| 0\) && AUDIO_DAEMON_DESIRED\) \{/);
  });
  it("with real data, air isolation is a copy with no account session — never stations alone", () => {
    expect(main).toMatch(/const airIsolated = stationCount === 0 \|\| \(fillSid > 0 && noAccount\);/);
    expect(main).toMatch(/SELECT 1 FROM install_config_kv WHERE key IN \('account_jwt','account_license_key'\)/);
    expect(main).toMatch(/\(!SMOKE_ISOLATED \|\| airIsolated\)/);
  });
  it("a normal launch still takes the single-instance lock (two Ethers must never drive one engine)", () => {
    const lock = main.slice(at("if (SMOKE_ISOLATED) {\n  console.log('[SMOKE] ISOLATED MODE"), at("// ── Environment"));
    expect(lock).toMatch(/\} else \{[\s\S]*if \(!app\.requestSingleInstanceLock\(\)\) \{[\s\S]*app\.quit\(\);/);
  });
});

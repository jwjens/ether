// Remote Link pairing, main-process wiring (2026-10-04). main.js only loads under Electron, so the wiring is pinned as
// a source contract (CRLF-normalised); the client it drives is tested for real in link-pairing-client.test.js.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const main = fs.readFileSync(path.join(here, "main.js"), "utf8").replace(/\r\n/g, "\n");
const preload = fs.readFileSync(path.join(here, "preload.js"), "utf8").replace(/\r\n/g, "\n");

describe("pairing IPC", () => {
  it("the four pairing handlers exist and are exposed to the renderer", () => {
    for (const ch of ["link:account-machines", "link:pair-machine", "link:pair-code", "link:pair-redeem"]) {
      expect(main).toContain(`ipcMain.handle("${ch}"`);
      expect(preload).toContain(`"${ch}"`);
    }
  });
  it("the client runs behind the dev-write guard and the account token", () => {
    expect(main).toMatch(/createLinkPairingClient\(\{[\s\S]{0,300}canWrite: \(\) => canWriteProduction\(\)/);
    expect(main).toMatch(/key='account_jwt'/);
  });
  it("a paired key goes through the SAME apply path as a pasted one, after the loop refusal", () => {
    const fn = /async function _linkApplyFrom\(sid, from\) \{([\s\S]*?)\n\}\n/.exec(main);
    expect(fn).toBeTruthy();
    expect(fn[1]).toMatch(/LinkCfg\.inputRefusal\(/);
    expect(fn[1]).toMatch(/_linkSetInputCore\(sid, edit, from\)/);
    expect(fn[1].indexOf("inputRefusal")).toBeLessThan(fn[1].indexOf("_linkSetInputCore"));
    expect(main).toMatch(/ipcMain\.handle\("link:set-input", \(_, stationId, input\) => _linkSetInputCore\(Number\(stationId\), input\)\)/);
  });
  it("this machine's key is published when it is made and when it is replaced", () => {
    const mint = /ipcMain\.handle\("link:mint-key"[\s\S]*?\n\}\);/.exec(main)[0];
    expect(mint).toMatch(/_linkPublishOwnKey\("replaced"\)/);
    const line = /ipcMain\.handle\("link:key-line"[\s\S]*?\n\}\);/.exec(main)[0];
    expect(line).toMatch(/_linkPublishOwnKey\("made"\)/);
  });
  it("receivers re-fetch every minute — only faders paired from the account", () => {
    const fn = /async function _linkRefetchAccountKeys\(\) \{([\s\S]*?)\n\}\n/.exec(main);
    expect(fn).toBeTruthy();
    expect(fn[1]).toMatch(/stored\.from\.via !== "account"/);
    expect(main).toMatch(/setInterval\(\(\) => \{ _linkRefetchAccountKeys\(\); \}, 60000\)/);
  });
});

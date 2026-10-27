// The installer stops the old app, its watchdog and its audio engine cleanly BEFORE installing (Jeff, 2026-10-27: "The
// installer stops the old audio engine and the watchdog cleanly before installing, so a new version never runs on an old
// engine."). build-resources/installer.nsh customInit → build-resources/stop-ether.ps1; electron/main.js --stop-and-quit.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const nsh = read("build-resources", "installer.nsh");
const ps1 = read("build-resources", "stop-ether.ps1");
const main = read("electron", "main.js");
const at = (s, x) => { const i = s.indexOf(x); expect(i, `missing: ${x}`).toBeGreaterThan(-1); return i; };

describe("installer.nsh customInit", () => {
  const init = nsh.slice(at(nsh, "!macro customInit"), nsh.indexOf("!macroend", nsh.indexOf("!macro customInit")));
  it("ships the stop script and runs it first, hidden", () => {
    expect(init).toMatch(/File "\/oname=\$PLUGINSDIR\\stop-ether\.ps1" "\$\{BUILD_RESOURCES_DIR\}\\stop-ether\.ps1"/);
    expect(init).toMatch(/nsExec::Exec 'powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\$PLUGINSDIR\\stop-ether\.ps1"'/);
  });
  it("then the backstop ends the app, the watchdog AND the engine — the engine is no longer left running", () => {
    const run = init.indexOf("stop-ether.ps1\"'");
    expect(init.indexOf("taskkill /F /T /IM Ether.exe")).toBeGreaterThan(run);
    expect(init.indexOf("taskkill /F /IM ether-engine.exe")).toBeGreaterThan(run);
    expect(nsh).not.toMatch(/do NOT kill the detached audio engine/);
  });
});

describe("stop-ether.ps1: clean first, in order, logged, never failing the install", () => {
  it("asks the app to Stop & Quit, then stands the watchdog down, then shuts the engine over its pipe, then ends leftovers", () => {
    const ask = at(ps1, "-ArgumentList '--stop-and-quit'");
    const sentinel = at(ps1, "'.ether-clean-exit'");
    const endApp = at(ps1, "$left = @(Procs | Where-Object { $_.Name -eq 'Ether.exe' -and (Kind $_) -ne 'engine' })");
    const pipe = at(ps1, "NamedPipeClientStream('.', 'ether-audiod'");
    const shutdown = at(ps1, `'{"id":1,"cmd":"shutdown"}'`);
    const endEngine = at(ps1, "engine: still running after 15 s - ending pid");
    expect(ask).toBeLessThan(sentinel);
    expect(sentinel).toBeLessThan(endApp);
    expect(endApp).toBeLessThan(pipe);
    expect(pipe).toBeLessThan(shutdown);
    expect(shutdown).toBeLessThan(endEngine);
  });
  it("the --stop-and-quit launch is only made when the main app is running (an old Ether.exe would otherwise START)", () => {
    expect(ps1).toMatch(/\$app = @\(\$all \| Where-Object \{ \(Kind \$_\) -eq 'app' \}\) \| Select-Object -First 1\s*\nif \(\$app -and \$app\.ExecutablePath\) \{/);
  });
  it("the watchdog and the engine are told apart from the app", () => {
    expect(ps1).toMatch(/if \(\$c -match '--ether-watchdog'\) \{ return 'watchdog' \}/);
    expect(ps1).toMatch(/if \(\$p\.Name -eq 'ether-engine\.exe' -or \$c -match 'ether-audiod\\\.js'\) \{ return 'engine' \}/);
  });
  it("is plain ASCII: Windows PowerShell 5.1 reads a BOM-less file as ANSI, and an em dash's bytes include a curly quote it parses AS a quote (found 2026-10-27: 4 parse errors)", () => {
    const bytes = fs.readFileSync(path.join(__dirname, "..", "build-resources", "stop-ether.ps1"));
    expect([...bytes].filter(b => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09))).toEqual([]);
  });
  it("every step goes to %TEMP%\\ether-installer-stop.log, and it always exits 0", () => {
    expect(ps1).toMatch(/\$log = Join-Path \$env:TEMP 'ether-installer-stop\.log'/);
    expect(ps1).not.toMatch(/exit [1-9]/);
    expect(ps1).toMatch(/Say "stopped: no Ether, watchdog or engine process left"/);
  });
});

describe("main.js --stop-and-quit", () => {
  it("a running Ether asked by a second instance does its full Stop & Quit (watchdog stood down, engine shut)", () => {
    const h = main.slice(at(main, "app.on('second-instance', (_e, argv) => {"), main.indexOf("SelfActions.operatorAct()", at(main, "app.on('second-instance'")));
    expect(h).toMatch(/if \(Array\.isArray\(argv\) && argv\.includes\('--stop-and-quit'\)\) \{[\s\S]*fullStopAndQuit\(\);\s*\n\s*return;/);
    const fq = main.slice(at(main, "function fullStopAndQuit() {"), main.indexOf("\n}\n", at(main, "function fullStopAndQuit() {")));
    expect(fq).toMatch(/pauseKeepOnAir\(\)/);
    expect(fq).toMatch(/audiodClient\.cmd\("shutdown"\)/);
  });
  it("with nothing running, --stop-and-quit exits at once and never starts Ether", () => {
    const i = at(main, "if (global.__etherDiag) global.__etherDiag('POINT-3: lock acquired OK');");
    expect(main.slice(i, i + 900)).toMatch(/if \(process\.argv\.includes\('--stop-and-quit'\)\) \{[^}]*app\.exit\(0\); process\.exit\(0\); \}/);
  });
});

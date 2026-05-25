import { describe, it, expect } from "vitest";
import { buildElevatePs, psSingleQuote } from "./ha-elevate.js";

describe("psSingleQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(psSingleQuote("enable")).toBe("'enable'");
  });

  it("doubles embedded single quotes (injection-safe)", () => {
    expect(psSingleQuote("a'; calc; '")).toBe("'a''; calc; '''");
  });

  it("preserves spaces and backslashes without escaping them", () => {
    expect(psSingleQuote("C:\\Program Files\\Ether\\ha-setup.exe"))
      .toBe("'C:\\Program Files\\Ether\\ha-setup.exe'");
  });
});

describe("buildElevatePs", () => {
  const exe = "C:\\Program Files\\Ether\\resources\\ha-setup.exe";
  const args = ["enable", "--result", "C:\\Temp\\r.json", "--user", "DESKTOP-AB12\\jensj", "--pipe", "\\\\.\\pipe\\ether-ha-abcd"];

  it("elevates with RunAs, waits, and returns the child exit code", () => {
    const cmd = buildElevatePs(exe, args);
    expect(cmd).toContain("-Verb RunAs");
    expect(cmd).toContain("-PassThru");
    expect(cmd).toContain("-Wait");
    expect(cmd).toContain("exit $p.ExitCode");
  });

  it("single-quotes the exe path and every argument", () => {
    const cmd = buildElevatePs(exe, args);
    expect(cmd).toContain("-FilePath 'C:\\Program Files\\Ether\\resources\\ha-setup.exe'");
    expect(cmd).toContain("-ArgumentList 'enable','--result','C:\\Temp\\r.json','--user','DESKTOP-AB12\\jensj','--pipe','\\\\.\\pipe\\ether-ha-abcd'");
  });

  it("neutralizes a username that tries to break out of the quoting", () => {
    const cmd = buildElevatePs(exe, ["enable", "--user", "evil'; Remove-Item C:\\ -Recurse; '"]);
    // the malicious quote is doubled, so it stays inside the single-quoted literal
    expect(cmd).toContain("'evil''; Remove-Item C:\\ -Recurse; '''");
    expect(cmd).not.toMatch(/--user'\s*;\s*Remove-Item/);
  });
});

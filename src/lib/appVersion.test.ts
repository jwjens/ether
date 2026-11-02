import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appVersionField, _setVersionForTest } from "./appVersion";

describe("this build's version rides on sign-in and the account check", () => {
  it("app_version once known; nothing before (the server then reads the User-Agent)", () => {
    _setVersionForTest(null);
    expect(appVersionField()).toEqual({});
    _setVersionForTest("4.6.71");
    expect(appVersionField()).toEqual({ app_version: "4.6.71" });
  });
  it("wired: every sign-in and account-check request body carries it", () => {
    const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
    const onb = read("components/OnboardingFlow.tsx"), sub = read("components/SubscriptionPanel.tsx");
    expect((onb.match(/\.\.\.appVersionField\(\)/g) || []).length).toBe(3);   // sign-in + two account checks
    expect(sub).toMatch(/os: navigator\.platform, \.\.\.appVersionField\(\) \}/);
    expect(read("lib/ccData.ts")).toMatch(/machine_name: idResp\?\.ok \? idResp\.machine_name : "",\n\s+\.\.\.appVersionField\(\),/);
    expect(read("lib/licenseGuard.ts")).toMatch(/\.\.\.appVersionField\(\),/);
  });
});

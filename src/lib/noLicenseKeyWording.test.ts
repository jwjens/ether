import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Customers never see or use a license key (Jeff, 2026-11-01: the email is the license; keys are internal). The screens a
// customer reaches carry no key wording. (The old onboarding key screens are unreachable — the app always opens on the
// account sign-in — and are left as they are.)
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const FILES = ["components/SubscriptionPanel.tsx", "components/ManageDevices.tsx", "components/CloudBackup.tsx", "components/HelpPanel.tsx", "App.tsx"];

describe("no license key wording on the screens customers reach", () => {
  for (const f of FILES) {
    it(f, () => {
      const visible = read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\{\/\*)/.test(l)).join("\n");
      expect(visible).not.toMatch(/Enter License Key|enter a license key|Enter your license key|No license key is set|>License Key</);
      expect(visible).not.toMatch(/Ether Global Technologies/);
    });
  }
  it("the Subscription panel offers only Sign In", () => {
    const s = read("components/SubscriptionPanel.tsx");
    expect(s).toMatch(/Sign in with your Ether account\./);
    expect(s).not.toMatch(/\{showLicenseEntry && \(/);
  });
  it("the sign-in panel names the plan by its current name (Network, not Unlimited)", () => {
    const s = read("components/SubscriptionPanel.tsx");
    expect(s).toMatch(/During your free trial this unlocks the full Network plan\./);
    expect(s).not.toMatch(/full Unlimited plan/);
  });
});

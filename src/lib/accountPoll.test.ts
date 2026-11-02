import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LICENSE_CHANGED, announceLicenseKey, announcedKey, accountPollReady, startAccountPoll, ACCOUNT_POLL_MS } from "./accountPoll";

// The regular account check after a FRESH sign-in (billing test 2026-11-01: the app checked once and never again until
// reopened, so no billing popup and no cloud station sync in that session).

describe("account check gate", () => {
  const base = { firstRunChecked: true, accountSignedIn: true, hasAccountJwt: false, licenseKey: "ETH-STN-AAAA-BBBB" };
  it("runs once the app is initialised, an account is signed in and a key is known", () => {
    expect(accountPollReady(base)).toBe(true);
    expect(accountPollReady({ ...base, accountSignedIn: false, hasAccountJwt: true })).toBe(true);
  });
  it("waits for the key (the fresh sign-in case: the key arrives after the account is signed in)", () => {
    expect(accountPollReady({ ...base, licenseKey: "" })).toBe(false);
    expect(accountPollReady({ ...base, licenseKey: "   " })).toBe(false);
  });
  it("never before init, never with no account", () => {
    expect(accountPollReady({ ...base, firstRunChecked: false })).toBe(false);
    expect(accountPollReady({ ...base, accountSignedIn: false, hasAccountJwt: false })).toBe(false);
  });
});

describe("the check itself", () => {
  it("runs now, then every 20 s, until stopped", () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn();
      const stop = startAccountPoll(check);
      expect(check).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(ACCOUNT_POLL_MS * 3);
      expect(check).toHaveBeenCalledTimes(4);
      stop();
      vi.advanceTimersByTime(ACCOUNT_POLL_MS * 3);
      expect(check).toHaveBeenCalledTimes(4);
    } finally { vi.useRealTimers(); }
  });
});

describe("calls the timers the way a browser allows", () => {
  it("never calls setInterval as a method of another object (a browser throws 'Illegal invocation' — the rerun crash)", () => {
    const real = globalThis.setInterval, realClear = globalThis.clearInterval;
    const strict = function (this: unknown, ...a: any[]) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return (real as any)(...a);
    };
    const strictClear = function (this: unknown, id: any) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return (realClear as any)(id);
    };
    (globalThis as any).setInterval = strict; (globalThis as any).clearInterval = strictClear;
    try {
      const check = vi.fn();
      let stop: () => void = () => {};
      expect(() => { stop = startAccountPoll(check); }).not.toThrow();
      expect(() => stop()).not.toThrow();
      expect(check).toHaveBeenCalledTimes(1);
    } finally { (globalThis as any).setInterval = real; (globalThis as any).clearInterval = realClear; }
  });
});

describe("the key is announced with the announcement", () => {
  it("announceLicenseKey dispatches ether:license-changed carrying the key", () => {
    const t = new EventTarget();
    let got: string | null = null;
    t.addEventListener(LICENSE_CHANGED, (e) => { got = announcedKey(e); });
    announceLicenseKey("ETH-STN-1234-5678", t);
    expect(got).toBe("ETH-STN-1234-5678");
  });
  it("an older announcement (no detail) carries no key", () => {
    expect(announcedKey(new CustomEvent(LICENSE_CHANGED))).toBe(null);
  });
});

describe("wired", () => {
  const app = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");
  const onb = readFileSync(join(__dirname, "..", "components", "OnboardingFlow.tsx"), "utf8");
  it("App's check is keyed to the license key STATE (re-runs when a sign-in stores it)", () => {
    expect(app).toMatch(/if \(!accountPollReady\(\{ firstRunChecked, accountSignedIn, hasAccountJwt, licenseKey \}\)\) return;/);
    expect(app).toMatch(/\}, \[firstRunChecked, accountSignedIn, hasAccountJwt, licenseKey\]\);/);
    expect(app).not.toMatch(/apiKeyRef\.current = (apiKey|key);/);
  });
  it("App takes the key an announcement carries", () => {
    expect(app).toMatch(/window\.addEventListener\(LICENSE_CHANGED, reload\)/);
    expect(app).toMatch(/let key = e \? announcedKey\(e\) : null;/);
  });
  it("every place sign-in / key entry stores the key announces it", () => {
    const writes = onb.match(/upsertByKey\(stationId, 'license_key'/g) || [];
    const announces = onb.match(/announceLicenseKey\(/g) || [];
    expect(writes.length).toBe(3);
    expect(announces.length).toBe(3);
  });
});

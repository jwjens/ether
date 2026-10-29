// Sign-in Phase 1 on the desktop (Jeff, 2026-10-28): a running station stays signed in forever; if renewal can't happen
// the station runs as normal and only account features pause. Opening Ether shows the account sign-in screen first, as
// before 2026-10-28 (Jeff: "Put the account sign-in screen back exactly as it was before today: when Ether opens, the
// sign-in screen comes first."). electron/account-renewer.js + account-session.js.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { createAccountSession } = require_("./account-session");
const { createAccountRenewer } = require_("./account-renewer");

const fakeSafe = () => ({ isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, "utf8").map(b => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(Buffer.from(b).map(x => x ^ 0x5a)).toString("utf8") });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const pass = (expMs) => `${b64({ alg: "HS256" })}.${b64({ uid: 25, typ: "user", exp: Math.floor(expMs / 1000) })}.sig`;

function rig({ answer } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ether-renew-"));
  let t = Date.parse("2026-10-28T12:00:00Z");
  const now = () => t;
  const session = createAccountSession({ safeStorage: fakeSafe(), dir: () => dir, now });
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    const p = url.replace(/^.*\/api/, "/api"); const body = JSON.parse(init.body || "{}");
    calls.push({ path: p, body, auth: init.headers.Authorization || null });
    const a = answer ? answer(p, body) : null;
    if (a instanceof Error) throw a;
    if (a) return { status: a.status, json: async () => a.body };
    n++;
    return { status: 200, json: async () => ({ access_token: pass(t + 15 * 60000), access_expires_in: 900, refresh_token: `sid.r${n}`, session_id: "sid" }) };
  };
  const timers = [];
  const r = createAccountRenewer({ session, fetch, baseUrl: "https://x", now, machine: () => ({ id: "m-ov", name: "ovow" }),
                                   setTimer: (f, ms) => { timers.push({ f, at: t + ms }); return timers.length; }, clearTimer: () => {} });
  return { dir, session, r, calls, advance: (ms) => { t += ms; }, now };
}

describe("renewal", () => {
  it("an old pass from before this build is swapped once for a session while it is valid", async () => {
    const x = rig();
    x.session.set(pass(x.now() + 6 * 3600000));
    const s = await x.r.tick();
    expect(s.state).toBe("ok");
    expect(x.calls[0]).toMatchObject({ path: "/api/auth/upgrade", body: { machine_id: "m-ov" } });
    expect(x.session.refreshToken()).toBe("sid.r1");
    expect(x.session.legacyToken()).toBe(null);
  });

  it("a running station stays signed in forever: a renewal before each pass runs out, a year of them, each rotating", async () => {
    const x = rig();
    x.session.setSession({ access_token: pass(x.now() + 15 * 60000), refresh_token: "sid.r0" });
    for (let day = 0; day < 365; day += 3) {             // a check every 3 days for a year (the pass long run out each time)
      x.advance(3 * 24 * 3600000);
      const s = await x.r.tick();
      expect(s.state, String(s.reason)).toBe("ok");
      expect(x.session.get()).toBeTruthy();
    }
    expect(new Set(x.calls.map(c => c.body.refresh_token)).size).toBe(x.calls.length);   // never the same token twice
    // …and what is on disk is the latest one: a restart renews from it.
    const again = createAccountSession({ safeStorage: fakeSafe(), dir: () => x.dir, now: x.now });
    expect(again.refreshToken()).toBe(x.session.refreshToken());
  }, 60000);

  it("no network: account features pause (no pass), the session is kept, and it keeps trying", async () => {
    const x = rig({ answer: () => new Error("ENOTFOUND") });
    x.session.setSession({ access_token: pass(x.now() + 60000), refresh_token: "sid.r0" });
    const s = await x.r.tick();
    expect(s.state).toBe("offline");
    expect(x.session.refreshToken()).toBe("sid.r0");
    expect(x.session.isSetUp()).toBe(true);
  });

  it("the computer was removed: the sign-in is cleared (the NEXT start shows the sign-in screen)", async () => {
    const x = rig({ answer: () => ({ status: 401, body: { error: "session_ended", reason: "computer_removed" } }) });
    x.session.setSession({ access_token: pass(x.now() + 60000), refresh_token: "sid.r0" });
    expect((await x.r.tick()).state).toBe("removed");
    expect(x.session.isSetUp()).toBe(false);
  });

  it("password changed: account features pause, the computer stays set up (no sign-in screen on its own)", async () => {
    const x = rig({ answer: () => ({ status: 401, body: { error: "session_ended", reason: "password_changed" } }) });
    x.session.setSession({ access_token: pass(x.now() + 60000), refresh_token: "sid.r0" });
    const s = await x.r.tick();
    expect([s.state, s.reason]).toEqual(["needs_sign_in", "password_changed"]);
    expect(x.session.get()).toBe(null);
    expect(x.session.isSetUp()).toBe(true);
  });

  it("Sign Out ends the server session with the refresh token, then forgets it", async () => {
    const x = rig({ answer: (p) => (p === "/api/auth/logout" ? { status: 200, body: { ok: true } } : null) });
    x.session.setSession({ access_token: pass(x.now() + 60000), refresh_token: "sid.r0" });
    await x.r.signOut();
    expect(x.calls.at(-1)).toMatchObject({ path: "/api/auth/logout", body: { refresh_token: "sid.r0" } });
    expect(x.session.isSetUp()).toBe(false);
  });

  it("Remember me off: the session is kept for this run only (nothing on disk)", () => {
    const x = rig();
    x.session.setSession({ access_token: pass(x.now() + 60000), refresh_token: "sid.r0" }, { remember: false });
    expect(fs.existsSync(path.join(x.dir, "auth.bin"))).toBe(false);
    expect(x.session.get()).toBeTruthy();
  });
});

describe("start-up: opening Ether shows the account sign-in screen first", () => {
  // Jeff (2026-10-28): "Put the account sign-in screen back exactly as it was before today: when Ether opens, the sign-in
  // screen comes first." A kept sign-in no longer skips it; only the paths that existed before today do (a restart while
  // on air, and the app's own relaunch carrying the session).
  const app = () => fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  const code = () => app().split("\n").filter(l => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  it("a kept sign-in does not skip the sign-in screen", () => {
    expect(code()).not.toMatch(/isSetUp/);
    expect(code()).not.toMatch(/startupScreen|startupGate/);
    expect(fs.existsSync(path.join(__dirname, "..", "src", "lib", "startupGate.ts"))).toBe(false);
  });
  it("only the restart while on air and the app's own relaunch come back signed in at start-up", () => {
    const src = code();
    const start = src.indexOf('ether.invoke("account:was-on-air")');
    const end = src.indexOf("setFirstRunChecked(true);", start);
    expect(start).toBeGreaterThan(0);
    const startup = src.slice(start, end);
    expect((startup.match(/setAccountSignedIn\(true\)/g) || []).length).toBe(2);
    expect(startup).toMatch(/account:resume-session/);
  });
  it("while Ether runs, nothing signs anyone out", () => {
    expect((code().match(/setAccountSignedIn\(false\)/g) || []).length).toBe(0);
  });
});

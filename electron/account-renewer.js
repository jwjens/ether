// electron/account-renewer.js — KEEPS THIS COMPUTER SIGNED IN (docs/account-sign-in-plan-2026-10-26.md Phase 1).
//
// Jeff, 2026-10-28: "A running station stays signed in forever: a short-lived pass (15 minutes, a user setting) renewed
// silently in the background, with no limit while the computer runs. It ends only on Sign Out, a password change, or the
// computer being removed from the account ... If renewal can't happen, the station runs exactly as normal and only account
// features pause, with a small notice an admin can see and nothing that blocks anyone."
//
// The pass is renewed ~2 minutes before it expires (POST /api/auth/refresh, the refresh token rotating each time). An old
// Phase 0 pass is swapped once for a session (POST /api/auth/upgrade) while it is still valid. What happens otherwise:
//   network / server unreachable → "offline": retried (30 s, doubling to 5 min); account features pause; nothing else.
//   the computer was removed     → "removed": the sign-in is cleared; the NEXT start shows the sign-in screen.
//   password changed, offline limit, signed out from another computer, a reused token → "needs_sign_in": the station
//                                  runs as normal; account features pause; the notice offers "sign in again".
// It never touches playout and never shows a screen. Every state change goes to the health ledger.
"use strict";

const RENEW_BEFORE_MS = 2 * 60 * 1000;
const RETRY_MIN_MS = 30 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const REMOVED = new Set(["computer_removed"]);

/**
 * @param {object} o
 * @param {ReturnType<import("./account-session").createAccountSession>} o.session
 * @param {(url: string, init?: object) => Promise<{ status: number, json(): Promise<any> }>} o.fetch
 * @param {string} o.baseUrl
 * @param {() => { id: string|null, name: string|null }} [o.machine]
 * @param {(event: string, detail?: object) => void} [o.note]
 * @param {(state: object) => void} [o.onChange]
 * @param {() => number} [o.now]
 * @param {(fn: Function, ms: number) => any} [o.setTimer]
 * @param {(t: any) => void} [o.clearTimer]
 */
function createAccountRenewer({ session, fetch, baseUrl, machine = () => ({ id: null, name: null }), note = () => {}, onChange = () => {},
                                now = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) }) {
  let state = { state: "none", reason: null, since: now(), lastRenewedAt: null };
  let timer = null, retry = RETRY_MIN_MS, stopped = false;

  function setState(next, reason = null) {
    if (state.state === next && state.reason === reason) return;
    state = { ...state, state: next, reason, since: now() };
    note("account-sign-in-" + next, { reason });
    try { onChange({ ...state }); } catch { /* a listener's problem is not the renewer's */ }
  }
  function schedule(ms) { if (stopped) return; if (timer) clearTimer(timer); timer = setTimer(() => { tick().catch(() => {}); }, Math.max(1000, ms)); }
  function retryLater() { schedule(retry); retry = Math.min(RETRY_MAX_MS, retry * 2); }

  async function post(path, body, bearer) {
    const r = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body || {}),
    });
    let j = {}; try { j = await r.json(); } catch { j = {}; }
    return { status: r.status, body: j };
  }
  function ended(reason) {
    if (REMOVED.has(reason)) { session.clear(); setState("removed", reason); return; }
    session.markDead(); setState("needs_sign_in", reason || "session_ended");
  }

  /** One step: renew if due; upgrade an old pass; or say why it cannot. Never throws. */
  async function tick() {
    if (stopped) return state;
    if (!session.isSetUp()) { setState("none"); return state; }
    const refresh = session.refreshToken();
    try {
      if (refresh) {
        const due = session.accessExpiresAt() - now() - RENEW_BEFORE_MS;
        if (due > 0 && session.get()) { setState("ok"); schedule(due); return state; }
        const r = await post("/api/auth/refresh", { refresh_token: refresh });
        if (r.status === 200 && r.body.refresh_token) {
          session.setSession(r.body);
          state.lastRenewedAt = now(); retry = RETRY_MIN_MS; setState("ok");
          schedule(session.accessExpiresAt() - now() - RENEW_BEFORE_MS);
        } else if (r.status === 401) { ended(r.body.reason || r.body.error); }
        else { setState("offline", `server answered ${r.status}`); retryLater(); }
        return state;
      }
      const legacy = session.legacyToken();
      if (legacy) {
        const m = machine() || {};
        const r = await post("/api/auth/upgrade", { machine_id: m.id || null, machine_name: m.name || null }, legacy);
        if (r.status === 200 && r.body.refresh_token) {
          session.setSession(r.body);
          state.lastRenewedAt = now(); retry = RETRY_MIN_MS; setState("ok", "upgraded");
          schedule(session.accessExpiresAt() - now() - RENEW_BEFORE_MS);
        } else if (r.status === 401 || r.status === 400) { ended("upgrade_refused"); }
        else { setState("offline", `server answered ${r.status}`); retryLater(); }
        return state;
      }
      // Set up, but nothing that can renew (an old pass that expired before this build ran, or a dead session).
      setState("needs_sign_in", state.reason || "pass_expired");
    } catch (e) {
      setState("offline", String(e && e.message || e).slice(0, 120));
      retryLater();
    }
    return state;
  }

  /** Sign Out: end this computer's session on the server (best effort, short), then forget it here. */
  async function signOut({ timeoutMs = 3000 } = {}) {
    const refresh = session.refreshToken();
    if (refresh) {
      try { await Promise.race([post("/api/auth/logout", { refresh_token: refresh }), new Promise(r => setTimeout(r, timeoutMs))]); } catch { /* offline: the server ends it at the offline limit */ }
    }
    session.clear(); setState("signed_out");
  }

  function start(delayMs = 5000) { stopped = false; schedule(delayMs); }
  function stop() { stopped = true; if (timer) clearTimer(timer); timer = null; }
  /** A new sign-in (or "sign in again") just stored a session: renew from it on schedule. */
  function signedIn() { retry = RETRY_MIN_MS; setState("ok"); schedule(Math.max(1000, session.accessExpiresAt() - now() - RENEW_BEFORE_MS)); }

  return { tick, start, stop, signOut, signedIn, status: () => ({ ...state }) };
}

module.exports = { createAccountRenewer, RENEW_BEFORE_MS };

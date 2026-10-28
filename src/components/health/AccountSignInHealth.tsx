// AccountSignInHealth.tsx — the Health Monitor's view of THIS COMPUTER'S SIGN-IN (docs/account-sign-in-plan-2026-10-26.md
// Phase 1). Jeff, 2026-10-28: "If renewal can't happen, the station runs exactly as normal and only account features
// pause, with a small notice an admin can see and nothing that blocks anyone." This is that notice: the renewer's state
// (electron/account-renewer.js), said in plain words, and — when account features are paused — "Sign in again" right
// here, while the station keeps running. It never blocks, never opens a screen on its own.
import React, { useEffect, useState } from "react";
import { HealthPanel } from "./sectionChrome";

type Status = { state: string; reason: string | null; since: number; lastRenewedAt: number | null };
const TONE: Record<string, string> = { ok: "var(--accent-green)", offline: "var(--accent-amber, #f59e0b)", needs_sign_in: "var(--accent-amber, #f59e0b)",
                                       removed: "var(--accent-red, #ef4444)", none: "var(--text-tertiary)", signed_out: "var(--text-tertiary)" };
const REASONS: Record<string, string> = {
  password_changed: "the account's password was changed",
  offline_limit: "this computer had not checked in for longer than the account's offline limit",
  sign_out_everywhere: "someone used Sign out everywhere",
  signed_out_from_another_computer: "this computer was signed out from another computer",
  refresh_reused: "a sign-in was used twice, so it was ended for safety",
  pass_expired: "this computer's sign-in from an older Ether ran out",
  upgrade_refused: "this computer's sign-in from an older Ether could not be renewed",
  computer_removed: "this computer was removed from the account",
};

export function signInWords(s: Status | null): { text: string; tone: string } {
  if (!s) return { text: "waiting for Ether", tone: TONE.none };
  const why = s.reason ? REASONS[s.reason] || s.reason : null;
  switch (s.state) {
    case "ok": return { text: "Signed in: renewed in the background", tone: TONE.ok };
    case "offline": return { text: `Can't reach Ether's server right now (${s.reason || "no answer"}): account features are paused and it keeps trying. The station runs as normal.`, tone: TONE.offline };
    case "needs_sign_in": return { text: `Account features are paused: ${why || "the sign-in ended"}. The station runs as normal. Sign in again below.`, tone: TONE.needs_sign_in };
    case "removed": return { text: "This computer was removed from the account. The station runs until Ether is closed; the next start asks for a sign-in.", tone: TONE.removed };
    case "signed_out": return { text: "Signed out", tone: TONE.signed_out };
    default: return { text: "Not signed in on this computer", tone: TONE.none };
  }
}

export default function AccountSignInHealth({ id }: { id: string }) {
  const api = (window as any).ether?.accountSession;
  const [st, setSt] = useState<Status | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api?.status?.().then((s: Status) => { if (alive) setSt(s); }).catch(() => {});
    const off = api?.onStatus?.((s: Status) => setSt(s));
    return () => { alive = false; try { off?.(); } catch { /* gone */ } };
  }, [api]);
  const w = signInWords(st);
  const signIn = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api?.signInAgain?.({ email, password, remember: true });
      if (r?.ok) { setPassword(""); setMsg("Signed in. Account features have resumed."); }
      else setMsg(r?.error || "Could not sign in.");
    } finally { setBusy(false); }
  };
  return (
    <HealthPanel id={id} title="Account sign-in" right={<span style={{ fontSize: 11, color: w.tone, fontWeight: 700 }}>● {st?.state === "ok" ? "signed in" : st?.state?.replace("_", " ") || "—"}</span>}>
      <div style={{ fontSize: 12, color: w.tone, lineHeight: 1.5 }}>{w.text}</div>
      {st?.lastRenewedAt && <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Last renewed {new Date(st.lastRenewedAt).toLocaleTimeString()}</div>}
      {st?.state === "needs_sign_in" && (
        <form onSubmit={e => { e.preventDefault(); void signIn(); }} style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <input type="email" name="email" autoComplete="username" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} style={{ flex: "1 1 180px", padding: "4px 6px" }} />
          <input type="password" name="password" autoComplete="current-password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} style={{ flex: "1 1 140px", padding: "4px 6px" }} />
          <button type="submit" disabled={busy || !email || !password} style={{ padding: "4px 12px", cursor: "pointer" }}>{busy ? "Signing in…" : "Sign in again"}</button>
        </form>
      )}
      {msg && <div style={{ fontSize: 12, marginTop: 6, color: "var(--text-secondary)" }}>{msg}</div>}
    </HealthPanel>
  );
}

// THE START-UP RULE (Jeff, 2026-10-28; docs/account-sign-in-plan-2026-10-26.md Phase 1):
//   "Once a computer is set up, Ether never shows the sign-in screen on its own: not after a timeout, not on restart. It
//    starts straight to the station. If renewal can't happen, the station runs exactly as normal and only account
//    features pause ... The sign-in screen appears only on a brand-new computer, after Sign Out, or after the computer is
//    removed."
// "Set up" = this computer keeps a sign-in (electron/account-session.js isSetUp): a session or an old pass, valid or
// NOT. Sign Out and "computer removed" delete it, which is exactly what brings the sign-in screen back.

export type StartupFacts = {
  /** This computer keeps a sign-in (valid or expired). */
  setUp: boolean;
  /** Ether is coming back on air after a crash (the watchdog's recovery). */
  onAirRecovery?: boolean;
  /** Ether relaunched itself and asked to keep the session (a restore, an update). */
  keepSession?: boolean;
};

export function startupScreen(f: StartupFacts): "station" | "sign-in" {
  return f.setUp || f.onAirRecovery || f.keepSession ? "station" : "sign-in";
}

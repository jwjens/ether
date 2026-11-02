// THE REGULAR ACCOUNT CHECK (App.tsx): /account/connect about every 20 s — new cloud stations, staged programming and the
// billing notice (src/lib/billingNotice.ts) all ride on it.
//
// Root cause it fixes (billing test, 2026-11-01): the check was gated on the license key ALREADY being in a ref when
// the effect ran. On a fresh sign-in the key is written a moment later, a ref change re-runs nothing, and nothing told
// App about the key — so after signing in the app checked the account once and never again until it was reopened (no
// billing popup, no cloud station sync in that session). Now the key is announced the moment sign-in stores it
// (announceLicenseKey), App keeps it as state, and the check starts as soon as it is there.

export const LICENSE_CHANGED = "ether:license-changed";

/** Tell the app the account's license key is now stored (sign-in, a key entered by hand). */
export function announceLicenseKey(licenseKey: string, target: Pick<EventTarget, "dispatchEvent"> = window): void {
  target.dispatchEvent(new CustomEvent(LICENSE_CHANGED, { detail: { licenseKey } }));
}

/** The key an announcement carries, or null (older announcements carry none: read it from the station instead). */
export function announcedKey(e: Event): string | null {
  const k = (e as CustomEvent)?.detail?.licenseKey;
  return typeof k === "string" && k.trim() ? k.trim() : null;
}

/** May the regular account check run? App initialised, an account signed in (this session or a durable sign-in), and
 *  a license key known. */
export function accountPollReady(s: { firstRunChecked: boolean; accountSignedIn: boolean; hasAccountJwt: boolean; licenseKey: string }): boolean {
  return !!(s.firstRunChecked && (s.accountSignedIn || s.hasAccountJwt) && s.licenseKey && s.licenseKey.trim());
}

export const ACCOUNT_POLL_MS = 20 * 1000;

/** Run `check` now and then every `everyMs` until the returned stop() is called. `timers` only for tests: by default the
 *  global setInterval / clearInterval are called as plain functions — a browser refuses window.setInterval called as a
 *  method of another object ("Illegal invocation"; it crashed the app at sign-in in the billing test rerun). */
export function startAccountPoll(check: () => void, everyMs = ACCOUNT_POLL_MS,
  timers?: { setInterval: (f: () => void, ms: number) => unknown; clearInterval: (id: any) => void }): () => void {
  check();
  const id = timers ? timers.setInterval(check, everyMs) : setInterval(check, everyMs);
  return () => { if (timers) timers.clearInterval(id); else clearInterval(id as ReturnType<typeof setInterval>); };
}

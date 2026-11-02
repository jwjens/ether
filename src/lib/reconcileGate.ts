// WHEN THE 20-SECOND ACCOUNT CHECK MAY COMPARE STATIONS (Jeff, 2026-11-01). A REFUSED /account/connect answer (401, or
// any non-OK) carries no station list. Treating its missing list as "the account has no stations" made every local
// station look unregistered, so the check re-sent every station to /account/register-station every 20 seconds for as
// long as the account was refused (seen for an expired trial on 4.6.57). Only an OK answer with a station list is the
// account's real list; anything else skips the copy-down and register steps until the account answers normally.
export function canCompareStations(res: { ok: boolean } | null | undefined, data: unknown): boolean {
  return !!(res && res.ok && data && typeof data === "object" && Array.isArray((data as { stations?: unknown }).stations));
}

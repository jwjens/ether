// THIS BUILD'S ETHER VERSION, sent as `app_version` on sign-in and on the account check (Jeff, 2026-11-01) so the server
// records which version each device runs (license_activations.app_version, shown on the platform's machine list).
// Loaded once from the main process at startup; until it arrives the field is left out and the server reads the
// version from the User-Agent instead (which every build sends).
let version: string | null = null;
try {
  const p = (window as any)?.ether?.system?.getVersion?.();
  if (p && typeof p.then === "function") p.then((v: unknown) => { if (typeof v === "string" && v.trim()) version = v.trim(); }).catch(() => {});
} catch { /* not in Electron (tests) */ }

/** `{ app_version }` to spread into a request body, or `{}` while the version isn't known yet. */
export function appVersionField(): { app_version?: string } {
  return version ? { app_version: version } : {};
}
/** Tests only. */
export function _setVersionForTest(v: string | null): void { version = v; }

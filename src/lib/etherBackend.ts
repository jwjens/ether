// Single source of truth for the Ether backend base URL — renderer side.
// Imported by every renderer file that fetches the Railway backend.
//
// Parallel file: electron/lib/etherBackend.js holds the same constant for the
// electron main process (separate module system — Node CommonJS can't load
// .ts at runtime, and Vite only bundles src/). Two physical sources, one per
// bundle. If the URL ever changes, update both files. Same pattern as the
// electron/sync/ shape that's local to its bundle.
//
// History: OB1 — the URL was inlined in ~13 sites across renderer + electron
// before this module landed. See close-out-tracker.md.

export const ETHER_BACKEND_URL = "https://ether-backend-production.up.railway.app";

// ── THE DEV WRITE GUARD (2026-08-31) ─────────────────────────────────────────────────────────────
//
// A DEV BUILD MUST NOT WRITE TO PRODUCTION. Here beside the URL, because this module is the one
// thing every writer already imports — a guard kept anywhere else is one a future writer forgets.
//
// Before this there was no separation: the only conditions on an outbound write were a license key
// and a station uuid, so a dev instance signed into a real account was a fully-privileged production
// client, and one published a closing time onto a live public page for a park it was not running.
//
// NOT ABOUT WHICH MACHINE. Several real machines syncing and pushing the same station is the system
// working correctly. The line is dev-vs-installed, nothing else.
//
// WRITES ONLY — reads from dev stay open, because pointing dev at production data is how anything
// gets reproduced.
//
// `import.meta.env.DEV` is true under `npm run electron:dev` and false in a `vite build`, so the
// packaged renderer takes the true branch with the check compiled away. The override is read from
// the main process (preload exposes it), because a runtime env var cannot reach a bundled renderer
// any other way.
export const CAN_WRITE_PRODUCTION: boolean =
  !import.meta.env.DEV || (typeof window !== "undefined" && (window as any).ether?.allowDevPush === true);

/** Loud, once per session per label: a silent guard is indistinguishable from a broken push, which
 *  is how someone spends an hour wondering why a page stopped updating. */
const _guardSeen = new Set<string>();
export function blockedByDevGuard(what: string): boolean {
  if (CAN_WRITE_PRODUCTION) return false;
  if (!_guardSeen.has(what)) {
    _guardSeen.add(what);
    console.warn(`[devguard] ${what} NOT sent — this is a dev build and will not write to production. Set ETHER_ALLOW_DEV_PUSH=1 to override.`);
  }
  return true;
}

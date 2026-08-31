'use strict';

// Single source of truth for the Ether backend base URL — electron-main side.
// Required by electron/main.js and electron/cloud-backup.js (the only main-
// process files that fetch the Railway backend today).
//
// Parallel file: src/lib/etherBackend.ts holds the same constant for the
// renderer. Two physical sources because Node CommonJS in the electron main
// process can't load .ts at runtime, and Vite only bundles src/. If the URL
// ever changes, update both files. Same pattern as the electron/sync/ shape
// that's local to its bundle.
//
// History: OB1 — the URL was inlined in ~13 sites across renderer + electron
// before this module landed. See docs/close-out-tracker.md.

// ── THE DEV WRITE GUARD (2026-08-31) ─────────────────────────────────────────────────────────────
//
// A DEV BUILD MUST NOT WRITE TO PRODUCTION. It lives here, beside the URL, because this module is
// the single thing every writer already has to reach for — a guard anywhere else is one a future
// writer can forget to ask.
//
// WHY: there was no separation at all. The only conditions on any outbound write were "do I have a
// license key" and "do I have a station uuid", so a development instance signed into a real account
// was a fully-privileged production client. One duly published a closing time and a re-timed
// announcement queue onto a live public page for a park it was not running, and station_cc_data has
// no expiry, so it sat there looking current.
//
// THIS IS NOT ABOUT WHICH MACHINE. Several real machines syncing and pushing the same station is the
// system working correctly and must keep working. The line is dev-vs-installed, nothing else.
//
// WRITES ONLY. Reads from a dev build are useful and harmless — pointing dev at production data is
// how you reproduce anything. Only writes are gated.
//
// THE OPT-IN IS REQUIRED, NOT DECORATION. Without a way to say "yes, really, push from dev", the
// first time someone needs to test the push path end to end they will delete the guard to work, and
// it will not come back. ETHER_ALLOW_DEV_PUSH=1 makes that a deliberate, visible act.
const _app = (() => { try { return require("electron").app; } catch { return null; } })();

/** True when this process may write to the production backend. */
function canWriteProduction() {
  // No electron app object (a plain node script, a smoke, a migration) → treat as packaged. Those
  // callers are not dev instances, and failing closed here would silently break tooling.
  const packaged = _app ? !!_app.isPackaged : true;
  return packaged || process.env.ETHER_ALLOW_DEV_PUSH === "1";
}

module.exports = {
  ETHER_BACKEND_URL: "https://ether-backend-production.up.railway.app",
  canWriteProduction,
};

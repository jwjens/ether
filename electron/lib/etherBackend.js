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

module.exports = {
  ETHER_BACKEND_URL: "https://ether-backend-production.up.railway.app",
};

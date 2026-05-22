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

import { query } from "../db/client";
import { ETHER_BACKEND_URL } from "./etherBackend";

interface LocalUser {
  name: string;
  role: string;
  pin_hash: string | null;
}

// Mirror this install's local console users up to the backend so the same people
// can sign into the Control Center dashboard with their same name + PIN.
//
// One-way (install -> backend), best-effort. Only users WITH a PIN are sent —
// no-PIN console logins can't (and shouldn't) authenticate remotely, and the
// backend stores PINs in the desktop's "salt:sha256" format verbatim, so a remote
// login verifies identically to the local one. The backend reconciles: any
// install-origin user we stop sending (deleted, or PIN cleared) is revoked.
export async function pushInstallUsers(licenseKey: string | null | undefined): Promise<void> {
  if (!licenseKey) return;
  try {
    const rows = await query<LocalUser>("SELECT name, role, pin_hash FROM users", []);
    const users = rows
      .filter((u) => u.pin_hash)
      .map((u) => ({ name: u.name, role: u.role, pin_hash: u.pin_hash }));
    if (users.length === 0) return; // never send an empty set (avoids mass-revoke on a transient read)
    await fetch(`${ETHER_BACKEND_URL}/api/account/users/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-license-key": licenseKey },
      body: JSON.stringify({ users }),
    });
  } catch {
    /* best-effort — the dashboard still works via web-created users */
  }
}

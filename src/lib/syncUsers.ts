import { query } from "../db/client";
import { ETHER_BACKEND_URL } from "./etherBackend";

export interface LocalUserRow {
  name: string;
  role: string;
  pin_hash: string | null;
  deleted_at: string | null;
}

export interface UsersPush {
  users: { name: string; role: string; pin_hash: string }[];
  removed: string[];
}

// What this computer tells the backend (2026-10-27, docs/library-sync-open-items-2026-10-27.md §2).
//
// `users` — every live user WITH a PIN (no-PIN console logins can't authenticate remotely). The backend only adds or
// updates these; a name missing from the list is NOT removed, so two computers with different lists no longer flip
// the account's users.
// `removed` — the explicit removals: names deleted here, or whose PIN was cleared, that no live user with a PIN still
// carries (a person kept by the same-person merge, or re-added, is never removed). Compared trimmed, any case.
export function buildUsersPush(rows: LocalUserRow[]): UsersPush {
  const key = (n: string) => String(n || "").trim().toLowerCase();
  const users = rows
    .filter((u) => !u.deleted_at && u.pin_hash)
    .map((u) => ({ name: u.name, role: u.role, pin_hash: u.pin_hash as string }));
  const sent = new Set(users.map((u) => key(u.name)));
  const removed: string[] = [];
  const seen = new Set<string>();
  for (const u of rows) {
    const k = key(u.name);
    if (!k || sent.has(k) || seen.has(k)) continue;
    if (u.deleted_at || !u.pin_hash) { seen.add(k); removed.push(String(u.name).trim()); }
  }
  return { users, removed };
}

// Mirror this install's local console users up to the backend so the same people
// can sign into the Control Center dashboard with their same name + PIN.
// One-way (install -> backend), best-effort.
export async function pushInstallUsers(licenseKey: string | null | undefined): Promise<void> {
  if (!licenseKey) return;
  try {
    const rows = await query<LocalUserRow>("SELECT name, role, pin_hash, deleted_at FROM users", []);
    const body = buildUsersPush(rows || []);
    if (body.users.length === 0 && body.removed.length === 0) return;
    await fetch(`${ETHER_BACKEND_URL}/api/account/users/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-license-key": licenseKey },
      body: JSON.stringify(body),
    });
  } catch {
    /* best-effort — the dashboard still works via web-created users */
  }
}

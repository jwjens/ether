import { ETHER_BACKEND_URL } from "./etherBackend";

// RBAC foundation (read-only). The accounts + accessible stations the signed-in person belongs to.
// This does NOT touch the sync engine or the active station — it only reads "what can this person
// reach", so the badge/Preferences can surface accounts beyond the single seated license. Operating
// a cross-account station (syncing its data) is the separate, flagged sync bridge (Plan A).

export interface MembershipStation { uuid: string; name: string; can_edit?: boolean; }
export interface Membership {
  membership_id: number;
  account_id: number;
  account_name: string | null;
  account_email: string;
  position: string;
  label: string;
  rank: number;
  permissions: Record<string, boolean>;
  all_stations: boolean;
  status: string;
  stations: MembershipStation[];
}

async function accountJwt(): Promise<string | null> {
  try {
    const ether = (window as any).ether;
    const row = (await ether.installConfigKv?.get?.("account_jwt"))?.row;
    return row?.value ? String(row.value) : null;
  } catch { return null; }
}

// Returns [] when there's no token, the token is expired, or the session is PIN-only — callers just
// show nothing extra in that case (never throws, never blocks the UI).
export async function fetchMyMemberships(): Promise<Membership[]> {
  const token = await accountJwt();
  if (!token) return [];
  try {
    const res = await fetch(`${ETHER_BACKEND_URL}/api/me/memberships`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data?.memberships) ? (data.memberships as Membership[]) : [];
  } catch { return []; }
}

// adminPin — check a 4-digit admin PIN against this install's admin profiles and say WHICH admin it was.
// Same rule as Station Delete (SettingsPanel): install-level admins, verified with users.verifyPin. Unlike that
// gate, a door that must be PIN-only (the designation bypass, audit 20) refuses when no admin has a PIN at all —
// an unguarded door is not "behind the admin PIN".
import { query } from "../db/client";

export async function verifyAdminPin(pin: string): Promise<{ ok: true; operator: string } | { ok: false; error: string }> {
  const admins = (await query<{ name: string | null; pin_hash: string | null }>("SELECT name, pin_hash FROM users WHERE role = 'admin'")) || [];
  const withPin = admins.filter(a => a.pin_hash);
  if (!withPin.length) return { ok: false, error: "No admin PIN is set on this computer. Set one on an admin profile first — this switch is PIN-only." };
  if (!/^\d{4}$/.test(pin || "")) return { ok: false, error: "Enter your 4-digit admin PIN." };
  const ether = (window as any).ether;
  for (const a of withPin) {
    const ok = ether?.users?.verifyPin ? await ether.users.verifyPin(pin, a.pin_hash) : pin === a.pin_hash;
    if (ok) return { ok: true, operator: a.name || "admin" };
  }
  return { ok: false, error: "Incorrect admin PIN." };
}

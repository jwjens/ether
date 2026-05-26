import { ETHER_BACKEND_URL } from "./etherBackend";

// Control Center data mirror (Phase 2). Pushes install-owned table rows up so the
// dashboard can view them, and applies remote dashboard edits back through the local
// sync handlers. License-key authed (same pattern as the now-playing / users pushes).

// Push a table's LIVE rows up. Best-effort, one-way (install -> backend). Send only
// live rows; the backend reconcile clause tombstones any row_uuid it no longer sees.
export async function pushCcData(
  licenseKey: string | null | undefined,
  stationUuid: string | null | undefined,
  table: string,
  rows: unknown[],
): Promise<void> {
  if (!licenseKey || !stationUuid) return;
  try {
    const res = await fetch(`${ETHER_BACKEND_URL}/api/account/data/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-license-key": licenseKey },
      body: JSON.stringify({ station_uuid: stationUuid, table, rows }),
    });
    console.log(`[CCPUSH] ${table} sync → HTTP ${res.status}`);
  } catch (e) { console.log(`[CCPUSH] ${table} sync error:`, (e as any)?.message ?? e); }
}

// Gather a table's live rows via the typed sync handlers and push them. Only categories
// is wired for the Phase 2 categories loop; extend the switch per domain.
export async function pushCcTable(
  licenseKey: string | null | undefined,
  stationUuid: string | null | undefined,
  stationId: number,
  table: string,
): Promise<void> {
  if (!licenseKey || !stationUuid) return;
  const ether = (window as any).ether;
  let res: any;
  try {
    if (table === "categories") res = await ether.categories.list(stationId);
    else return;
  } catch (e) { console.log(`[CCPUSH] ${table} list failed:`, (e as any)?.message ?? e); return; }
  // IPC list handlers return { rows: [...] } (or { ok, rows }), NOT a bare array.
  const rows: unknown[] = Array.isArray(res) ? res : ((res && res.rows) || []);
  console.log(`[CCPUSH] ${table}: ${rows.length} rows from station ${stationId}`);
  await pushCcData(licenseKey, stationUuid, table, rows);
}

// Whitelist of tables the dashboard may edit -> the preload namespace that owns them.
const NS: Record<string, string> = { categories: "categories" };

// Apply a remote dashboard edit to the local DB via the existing typed sync handlers
// (they wrap writes in withMutation -> HLC mutation -> syncs), then re-push the changed
// table so the dashboard reflects it. Whitelisted tables/ops only.
export async function applyDbMutation(
  licenseKey: string | null | undefined,
  data: { table: string; op: string; uuid?: string; payload?: any; station_id?: number; station_uuid?: string },
): Promise<void> {
  const ether = (window as any).ether;
  const ns = NS[data.table] ? ether[NS[data.table]] : null;
  if (!ns) { console.warn("[db:apply] unsupported table:", data.table); return; }
  try {
    if (data.op === "create") await ns.create(data.payload);
    else if (data.op === "update") await ns.update(data.uuid, data.payload);
    else if (data.op === "delete") await ns.delete(data.uuid, data.station_id);
    else { console.warn("[db:apply] unsupported op:", data.op); return; }
  } catch (e) {
    console.error("[db:apply] handler failed:", data.table, data.op, e);
    return;
  }
  if (data.station_uuid) await pushCcTable(licenseKey, data.station_uuid, data.station_id as number, data.table);
}

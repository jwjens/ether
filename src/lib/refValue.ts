// Settings values that point at rows — stored as the rows' UUIDS (2026-10-19).
//
// `jukebox_categories` (a list of categories) and `overlay_fallback_category_id` (a jingle category) are synced
// station_config_kv values. They used to hold this machine's local integer ids, which name a different row on a machine
// that numbers rows differently — and no reference translation can reach inside a text value. From this build they are
// written as uuids and read back to this machine's ids. A value still holding integers (written before, not yet
// re-filed by the one-time repair) is read as this machine's ids, exactly as before.
// docs/sync-uuid-references-2026-10-19.md
import { query } from "../db/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
type RefTable = "categories" | "jingle_categories";

/** Stored values (uuids, or legacy local integers) → this machine's ids, in the stored order. Unknown uuids drop out. */
export async function idsFromStored(table: RefTable, values: unknown[]): Promise<number[]> {
  const uuids = values.filter((v): v is string => typeof v === "string" && UUID.test(v));
  const map = new Map<string, number>();
  if (uuids.length) {
    const rows = await query<{ id: number; uuid: string }>(
      `SELECT id, uuid FROM ${table} WHERE uuid IN (${uuids.map(() => "?").join(",")})`, uuids);
    for (const r of rows) map.set(r.uuid, r.id);
  }
  const out: number[] = [];
  for (const v of values) {
    if (typeof v === "string" && UUID.test(v)) { const id = map.get(v); if (id != null) out.push(id); }
    else { const n = parseInt(String(v), 10); if (Number.isFinite(n)) out.push(n); }
  }
  return out;
}

/** This machine's ids → their uuids, for storing. An id with no uuid is kept as its number (cannot be named better). */
export async function storedFromIds(table: RefTable, ids: number[]): Promise<Array<string | number>> {
  if (!ids.length) return [];
  const rows = await query<{ id: number; uuid: string | null }>(
    `SELECT id, uuid FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  const map = new Map(rows.map(r => [r.id, r.uuid]));
  return ids.map(id => map.get(id) || id);
}

/** A JSON-list setting (e.g. jukebox_categories) → this machine's ids. */
export async function idsFromStoredList(table: RefTable, raw: string | null | undefined): Promise<number[]> {
  if (!raw) return [];
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? await idsFromStored(table, parsed) : []; }
  catch { return []; }
}

/** A single-reference setting (e.g. overlay_fallback_category_id) → this machine's id, or null. */
export async function idFromStoredOne(table: RefTable, raw: string | null | undefined): Promise<number | null> {
  if (!raw) return null;
  const [id] = await idsFromStored(table, [raw]);
  return id ?? null;
}

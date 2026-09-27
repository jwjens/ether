// markAsSpot — the ONE confirm behind "Mark as Spot", wherever it is opened (Library, deck, Up Next — audit 10,
// docs/help-audit-2026-09-27.md). Moved verbatim from LibraryPanel's confirmSpotMark: the track becomes
// content_class='SPOT' (leaves music rotation) AND a spots record is created in a spot category, because a break
// pulls from a category — tagging alone leaves nothing a break can find. `ether` is injected so it is tested
// without Electron.

export interface SpotMarkChoice {
  stationId: number;
  song: { id: number; title: string | null; file_path: string | null };
  catId: number | null;
  newCat: string;
  type: string;
}

export async function markAsSpot(ether: any, m: SpotMarkChoice): Promise<{ ok: boolean; reason?: string }> {
  let catId = m.catId;
  const nc = m.newCat.trim();
  if (nc) { try { const r = await ether.spotCategories.create({ station_id: m.stationId, name: nc, color: "#fbbf24" }); catId = r?.row?.id ?? catId; } catch { /* keep going */ } }
  // Breaks are traffic law: a category-specific break must never pull uncategorized audio. Require one.
  if (catId == null) return { ok: false, reason: "Pick a spot category (or type a new one) — a break pulls from a category." };
  try { await ether.songs.updateById(m.song.id, { content_class: "SPOT" }); } catch {}
  // Probe the REAL audio duration (seconds) — the same native probe every import uses — so the spot's
  // length_sec is truthful. A fake default corrupts the calendar, the generator's spacing, and anchor-fit.
  let lengthSec: number | null = null;
  try { const d = await ether.audio.getFileDuration(m.song.file_path); if (typeof d === "number" && d > 0) lengthSec = Math.round(d); } catch {}
  // is_active:1 explicitly so the spot airs immediately (spots.create also defaults it now).
  try { await ether.spots.create({ station_id: m.stationId, title: m.song.title, file_path: m.song.file_path, spot_type: m.type || "commercial", spot_category_id: catId, is_active: 1, max_plays_day: 999, length_sec: lengthSec }); } catch {}
  return { ok: true };
}

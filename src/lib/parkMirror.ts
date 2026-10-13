// src/lib/parkMirror.ts — keeps the hosted Park page showing the REAL state (2026-10-13).
//
// Jeff: "The page always shows the real state if something is changed elsewhere (Preferences, another screen)."
// The Park page reads a mirror this install pushes (src/lib/ccData.ts pushOpsData). It used to be pushed for the
// ACTIVE station only, every 60 s — a park whose station was not the one on screen went stale. Now:
//   · every station with a uuid, every 60 s (the refresh that was there);
//   · a station AT ONCE when something it shows is written anywhere — closing time, its MONITOR level, its fader
//     maximum (main's "ops:changed", from the Preferences writers) — or when a Park command lands ("ether:ops-push");
//   · a station AT ONCE when its cart channel starts or stops playing a cart (checked every second, from the engine's
//     state — no database work).
import { query } from "../db/client";
import { pushOpsData, cartPlaying } from "./ccData";

type Ctx = { licenseKey: () => string | null | undefined };
let started = false;

export function startParkMirror(ctx: Ctx): () => void {
  if (started) return () => {};
  started = true;
  const uuidOf = new Map<number, string>();
  const loadStations = async () => {
    try {
      const rows = await query<{ id: number; uuid: string | null }>("SELECT id, uuid FROM stations WHERE deleted_at IS NULL", []);
      uuidOf.clear();
      for (const r of rows) if (r.uuid) uuidOf.set(Number(r.id), r.uuid);
    } catch { /* keep the last list */ }
  };
  const pending = new Map<number, number>();
  const pushOne = (sid: number) => {
    const t = pending.get(sid); if (t) window.clearTimeout(t);
    pending.set(sid, window.setTimeout(async () => {
      pending.delete(sid);
      if (!uuidOf.has(sid)) await loadStations();
      const uuid = uuidOf.get(sid);
      if (uuid) await pushOpsData(ctx.licenseKey(), uuid, sid);
    }, 250));
  };
  const pushAll = async () => { await loadStations(); for (const sid of uuidOf.keys()) pushOne(sid); };

  const onLocal = (e: Event) => {
    const sid = Number((e as CustomEvent).detail?.stationId);
    if (Number.isFinite(sid)) pushOne(sid); else pushAll();
  };
  window.addEventListener("ether:ops-push", onLocal);
  const ether = (window as any).ether;
  // main names the station by UUID (the station-identity rule); this module keys its pushes by local id.
  const h = ether?.on?.("ops:changed", async (p: any) => {
    const uuid = String(p?.stationUuid || "");
    if (!uuid) return;
    let sid = [...uuidOf].find(([, u]) => u === uuid)?.[0];
    if (sid == null) { await loadStations(); sid = [...uuidOf].find(([, u]) => u === uuid)?.[0]; }
    if (sid != null) pushOne(sid);
  });

  // Cart starts and stops, from the engine (once a second; a signature compare, no database read unless it changed).
  const cartSig = new Map<number, string>();
  const cartTimer = window.setInterval(async () => {
    for (const sid of uuidOf.keys()) {
      const c = await cartPlaying(sid);
      const sig = c ? `${c.slot}:${c.title}` : "";
      if ((cartSig.get(sid) ?? "") !== sig) { cartSig.set(sid, sig); pushOne(sid); }
    }
  }, 1000);

  pushAll();
  const every = window.setInterval(pushAll, 60_000);
  return () => {
    window.removeEventListener("ether:ops-push", onLocal);
    try { if (h) ether?.off?.("ops:changed", h); } catch {}
    window.clearInterval(cartTimer); window.clearInterval(every);
    started = false;
  };
}

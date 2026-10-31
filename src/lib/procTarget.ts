// src/lib/procTarget.ts — Settings → Broadcast → Audio Processing → "Target loudness" (dead-controls item 14).
//
// The field wrote the legacy key proc_target_lufs, and once a station had saved a processor rack (rack_master) nothing
// read that key: the daemon runs the rack document (audiod/rack-seed.js seedMasterRack — the stored document wins). The
// rack is the one source of truth (docs/dsp-rack-framework.md §1.2: rack_master, legacy keys only SEEDED from and WRITTEN
// THROUGH). So the field now reads the monitor branch's RIDE target from the rack (rack:get) and writes it by editing
// that ride module and sending the rack through rack:set — the engine accepts it first, then it is stored with the
// legacy write-through. One value, two doors: this field and the Processor rack's RIDE target.
import type { MasterRackDoc } from "../components/rack/rackTypes";
import { editModule, findModule } from "../components/rack/rackModel";

export const TARGET_MIN = -30, TARGET_MAX = -6;   // the ride's range (rack-seed clamp, native clamp_ride)

/** The monitor (local) branch's ride target, or null if the rack has no ride module there. */
export function localTargetOf(doc: MasterRackDoc | null | undefined): number | null {
  if (!doc) return null;
  const r = findModule(doc.sections.local as any, "ride") as any;
  return r && Number.isFinite(r.target) ? r.target : null;
}

/** The rack with the monitor branch's ride target set (clamped to the ride's range). A linked stream follows it, as in
 *  the rack's own editor (editModule mirrors local → stream while linked). null = no ride module to set. */
export function withLocalTarget(doc: MasterRackDoc, target: number): MasterRackDoc | null {
  const slot = (doc.sections.local as any[]).find(s => s && s.module && s.module.type === "ride");
  if (!slot) return null;
  const t = Math.max(TARGET_MIN, Math.min(TARGET_MAX, Math.round(target)));
  return editModule(doc, "local", slot.id, { target: t } as any);
}

// spotEditPatch — what Edit Spot's Save writes (Spots.tsx). Pure so the save is tested without a DOM.
// Audit 9 (docs/help-audit-2026-09-27.md): cart # and ISCI are edited here, each its own value; blank → NULL.

export interface SpotEdit {
  title?: string; spot_type?: string | null; advertiser?: string | null;
  start_date?: string | null; end_date?: string | null; max_plays_day?: number | null;
  is_active?: number | null; notes?: string | null; spot_category_id?: number | null; art_image?: string | null;
  cart_number?: string | null; isci_code?: string | null;
}

const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

export function spotEditPatch(e: SpotEdit) {
  return {
    title: e.title, spot_type: e.spot_type || "promo", advertiser: e.advertiser || null,
    start_date: e.start_date || null, end_date: e.end_date || null, max_plays_day: e.max_plays_day || 999,
    is_active: e.is_active ?? 1, notes: e.notes || null, spot_category_id: e.spot_category_id ?? null,
    art_image: e.art_image || null,
    cart_number: text(e.cart_number), isci_code: text(e.isci_code),
  };
}

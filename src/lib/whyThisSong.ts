// whyThisSong — the one line the Program Log shows under a music row when it is clicked (audit 18).
// The text comes from the generator's own record (generated_schedule.pick_reason via rotation:explain →
// rotation-analytics.js renderReason). Honest about absence: a row with no recorded reason says so; nothing is
// reconstructed after the fact — the losing candidates only existed during the pick.

export interface ExplainResult { ok?: boolean; error?: string; data?: { reasonAvailable?: boolean; reasonText?: string | null } | null }

export function whyThisSongText(res: ExplainResult | null | undefined): string {
  if (!res || res.ok === false) return `Couldn't read the reason: ${(res && res.error) || "no response"}`;
  if (!res.data) return "This row is no longer in the log — it may have been regenerated.";
  if (res.data.reasonAvailable && res.data.reasonText) return res.data.reasonText;
  return "No reason recorded — this row was generated before reasons were kept, or placed by hand.";
}

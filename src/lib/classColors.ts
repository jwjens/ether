// Content-class color identity — ONE canonical token per class, consumed everywhere (color audit,
// JINGLES overlay v1 D3). JIN = teal (matches the shipped JINGLES fader #14e0c8, commit ff5b965);
// SPOT = amber. Standardizes the pre-GO purples (UpNext SPOT #a855f7, Spots JIN #a78bfa) and the
// stray teal hex (#14b8a6) onto these. Music stays neutral (no class color).
export const JIN_TEAL = "#14e0c8";
export const SPOT_AMBER = "#fbbf24";
// SWP (sweepers, v2) — deep indigo, blue-violet. Deliberately distinct from brand purple #8868D8/#6040C0
// (Iris-reserved), JIN teal, SPOT amber, and the category blues (D #3b82f6, news #6366f1 — darker/more
// saturated than both so it never reads as "news"). Proposed for Jeff's eyes; change here to retint SWP
// everywhere at once.
export const SWP_INDIGO = "#4f46e5";

// Backgrounds/borders for chips at low alpha (consistent chip treatment across surfaces).
export const JIN_TEAL_BG = "rgba(20,224,200,0.14)";
export const JIN_TEAL_BORDER = "rgba(20,224,200,0.45)";
export const SPOT_AMBER_BG = "rgba(251,191,36,0.14)";
export const SPOT_AMBER_BORDER = "rgba(251,191,36,0.45)";
export const SWP_INDIGO_BG = "rgba(79,70,229,0.16)";
export const SWP_INDIGO_BORDER = "rgba(79,70,229,0.55)";

// Map a content_class string → its canonical color, or null for MUSIC/unknown (neutral).
export function classColor(contentClass?: string | null): string | null {
  const c = (contentClass || "").toUpperCase();
  if (c === "JIN") return JIN_TEAL;
  if (c === "SWP") return SWP_INDIGO;
  if (c === "SPOT") return SPOT_AMBER;
  return null;
}
// Short label for a class chip.
export function classLabel(contentClass?: string | null): string | null {
  const c = (contentClass || "").toUpperCase();
  return (c === "JIN" || c === "SWP" || c === "SPOT") ? c : null;
}

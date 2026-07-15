// Content-class color identity — ONE canonical token per class, consumed everywhere (color audit,
// JINGLES overlay v1 D3). JIN = teal (matches the shipped JINGLES fader #14e0c8, commit ff5b965);
// SPOT = amber. Standardizes the pre-GO purples (UpNext SPOT #a855f7, Spots JIN #a78bfa) and the
// stray teal hex (#14b8a6) onto these. Music stays neutral (no class color).
export const JIN_TEAL = "#14e0c8";
export const SPOT_AMBER = "#fbbf24";

// Backgrounds/borders for chips at low alpha (consistent chip treatment across surfaces).
export const JIN_TEAL_BG = "rgba(20,224,200,0.14)";
export const JIN_TEAL_BORDER = "rgba(20,224,200,0.45)";
export const SPOT_AMBER_BG = "rgba(251,191,36,0.14)";
export const SPOT_AMBER_BORDER = "rgba(251,191,36,0.45)";

// Map a content_class string → its canonical color, or null for MUSIC/unknown (neutral).
export function classColor(contentClass?: string | null): string | null {
  const c = (contentClass || "").toUpperCase();
  if (c === "JIN") return JIN_TEAL;
  if (c === "SPOT") return SPOT_AMBER;
  return null;
}

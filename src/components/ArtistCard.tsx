// src/components/ArtistCard.tsx
//
// Category-colored deck backdrop.
// Uses the song's category color as the primary color.
// Clean, consistent, always looks right.

import { useMemo } from "react";

interface Props {
  artistName:    string;
  categoryColor: string | null;  // from DB categories.color
  categoryName:  string | null;  // category display name
  energy?:       number | null;
  bpm?:          number | null;
  isPlaying:     boolean;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return Math.abs(h);
}

// Derive a complementary secondary color from primary
function deriveSecondary(hex: string): string {
  // Parse hex
  const r = parseInt(hex.slice(1,3), 16) || 100;
  const g = parseInt(hex.slice(3,5), 16) || 100;
  const b = parseInt(hex.slice(5,7), 16) || 100;

  // Shift hue ~30deg by rotating RGB channels and darkening slightly
  const r2 = Math.round(Math.min(255, r * 0.7 + b * 0.3));
  const g2 = Math.round(Math.min(255, g * 0.7 + r * 0.3));
  const b2 = Math.round(Math.min(255, b * 0.7 + g * 0.3));

  return `rgb(${r2},${g2},${b2})`;
}

// Fallback palette when no category assigned — based on artist name hash
const FALLBACK_PALETTES: [string, string][] = [
  ["#0066ff", "#00ccff"],  // electric blue
  ["#ff5500", "#ffaa00"],  // amber orange
  ["#6600cc", "#cc0066"],  // purple magenta
  ["#00cc88", "#0066ff"],  // teal blue
  ["#ff0055", "#ff6600"],  // hot pink orange
  ["#330066", "#9900cc"],  // deep purple
  ["#cc0044", "#ff6600"],  // crimson orange
  ["#009900", "#00ccff"],  // green cyan
];

export default function ArtistCard({
  artistName, categoryColor, categoryName, isPlaying
}: Props) {

  const [primary, secondary] = useMemo(() => {
    if (categoryColor && categoryColor.startsWith("#")) {
      return [categoryColor, deriveSecondary(categoryColor)];
    }
    // No category — use artist name hash for consistent color per artist
    const idx = hashStr(artistName) % FALLBACK_PALETTES.length;
    return FALLBACK_PALETTES[idx];
  }, [categoryColor, artistName]);

  const initial = artistName.charAt(0).toUpperCase();

  return (
    <div style={{
      width: "100%", height: "100%",
      position: "relative", overflow: "hidden",
      borderRadius: "inherit",
      background: `linear-gradient(160deg, ${primary} 0%, ${secondary} 100%)`,
    }}>

      {/* Studio spotlight — top left bright zone */}
      <div style={{
        position: "absolute", inset: 0,
        background: "radial-gradient(ellipse at 20% 15%, rgba(255,255,255,0.28) 0%, transparent 55%)",
        pointerEvents: "none",
      }} />

      {/* Giant artist initial — bottom right, massive decorative type */}
      <div style={{
        position: "absolute",
        bottom: "-12%", right: "-5%",
        fontSize: "95%",
        fontWeight: 900,
        fontFamily: "'Newsreader', Georgia, serif",
        color: "rgba(0,0,0,0.18)",
        letterSpacing: "-0.08em",
        lineHeight: 1,
        userSelect: "none",
        pointerEvents: "none",
      }}>
        {initial}
      </div>

      {/* Category name badge — top left */}
      {categoryName && (
        <div style={{
          position: "absolute",
          top: 8, left: 8,
          padding: "2px 8px",
          borderRadius: 0,
          background: "rgba(0,0,0,0.2)",
          backdropFilter: "blur(8px)",
          fontSize: 8,
          fontWeight: 800,
          letterSpacing: "0.12em",
          color: "rgba(255,255,255,0.7)",
          textTransform: "uppercase" as const,
          userSelect: "none",
        }}>
          {categoryName}
        </div>
      )}

      {/* Bottom fade — grounds it */}
      <div style={{
        position: "absolute",
        bottom: 0, left: 0, right: 0,
        height: "35%",
        background: "linear-gradient(to top, rgba(0,0,0,0.3), transparent)",
        pointerEvents: "none",
      }} />

      {/* Playing pulse ring */}
      {isPlaying && (
        <div style={{
          position: "absolute", inset: 0,
          borderRadius: "inherit",
          animation: "cardRing 3s ease-in-out infinite",
          pointerEvents: "none",
        }} />
      )}

      <style>{`
        @keyframes cardRing {
          0%,100% { box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.1); }
          50%      { box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.35); }
        }
      `}</style>
    </div>
  );
}

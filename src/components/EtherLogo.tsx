/**
 * EtherLogo — inline SVG logo, no image dependency.
 * Matches the new brand icon: rounded-square with blue→purple gradient + bold "E" letterform.
 *
 * Usage:
 *   <EtherLogo />                    // icon + wordmark (default, for header)
 *   <EtherLogo size={32} />          // smaller
 *   <EtherLogo iconOnly />           // just the square mark
 *   <EtherLogo wordmarkOnly />       // just the ETHER text
 */

interface EtherLogoProps {
  /** Height of the icon mark in px. Wordmark scales proportionally. Default: 32 */
  size?: number;
  /** Show only the square icon mark, no wordmark */
  iconOnly?: boolean;
  /** Show only the wordmark, no icon */
  wordmarkOnly?: boolean;
  /** Additional CSS class */
  className?: string;
  style?: React.CSSProperties;
}

export default function EtherLogo({
  size = 32,
  iconOnly = false,
  wordmarkOnly = false,
  className,
  style,
}: EtherLogoProps) {
  const radius = size * 0.22; // ~22% corner radius matches the brand asset
  const gradId = `ether-grad-${size}`;

  const iconMark = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0, display: "block" }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
          {/* Cyan top-left → blue mid → indigo/purple bottom-right */}
          <stop offset="0%"   stopColor="#38bdf8" />
          <stop offset="45%"  stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#6d28d9" />
        </linearGradient>
      </defs>

      {/* Rounded square background */}
      <rect
        width="512"
        height="512"
        rx={radius * (512 / size)}
        ry={radius * (512 / size)}
        fill={`url(#${gradId})`}
      />

      {/*
        Bold "E" letterform — thick stroked paths matching the brand asset.
        The E sits centred, slightly left-weighted, with rounded ends.
        Three horizontal bars: top, middle (shorter), bottom.
        One vertical spine on the left.
      */}
      <g fill="none" stroke="#0a0a18" strokeLinecap="round" strokeLinejoin="round" strokeWidth="68">
        {/* Left vertical spine */}
        <line x1="148" y1="120" x2="148" y2="392" />
        {/* Top bar */}
        <line x1="148" y1="120" x2="364" y2="120" />
        {/* Middle bar (slightly shorter) */}
        <line x1="148" y1="256" x2="318" y2="256" />
        {/* Bottom bar */}
        <line x1="148" y1="392" x2="364" y2="392" />
      </g>
    </svg>
  );

  const wordmark = (
    <span
      style={{
        fontFamily: "'Syne', 'Inter', system-ui, sans-serif",
        fontSize: size * 0.56,
        fontWeight: 800,
        letterSpacing: "-0.02em",
        color: "var(--text-primary)",
        lineHeight: 1,
        userSelect: "none",
      }}
    >
      Ether Technologies
    </span>
  );

  if (iconOnly) return <span className={className} style={style}>{iconMark}</span>;
  if (wordmarkOnly) return <span className={className} style={style}>{wordmark}</span>;

  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: size * 0.28,
        textDecoration: "none",
        ...style,
      }}
    >
      {iconMark}
      {wordmark}
    </span>
  );
}

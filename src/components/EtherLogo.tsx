import etherLogoMark from "../assets/ether-logo.svg";

/**
 * EtherLogo — logo component backed by brand asset files.
 *
 * Usage:
 *   <EtherLogo />                    // icon + wordmark (default, for header)
 *   <EtherLogo size={32} />          // smaller
 *   <EtherLogo iconOnly />           // just the mark
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
  const iconMark = (
    <img
      src={etherLogoMark}
      width={size}
      height={size}
      alt=""
      style={{ flexShrink: 0, display: "block" }}
    />
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

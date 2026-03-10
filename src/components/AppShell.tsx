import { useState, useEffect } from "react";

interface Props {
  children: React.ReactNode;
  sidebar: React.ReactNode;
  header: React.ReactNode;
  footer: React.ReactNode;
  darkMode: boolean;
}

export default function AppShell({ children, sidebar, header, footer, darkMode }: Props) {
  return (
    <div className={darkMode ? "dark-theme" : ""} style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg-primary)", color: "var(--text-primary)" }}>
      {/* Header */}
      <header style={{
        height: 52,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 20px",
        background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border-primary)",
        boxShadow: "var(--shadow-sm)",
        flexShrink: 0,
      }}>
        {header}
      </header>

      {/* Body */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Sidebar */}
        <nav style={{
          width: 200,
          background: "var(--bg-secondary)",
          borderRight: "1px solid var(--border-primary)",
          display: "flex",
          flexDirection: "column",
          padding: "8px 0",
          flexShrink: 0,
        }}>
          {sidebar}
        </nav>

        {/* Main */}
        <main style={{
          flex: 1,
          overflow: "auto",
          padding: 20,
          background: "var(--bg-primary)",
        }}>
          {children}
        </main>
      </div>

      {/* Footer */}
      <footer style={{
        height: 28,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 20px",
        background: "var(--bg-secondary)",
        borderTop: "1px solid var(--border-primary)",
        fontSize: 11,
        color: "var(--text-tertiary)",
        flexShrink: 0,
      }}>
        {footer}
      </footer>
    </div>
  );
}

// Reusable styled components
export function Card({ children, className = "", style = {} }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={className} style={{
      background: "var(--bg-secondary)",
      borderRadius: "var(--radius)",
      border: "1px solid var(--border-primary)",
      boxShadow: "var(--shadow-sm)",
      ...style,
    }}>
      {children}
    </div>
  );
}

export function NavButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: "block",
      width: "100%",
      padding: "10px 20px",
      textAlign: "left",
      fontSize: 14,
      fontWeight: active ? 600 : 400,
      color: active ? "var(--accent-blue)" : "var(--text-secondary)",
      background: active ? "var(--bg-tertiary)" : "transparent",
      border: "none",
      borderLeft: active ? "3px solid var(--accent-blue)" : "3px solid transparent",
      cursor: "pointer",
      transition: "all 0.15s ease",
      letterSpacing: "-0.01em",
    }}
    onMouseEnter={e => { if (!active) { (e.target as HTMLElement).style.background = "var(--bg-hover)"; } }}
    onMouseLeave={e => { if (!active) { (e.target as HTMLElement).style.background = "transparent"; } }}
    >
      {label}
    </button>
  );
}

export function Btn({ children, variant = "default", size = "md", onClick, disabled, style = {} }: {
  children: React.ReactNode; variant?: "default" | "primary" | "danger" | "success" | "ghost";
  size?: "sm" | "md" | "lg"; onClick?: () => void; disabled?: boolean; style?: React.CSSProperties;
}) {
  const colors = {
    default: { bg: "var(--bg-tertiary)", color: "var(--text-primary)", hover: "var(--bg-active)" },
    primary: { bg: "var(--accent-blue)", color: "#ffffff", hover: "#1d4ed8" },
    danger: { bg: "var(--accent-red)", color: "#ffffff", hover: "#b91c1c" },
    success: { bg: "var(--accent-green)", color: "#ffffff", hover: "#15803d" },
    ghost: { bg: "transparent", color: "var(--text-secondary)", hover: "var(--bg-hover)" },
  };
  const sizes = {
    sm: { padding: "4px 10px", fontSize: 11, borderRadius: "var(--radius-xs)" },
    md: { padding: "6px 14px", fontSize: 12, borderRadius: "var(--radius-sm)" },
    lg: { padding: "10px 20px", fontSize: 14, borderRadius: "var(--radius)" },
  };
  const c = colors[variant];
  const s = sizes[size];
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...s,
      background: c.bg,
      color: c.color,
      border: "none",
      fontWeight: 600,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      transition: "all 0.15s ease",
      letterSpacing: "0.02em",
      ...style,
    }}
    onMouseEnter={e => { (e.target as HTMLElement).style.background = c.hover; }}
    onMouseLeave={e => { (e.target as HTMLElement).style.background = c.bg; }}
    >
      {children}
    </button>
  );
}

export function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "2px 8px",
      borderRadius: 20,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: "0.05em",
      textTransform: "uppercase" as const,
      color: "#ffffff",
      background: color,
    }}>
      {children}
    </span>
  );
}

const fs = require('fs');

console.log('\n  Ether — Apple-Inspired Visual Overhaul\n');

// ============================================================
// 1. New CSS with theme variables
// ============================================================

fs.writeFileSync('src/index.css', `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  /* Light theme — Apple Studios inspired */
  --bg-primary: #fafaf9;
  --bg-secondary: #ffffff;
  --bg-tertiary: #f5f5f4;
  --bg-elevated: #ffffff;
  --bg-hover: #f0f0ee;
  --bg-active: #e7e5e4;
  
  --text-primary: #1c1917;
  --text-secondary: #57534e;
  --text-tertiary: #a8a29e;
  --text-inverse: #ffffff;
  
  --border-primary: #e7e5e4;
  --border-secondary: #d6d3d1;
  
  --accent-blue: #2563eb;
  --accent-green: #16a34a;
  --accent-red: #dc2626;
  --accent-amber: #d97706;
  --accent-purple: #7c3aed;
  --accent-orange: #ea580c;
  --accent-teal: #0d9488;
  
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
  --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px -2px rgba(0,0,0,0.05);
  --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px -4px rgba(0,0,0,0.05);
  
  --radius: 12px;
  --radius-sm: 8px;
  --radius-xs: 6px;
}

.dark-theme {
  --bg-primary: #09090b;
  --bg-secondary: #18181b;
  --bg-tertiary: #27272a;
  --bg-elevated: #1c1c1f;
  --bg-hover: #27272a;
  --bg-active: #3f3f46;
  
  --text-primary: #fafaf9;
  --text-secondary: #a1a1aa;
  --text-tertiary: #52525b;
  --text-inverse: #09090b;
  
  --border-primary: #27272a;
  --border-secondary: #3f3f46;
  
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.4);
  --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.5);
}

* { box-sizing: border-box; }

body {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}

/* Smooth transitions for theme switching */
body, .theme-transition, .theme-transition * {
  transition: background-color 0.3s ease, color 0.2s ease, border-color 0.3s ease, box-shadow 0.3s ease;
}

/* Custom scrollbar */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border-secondary); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-tertiary); }

/* Range input styling */
input[type="range"] {
  -webkit-appearance: none;
  height: 4px;
  background: var(--border-primary);
  border-radius: 2px;
  outline: none;
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  background: var(--accent-blue);
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
`, 'utf8');
console.log('  CREATED index.css (theme system)');

// ============================================================
// 2. Update index.html
// ============================================================

fs.writeFileSync('index.html', `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Ether</title></head>
<body>
<div id="root"></div>
<script type="module" src="/src/main.tsx"><\/script>
</body></html>`, 'utf8');
console.log('  UPDATED index.html (removed dark class)');

// ============================================================
// 3. Create ThemedApp wrapper with new visual language
// ============================================================

fs.writeFileSync('src/components/AppShell.tsx', `import { useState, useEffect } from "react";

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
`, 'utf8');
console.log('  CREATED AppShell.tsx (themed wrapper + components)');

// ============================================================
// 4. Add theme toggle to App.tsx header
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');

if (!app.includes('darkMode')) {
  // Add dark mode state
  app = app.replace(
    'const [showNowPlaying, setShowNowPlaying] = useState(false);',
    'const [showNowPlaying, setShowNowPlaying] = useState(false);\n  const [darkMode, setDarkMode] = useState(false);'
  );

  // Wrap the entire app in theme class
  app = app.replace(
    '<div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">',
    '<div className={"h-screen flex flex-col " + (darkMode ? "dark-theme bg-zinc-950 text-zinc-100" : "")} style={{ background: "var(--bg-primary)", color: "var(--text-primary)" }}>'
  );

  // Add theme toggle button to header
  app = app.replace(
    '<button onClick={() => setShowNowPlaying(true)}',
    '<button onClick={() => setDarkMode(!darkMode)} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: darkMode ? "var(--accent-purple)" : "var(--bg-tertiary)", color: darkMode ? "#fff" : "var(--text-secondary)", border: "none", cursor: "pointer" }}>{darkMode ? "DARK" : "LIGHT"}</button>\n          <button onClick={() => setShowNowPlaying(true)}'
  );

  // Update header background
  app = app.replace(
    'className="h-12 flex items-center justify-between px-4 bg-zinc-900 border-b border-zinc-800 shrink-0"',
    'style={{ height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)", boxShadow: "var(--shadow-sm)", flexShrink: 0 }}'
  );

  // Update sidebar
  app = app.replace(
    'className="w-44 bg-zinc-900 border-r border-zinc-800 flex flex-col py-2 shrink-0"',
    'style={{ width: 200, background: "var(--bg-secondary)", borderRight: "1px solid var(--border-primary)", display: "flex", flexDirection: "column" as const, padding: "8px 0", flexShrink: 0 }}'
  );

  // Update nav buttons
  app = app.replace(
    'className={active === i.id ? "px-4 py-2.5 text-sm text-left bg-zinc-800 text-white border-l-2 border-blue-400" : "px-4 py-2.5 text-sm text-left text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 border-l-2 border-transparent"}',
    'style={{ display: "block", width: "100%", padding: "10px 20px", textAlign: "left" as const, fontSize: 14, fontWeight: active === i.id ? 600 : 400, color: active === i.id ? "var(--accent-blue)" : "var(--text-secondary)", background: active === i.id ? "var(--bg-tertiary)" : "transparent", border: "none", borderLeft: active === i.id ? "3px solid var(--accent-blue)" : "3px solid transparent", cursor: "pointer", letterSpacing: "-0.01em" }}'
  );

  // Update footer
  app = app.replace(
    'className="h-7 flex items-center justify-between px-4 bg-zinc-900 border-t border-zinc-800 text-[11px] text-zinc-500 shrink-0"',
    'style={{ height: 28, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", background: "var(--bg-secondary)", borderTop: "1px solid var(--border-primary)", fontSize: 11, color: "var(--text-tertiary)", flexShrink: 0 }}'
  );

  // Update main content area
  app = app.replace(
    'className="flex-1 overflow-auto p-4"',
    'style={{ flex: 1, overflow: "auto", padding: 20, background: "var(--bg-primary)" }}'
  );

  // Update the Ether wordmark
  app = app.replace(
    '<span className="text-lg font-bold tracking-tight"><span className="text-blue-400">Eth</span>er</span>',
    '<span style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.03em" }}><span style={{ color: "var(--accent-blue)" }}>Eth</span><span style={{ color: "var(--text-primary)" }}>er</span></span>'
  );

  // Update version badge
  app = app.replace(
    '<span className="text-xs text-zinc-500">v0.2.0</span>',
    '<span style={{ fontSize: 10, color: "var(--text-tertiary)", fontWeight: 500 }}>v1.5</span>'
  );

  // Update bottom of sidebar
  app = app.replace(
    '<div className="mt-auto px-4 py-3 text-[10px] text-zinc-600">Ether v0.2.0<br/>Free forever</div>',
    '<div style={{ marginTop: "auto", padding: "12px 20px", fontSize: 10, color: "var(--text-tertiary)" }}>Ether v1.5<br/>Free forever</div>'
  );

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  UPDATED App.tsx (theme system + light mode)');
}

console.log('\n  Done! npm run tauri:dev');
console.log('');
console.log('  LIGHT/DARK toggle in the top bar.');
console.log('');
console.log('  Light mode (default):');
console.log('    - Warm off-white canvas (#fafaf9)');
console.log('    - Clean white cards with subtle shadows');
console.log('    - Bold dark text, generous spacing');
console.log('    - Blue accent for active elements');
console.log('    - Apple-style typography (SF Pro / system font)');
console.log('    - Smooth rounded corners');
console.log('    - Custom scrollbars');
console.log('    - Polished range sliders');
console.log('');
console.log('  Dark mode:');
console.log('    - Same layout, dark zinc palette');
console.log('    - For on-air studio use');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v1.5.0 Apple-inspired visual overhaul"');
console.log('    git push\n');

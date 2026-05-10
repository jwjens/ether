// src/components/CueEditorWindow.tsx
// Standalone floating OS window for the Cue Editor.
// Opened via WebviewWindow — stays open while jock works Live Assist.
// Theme syncs automatically with the main window via localStorage.

import { useEffect, useState } from "react";

// Apply immediately — before first paint, so no flash of white
(() => {
  try {
    const dark = localStorage.getItem("ether_dark_mode") !== "false";
    const skin = localStorage.getItem("ether_skin_id") || "";
    const bg   = dark ? "#13131f" : "#f8fafc";
    const fg   = dark ? "#e2e8f0" : "#0f172a";
    if (dark) {
      document.documentElement.classList.add("dark-theme");
      document.body.classList.add("dark-theme");
    }
    document.documentElement.setAttribute("data-skin", skin);
    document.body.setAttribute("data-skin", skin);
    // Force color on both html and body before stylesheet
    document.documentElement.style.cssText = `background:${bg}!important;color:${fg}!important;`;
    document.body.style.cssText = `background:${bg}!important;color:${fg}!important;margin:0;overflow:hidden;`;
    // Read CSS vars passed from main window in URL — exact live values
    try {
      const urlVars = new URLSearchParams(window.location.hash.split("?")[1] || "").get("vars");
      if (urlVars) {
        const v = JSON.parse(decodeURIComponent(urlVars));
        const bg = v.bgPrimary || (dark ? "#0d0b1e" : "#f8fafc");
        const fg = v.textPrimary || (dark ? "#e2e8f0" : "#0f172a");
        const s = document.createElement("style");
        s.id = "ether-theme-vars";
        s.textContent = `
          html, body { background: ${bg} !important; color: ${fg} !important; }
          :root {
            --bg-primary: ${v.bgPrimary || bg};
            --bg-secondary: ${v.bgSecondary || (dark ? "#1a1628" : "#f1f5f9")};
            --bg-tertiary: ${v.bgTertiary || (dark ? "#1e1a30" : "#e2e8f0")};
            --border-primary: ${v.borderPrimary || (dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.1)")};
            --text-primary: ${v.textPrimary || fg};
            --text-secondary: ${v.textSecondary || (dark ? "#94a3b8" : "#475569")};
            --text-tertiary: ${v.textTertiary || (dark ? "#64748b" : "#94a3b8")};
            --accent-blue: #0ea5e9;
            --accent-cyan: #22d3ee;
            --accent-green: #34d399;
          }
        `;
        document.head.appendChild(s);
        document.documentElement.style.background = bg;
        document.body.style.background = bg;
      } else {
        // Fallback hardcoded dark purple — Ether default
        const bg = dark ? "#0d0b1e" : "#f8fafc";
        const s = document.createElement("style");
        s.textContent = `html,body{background:${bg}!important;} :root{--bg-primary:${bg};}`;
        document.head.appendChild(s);
        document.documentElement.style.background = bg;
        document.body.style.background = bg;
      }
    } catch {}
  } catch {}
})();
import { queryScoped } from "../db/stationScoped";
import { getActiveStationIdSync } from "../hooks/useActiveStation";
import TrackEditor from "./TrackEditor";

interface Song {
  id: number; title: string; artist_name?: string;
  file_path: string; duration_ms: number;
  cue_in?: number; cue_out?: number;
  intro_end?: number; outro_start?: number;
}

// Apply Ether theme classes to this window's document
function applyTheme() {
  try {
    const darkMode = localStorage.getItem("ether_dark_mode") === "true";
    const skinId   = localStorage.getItem("ether_skin_id") || "";
    const root     = document.documentElement;
    const body     = document.body;

    // Mirror exactly what App.tsx applies
    if (darkMode) {
      body.classList.add("dark-theme");
      root.classList.add("dark-theme");
    } else {
      body.classList.remove("dark-theme");
      root.classList.remove("dark-theme");
    }

    // Apply skin id as data attribute (SkinPicker uses this)
    root.setAttribute("data-skin", skinId);
    body.setAttribute("data-skin", skinId);

    body.style.margin  = "0";
    body.style.padding = "0";
    body.style.overflow = "hidden";
  } catch {}
}

export default function CueEditorWindow() {
  const [song, setSong]       = useState<Song | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [ready, setReady]     = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    try { return localStorage.getItem("ether_dark_mode") !== "false"; } catch { return true; }
  });

  // Apply theme on mount and listen for changes from main window
  useEffect(() => {
    applyTheme();

    const onStorage = (e: StorageEvent) => {
      if (e.key === "ether_dark_mode" || e.key === "ether_skin_id") {
        applyTheme();
        setDarkMode(localStorage.getItem("ether_dark_mode") === "true");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Load song from path in URL hash
  useEffect(() => {
    const init = async () => {
      const params  = new URLSearchParams(window.location.hash.split("?")[1] || "");
      const path    = params.get("path");
      if (!path) { setReady(true); return; }

      const decoded = decodeURIComponent(path);
      setFilePath(decoded);

      try {
        const stationId = getActiveStationIdSync();
        const rows = await Promise.race([
          queryScoped<Song>(
            `SELECT s.id, s.title, a.name as artist_name, s.file_path,
                    s.duration_ms, s.cue_in, s.cue_out, s.intro_end, s.outro_start
             FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
             WHERE s.file_path = ? LIMIT 1`,
            [decoded],
            stationId,
            { skipScoping: true }
          ),
          new Promise<Song[]>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))
        ]) as Song[];
        if (rows.length > 0) setSong(rows[0]);
      } catch {}

      setReady(true);
    };
    init();
  }, []);

  if (!ready) {
    return (
      <div className={darkMode ? "dark-theme" : ""} style={{
        height: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--bg-primary)", color: "var(--text-tertiary)",
        fontSize: 13, fontFamily: "'Inter', system-ui, sans-serif",
      }}>
        Loading...
      </div>
    );
  }

  return (
    <div className={darkMode ? "dark-theme" : ""} style={{
      height: "100vh", display: "flex", flexDirection: "column",
      overflow: "hidden",
      background: darkMode ? "var(--bg-primary, #13131f)" : "var(--bg-primary, #f8fafc)",
      color: darkMode ? "var(--text-primary, #e2e8f0)" : "var(--text-primary, #0f172a)",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <TrackEditor
        song={song}
        filePath={filePath}
        onClose={() => window.close()}
        onSaved={() => {/* window stays open */}}
      />
    </div>
  );
}

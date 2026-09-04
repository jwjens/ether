// askText — the replacement for window.prompt(), which Electron does not implement.
//
// Chromium's prompt() is removed in Electron: calling it logs "prompt() is and will not be
// supported" and returns nothing. Every one of the nine call sites in this app therefore looked
// live and did NOTHING — no dialog, no error, no clue. A cart could not be renamed, a clock slot
// could not be pinned to a cart number, markers and versions and snapshots could not be named, and
// a URL could not be pasted. The controls were all there; none of them worked.
//
// Same shape as prompt() so a call site changes by one `await`:
//
//     const name = await askText("Marker label:");            // null when cancelled
//     const v    = await askText("Name this version:", `Version ${n}`);
//
// SELF-MOUNTING, ON PURPOSE. It creates its own root on document.body rather than needing a
// <Provider> at the app root, because several of these callers (Show+ DAW, the Producer Desk
// window) run in POP-OUT windows — separate renderer roots. A provider would have to be remembered
// in each one, and the failure mode of forgetting is exactly what this is replacing: a dialog that
// silently never appears.

import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";

export interface AskTextOptions {
  title: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Let the caller accept an empty string as a real answer (e.g. "blank to clear"). */
  allowEmpty?: boolean;
}

function Dialog({ opts, done }: { opts: AskTextOptions; done: (v: string | null) => void }) {
  const [value, setValue] = useState(opts.initial ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const commit = () => {
    const v = value.trim();
    if (!v && !opts.allowEmpty) { done(null); return; }   // empty = cancel, like prompt()
    done(v);
  };

  return (
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) done(null); }}
      style={{
        position: "fixed", inset: 0, zIndex: 100000, background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      <div
        onMouseDown={e => e.stopPropagation()}
        style={{
          background: "var(--bg-secondary, #14141c)", border: "1px solid var(--border-primary, #2a2a38)",
          boxShadow: "0 18px 50px rgba(0,0,0,0.6)", padding: 16, minWidth: 340, maxWidth: "90vw",
        }}
      >
        <div style={{
          fontSize: 12, fontWeight: 800, letterSpacing: "0.06em",
          color: "var(--text-primary, #e8e8f0)", marginBottom: 10,
        }}>{opts.title}</div>

        <input
          ref={inputRef}
          value={value}
          placeholder={opts.placeholder}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            // Stopped so the app's global hotkeys — the cart letters especially — do not fire
            // while someone is typing a name.
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { e.preventDefault(); done(null); }
          }}
          style={{
            width: "100%", padding: "7px 9px", fontSize: 13, borderRadius: 2, outline: "none",
            background: "var(--bg-primary, #0b0b12)", color: "var(--text-primary, #e8e8f0)",
            border: "1px solid var(--accent-teal, #14e0c8)",
          }}
        />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button
            onClick={() => done(null)}
            style={{
              padding: "5px 12px", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
              background: "var(--bg-tertiary, #1c1c26)", color: "var(--text-secondary, #9a9aac)",
              border: "1px solid var(--border-primary, #2a2a38)", borderRadius: 2, cursor: "pointer",
            }}
          >CANCEL</button>
          <button
            onClick={commit}
            style={{
              padding: "5px 12px", fontSize: 11, fontWeight: 800, letterSpacing: "0.06em",
              background: "rgb(from var(--accent-teal, #14e0c8) r g b / 0.15)",
              color: "var(--accent-teal, #14e0c8)",
              border: "1px solid var(--accent-teal, #14e0c8)", borderRadius: 2, cursor: "pointer",
            }}
          >{opts.confirmLabel || "OK"}</button>
        </div>
      </div>
    </div>
  );
}

/** prompt()'s shape, with a dialog that actually opens. Resolves null when cancelled. */
export function askText(title: string, initial?: string, opts: Partial<AskTextOptions> = {}): Promise<string | null> {
  return new Promise(resolve => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: string | null) => {
      // Unmount on a later tick: React refuses to unmount a root from inside its own render/commit.
      setTimeout(() => { try { root.unmount(); } catch { /* already gone */ } host.remove(); }, 0);
      resolve(v);
    };
    root.render(<Dialog opts={{ title, initial, ...opts }} done={done} />);
  });
}

import React, { useState, useEffect } from "react";

// Post-sign-in prompt: on a FRESH install whose account has a cloud backup, offer to pull the
// whole station down (database + audio). Self-contained; checks availability on mount and shows
// once per session unless dismissed. Reuses station:install-from-cloud + libraryR2.download.
export default function CloudInstallPrompt() {
  const [show, setShow]   = useState(false);
  const [phase, setPhase] = useState<"offer" | "installing" | "done" | "error">("offer");
  const [msg, setMsg]     = useState("");
  const [stationName, setStationName] = useState("");

  useEffect(() => {
    try { if (sessionStorage.getItem("cloud_install_dismissed") === "1") return; } catch { /* ignore */ }
    (window as any).ether.invoke("station:cloud-install-available")
      .then((r: any) => { if (r?.available) setShow(true); })
      .catch(() => {});
  }, []);

  if (!show) return null;

  const dismiss = () => { try { sessionStorage.setItem("cloud_install_dismissed", "1"); } catch { /* ignore */ } setShow(false); };

  const install = async () => {
    setPhase("installing"); setMsg("Downloading database…");
    try {
      const r = await (window as any).ether.invoke("station:install-from-cloud", {});
      if (!r?.ok) { setPhase("error"); setMsg(r?.error || "Install failed"); return; }
      setStationName(r.stationName || "");
      setMsg(`Database installed — ${r.songs} songs. Downloading audio…`);
      const offP = (window as any).ether.libraryR2.onDownloadProgress?.((v: any) => setMsg(`Downloading audio… ${v.done ?? 0}/${v.total ?? 0}`));
      const offD = (window as any).ether.libraryR2.onDownloadDone?.((v: any) => { offP?.(); offD?.(); setPhase("done"); setMsg(`Installed ${v?.done ?? r.songs} files.`); });
      await (window as any).ether.libraryR2.download();
    } catch (e: any) { setPhase("error"); setMsg(String(e?.message || e)); }
  };

  const restart = () => { (window as any).ether.invoke("app:relaunch").catch(() => {}); };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 99999, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 470, maxWidth: "90vw", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", boxShadow: "0 20px 60px rgba(0,0,0,0.6)" }}>
        <div style={{ padding: "20px 22px 14px", borderBottom: "1px solid var(--border-primary)" }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: "var(--text-primary)", fontFamily: "'Syne', sans-serif" }}>Install your station from the cloud?</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 4 }}>We found a cloud backup of your account.</div>
        </div>
        <div style={{ padding: "18px 22px" }}>
          {phase === "offer" ? (
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              Pull your whole station onto this computer — the <b>database</b> (library, clocks, shows, schedule, settings) and then the <b>audio files</b>. The fast way to set up a new machine.
            </div>
          ) : (
            <div style={{ fontSize: 13, color: phase === "error" ? "#ef4444" : phase === "done" ? "#34d399" : "var(--text-secondary)", lineHeight: 1.6 }}>
              {phase === "installing" ? "⏳ " : phase === "done" ? "✓ " : "✗ "}{msg}
              {phase === "done" && <div style={{ marginTop: 6, color: "var(--text-tertiary)" }}>Restart Ether to finish loading {stationName || "your station"}.</div>}
            </div>
          )}
        </div>
        <div style={{ padding: "0 22px 20px", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          {phase === "offer" && (<>
            <button onClick={dismiss} style={btn(false)}>Not now</button>
            <button onClick={install} style={btn(true)}>↓ Install</button>
          </>)}
          {phase === "installing" && <button disabled style={{ ...btn(false), opacity: 0.6 }}>Installing…</button>}
          {phase === "done" && <button onClick={restart} style={btn(true)}>Restart Ether</button>}
          {phase === "error" && (<>
            <button onClick={dismiss} style={btn(false)}>Close</button>
            <button onClick={install} style={btn(true)}>Retry</button>
          </>)}
        </div>
      </div>
    </div>
  );
}

const btn = (primary: boolean): React.CSSProperties => ({
  padding: "9px 18px", borderRadius: 0, fontSize: 13, fontWeight: 700, cursor: "pointer",
  border: primary ? "none" : "1px solid var(--border-primary)",
  background: primary ? "var(--accent-green, #34d399)" : "var(--bg-tertiary)",
  color: primary ? "#0a160d" : "var(--text-secondary)",
});

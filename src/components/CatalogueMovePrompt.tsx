// THE "MOVE TO THE CATALOGUE" POP-UP (Jeff, 2026-10-27). Songs are only ever in the catalogue. When Ether finds files that
// are not (stored somewhere else, or not on this computer) it lists them and asks:
//   "These files need to be moved to the catalogue. Do you want to do that now?"  Yes / No
// Yes → main moves each file in, or downloads it when it is not on this computer, and points the rows there
//       (electron/catalogue-moves.js moveIntoCatalogue). No → nothing is moved or changed.
// Nothing reaches catalogue:move-in except the Yes button.
//
// "Download missing files into the catalogue automatically" (Preferences): while it is on, a file that is not on this
// computer and has a cloud copy downloads by itself (main, _autoDownloadMissing) and is NOT asked about here — the same
// rule as electron/catalogue-moves.js downloadsByItself. Off, or never set: everything is asked about.
//
// Sources of the list: the library-health sweep (snapshot.notInCatalogue, every 2 min and at start) and Re-sync, which
// sends the files it could not find (window event "ether:catalogue-prompt"). A file the user has already answered is not
// asked about again this session; a new one brings the pop-up back with the whole list.
import React, { useCallback, useEffect, useState } from "react";

export type NotInCatalogueFile = {
  key: string; file: string | null; name: string | null; state: "elsewhere" | "missing"; fileKey: string | null;
  rows: { table: string; id: number; title: string | null }[];
};
type MoveResult = { key: string; name: string | null; ok: boolean; action: string | null; to: string | null; reason: string | null; note: string | null };
type Api = { invoke: (ch: string, ...a: any[]) => Promise<any>; on?: (ch: string, cb: (...a: any[]) => void) => any; off?: (ch: string, h: any) => void };

const answered = new Set<string>();   // file keys the user said Yes or No to, this session
/** Does this list hold a file the user has not answered yet? */
export function needsAsking(files: NotInCatalogueFile[] | null | undefined, seen: Set<string> = answered): boolean {
  return !!files && files.some(f => !seen.has(f.key));
}
export function _resetAnsweredForTest() { answered.clear(); }
/** With the switch on, what downloads by itself is left out (electron/catalogue-moves.js downloadsByItself). */
export function toAsk(files: NotInCatalogueFile[] | null | undefined, autoDownloadOn: boolean): NotInCatalogueFile[] {
  return (files || []).filter(f => !(autoDownloadOn && f.state === "missing" && !!f.fileKey));
}

const whereText = (f: NotInCatalogueFile) =>
  f.state === "elsewhere" ? `at ${f.file}`
    : f.fileKey ? "not on this computer — will be downloaded"
      : "not on this computer, and there is no cloud copy";

export default function CatalogueMovePrompt({ api }: { api?: Api }) {
  const ether: Api | undefined = api || (window as any).ether;
  const [files, setFiles] = useState<NotInCatalogueFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<MoveResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const offer = useCallback(async (all: NotInCatalogueFile[] | null | undefined, force = false) => {
    if (!all || !all.length || !ether) return;
    let on = false;
    try { on = !!(await ether.invoke("catalogue:auto-download:get"))?.on; } catch { /* unknown → ask about everything */ }
    const list = toAsk(all, on);
    if (!list.length) return;
    if (!force && !needsAsking(list)) return;
    setResults(null); setError(null); setFiles(list);
  }, [ether]);

  useEffect(() => {
    if (!ether) return;
    let on = true;
    ether.invoke("library-health:get").then((s: any) => { if (on) offer(s?.notInCatalogue?.files); }).catch(() => {});
    const h = ether.on ? ether.on("library-health", (s: any) => offer(s?.notInCatalogue?.files)) : null;
    const fromResync = (e: Event) => offer((e as CustomEvent).detail?.files, true);
    window.addEventListener("ether:catalogue-prompt", fromResync);
    return () => { on = false; if (h && ether.off) ether.off("library-health", h); window.removeEventListener("ether:catalogue-prompt", fromResync); };
  }, [ether, offer]);

  if (!files) return null;
  const close = () => { setFiles(null); setResults(null); setError(null); };
  const no = () => { for (const f of files) answered.add(f.key); close(); };
  const yes = async () => {
    for (const f of files) answered.add(f.key);
    setBusy(true); setError(null);
    try {
      const r = await ether!.invoke("catalogue:move-in", files);
      if (!r?.ok) setError(r?.error || "The move failed.");
      else setResults(r.results || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const box: React.CSSProperties = { background: "var(--bg-primary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)",
    width: "min(640px, calc(100vw - 32px))", maxHeight: "80vh", display: "flex", flexDirection: "column", padding: 16, gap: 10 };
  const btn: React.CSSProperties = { padding: "7px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer", border: "1px solid var(--border-secondary)",
    background: "var(--bg-secondary)", color: "var(--text-primary)" };
  return (
    <div role="dialog" aria-modal="true" aria-label="Move files to the catalogue"
      style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={box}>
        {!results && <div style={{ fontSize: 15, fontWeight: 700 }}>These files need to be moved to the catalogue. Do you want to do that now?</div>}
        {results && <div style={{ fontSize: 15, fontWeight: 700 }}>{results.filter(r => r.ok).length} of {results.length} files are in the catalogue now.</div>}
        <div style={{ overflowY: "auto", fontSize: 12, border: "1px solid var(--border-primary)", padding: "6px 8px" }}>
          {!results && files.map(f => (
            <div key={f.key} style={{ padding: "3px 0" }}>
              <span style={{ fontWeight: 600 }}>{f.name || "(no file name)"}</span>
              <span style={{ color: "var(--text-tertiary)" }}> — {whereText(f)}</span>
            </div>
          ))}
          {results && results.map(r => (
            <div key={r.key} style={{ padding: "3px 0", color: r.ok ? "var(--text-secondary)" : "#f59e0b" }}>
              <span style={{ fontWeight: 600 }}>{r.name || "(no file name)"}</span>
              {r.ok ? ` — ${r.action === "downloaded" ? "downloaded" : r.action === "moved" ? "moved" : "already in the catalogue"}${r.note ? ` (${r.note})` : ""}`
                    : ` — not moved: ${r.reason}`}
            </div>
          ))}
        </div>
        {error && <div role="alert" style={{ color: "#ef4444", fontSize: 12 }}>Not moved: {error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {!results && <button style={btn} onClick={no} disabled={busy}>No</button>}
          {!results && <button style={{ ...btn, background: "var(--accent-blue)", color: "#fff", border: "none" }} onClick={yes} disabled={busy}>{busy ? "Moving…" : "Yes"}</button>}
          {results && <button style={btn} onClick={close}>Close</button>}
        </div>
      </div>
    </div>
  );
}

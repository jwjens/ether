// PublicLinks — Preferences → Links: every public page of this account and its stations, at its real address, with
// Open and Copy (2026-10-27; src/lib/publicPages.ts has the routes and where each value comes from).
import { useEffect, useState } from "react";
import { pageLinks, type AccountLinksData, type PageLink, type PageType } from "../lib/publicPages";

type Loaded = { state: "loading" } | { state: "error"; reason: string } | { state: "ok"; data: AccountLinksData };

/** This account's handle, stations (with public slugs) and jukebox slugs — once per Preferences open. */
export function useAccountLinks(): { loaded: Loaded; links: PageLink[]; reload: () => void } {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stop = false;
    setLoaded({ state: "loading" });
    (async () => {
      try {
        const r = await (window as any).ether?.invoke?.("links:account");
        if (stop) return;
        if (r && r.ok) setLoaded({ state: "ok", data: { handle: r.handle ?? null, stations: r.stations || [], jukeboxSlugs: r.jukeboxSlugs || {} } });
        else setLoaded({ state: "error", reason: (r && r.reason) || "no answer" });
      } catch (e: any) { if (!stop) setLoaded({ state: "error", reason: String(e?.message || e) }); }
    })();
    return () => { stop = true; };
  }, [tick]);
  // Without the account, the pages that need no station or handle are still listed (sign-up, apps, website).
  const data: AccountLinksData = loaded.state === "ok" ? loaded.data : { handle: null, stations: [], jukeboxSlugs: {} };
  return { loaded, links: pageLinks(data), reload: () => setTick(t => t + 1) };
}

const btn: React.CSSProperties = {
  padding: "4px 10px", fontSize: 12, fontWeight: 600, borderRadius: 0, cursor: "pointer", flexShrink: 0,
  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)",
};

function Row({ l }: { l: PageLink }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!l.url) return;
    try { await navigator.clipboard.writeText(l.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard refused */ }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border-primary)", minWidth: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{l.name}{l.station ? ` — ${l.station}` : ""}</div>
        {l.url
          ? <div style={{ fontSize: 12, fontFamily: "monospace", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.url}>{l.url}</div>
          : <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No address: {l.missing}</div>}
      </div>
      <button style={{ ...btn, opacity: l.url ? 1 : 0.4 }} disabled={!l.url} onClick={() => l.url && (window as any).ether?.system?.openUrl?.(l.url)}>Open</button>
      <button style={{ ...btn, opacity: l.url ? 1 : 0.4 }} disabled={!l.url} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

/** One type's lines (Preferences → Links → <type>). */
export function LinkRows({ type, links, loaded, reload }: { type: PageType; links: PageLink[]; loaded: Loaded; reload: () => void }) {
  const rows = links.filter(l => l.type === type);
  return (
    <div>
      {loaded.state === "loading" && <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 6 }}>Getting your account's stations…</div>}
      {loaded.state === "error" && (
        <div style={{ fontSize: 12, color: "var(--accent-amber, #f59e0b)", marginBottom: 6 }}>
          Your stations' addresses could not be read: {loaded.reason}. <button style={btn} onClick={reload}>Try again</button>
        </div>
      )}
      {rows.length === 0 && loaded.state === "ok" && <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No stations on this account.</div>}
      {rows.map((l, i) => <Row key={`${l.name}|${l.station || ""}|${i}`} l={l} />)}
    </div>
  );
}

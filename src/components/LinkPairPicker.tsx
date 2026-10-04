// LinkPairPicker — how a Link fader gets its sender (Jeff's ruling, 2026-10-04: the key is never copied or typed by hand).
//   1. THIS ACCOUNT (default): pick one of the account's computers; its key is fetched from the Ether service and
//      followed when that computer replaces its key.
//   2. A GUEST computer (another account): type the 8-character code its screen shows (XXXX-XXXX, 10 minutes, once).
//   3. Advanced: paste an ether-link:1: line (the old way, kept as a fallback).
// Used on the board strip (compact) and in Preferences → Broadcast → Remote Link.
import React, { useCallback, useEffect, useState } from "react";
import type { AccountMachine, LinkInputEdit, PairResult } from "../hooks/useRemoteLink";
import { codeComplete, formatCodeTyping } from "../lib/linkPairing";

type LinkApi = {
  accountMachines: () => Promise<{ ok: boolean; machines?: AccountMachine[]; reason?: string }>;
  pairMachine: (machineId: string) => Promise<PairResult>;
  pairRedeem: (code: string) => Promise<PairResult>;
  setInput: (input: LinkInputEdit | null) => Promise<{ ok: boolean; reason?: string }>;
};

const FIELD: React.CSSProperties = {
  minHeight: 30, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)",
  padding: "0 8px", fontSize: 12,
};

export default function LinkPairPicker({ link, edit, compact = false, label }: {
  link: LinkApi;
  /** The fader's current settings without its key — needed by the advanced paste. null = no fader patched. */
  edit: LinkInputEdit | null;
  compact?: boolean;
  /** e.g. "channel G" — for screen readers. */
  label?: string;
}) {
  const [machines, setMachines] = useState<AccountMachine[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [line, setLine] = useState("");

  const load = useCallback(async () => {
    setListErr(null);
    const r = await link.accountMachines();
    if (r.ok) setMachines(r.machines || []); else { setMachines([]); setListErr(r.reason || "could not read this account's computers"); }
  }, [link]);
  useEffect(() => { load(); }, [load]);

  const run = async (p: Promise<PairResult | { ok: boolean; reason?: string }>) => {
    setBusy(true); setMsg(null);
    try { const r = await p; if (!r.ok) setMsg(`⚠ ${r.reason || "not applied"}`); else { setCode(""); setLine(""); } }
    finally { setBusy(false); }
  };
  const gap = compact ? 4 : 8;
  const published = (machines || []).filter(m => m.published);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap, width: "100%" }}>
      {/* 1 · this account */}
      <select disabled={busy || machines == null} value="" aria-label={`Pick the sending computer${label ? ` for ${label}` : ""}`}
        onChange={e => { if (e.target.value) run(link.pairMachine(e.target.value)); }}
        style={{ ...FIELD, cursor: "pointer", width: "100%" }}>
        <option value="">{machines == null ? "reading this account's computers…"
          : published.length ? "— pick the sending computer —" : "no other computer on this account has shared its key yet"}</option>
        {(machines || []).map(m => (
          <option key={m.machineId} value={m.machineId} disabled={!m.published}>
            {m.name}{m.published ? (m.fingerprint ? `  ·  key ${m.fingerprint}` : "") : "  ·  not shared yet — open Ether on it"}
          </option>
        ))}
      </select>
      {listErr && <div style={{ fontSize: 11, color: "var(--accent-red, #ef4444)" }}>⚠ {listErr}</div>}

      {/* 2 · a guest computer's code */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input value={code} disabled={busy} placeholder="guest code  XXXX-XXXX" inputMode="text" autoCapitalize="characters"
          aria-label={`Guest pairing code${label ? ` for ${label}` : ""}`}
          onChange={e => setCode(formatCodeTyping(e.target.value))}
          onKeyDown={e => { if (e.key === "Enter" && codeComplete(code)) run(link.pairRedeem(code)); }}
          style={{ ...FIELD, flex: 1, minWidth: 0, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.08em" }} />
        <button disabled={busy || !codeComplete(code)} onClick={() => run(link.pairRedeem(code))}
          style={{ ...FIELD, cursor: codeComplete(code) ? "pointer" : "default", fontWeight: 700 }}>Pair</button>
      </div>

      {/* 3 · advanced: the old line */}
      <details>
        <summary style={{ fontSize: 11, color: "var(--text-tertiary)", cursor: "pointer" }}>Advanced — paste a link key line</summary>
        <input value={line} disabled={busy || !edit} placeholder="ether-link:1:…" aria-label="Paste a link key line"
          onChange={e => setLine(e.target.value)}
          onPaste={e => { const t = e.clipboardData.getData("text"); if (t.trim() && edit) { e.preventDefault(); setLine(t); run(link.setInput({ ...edit, keyLine: t })); } }}
          onKeyDown={e => { if (e.key === "Enter" && line.trim() && edit) run(link.setInput({ ...edit, keyLine: line })); }}
          style={{ ...FIELD, width: "100%", marginTop: 4, boxSizing: "border-box", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }} />
      </details>

      {msg && <div style={{ fontSize: 11, color: "var(--accent-red, #ef4444)" }}>{msg}</div>}
    </div>
  );
}

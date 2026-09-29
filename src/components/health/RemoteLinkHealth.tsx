// RemoteLinkHealth.tsx — the Health Monitor's view of THE REMOTE LINK (docs/remote-link-design-2026-09-28.md; "build
// the sense, not the scaffold"). Both directions as the ENGINE reports them: the receive side (who is sending, the
// latency, what was lost / recovered / concealed, keys refused, a second sender refused, dropouts, the clock drift the
// engine absorbs) and SEND TO (what the far end SAYS it received — never assumed). Nothing is claimed: an end the
// engine has not reported says "waiting for the engine".
import React from "react";
import { HealthPanel } from "./sectionChrome";
import { openLinkPreferences, rxWords, txWords, useRemoteLink } from "../../hooks/useRemoteLink";
import { useBoardName } from "../../hooks/useBoardName";

const TONE: Record<string, string> = { ok: "var(--accent-green)", warn: "var(--accent-amber, #f59e0b)", bad: "var(--accent-red, #ef4444)", off: "var(--text-tertiary)" };
const MONO: React.CSSProperties = { color: "var(--text-tertiary)", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 };
const n = (v: number | null | undefined, d = 0) => (v == null ? "—" : v.toFixed(d));

export default function RemoteLinkHealth({ id, stationId }: { id: string; stationId: number | null }) {
  const link = useRemoteLink(stationId);
  const name = useBoardName();
  const cfg = link.cfg;
  const rx = link.state?.rx ?? null;
  const tx = link.state?.tx ?? null;
  const input = cfg?.input ?? null;
  const send = cfg?.send ?? null;
  const target = cfg?.stations.find(s => s.uuid === send?.target)?.name;
  const wIn = rxWords(rx, !!input);
  const wOut = txWords(tx, !!send, target);
  return (
    <HealthPanel id={id} title="Remote Link" right={
      <button onClick={openLinkPreferences} style={{ fontSize: 11, cursor: "pointer", background: "transparent", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", padding: "2px 8px" }}
              title="Key, buffer, port, auto-cut and SEND TO: Preferences → Broadcast → Remote Link">Set up…</button>
    }>
      {!input && !send ? (
        <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
          No Remote Link on this station on this computer. To take a remote broadcast, set a source channel's source to <b>Link</b>;
          to send this station to another, use <b>SEND TO</b>.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {input && (
            <div style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: "2px 12px", alignItems: "baseline" }}>
              <b style={{ minWidth: 70 }}>IN · {name(input.slot)}</b>
              <span style={{ color: TONE[wIn.tone], fontWeight: 700 }}>● {wIn.text}</span>
              {rx && (
                <span style={MONO} title="latency = the remote's programme bus → this channel · lost = frames missing at their turn (FEC = recovered from the next packet, concealed = filled by the codec) · late = arrived after their turn · dropouts = the channel ran dry · key refused = packets that failed the key check (never answered)">
                  {rx.transport} {rx.port} · latency {n(rx.latencyMs)} ms · buffer {n(rx.bufferedMs)}/{rx.jitterTargetMs} ms · jitter {n(rx.jitterMs, 1)} ms ·
                  {" "}lost {rx.lost} (FEC {rx.fec}, concealed {rx.concealed}) · late {rx.late} · dropouts {rx.underruns ?? 0} · starved {rx.starved} ·
                  {" "}key refused {rx.authFailures} · 2nd sender refused {rx.busyRefusals} · clock {rx.driftPpm != null ? `${rx.driftPpm >= 0 ? "+" : ""}${rx.driftPpm.toFixed(0)} ppm` : "—"} · reconnects {rx.reconnects}
                  {input.autoCut ? ` · auto-cut after ${input.autoCutSec} s` : " · auto-cut off"}
                </span>
              )}
              {rx && rx.reason && <span style={{ color: "var(--text-tertiary)", width: "100%", paddingLeft: 82 }}>{rx.reason}</span>}
            </div>
          )}
          {send && (
            <div style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: "2px 12px", alignItems: "baseline" }}>
              <b style={{ minWidth: 70 }}>SEND TO</b>
              <span style={{ color: TONE[wOut.tone], fontWeight: 700 }}>● {wOut.text}</span>
              {tx && (
                <span style={MONO} title="What this computer sent, and what the receiving station reports it received">
                  {tx.transport} → {tx.host}:{tx.port} · {tx.bitrate / 1000} kb/s · FEC {tx.fec ? `on (hint ${tx.lossHint} %)` : "off"} · RTT {n(tx.rttMs, 1)} ms ·
                  {" "}sent {tx.framesSent} · tap overruns {tx.tapOverruns} · send errors {tx.sendErrors} ·
                  {" "}far end: {tx.rxState || "—"}, received {tx.rxReceived}, lost {tx.rxLost}
                </span>
              )}
              {tx && tx.reason && <span style={{ color: "var(--text-tertiary)", width: "100%", paddingLeft: 82 }}>{tx.reason}</span>}
            </div>
          )}
        </div>
      )}
    </HealthPanel>
  );
}

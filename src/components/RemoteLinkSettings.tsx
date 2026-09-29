// RemoteLinkSettings.tsx — Preferences → Broadcast → REMOTE LINK (docs/remote-link-design-2026-09-28.md).
//
// Two halves, because one station can be either end:
//   RECEIVE — this station takes a remote Ether box's programme on a source channel patched to "Link": the
//             station's link key (made here; shown only as a fingerprint), the jitter buffer, the UDP port this
//             computer listens on, the auto-cut (D4: ships OFF, its delay shown), and the engine's live numbers.
//   SEND TO — this station's programme (before its processing — ruling D3) goes to another station: which one,
//             the address, the bitrate, FEC, and the SRT fallback timeout (shown, not active: SRT is not in this
//             build). Every D5 number is visible and editable here (Jeff's ruling).
// Everything is machine-local. The key is local in this build: carrying it to other machines is the next slice.
import React, { useEffect, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { useDeckConfig } from "./DeckConfigurator";
import { useBoardName } from "../hooks/useBoardName";
import { rxWords, txWords, useRemoteLink, type LinkInput, type LinkSend } from "../hooks/useRemoteLink";

const TONE: Record<string, string> = { ok: "var(--accent-green)", warn: "var(--accent-amber, #f59e0b)", bad: "var(--accent-red, #ef4444)", off: "var(--text-tertiary)" };
const FIELD: React.CSSProperties = {
  minHeight: 36, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", padding: "0 8px", fontSize: 12,
};
const LABEL: React.CSSProperties = { fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", minWidth: 150 };
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "var(--text-tertiary)" };
const BITRATES = [64000, 96000, 128000, 160000, 192000, 256000];
const n = (v: number | null | undefined, d = 0) => (v == null ? "—" : v.toFixed(d));

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }} title={hint}>
      <span style={LABEL}>{label}</span>
      {children}
    </div>
  );
}

export default function RemoteLinkSettings() {
  const { stationId } = useActiveStation();
  const { configs } = useDeckConfig();
  const boardName = useBoardName();
  const link = useRemoteLink(stationId);
  const cfg = link.cfg;
  const rx = link.state?.rx ?? null;
  const tx = link.state?.tx ?? null;
  const d = cfg?.defaults;
  const [msgIn, setMsgIn] = useState("");
  const [msgOut, setMsgOut] = useState("");
  const [confirmRotate, setConfirmRotate] = useState(false);
  // SEND TO draft (edited here, applied with Start)
  const [draft, setDraft] = useState<LinkSend | null>(null);
  useEffect(() => {
    if (!cfg || draft) return;
    setDraft(cfg.send ?? { target: "", host: "", port: cfg.defaults.port, bitrate: cfg.defaults.bitrate, fec: true, srtFallbackSec: null });
  }, [cfg, draft]);

  if (!cfg) return <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Reading the Remote Link…</div>;
  if (!cfg.daemon) return <div style={{ fontSize: 12, color: TONE.bad }}>The Remote Link needs the audio engine service — fully close and reopen Ether.</div>;

  // Where the board has a channel set to Link (the patch is made on the strip; here are its settings).
  const linkChannels = ((configs as any[]) || []).filter(c => c.enabled && c.type === "source" && c.kind === "link").map(c => c.slot as string);
  const input = cfg.input;
  const wIn = rxWords(rx, !!input);
  const applyIn = async (next: LinkInput | null) => {
    setMsgIn("");
    const r = await link.setInput(next);
    if (!r.ok) setMsgIn(`⚠ Not applied — ${r.reason}`);
  };
  const targetName = (uuid?: string) => cfg.stations.find(s => s.uuid === uuid)?.name;
  const sending = !!cfg.send;
  const wOut = txWords(tx, sending, targetName(cfg.send?.target));
  const choice = cfg.stations.find(s => s.uuid === draft?.target);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
        A <b>remote broadcast</b> keeps this station on air while another Ether computer — at the venue — sends its board to a channel here,
        directly over the network in about a fifth of a second (the listener stream is about 8 s behind, far too late to cue from).
        The remote computer's programme arrives on a <b>source channel</b> set to <b>Link</b>, and from there it is a channel like any other:
        its meter, fader, ON, the ducker, and this station's processing — once.
      </div>

      {/* ── RECEIVE ─────────────────────────────────────────────────────────────────────────── */}
      <div style={{ padding: 10, border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <b style={{ fontSize: 13 }}>Receive on this station</b>
          <span style={{ fontSize: 12, fontWeight: 700, color: TONE[wIn.tone] }}>● {wIn.text}</span>
          {rx && rx.reason && rx.state !== "receiving" && <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{rx.reason}</span>}
        </div>

        <Row label="Link key" hint="Senders seal every packet with this key; anything without it is refused silently. Shown as a fingerprint — compare it on both computers.">
          {cfg.key ? (
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 800 }}>{cfg.key.fingerprint}</span>
          ) : <span style={{ fontSize: 12, color: TONE.warn }}>none yet</span>}
          {cfg.key && <span style={MONO}>key #{cfg.key.id}{cfg.key.mintedAt ? ` · made ${new Date(cfg.key.mintedAt).toLocaleString()}` : ""}</span>}
          {!cfg.key ? (
            <button style={{ ...FIELD, cursor: "pointer" }} onClick={async () => { const r = await link.mintKey(); if (!r.ok) setMsgIn(`⚠ ${r.reason}`); }}>Make a key</button>
          ) : confirmRotate ? (
            <>
              <button style={{ ...FIELD, cursor: "pointer", borderColor: TONE.bad, color: TONE.bad }}
                onClick={async () => { setConfirmRotate(false); const r = await link.mintKey(); if (!r.ok) setMsgIn(`⚠ ${r.reason}`); }}>
                Replace — a sender with the old key is refused from now on
              </button>
              <button style={{ ...FIELD, cursor: "pointer" }} onClick={() => setConfirmRotate(false)}>Keep</button>
            </>
          ) : <button style={{ ...FIELD, cursor: "pointer" }} onClick={() => setConfirmRotate(true)}>Replace key…</button>}
        </Row>

        <Row label="Channel">
          {input ? <span style={{ fontSize: 12 }}>Source channel <b>{boardName(input.slot)}</b> is set to Link</span>
            : <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                No channel takes the Link. On the board, set a source channel's source to <b>Link (remote Ether)</b>.
                {linkChannels.length > 0 && ` (${linkChannels.map(boardName).join(", ")} ${linkChannels.length > 1 ? "are" : "is"} set to Link but not patched in the engine — pick Link on the strip again.)`}
              </span>}
        </Row>

        {input && d && (
          <>
            <Row label="Jitter buffer" hint={`How much audio the Link holds to ride out network wobble (${d.jitterRangeMs[0]}–${d.jitterRangeMs[1]} ms). More = fewer dropouts, more delay. Default ${d.jitterMs} ms.`}>
              <input type="number" min={d.jitterRangeMs[0]} max={d.jitterRangeMs[1]} step={20} defaultValue={input.jitterMs} key={`j${input.jitterMs}`}
                style={{ ...FIELD, width: 100 }} onBlur={e => { const v = Number(e.target.value); if (v && v !== input.jitterMs) applyIn({ ...input, jitterMs: v }); }} />
              <span style={MONO}>ms (default {d.jitterMs})</span>
            </Row>
            <Row label="Listen on UDP port" hint="The port this computer listens on, for every station on it. A router forwarding the remote's traffic here points at this port.">
              <input type="number" min={1} max={65535} defaultValue={input.port} key={`p${input.port}`}
                style={{ ...FIELD, width: 100 }} onBlur={e => { const v = Number(e.target.value); if (v && v !== input.port) applyIn({ ...input, port: v }); }} />
              <span style={MONO}>default {d.port} · in use: {link.state?.port ?? "—"}</span>
            </Row>
            <Row label="Auto-cut on loss" hint="If the Link is lost for this long, turn this channel OFF — so the remote never returns to air unannounced. Off by default: the channel just goes silent and NOT FED.">
              <button role="switch" aria-checked={input.autoCut} onClick={() => applyIn({ ...input, autoCut: !input.autoCut })}
                style={{ ...FIELD, cursor: "pointer", fontWeight: 700, color: input.autoCut ? TONE.ok : "var(--text-tertiary)" }}>
                {input.autoCut ? "ON" : "OFF"}
              </button>
              <span style={{ fontSize: 12 }}>turn the channel OFF after</span>
              <input type="number" min={1} max={600} defaultValue={input.autoCutSec} key={`a${input.autoCutSec}`}
                style={{ ...FIELD, width: 70 }} onBlur={e => { const v = Number(e.target.value); if (v && v !== input.autoCutSec) applyIn({ ...input, autoCutSec: v }); }} />
              <span style={{ fontSize: 12 }}>s of loss</span>
            </Row>
          </>
        )}

        {rx && input && (
          <div style={MONO} title="The engine's live numbers for the Link">
            {rx.transport} {rx.port}{rx.sender ? ` · from ${rx.sender} (${rx.senderAddr})` : ""} ·
            latency {n(rx.latencyMs)} ms (network {n(rx.oneWayMs)} + buffered {n(rx.bufferedMs)}) · jitter {n(rx.jitterMs, 1)} ms · {n(rx.kbps)} kb/s
            <br />
            received {rx.received} · lost {rx.lost} (FEC {rx.fec}, concealed {rx.concealed}) · late {rx.late} · reordered {rx.reordered} ·
            {" "}dropouts {rx.underruns ?? 0} · starved {rx.starved} · key refused {rx.authFailures} · second sender refused {rx.busyRefusals} ·
            {" "}clock {rx.driftPpm != null ? `${rx.driftPpm >= 0 ? "+" : ""}${rx.driftPpm.toFixed(0)} ppm` : "—"} · reconnects {rx.reconnects}
          </div>
        )}
        {msgIn && <div style={{ fontSize: 12, color: TONE.bad }}>{msgIn}</div>}
      </div>

      {/* ── SEND TO ─────────────────────────────────────────────────────────────────────────── */}
      <div style={{ padding: 10, border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <b style={{ fontSize: 13 }}>SEND TO another station</b>
          <span style={{ fontSize: 12, fontWeight: 700, color: TONE[wOut.tone] }}>● {sending ? "SENDING " : ""}{wOut.text}</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
          Sends this station's programme — before its processing, so the station it feeds processes once — to a channel set to Link there.
        </div>
        {draft && d && (
          <>
            <Row label="Station">
              <select value={draft.target} disabled={sending} style={{ ...FIELD, flex: "1 1 240px" }}
                onChange={e => setDraft({ ...draft, target: e.target.value })}>
                <option value="">— pick a station —</option>
                {cfg.stations.map(s => (
                  <option key={s.uuid} value={s.uuid} disabled={!!s.refusal} title={s.refusal || ""}>
                    {s.name}{s.refusal ? ` — ${s.refusal}` : !s.hasKeyHere ? " — no key on this computer" : ` · key ${s.keyFingerprint}`}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Address" hint="Where that station's computer listens: its public address (with the router forwarding the port) — or 127.0.0.1 when it is on this computer. The relay on the Ether server is the next slice.">
              <input value={draft.host} disabled={sending} placeholder="ov.example.org, 203.0.113.7 — or 127.0.0.1" style={{ ...FIELD, flex: "1 1 240px" }}
                onChange={e => setDraft({ ...draft, host: e.target.value })} />
              <span style={LABEL as any}>port</span>
              <input type="number" min={1} max={65535} value={draft.port} disabled={sending} style={{ ...FIELD, width: 90 }}
                onChange={e => setDraft({ ...draft, port: Number(e.target.value) })} />
            </Row>
            <Row label="Bitrate" hint={`Opus, stereo, 48 kHz, 20 ms frames. Default ${d.bitrate / 1000} kb/s.`}>
              <select value={draft.bitrate} disabled={sending} style={{ ...FIELD, width: 130 }} onChange={e => setDraft({ ...draft, bitrate: Number(e.target.value) })}>
                {BITRATES.map(b => <option key={b} value={b}>{b / 1000} kb/s{b === d.bitrate ? " (default)" : ""}</option>)}
              </select>
              <span style={MONO}>Opus · stereo · {d.rate / 1000} kHz · {d.frameMs} ms frames · {d.transport}</span>
            </Row>
            <Row label="Loss protection (FEC)" hint="Measured: with FEC on and no loss reported, the codec runs at full quality. When the receiver reports loss, the codec moves some frames to a speech-style mode to carry a spare copy — the audio is recoverable but measurably less clean on music.">
              <button role="switch" aria-checked={draft.fec} disabled={sending} onClick={() => setDraft({ ...draft, fec: !draft.fec })}
                style={{ ...FIELD, cursor: "pointer", fontWeight: 700, color: draft.fec ? TONE.ok : "var(--text-tertiary)" }}>{draft.fec ? "ON" : "OFF"}</button>
              <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                Full quality while nothing is lost; when the far end reports loss, part of the audio is coded as speech to carry a spare copy.
              </span>
            </Row>
            <Row label="SRT → UDP fallback" hint="SRT is not in this build — this build sends UDP only. The timeout is shown so it can be set before SRT arrives.">
              <input type="number" disabled value={draft.srtFallbackSec ?? cfg.srtFallbackProposedSec} style={{ ...FIELD, width: 70, opacity: 0.6 }} />
              <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>s — proposed {cfg.srtFallbackProposedSec} s, not set. SRT is not in this build: the Link sends UDP.</span>
            </Row>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {!sending ? (
                <button style={{ ...FIELD, cursor: "pointer", fontWeight: 800, color: TONE.ok, borderColor: TONE.ok }}
                  disabled={!draft.target || !draft.host.trim() || !!choice?.refusal}
                  onClick={async () => { setMsgOut(""); const r = await link.setSend(draft); if (!r.ok) setMsgOut(`⚠ Not sending — ${r.reason}`); }}>
                  ▶ SEND TO {choice?.name || "…"}
                </button>
              ) : (
                <button style={{ ...FIELD, cursor: "pointer", fontWeight: 800, color: TONE.bad, borderColor: TONE.bad }}
                  onClick={async () => { setMsgOut(""); const r = await link.setSend(null); if (!r.ok) setMsgOut(`⚠ ${r.reason}`); }}>
                  ■ STOP SENDING
                </button>
              )}
              {choice?.refusal && <span style={{ fontSize: 12, color: TONE.bad }}>{choice.refusal}</span>}
            </div>
          </>
        )}
        {tx && sending && (
          <div style={MONO} title="The engine's live numbers for SEND TO; the receiver's are from its own report">
            {tx.transport} → {tx.host}:{tx.port} · {tx.bitrate / 1000} kb/s · FEC {tx.fec ? `on (loss hint ${tx.lossHint} %)` : "off"} · RTT {n(tx.rttMs, 1)} ms ·
            {" "}sent {tx.framesSent} frames · send errors {tx.sendErrors} · tap overruns {tx.tapOverruns}
            <br />
            receiver says: {tx.rxState || "—"} · received {tx.rxReceived} · lost {tx.rxLost} (FEC {tx.rxFec}, concealed {tx.rxConcealed}) · buffer {tx.rxDepthMs} ms · jitter {tx.rxJitterMs} ms
          </div>
        )}
        {msgOut && <div style={{ fontSize: 12, color: TONE.bad }}>{msgOut}</div>}
      </div>
    </div>
  );
}

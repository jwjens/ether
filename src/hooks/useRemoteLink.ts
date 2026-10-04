// src/hooks/useRemoteLink.ts — THE REMOTE LINK, renderer side (docs/remote-link-design-2026-09-28.md).
//
// A Link is a FEED over the network into a FADER (its input selector set to Link) — not station to station. The
// SENDING machine makes the key and shows it as one copyable line; the receiving fader's Link input takes it pasted.
// ONE READER, ONE WRITER, like the mic (useMicInputs.ts). The stored Link (which fader takes it and whose key it
// holds, where this station's feed goes, this machine's key fingerprint) is read with link:get and written with
// link:set-input / link:set-send — ENGINE FIRST, stored machine-local only if the engine took it. The live state (both directions,
// every counter) is the ENGINE's, read with link:state. One shared poller per station, however many strips and
// panels show it. The words for each state are HERE, so the strip, Preferences and the Health Monitor say the same.
import { useCallback, useEffect, useState } from "react";
import { OPEN_PREFS_KEY } from "./useMicInputs";

export type LinkDefaults = { bitrate: number; bitrateRange: [number, number]; jitterMs: number; jitterRangeMs: [number, number];
                             port: number; frameMs: number; rate: number; transport: string };
/** Whose key the fader holds (pasted from the sending computer) — shown as a name and fingerprint, never the key. */
/** via (2026-10-04): how it was paired — "account" (followed when the sender replaces its key), "code" (a guest), "line". */
export type LinkFrom = { machine: string; name: string; keyId: number; fingerprint: string; via?: "account" | "code" | "line" };
export type LinkInput = { slot: string; jitterMs: number; port: number; autoCut: boolean; autoCutSec: number; from?: LinkFrom | null };
/** A change to the fader's Link: `keyLine` = a pasted key line, `clearKey` = forget the key (cut that sender off). */
export type LinkInputEdit = Omit<LinkInput, "from"> & { keyLine?: string; clearKey?: boolean };
export type LinkSend = { target: string; targetMachine: string; targetMachineName: string; host: string; port: number;
                         bitrate: number; fec: boolean; srtFallbackSec: number | null };
/** Where a feed can go: a computer · a station on it (and, on this computer, the fader set to Link). */
export type LinkTarget = { machine: string; machineName: string; thisComputer: boolean; stationUuid: string; stationName: string;
                           stationId: number; channel?: string | null; refusal: string | null };
export type LinkCfg = {
  ok: boolean; reason?: string; defaults: LinkDefaults; stationUuid: string; machineId: string | null; machineName: string; selfTest: boolean;
  input: LinkInput | null; inputRefusal: string | null; send: LinkSend | null; key: { fingerprint: string; id: number; mintedAt: string | null } | null;
  targets: LinkTarget[]; slots: string[]; autoCutDefault: { autoCut: boolean; autoCutSec: number };
  srtFallbackProposedSec: number; daemon: boolean;
};
export type LinkRx = {
  slot: string; state: string; reason: string; port: number; transport: string; sender: string; senderAddr: string;
  jitterTargetMs: number; packets: number; authFailures: number; lastAuthFailureAgoMs: number | null; replays: number;
  busyRefusals: number; busySender: string; reconnects: number; received: number; lost: number; fec: number; concealed: number;
  late: number; duplicates: number; reordered: number; tooFar: number; starved: number; staleFlushes: number; staleDropped: number;
  jitterMs: number; depthMs: number; bufferedMs: number; rttMs: number | null; oneWayMs: number | null; latencyMs: number | null;
  kbps: number; lastPacketAgoMs: number | null;
  ringMs?: number; ringTargetMs?: number; driftPpm?: number; primed?: boolean; underruns?: number; starvedMs?: number;
};
export type LinkTx = {
  target: string; host: string; port: number; state: string; reason: string; transport: string; bitrate: number; fec: boolean;
  lossHint: number; framesSent: number; bytesSent: number; sendErrors: number; encodeErrors: number; tapOverruns: number;
  rttMs: number | null; offsetMs: number | null; reconnects: number; lastPongAgoMs: number | null; busyHolder: string;
  rxState: string; rxReceived: number; rxLost: number; rxFec: number; rxConcealed: number; rxLate: number; rxDepthMs: number; rxJitterMs: number;
};
export type LinkState = { v: number; port?: number; rx: LinkRx | null; tx: LinkTx | null };

const REV_KEY = "ether.link.rev";
const OPEN_KEY = OPEN_PREFS_KEY;   // the same door App.tsx listens on (a pop-out opens Preferences in the main window)

type Snap = { cfg: LinkCfg | null; state: LinkState | null };
type Store = { snap: Snap; subs: Set<(s: Snap) => void>; timer: any; tick: number };
const stores = new Map<number, Store>();

async function refresh(stationId: number, cfg: boolean) {
  const st = stores.get(stationId);
  if (!st) return;
  const api = (window as any).ether?.audio;
  let next = st.snap;
  try {
    if (cfg) { const r = await api?.linkGet?.(stationId); if (r && r.ok) next = { ...next, cfg: r }; }
    const s = await api?.linkState?.(stationId);
    if (s) next = { ...next, state: s };
  } catch { /* keep the last snapshot; the panel says what it last knew */ }
  st.snap = next;
  st.subs.forEach(fn => fn(next));
}
function bump(stationId: number) {
  try { localStorage.setItem(REV_KEY, `${stationId}:${Date.now()}`); } catch { /* not essential */ }
  refresh(stationId, true);
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key !== REV_KEY) return;
    for (const id of stores.keys()) refresh(id, true);
  });
}

/** The station's stored Link and the engine's live Link state. Polled once a second while anything shows it. */
export function useRemoteLink(stationId: number | null | undefined) {
  const empty: Snap = { cfg: null, state: null };
  const [snap, setSnap] = useState<Snap>(() => (stationId != null ? stores.get(stationId)?.snap ?? empty : empty));
  useEffect(() => {
    if (stationId == null) { setSnap(empty); return; }
    let st = stores.get(stationId);
    if (!st) {
      st = { snap: empty, subs: new Set(), timer: null, tick: 0 };
      stores.set(stationId, st);
      const s0 = st;
      s0.timer = setInterval(() => { s0.tick++; refresh(stationId, s0.tick % 15 === 0); }, 1000);
      refresh(stationId, true);
    } else setSnap(st.snap);
    st.subs.add(setSnap);
    return () => {
      const s2 = stores.get(stationId);
      if (!s2) return;
      s2.subs.delete(setSnap);
      if (s2.subs.size === 0) { clearInterval(s2.timer); stores.delete(stationId); }
    };
  }, [stationId]);

  const api = () => (window as any).ether?.audio;
  /** Patch the Link on a fader / change its buffer, port, auto-cut or pasted key (null = unpatch). Engine first. */
  const setInput = useCallback(async (input: LinkInputEdit | null): Promise<{ ok: boolean; reason?: string; needsKey?: boolean }> => {
    if (stationId == null) return { ok: false, reason: "no station" };
    const r = await api()?.linkSetInput?.(stationId, input);
    bump(stationId);
    return r || { ok: false, reason: "no answer" };
  }, [stationId]);
  /** The feed out (null = stop). Engine first. */
  const setSend = useCallback(async (send: LinkSend | null): Promise<{ ok: boolean; reason?: string }> => {
    if (stationId == null) return { ok: false, reason: "no station" };
    const r = await api()?.linkSetSend?.(stationId, send);
    bump(stationId);
    return r || { ok: false, reason: "no answer" };
  }, [stationId]);
  /** Replace THIS COMPUTER's link key. Every fader holding the old one stops accepting this computer's feed. */
  const mintKey = useCallback(async (): Promise<{ ok: boolean; reason?: string }> => {
    const r = await api()?.linkMintKey?.();
    if (stationId != null) bump(stationId);
    return r || { ok: false, reason: "no answer" };
  }, [stationId]);
  /** This computer's key as the one copyable line (made on first ask). */
  const keyLine = useCallback(async (): Promise<{ ok: boolean; line?: string; reason?: string }> => {
    const r = await api()?.linkKeyLine?.();
    if (stationId != null) bump(stationId);
    return r || { ok: false, reason: "no answer" };
  }, [stationId]);

  // ── PAIRING (2026-10-04): the key is never copied or typed by hand ──
  /** This account's other computers, and whether each has shared its key. */
  const accountMachines = useCallback(async (): Promise<{ ok: boolean; machines?: AccountMachine[]; reason?: string }> =>
    (await api()?.linkAccountMachines?.()) || { ok: false, reason: "no answer" }, []);
  /** Same account: put the picked computer's key on this station's Link fader. */
  const pairMachine = useCallback(async (machineId: string): Promise<PairResult> => {
    if (stationId == null) return { ok: false, reason: "no station" };
    const r = await api()?.linkPairMachine?.(stationId, machineId);
    bump(stationId);
    return r || { ok: false, reason: "no answer" };
  }, [stationId]);
  /** Guest: the 8-character code read off the sending computer's screen. */
  const pairRedeem = useCallback(async (code: string): Promise<PairResult> => {
    if (stationId == null) return { ok: false, reason: "no station" };
    const r = await api()?.linkPairRedeem?.(stationId, code);
    bump(stationId);
    return r || { ok: false, reason: "no answer" };
  }, [stationId]);
  /** Sender: a code for a guest computer (8 characters, 10 minutes, one use). */
  const pairCode = useCallback(async (): Promise<{ ok: boolean; code?: string; expiresAt?: string; reason?: string }> => {
    const r = await api()?.linkPairCode?.();
    if (stationId != null) bump(stationId);
    return r || { ok: false, reason: "no answer" };
  }, [stationId]);

  return { cfg: snap.cfg, state: snap.state, setInput, setSend, mintKey, keyLine, accountMachines, pairMachine, pairRedeem, pairCode };
}

/** The Remote Link's door: Preferences → Broadcast → Remote Link. */
export function openLinkPreferences() {
  try { localStorage.setItem(OPEN_KEY, `broadcast:${Date.now()}`); } catch { /* the same-window event still fires */ }
  try { window.dispatchEvent(new CustomEvent("ether:open-preferences", { detail: { category: "broadcast" } })); } catch { /* not in a browser */ }
}

export type AccountMachine = { machineId: string; name: string; published: boolean; fingerprint: string | null; keyId: number | null; lastSeen: string | null };
export type PairResult = { ok: boolean; reason?: string; from?: { machine: string; name: string; keyId: number; via: string; fingerprint: string } };

type Words = { text: string; tone: "ok" | "warn" | "bad" | "off" };
const ms = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)} ms`);

/** The RECEIVE side in words. `patched` = a Link input is stored for this station on this machine; `hasKey` = the
 *  sending computer's key is pasted into it; `refusal` = the pasted key was refused (e.g. this computer's own). */
export function rxWords(rx: LinkRx | null | undefined, patched: boolean, hasKey = true, refusal?: string | null): Words {
  if (!patched) return { text: "not patched", tone: "off" };
  if (refusal) return { text: refusal, tone: "bad" };
  if (!hasKey) return { text: "pick the sending computer", tone: "warn" };
  if (!rx) return { text: "waiting for the engine", tone: "warn" };
  const keyRejected = rx.lastAuthFailureAgoMs != null && rx.lastAuthFailureAgoMs < 10_000;
  switch (rx.state) {
    case "receiving": return { text: `${rx.sender || "sender"} · ${ms(rx.latencyMs)}`, tone: rx.lost > 0 && rx.concealed > 0 ? "warn" : "ok" };
    case "buffering": return { text: `connecting · ${rx.sender || "sender"}`, tone: "warn" };
    case "lost": return { text: `LOST ${rx.sender || "sender"} ${rx.lastPacketAgoMs != null ? `${Math.round(rx.lastPacketAgoMs / 1000)} s ago` : ""} — waiting`, tone: "bad" };
    case "listening": return keyRejected ? { text: "a sender's key was refused", tone: "bad" } : { text: `waiting for a sender · UDP ${rx.port}`, tone: "warn" };
    case "listen_failed": return { text: "cannot listen", tone: "bad" };
    case "bad_config": return { text: rx.reason || "not configured", tone: "bad" };
    case "off": return { text: "not patched in the engine", tone: "warn" };
    default: return { text: rx.state, tone: "warn" };
  }
}
/** The SEND side in words. `targetName` = "<computer> · <station>". */
export function txWords(tx: LinkTx | null | undefined, sending: boolean, targetName?: string): Words {
  if (!sending) return { text: "off", tone: "off" };
  if (!tx) return { text: "waiting for the engine", tone: "warn" };
  const to = targetName || "the other computer";
  switch (tx.state) {
    case "receiving": return { text: `→ ${to} · ${to} receiving · RTT ${ms(tx.rttMs)}`, tone: tx.rxState === "receiving" ? "ok" : "warn" };
    case "sending": return { text: `→ ${to} · no answer yet`, tone: "warn" };
    case "resolving": return { text: `→ ${to} · finding the address`, tone: "warn" };
    case "unreachable": return { text: `→ ${to} · ${tx.reason || "unreachable"}`, tone: "bad" };
    case "busy": return { text: `→ ${to} · refused: already carrying ${tx.busyHolder || "another sender"}`, tone: "bad" };
    case "refused": return { text: tx.reason || "refused", tone: "bad" };
    case "off": return { text: "not running in the engine", tone: "warn" };
    default: return { text: tx.state, tone: "warn" };
  }
}
/** A signal that the channel should read NOT FED: nothing is arriving to play. */
export function linkNotFed(rx: LinkRx | null | undefined): boolean {
  return !rx || rx.state !== "receiving" || rx.primed === false;
}
/** Where this station's feed goes, in words: "<computer> · <station>" — the same on every surface. */
export function sendTargetName(cfg: LinkCfg | null | undefined): string | undefined {
  const s = cfg?.send;
  if (!s) return undefined;
  const t = cfg?.targets.find(x => x.stationUuid === s.target && x.machine === s.targetMachine) ?? cfg?.targets.find(x => x.stationUuid === s.target);
  return `${s.targetMachineName || s.targetMachine.slice(0, 8)} · ${t?.stationName ?? "station"}`;
}

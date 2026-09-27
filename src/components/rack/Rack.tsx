// ── Rack — the processing racks, as a live instrument (Slice 4, docs/dsp-rack-framework.md §2; Slice 5 adds
//    the channel racks behind the selector row — ChannelRackView.tsx) ─────────────────────────────────────────
//
// Jeff's ruling: an operator looks at this while on air, in the Wheatstone Strata / Virtual Strata language —
// not a settings page. Layout (spec §5):
//   top     PRESET BAR — the active preset (· modified, derived), ARM → TAKE with what would change, SAVE / AS
//   middle  SIGNAL-FLOW STRIP — PGM (GEQ) → split → MONITOR / STREAM (RIDE → LIMITER), one tile per slot with
//           its colour, IN, and live activity; then the EDITOR for the selected slot ("editing: MONITOR · RIDE")
//   right   PINNED METER COLUMN — always visible, even while arming presets: IN (PGM) and OUT per branch
//           (PeakAvgMeter), RIDE + LIMITER per branch (GrMeter), loudness per branch (LoudnessPanel) — the
//           Slice 2/3 components, unchanged.
// Touch-sized: every control ≥ 44 px. One visual language: the slot colours (rackModel SLOT_COLOR) are what
// the channel racks of slices 5–6 will use.
//
// THE RULES IT KEEPS:
//   · One writer: every change is a rack sent through rack:set (useMasterRack). A refused rack shows its reason
//     and the panel returns to what is running.
//   · GEQ IN is saved; RIDE / LIMITER IN are the live-only bypass test tool (Jeff's rulings) — sent on the
//     bypass-only route, echoed back by the engine, never stored.
//   · Nothing is offered that the engine would refuse (rackModel): the limiter is pinned last, the ride and the
//     limiter cannot be removed, "add" offers the GEQ only when it was removed.
import React, { useEffect, useRef, useState } from "react";
import { useMasterRack } from "../../hooks/useMasterRack";
import { useProcessorParams, type Branch } from "../../hooks/useProcessorParams";
import type { MasterRackDoc, SectionName, Slot, AnyModule, GeqModule, RideModule, LimiterModule } from "./rackTypes";
import {
  SLOT_COLOR, SLOT_LABEL, effectiveSection, editModule, setGeqIn, setLink, canRemove, removeSlot, addableModules,
  addGeq, diffRacks, wouldRide, isPinned, MASTER_SLOTS,
} from "./rackModel";
import PeakAvgMeter from "../meter/PeakAvgMeter";
import GrMeter from "../meter/GrMeter";
import LoudnessPanel from "../meter/LoudnessPanel";
import { BUS, latestMeters, useMeterSubscription } from "../meter/meterStore";
import { ceilingLabel } from "../meter/loudnessWire";
import { EQ_LABELS } from "../GraphicEQ";
import { LABEL, MONO, TOUCH, BTN, Knob } from "./rackUi";
import ChannelRackView, { RtaBar } from "./ChannelRackView";
import { useRta } from "../../hooks/useRta";
import GeqGraph from "./GeqGraph";
import { useBoardName } from "../../hooks/useBoardName";
import { CHANNEL_SLOTS, isChannelSlot, type ChannelSlot } from "./channelRack";
import { RACK_VIEW_KEY, useChannelRackLamps } from "../../hooks/useChannelRack";

interface Props { stationId: number; stationUuid: string | null | undefined }

const SECTION_LABEL: Record<SectionName, string> = { pgm: "PGM", local: "MONITOR", stream: "STREAM" };
const SELECT_KEY = "ether.rack.select";

type Sel = { section: SectionName; slotId: string };
function readSel(): Sel | null {
  try {
    const v = localStorage.getItem(SELECT_KEY);
    if (!v) return null;
    const [section, slotId] = v.split(":");
    if ((section === "pgm" || section === "local" || section === "stream") && slotId) return { section, slotId };
  } catch { /* per-viewer convenience only */ }
  return null;
}

// ── SLICE 5 — ONE rack window, parameterized by rack kind: MASTER, or a fader's channel rack ────────────────
// (docs/dsp-channel-rack-eq.md §4). The selector row names every rack; a channel tab's lamp is lit when that
// fader's rack has something IN. The doors — Master Out's EQ / OPEN, each fader strip's EQ, the on-air decks'
// EQ — write `ether.rack.view` (and the master's `ether.rack.select`) and open or re-focus this window.
function readView(): "master" | ChannelSlot {
  try {
    const v = localStorage.getItem(RACK_VIEW_KEY);
    const m = v ? /^ch:(.+)$/.exec(v) : null;
    if (m && isChannelSlot(m[1])) return m[1];
  } catch { /* per-viewer convenience only */ }
  return "master";
}

export default function Rack({ stationId, stationUuid }: Props) {
  const [view, setView] = useState<"master" | ChannelSlot>(() => readView());
  const lamps = useChannelRackLamps(stationId);
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === RACK_VIEW_KEY) setView(readView()); };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);
  const pick = (v: "master" | ChannelSlot) => {
    setView(v);
    try { localStorage.setItem(RACK_VIEW_KEY, v === "master" ? "master" : `ch:${v}`); } catch { /* per-viewer */ }
  };
  // ONE NAME PER FADER — tabs carry the board letter, never the engine slot id (src/lib/boardName.ts).
  const name = useBoardName();
  const tab = (v: "master" | ChannelSlot, label: string) => {
    const on = view === v;
    const lit = v !== "master" && lamps[v] === true;
    return (
      <button key={v} onClick={() => pick(v)}
        title={v === "master" ? "The master rack — GEQ, loudness ride, limiter" : `${name(v)}'s channel rack (Filters, PEQ)${lit ? " — something is IN" : lamps[v] === false ? " — nothing IN" : ""}`}
        style={{ ...BTN(on), minWidth: v === "master" ? 96 : 52, padding: "0 10px", position: "relative" }}>
        {label}
        {v !== "master" && (
          <span style={{ position: "absolute", top: 5, right: 5, width: 7, height: 7, borderRadius: "50%",
                         background: lit ? "var(--slot-eq)" : "transparent", border: `1px solid ${lit ? "var(--slot-eq)" : "var(--border-primary)"}` }} />
        )}
      </button>
    );
  };
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "8px 12px 0" }}>
        <span style={{ ...LABEL, marginRight: 4 }}>Rack</span>
        {tab("master", "MASTER")}
        <span style={{ width: 8 }} />
        {CHANNEL_SLOTS.map(s => tab(s, name(s)))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {view === "master"
          ? <MasterRack stationId={stationId} stationUuid={stationUuid} />
          : <ChannelRackView key={view} stationId={stationId} stationUuid={stationUuid} slot={view} />}
      </div>
    </div>
  );
}

function MasterRack({ stationId, stationUuid }: Props) {
  const rack = useMasterRack(stationId);
  const proc = useProcessorParams(stationId);
  useMeterSubscription([stationId]);
  const [sel, setSel] = useState<Sel>(() => readSel() ?? { section: "local", slotId: "s-ride" });
  const [saveName, setSaveName] = useState("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

  // Master Out's EQ button opens this window with the GEQ selected (and re-selects if it is already open).
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === SELECT_KEY) { const s = readSel(); if (s) setSel(s); } };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);

  const doc = rack.doc;
  if (!doc) {
    return (
      <div style={{ padding: 24, color: "var(--text-tertiary)", fontSize: 13 }}>
        {rack.error ? <>⚠ The rack could not be read — {rack.error}</> : "Reading this station's rack…"}
      </div>
    );
  }

  const branchOf = (s: SectionName): Branch | null => (s === "local" ? "local" : s === "stream" ? "stream" : null);
  const slotsOf = (s: SectionName): Slot<AnyModule>[] => effectiveSection(doc, s);
  const selSlots = slotsOf(sel.section);
  const selSlot = selSlots.find(x => x.id === sel.slotId) ?? null;
  const pick = (section: SectionName, slotId: string) => {
    setSel({ section, slotId }); setMenu(null);
    try { localStorage.setItem(SELECT_KEY, `${section}:${slotId}`); } catch { /* per-viewer */ }
  };
  const anyBypass = proc.bypass.local.ride || proc.bypass.local.limiter || proc.bypass.stream.ride || proc.bypass.stream.limiter;
  const margin = latestMeters(stationUuid)?.margin;
  const armedDiff = rack.armed ? diffRacks(doc, rack.armed.doc) : [];

  // ── a slot tile ────────────────────────────────────────────────────────────
  const tile = (section: SectionName, slot: Slot<AnyModule>, idx: number, mirrored: boolean) => {
    const m = slot.module;
    const br = branchOf(section);
    const selected = sel.section === section && sel.slotId === slot.id;
    if (!m) {
      const add = addableModules(doc, section);
      return (
        <div key={`${section}-${idx}`} style={{ minWidth: 150, minHeight: 84, border: "1px dashed var(--border-primary)", display: "flex",
                                               alignItems: "center", justifyContent: "center", color: "var(--text-tertiary)", fontSize: 11 }}>
          {add.includes("geq") ? <button style={BTN()} onClick={() => rack.update(addGeq(doc))}>+ GEQ</button> : "empty"}
        </div>
      );
    }
    const color = SLOT_COLOR[m.type];
    const isIn = m.type === "geq" ? slot.in : br ? !(m.type === "ride" ? proc.bypass[br].ride : proc.bypass[br].limiter) : true;
    const toggleIn = () => {
      if (m.type === "geq") rack.update(setGeqIn(doc, !slot.in));
      else if (br) proc.setBypass(br, m.type === "ride" ? "ride" : "limiter", isIn);
    };
    const menuKey = `${section}:${slot.id}`;
    return (
      <div key={`${section}-${slot.id}`} onClick={() => pick(section === "stream" && doc.link ? "local" : section, slot.id)}
        style={{ position: "relative", minWidth: 190, minHeight: 84, padding: "8px 10px", cursor: "pointer",
                 background: selected ? "var(--bg-tertiary)" : "var(--bg-secondary)",
                 border: `1px solid ${selected ? color : "var(--border-primary)"}`, borderTop: `4px solid ${color}`,
                 opacity: mirrored ? 0.6 : 1, display: "flex", flexDirection: "column", gap: 6 }}
        title={mirrored ? "Linked — the stream runs the monitor's modules. Split to edit it on its own." : undefined}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 900, letterSpacing: "0.08em", color }}>{SLOT_LABEL[m.type]}</span>
          {isPinned(slot) && <span style={{ fontSize: 9, color: "var(--text-tertiary)" }} title="The limiter is always the last slot of a branch — it is the ceiling guarantee">PINNED</span>}
          <div style={{ flex: 1 }} />
          <button onClick={e => { e.stopPropagation(); toggleIn(); }}
            title={m.type === "geq" ? "GEQ IN / OUT (saved with the rack)" : "Bypass — a TEST TOOL, live only: it resets when Ether restarts and is never saved"}
            style={{ ...BTN(isIn, m.type === "geq" ? color : isIn ? color : "#f59e0b"), minWidth: 56, padding: "0 8px" }}>
            {isIn ? "IN" : m.type === "geq" ? "OUT" : "BYP"}
          </button>
          <button onClick={e => { e.stopPropagation(); setMenu(menu === menuKey ? null : menuKey); }} title="More" style={{ ...BTN(), minWidth: TOUCH, padding: 0 }}>⋯</button>
        </div>
        {br && m.type !== "geq" && stationUuid && (
          <div onClick={e => e.stopPropagation()}><GrMeter stationUuid={stationUuid} branch={br} kind={m.type === "ride" ? "ride" : "lim"}
                                                           clampDb={m.type === "ride" ? (m as RideModule).clamp : undefined} /></div>
        )}
        {m.type === "geq" && (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 22 }}>
            {(m as GeqModule).bands.map((g, i) => (
              <div key={i} style={{ flex: 1, height: `${50 + (g / 12) * 50}%`, background: slot.in ? color : "var(--border-primary)", opacity: 0.8 }} />
            ))}
          </div>
        )}
        {menu === menuKey && (
          <div onClick={e => e.stopPropagation()} style={{ position: "absolute", top: "100%", right: 0, zIndex: 10, minWidth: 220,
                                                          background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: 6 }}>
            {canRemove(slot)
              ? <button style={{ ...BTN(), width: "100%", textAlign: "left" }} onClick={() => { setMenu(null); rack.update(removeSlot(doc, section, slot.id)); }}>Remove GEQ</button>
              : <div style={{ fontSize: 11, color: "var(--text-tertiary)", padding: 8 }}>The ride and the limiter are always in a branch — bypass is the test tool.</div>}
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", padding: 8 }}>
              {isPinned(slot) ? "Pinned last: nothing can follow the limiter." : "Nothing in the master rack can move in this version (one module in PGM; ride → limiter is fixed)."}
            </div>
          </div>
        )}
      </div>
    );
  };

  const row = (section: SectionName) => {
    const mirrored = section === "stream" && doc.link;
    const slots = slotsOf(section);
    const empties = section === "pgm" ? Math.max(0, Math.min(1, MASTER_SLOTS - slots.length)) : 0;
    return (
      <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
        <span style={{ ...LABEL, width: 74, alignSelf: "center", fontWeight: 900, color: "var(--text-secondary)" }}>{SECTION_LABEL[section]}</span>
        {slots.map((s, i) => tile(section, s, i, mirrored))}
        {Array.from({ length: empties }).map((_, i) => tile(section, { id: `empty-${i}`, module: null, in: true }, slots.length + i, false))}
      </div>
    );
  };

  // ── the editor ──────────────────────────────────────────────────────────────
  const editSection: SectionName = sel.section === "stream" && doc.link ? "local" : sel.section;
  const edit = (patch: Partial<AnyModule>) => rack.update(editModule(doc, editSection, sel.slotId, patch));
  const editor = () => {
    const m = selSlot?.module;
    if (!m) return <div style={{ color: "var(--text-tertiary)", fontSize: 13 }}>Select a slot above.</div>;
    const br = branchOf(sel.section);
    if (m.type === "geq") return <GeqEditor stationId={stationId} geq={m as GeqModule} on={!!selSlot?.in}
                                            onBands={bands => edit({ bands } as any)} onIn={v => rack.update(setGeqIn(doc, v))} />;
    if (m.type === "ride") {
      const r = m as RideModule;
      const byp = br ? proc.bypass[br].ride : false;
      const wr = br ? wouldRide(doc, br, proc.meters[br]?.inLufs) : null;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <Knob label="Target" value={r.target} unit=" LUFS" min={-30} max={-6} step={1} onChange={v => edit({ target: v } as any)}
                hint="The programme loudness the ride walks toward." />
          <Knob label="Rate" value={r.rate} unit=" dB/s" min={0.3} max={6} step={0.1} onChange={v => edit({ rate: v } as any)}
                hint="How fast it moves. Faster pumps audibly across a seam; slower leaves a quiet track quiet for longer." />
          <Knob label="Clamp" value={r.clamp} unit=" dB" min={3} max={18} step={1} onChange={v => edit({ clamp: v } as any)}
                hint="How far it may travel. A large clamp on quiet material lifts the noise floor with it." />
          {byp && wr != null && (
            <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}
                 title="What this branch's ride would apply at this input loudness if it were not bypassed. A projection, not a measurement.">
              Bypassed — would ride {wr >= 0 ? "+" : ""}{wr.toFixed(1)} dB
            </div>
          )}
        </div>
      );
    }
    const l = m as LimiterModule;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Knob label="Ceiling" value={l.ceiling} unit=" dBTP" min={-3} max={-0.1} step={0.1} onChange={v => edit({ ceiling: Math.round(v * 10) / 10 } as any)}
              hint="Never reaches 0. Above about −0.3 dBTP the stream's encoder makes inter-sample overs that clip on the listener's decoder." />
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginLeft: 88 }}
             title="The limiter detects true peaks with a 1.15× margin, so it holds the output that much below the ceiling you set.">
          {typeof margin === "number" ? ceilingLabel(l.ceiling, l.ceiling - margin) : `${l.ceiling.toFixed(1)} dBTP set · the engine has not reported where it limits`}
        </div>
        <Knob label="Release" value={l.release} unit=" ms" min={30} max={500} step={10} onChange={v => edit({ release: v } as any)}
              hint="How quickly it lets go after a peak. Short distorts bass and pumps; long leaves the programme ducked after a transient." />
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 6 }}>
          Look-ahead 1.5 ms · attack completes within it · 4× oversampled true-peak — fixed: look-ahead is the processing latency.
        </div>
      </div>
    );
  };

  return (
    <div style={{ height: "100%", boxSizing: "border-box", overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <style>{`
        .rack-range { accent-color: #8868D8; cursor: pointer; }
        .rack-range::-webkit-slider-thumb { width: 28px; height: 28px; }
      `}</style>

      {/* ── PRESET BAR ───────────────────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: 8, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
        <span style={LABEL}>Preset</span>
        <span style={{ fontSize: 14, fontWeight: 800 }}>{rack.activeName}</span>
        {rack.modified && <span style={{ fontSize: 12, fontWeight: 700, color: "#f59e0b" }} title="The live rack differs from this preset (compared value by value, never a flag)">· modified</span>}
        <div style={{ width: 12 }} />
        <select value={rack.armed?.name ?? ""} onChange={e => e.target.value ? rack.arm(e.target.value) : rack.disarm()}
          style={{ minHeight: TOUCH, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", padding: "0 8px", fontSize: 13 }}
          title="ARM a preset: nothing changes on air until you press TAKE">
          <option value="">Arm a preset…</option>
          {rack.presets.map(p => <option key={p.name} value={p.name}>{p.name}{p.builtIn ? "" : " (yours)"}</option>)}
        </select>
        {rack.armed && (
          <>
            <button style={BTN(true, "#f59e0b")} onClick={rack.take} title="Apply the armed preset now (the master rack has no ON channels to protect)">TAKE ▸ {rack.armed.name}</button>
            <button style={BTN()} onClick={rack.disarm}>DISARM</button>
          </>
        )}
        <div style={{ flex: 1 }} />
        <button style={BTN()} onClick={() => setSaveMsg(rack.save())} title="Overwrite the active preset (your presets only)">SAVE</button>
        <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="Save as…"
          style={{ minHeight: TOUCH, width: 150, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", padding: "0 8px", fontSize: 13 }} />
        <button style={BTN()} disabled={!saveName.trim()} onClick={() => { const e = rack.saveAs(saveName); setSaveMsg(e); if (!e) setSaveName(""); }}>SAVE AS</button>
      </div>
      {rack.armed && (
        <div style={{ padding: "8px 12px", border: "1px solid #f59e0b", background: "rgba(245,158,11,0.10)", fontSize: 12 }}>
          <b style={{ color: "#f59e0b" }}>ARMED · {rack.armed.name}</b> — TAKE will change:{" "}
          {armedDiff.length ? armedDiff.join(" · ") : "nothing — it is what is running"}
          <span style={{ color: "var(--text-tertiary)" }}> · processing on/off is never part of a preset</span>
        </div>
      )}
      {saveMsg && <div style={{ fontSize: 12, color: "var(--accent-amber)" }}>{saveMsg}</div>}
      {rack.error && (
        <div style={{ padding: "8px 12px", background: "rgba(239,68,68,0.15)", border: "1px solid #ef4444", color: "#ef4444", fontSize: 12, fontWeight: 700 }}>
          ⚠ The engine did not accept that — {rack.error}. The rack shows what is running.
        </div>
      )}
      {proc.sendError && <div style={{ fontSize: 12, color: "#ef4444" }}>⚠ Bypass not applied — {proc.sendError}</div>}
      {anyBypass && (
        <div style={{ padding: "8px 12px", background: "rgba(245,158,11,0.15)", border: "1px solid #f59e0b", color: "#f59e0b", fontSize: 12, fontWeight: 700 }}>
          {(["local", "stream"] as Branch[]).filter(x => proc.bypass[x].ride || proc.bypass[x].limiter).map(x => (
            <div key={x}>⚠ {x === "local" ? "MONITOR" : "STREAM"}: {proc.bypass[x].limiter
              ? (x === "stream" ? "LIMITER BYPASSED — nothing is holding the ceiling on air" : "LIMITER BYPASSED — nothing is holding the ceiling")
              : "LOUDNESS RIDE BYPASSED"}</div>
          ))}
          <div style={{ fontWeight: 500 }}>test only, resets on restart</div>
        </div>
      )}
      {rack.source === "seed" && (
        <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>This station's rack is built from its existing processor settings; it is saved as a rack the first time you change it.</div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
        {/* ── STRIP + EDITOR ─────────────────────────────────────────────────────────────────── */}
        <div style={{ flex: "1 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
            {row("pgm")}
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 82 }}>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>split ⤵</span>
              <button style={BTN(!doc.link)} onClick={() => rack.update(setLink(doc, !doc.link))}
                title={doc.link ? "Split: give the stream its own modules. Splitting changes nothing by itself — the stream starts as a copy of the monitor." : "Link: the stream runs the monitor's modules again."}>
                {doc.link ? "LINKED ⇄" : "SPLIT"}
              </button>
            </div>
            {row("local")}
            {row("stream")}
          </div>
          <div style={{ padding: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
            <div style={{ ...LABEL, marginBottom: 10, fontSize: 12 }}>
              editing: <b style={{ color: "var(--text-primary)" }}>{SECTION_LABEL[sel.section]}{sel.section !== "pgm" && doc.link ? " + " + (sel.section === "local" ? "STREAM" : "MONITOR") + " (linked)" : ""} · {selSlot?.module ? SLOT_LABEL[selSlot.module.type] : "—"}</b>
            </div>
            {editor()}
          </div>
        </div>

        {/* ── PINNED METER COLUMN ───────────────────────────────────────────────────────────── */}
        <div style={{ flex: "0 1 340px", minWidth: 280, display: "flex", flexDirection: "column", gap: 10, padding: 10, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
          <div style={{ display: "flex", gap: 8, height: 150 }}>
            {[["IN · PGM", BUS.PGM, "IN — the programme before the processor"], ["OUT · MON", BUS.LOCAL, "OUT — what the monitor branch sends (processed)"], ["OUT · STR", BUS.STREAM, "OUT — exactly what the stream encoder gets"]].map(([l, b, t]) => (
              <div key={String(l)} style={{ flex: 1, display: "flex" }}>
                <PeakAvgMeter source={{ stationUuid, bus: b as number }} size="master" label={String(l)} title={String(t)} />
              </div>
            ))}
          </div>
          {stationUuid && (["local", "stream"] as Branch[]).map(b => (
            <div key={b} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ ...LABEL, fontWeight: 800 }}>{b === "local" ? "Monitor" : "Stream"}</span>
              <GrMeter stationUuid={stationUuid} branch={b} kind="ride" clampDb={(effectiveSection(doc, b).find(s => s.module?.type === "ride")?.module as RideModule | undefined)?.clamp ?? 12} />
              <GrMeter stationUuid={stationUuid} branch={b} kind="lim" />
            </div>
          ))}
          {(["local", "stream"] as Branch[]).map(b => (
            <LoudnessPanel key={b} stationId={stationId} stationUuid={stationUuid} branch={b} label={b === "local" ? "Monitor" : "Stream"}
              target={(effectiveSection(doc, b).find(s => s.module?.type === "ride")?.module as RideModule | undefined)?.target ?? -14} />
          ))}
          {proc.streamBranchUnreported && (
            <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>The running audio daemon predates the split and reports no stream branch — fully close and reopen Ether.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The GEQ slot's editor: ten touch-sized band faders over the live spectrum, IN/OUT, and FLAT.
 *  SLICE 8 — above the faders, GeqGraph: the RTA (before the GEQ dimmed, after it full) in the X32 look, the GEQ's
 *  curve and a numbered marker per fader — the same component set as the channel curve (docs/dsp-channel-rta.md). */
function GeqEditor({ stationId, geq, on, onBands, onIn }: {
  stationId: number; geq: GeqModule; on: boolean; onBands: (b: number[]) => void; onIn: (v: boolean) => void;
}) {
  void stationId;   // the RTA follows the active station (useRta)
  const rta = useRta("master");
  return <GeqPanel geq={geq} on={on} onBands={onBands} onIn={onIn} rta={rta} />;
}

/** The GEQ editor's body, presentational (the screenshot harness renders it with the engine's recorded frame). */
export function GeqPanel({ geq, on, onBands, onIn, rta }: {
  geq: GeqModule; on: boolean; onBands: (b: number[]) => void; onIn: (v: boolean) => void; rta: ReturnType<typeof useRta>;
}) {
  const set = (i: number, v: number) => { const next = [...geq.bands]; next[i] = Math.round(v * 10) / 10; onBands(next); };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button style={BTN(on, "var(--slot-eq)")} onClick={() => onIn(!on)} title="GEQ IN / OUT — saved with the rack">{on ? "IN" : "OUT"}</button>
        <button style={BTN()} onClick={() => onBands(new Array(10).fill(0))} title="All bands to 0 dB">FLAT</button>
        <span style={{ fontSize: 11, color: "var(--text-tertiary)", alignSelf: "center" }}>10-band master GEQ · ±12 dB · drives the air and the room EQ</span>
      </div>
      <RtaBar rta={rta} />
      {/* SLICE 8 — the X32-look graph (the same axis, grid and RTA bars as the channel curve): the GEQ curve in yellow
          and a numbered marker at every fader's position; the faders below are the controls. */}
      <GeqGraph bands={geq.bands} on={on} frame={rta.frame} held={rta.held} />
      <div style={{ position: "relative", display: "flex", gap: 6, alignItems: "flex-end", opacity: on ? 1 : 0.55 }}>
        {geq.bands.map((g, i) => (
          <div key={i} style={{ flex: 1, minWidth: TOUCH, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div style={{ position: "relative", height: 160, width: TOUCH, display: "flex", justifyContent: "center" }}>
              <input className="rack-range" type="range" min={-12} max={12} step={0.5} value={g}
                onChange={e => set(i, Number(e.target.value))}
                style={{ writingMode: "vertical-lr" as any, direction: "rtl", height: 160, width: TOUCH }} />
            </div>
            <span style={{ ...MONO, fontSize: 12, fontWeight: 800, color: Math.abs(g) > 0.05 ? "var(--slot-eq)" : "var(--text-tertiary)" }}>{g > 0 ? "+" : ""}{g.toFixed(1)}</span>
            <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}><b style={{ color: "var(--eq-curve)" }}>{i + 1}</b> · {EQ_LABELS[i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

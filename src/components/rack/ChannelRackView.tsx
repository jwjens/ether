// ── ChannelRackView — one fader's channel rack (Slice 5, docs/dsp-channel-rack-eq.md §4) ─────────────────────
//
// The same language as the master rack (rackUi, the slot colours): a SIGNAL-FLOW STRIP of this fader's slots,
// the EDITOR for the selected module ("editing: S2 · PEQ" — the channel is always named), and a PINNED METER
// column: IN (pre-rack) and OUT (post-rack) for this fader — what the EQ did.
//
// RULES IT KEEPS (channelRack.ts, enforced again by the engine): Add offers Filters and PEQ only, one of each;
// a new module starts OUT (ruling 5); nothing is pinned — a slot can move either way; module IN is saved. One
// writer: every change is a rack sent through rack:set "ch:<slot>" (useChannelRack); a refused rack shows its
// reason and the panel returns to what is running.
import React, { useEffect, useState } from "react";
import type { ChannelModule, ChannelModuleType, FilterModule, PeqModule, GateModule, CompModule, ChannelRackDoc, Slot } from "./rackTypes";
import DynCurve from "./DynCurve";
import { COMP, GATE } from "./dynMath";
import { BUILT_IN_CHANNEL_PRESETS, channelRacksEqual, type ChannelPreset } from "./channelRack";
import { latestMeters } from "../meter/meterStore";
import {
  CHANNEL_LABEL, CHANNEL_RACK_SLOTS, addChannelModule, canMoveChannel, channelAddable, channelRackAudible, editChannelModule,
  moveChannelSlot, removeChannelSlot, setChannelIn, findChannel, flatPeq, resetFilters, clearChannelRack, type ChannelSlot,
} from "./channelRack";
import { SLOT_COLOR } from "./rackModel";
import { HPF_HZ, LPF_HZ, PEQ_HZ, PEQ_GAIN_DB, PEQ_WIDTH_OCT } from "./eqMath";
import EqCurve from "./EqCurve";
import { LABEL, MONO, TOUCH, BTN } from "./rackUi";
import { useChannelRack } from "../../hooks/useChannelRack";
import PeakAvgMeter from "../meter/PeakAvgMeter";
import { CH_INDEX } from "../meter/meterStore";

/** A log-scaled time / level control sized for a finger (attack 0.1–330 ms spans three decades). */
function LogNum({ label, value, lo, hi, unit, onChange, color, hint }: {
  label: string; value: number; lo: number; hi: number; unit: string; onChange: (v: number) => void; color: string; hint: string;
}) {
  const t = Math.log(Math.max(lo, value) / lo) / Math.log(hi / lo);
  return (
    <div title={hint} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: TOUCH }}>
      <span style={{ ...LABEL, width: 70, flexShrink: 0 }}>{label}</span>
      <input className="rack-range" type="range" min={0} max={1000} step={1} value={Math.round(t * 1000)}
        onChange={e => { const v = lo * Math.pow(hi / lo, Number(e.target.value) / 1000); onChange(v < 10 ? Math.round(v * 10) / 10 : Math.round(v)); }}
        style={{ flex: 1, height: TOUCH }} />
      <span style={{ ...MONO, fontSize: 14, fontWeight: 800, minWidth: 84, textAlign: "right", color }}>{value < 10 ? value.toFixed(1) : value.toFixed(0)}{unit}</span>
    </div>
  );
}

/** SLICE 6 — this channel's channel presets: the built-ins (Voice, Off) and the station's own (`rack_ch_presets`,
 *  stored like the master's `rack_presets` — station-scoped). Taking one switches its modules IN (ruling 9). */
function useChannelPresets(stationId: number) {
  const [mine, setMine] = useState<ChannelPreset[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const r = await (window as any).ether?.stationConfigKv?.list(stationId);
        const raw = ((r?.rows || []) as { key: string; value: string }[]).find(x => x.key === "rack_ch_presets")?.value;
        const list = raw ? (JSON.parse(raw) as ChannelPreset[]).filter(p => p && p.name && p.doc && !p.builtIn) : [];
        setMine(list);
      } catch { setMine([]); }
    })();
  }, [stationId]);
  const saveAs = async (name: string, doc: ChannelRackDoc): Promise<string | null> => {
    const n = name.trim();
    if (!n) return "name it first";
    if (BUILT_IN_CHANNEL_PRESETS.some(p => p.name === n)) return "that is a built-in preset — pick another name";
    const list = [...mine.filter(p => p.name !== n), { name: n, doc }];
    const w = await (window as any).ether?.stationConfigKv?.upsertByKey?.(stationId, "rack_ch_presets", JSON.stringify(list));
    if (w && w.ok === false) return `not saved: ${w.error || "unknown"}`;
    setMine(list);
    return null;
  };
  return { presets: [...BUILT_IN_CHANNEL_PRESETS, ...mine], saveAs };
}

const BAND_COLOR = ["var(--band-1)", "var(--band-2)", "var(--band-3)", "var(--band-4)"];

/** A log-scaled frequency control sized for a finger. */
function FreqKnob({ label, value, lo, hi, onChange, color, hint }: {
  label: string; value: number; lo: number; hi: number; onChange: (v: number) => void; color: string; hint: string;
}) {
  const t = Math.log(value / lo) / Math.log(hi / lo);
  return (
    <div title={hint} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: TOUCH }}>
      <span style={{ ...LABEL, width: 60, flexShrink: 0 }}>{label}</span>
      <input className="rack-range" type="range" min={0} max={1000} step={1} value={Math.round(t * 1000)}
        onChange={e => { const f = lo * Math.pow(hi / lo, Number(e.target.value) / 1000); onChange(f < 100 ? Math.round(f * 10) / 10 : Math.round(f)); }}
        style={{ flex: 1, height: TOUCH }} />
      <span style={{ ...MONO, fontSize: 14, fontWeight: 800, minWidth: 84, textAlign: "right", color }}>
        {value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${value.toFixed(value < 100 ? 1 : 0)} Hz`}
      </span>
    </div>
  );
}
function Num({ label, value, unit, min, max, step, onChange, color, hint }: {
  label: string; value: number; unit: string; min: number; max: number; step: number; onChange: (v: number) => void; color: string; hint: string;
}) {
  return (
    <div title={hint} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: TOUCH }}>
      <span style={{ ...LABEL, width: 60, flexShrink: 0 }}>{label}</span>
      <input className="rack-range" type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))} style={{ flex: 1, height: TOUCH }} />
      <span style={{ ...MONO, fontSize: 14, fontWeight: 800, minWidth: 84, textAlign: "right", color }}>
        {unit === " dB" && value > 0 ? "+" : ""}{value.toFixed(unit === " oct" ? 2 : 1)}{unit}
      </span>
    </div>
  );
}

export default function ChannelRackView({ stationId, stationUuid, slot }: { stationId: number; stationUuid: string | null | undefined; slot: ChannelSlot }) {
  const rack = useChannelRack(stationId, slot);
  const [selMod, setSelMod] = useState<ChannelModuleType | null>(null);
  const [band, setBand] = useState<number | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const presets = useChannelPresets(stationId);
  const [armed, setArmed] = useState<ChannelPreset | null>(null);
  const [saveName, setSaveName] = useState("");
  const [presetMsg, setPresetMsg] = useState<string | null>(null);
  // SLICE 6 — the live operating point: this channel's pre-rack RMS level and the engine's gate / comp GR.
  const [live, setLive] = useState<{ level: number; gateGr: number; compGr: number; gateOpen: number } | null>(null);
  const idx0 = CH_INDEX[slot];
  useEffect(() => {
    const id = setInterval(() => {
      const m: any = latestMeters(stationUuid);
      const q = m?.ch?.[idx0];
      const d = m?.chDyn?.[idx0];
      if (!q) { setLive(null); return; }
      const ms = ((q[2] || 0) ** 2 + (q[3] || 0) ** 2) / 2;
      setLive({ level: ms > 0 ? 10 * Math.log10(ms) : -120, gateGr: d ? d[0] : 0, compGr: d ? d[1] : 0, gateOpen: d ? d[2] : 1 });
    }, 100);
    return () => clearInterval(id);
  }, [stationUuid, idx0]);
  const doc = rack.doc;

  if (!doc) {
    return (
      <div style={{ padding: 24, color: "var(--text-tertiary)", fontSize: 13 }}>
        {rack.error ? <>⚠ {slot}'s rack could not be read — {rack.error}</> : `Reading ${slot}'s rack…`}
      </div>
    );
  }

  const filters = findChannel(doc, "filters") as Slot<FilterModule> | null;
  const peq = findChannel(doc, "peq") as Slot<PeqModule> | null;
  const gate = findChannel(doc, "gate") as Slot<GateModule> | null;
  const comp = findChannel(doc, "comp") as Slot<CompModule> | null;
  const editG = (m: GateModule) => gate && rack.update(editChannelModule(doc, gate.id, m));
  const editC = (m: CompModule) => comp && rack.update(editChannelModule(doc, comp.id, m));
  const activePreset = presets.presets.find(p => channelRacksEqual(p.doc, doc))?.name ?? null;
  const grBar = (gr: number) => (
    <div title={`${gr.toFixed(1)} dB of gain reduction now`} style={{ height: 8, background: "var(--bg-primary)", border: "1px solid var(--border-primary)", position: "relative" }}>
      <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: `${Math.min(100, (gr / 20) * 100)}%`, background: "var(--slot-dynamics)" }} />
    </div>
  );
  const shown: ChannelModuleType | null = selMod && findChannel(doc, selMod) ? selMod : (doc.sections.ch[0]?.module?.type ?? null);
  const addable = channelAddable(doc);
  const idx = CH_INDEX[slot];
  const editF = (m: FilterModule) => filters && rack.update(editChannelModule(doc, filters.id, m));
  const editQ = (m: PeqModule) => peq && rack.update(editChannelModule(doc, peq.id, m));
  const setQBand = (i: number, patch: Partial<PeqModule["bands"][number]>) => {
    if (!peq?.module) return;
    editQ({ ...peq.module, bands: peq.module.bands.map((b, k) => (k === i ? { ...b, ...patch } : b)) as PeqModule["bands"] });
  };

  const tile = (s: Slot<ChannelModule>, i: number) => {
    const m = s.module!;
    const color = SLOT_COLOR[m.type];
    const sel = shown === m.type;
    const key = `m:${s.id}`;
    return (
      <div key={s.id} onClick={() => { setSelMod(m.type); setMenu(null); }}
        style={{ position: "relative", minWidth: 190, minHeight: 84, padding: "8px 10px", cursor: "pointer",
                 background: sel ? "var(--bg-tertiary)" : "var(--bg-secondary)",
                 border: `1px solid ${sel ? color : "var(--border-primary)"}`, borderTop: `4px solid ${color}`,
                 display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 900, letterSpacing: "0.08em", color }}>{CHANNEL_LABEL[m.type]}</span>
          <div style={{ flex: 1 }} />
          <button onClick={e => { e.stopPropagation(); rack.update(setChannelIn(doc, s.id, !s.in)); }}
            title={`${CHANNEL_LABEL[m.type]} IN / OUT — saved with ${slot}'s rack. OUT = this module does nothing to ${slot}.`}
            style={{ ...BTN(s.in, color), minWidth: 56, padding: "0 8px" }}>{s.in ? "IN" : "OUT"}</button>
          <button onClick={e => { e.stopPropagation(); setMenu(menu === key ? null : key); }} title="More" style={{ ...BTN(), minWidth: TOUCH, padding: 0 }}>⋯</button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
          {m.type === "filters"
            ? `HPF ${m.hpf.in ? `${Math.round(m.hpf.freq)} Hz` : "off"} · LPF ${m.lpf.in ? `${(m.lpf.freq / 1000).toFixed(1)} kHz` : "off"}`
            : m.type === "gate" ? `${m.threshold} dB · depth ${m.depth} · 1:${m.ratio}${s.in && live ? (live.gateOpen >= 0.5 ? " · OPEN" : " · CLOSED") : ""}`
            : m.type === "comp" ? `${m.ratio}:1 at ${m.threshold} dB · +${m.makeup} dB`
            : m.bands.map((b, k) => <span key={k} style={{ color: Math.abs(b.gain) > 1e-6 ? BAND_COLOR[k] : undefined }}>{k ? " · " : ""}{Math.abs(b.gain) > 1e-6 ? `${b.gain > 0 ? "+" : ""}${b.gain.toFixed(1)}` : "0"}</span>)}
        </div>
        {(m.type === "gate" || m.type === "comp") && s.in && live && grBar(m.type === "gate" ? live.gateGr : live.compGr)}
        {menu === key && (
          <div onClick={e => e.stopPropagation()} style={{ position: "absolute", top: "100%", right: 0, zIndex: 10, minWidth: 220,
                                                          background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: 6,
                                                          display: "flex", flexDirection: "column", gap: 4 }}>
            {canMoveChannel(doc, i, i - 1) && <button style={{ ...BTN(), textAlign: "left" }} onClick={() => { setMenu(null); rack.update(moveChannelSlot(doc, i, i - 1)); }}>◂ Move earlier</button>}
            {canMoveChannel(doc, i, i + 1) && <button style={{ ...BTN(), textAlign: "left" }} onClick={() => { setMenu(null); rack.update(moveChannelSlot(doc, i, i + 1)); }}>Move later ▸</button>}
            <button style={{ ...BTN(), textAlign: "left" }} onClick={() => { setMenu(null); rack.update(removeChannelSlot(doc, s.id)); }}>Remove {CHANNEL_LABEL[m.type]}</button>
          </div>
        )}
      </div>
    );
  };

  // ── SLICE 6 — the dynamics editor: the transfer graph + the controls of the selected module ─────────────────
  const dynEditor = () => {
    const gm = gate?.module ?? null, cm = comp?.module ?? null;
    const DYN = "var(--slot-dynamics)";
    return (
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 320px", minWidth: 260 }}>
          <DynCurve gate={gm} gateIn={!!gate?.in} comp={cm} compIn={!!comp?.in} onGate={editG} onComp={editC}
                    live={live && live.level > -100 ? live : null} />
        </div>
        <div style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 2 }}>
          {shown === "gate" && gm && gate && (
            <>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <button style={BTN(gate.in, DYN)} onClick={() => rack.update(setChannelIn(doc, gate.id, !gate.in))}>GATE {gate.in ? "IN" : "OUT"}</button>
                {gate.in && live && <span style={{ ...MONO, fontSize: 13, color: DYN }}>{live.gateOpen >= 0.5 ? "OPEN" : "CLOSED"} · GR {live.gateGr.toFixed(1)} dB</span>}
              </div>
              <Num label="Threshold" value={gm.threshold} unit=" dB" min={GATE.threshold[0]} max={GATE.threshold[1]} step={1} color={DYN} onChange={v => editG({ ...gm, threshold: v })} hint="It opens at this level (dBFS) — set it above the room noise and below your voice." />
              <Num label="Depth" value={gm.depth} unit=" dB" min={GATE.depth[0]} max={GATE.depth[1]} step={1} color={DYN} onChange={v => editG({ ...gm, depth: v })} hint="How far it turns the room down when closed. 14 dB is usually enough, 20 dB tops." />
              <Num label="Ratio 1:" value={gm.ratio} unit="" min={GATE.ratio[0]} max={GATE.ratio[1]} step={0.1} color={DYN} onChange={v => editG({ ...gm, ratio: v })} hint="How hard it expands below the threshold. 1:3–1:5 behaves as a gate." />
              <LogNum label="Open" value={gm.attack} lo={GATE.attack[0]} hi={GATE.attack[1]} unit=" ms" color={DYN} onChange={v => editG({ ...gm, attack: v })} hint="How fast it opens — fast, so the first syllable is not clipped." />
              <Num label="Hold" value={gm.hold} unit=" ms" min={GATE.hold[0]} max={GATE.hold[1]} step={10} color={DYN} onChange={v => editG({ ...gm, hold: v })} hint="Stays open this long after you stop — rides through the gaps between words." />
              <LogNum label="Release" value={gm.release} lo={GATE.release[0]} hi={GATE.release[1]} unit=" ms" color={DYN} onChange={v => editG({ ...gm, release: v })} hint="How gently it closes." />
              <Num label="Hysteresis" value={gm.hysteresis} unit=" dB" min={GATE.hysteresis[0]} max={GATE.hysteresis[1]} step={0.5} color={DYN} onChange={v => editG({ ...gm, hysteresis: v })} hint="It closes only this far below the threshold — so it does not chatter on a level hovering at the threshold." />
            </>
          )}
          {shown === "comp" && cm && comp && (
            <>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <button style={BTN(comp.in, DYN)} onClick={() => rack.update(setChannelIn(doc, comp.id, !comp.in))}>COMP {comp.in ? "IN" : "OUT"}</button>
                {comp.in && live && <span style={{ ...MONO, fontSize: 13, color: DYN }}>GR {live.compGr.toFixed(1)} dB</span>}
              </div>
              <Num label="Threshold" value={cm.threshold} unit=" dB" min={COMP.threshold[0]} max={COMP.threshold[1]} step={1} color={DYN} onChange={v => editC({ ...cm, threshold: v })} hint="Above this RMS level it starts to reduce." />
              <Num label="Ratio" value={cm.ratio} unit=":1" min={COMP.ratio[0]} max={COMP.ratio[1]} step={0.1} color={DYN} onChange={v => editC({ ...cm, ratio: v })} hint="3:1 is gentle voice control; 20:1 is close to limiting." />
              <Num label="Knee" value={cm.knee} unit=" dB" min={COMP.knee[0]} max={COMP.knee[1]} step={0.5} color={DYN} onChange={v => editC({ ...cm, knee: v })} hint="0 = hard knee; wider = it eases in around the threshold." />
              <LogNum label="Attack" value={cm.attack} lo={COMP.attack[0]} hi={COMP.attack[1]} unit=" ms" color={DYN} onChange={v => editC({ ...cm, attack: v })} hint="How fast it reacts to a louder voice." />
              <LogNum label="Release" value={cm.release} lo={COMP.release[0]} hi={COMP.release[1]} unit=" ms" color={DYN} onChange={v => editC({ ...cm, release: v })} hint="How fast it lets go." />
              <Num label="Makeup" value={cm.makeup} unit=" dB" min={COMP.makeup[0]} max={COMP.makeup[1]} step={0.5} color={DYN} onChange={v => editC({ ...cm, makeup: v })} hint="Gain after the compressor, 0–24 dB — to taste." />
            </>
          )}
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 6 }}>
            Every change is crossfaded over 20 ms — no clicks. No lookahead: nothing is added to the mic's delay.
          </div>
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
      {rack.error && (
        <div style={{ padding: "8px 12px", background: "rgba(239,68,68,0.15)", border: "1px solid #ef4444", color: "#ef4444", fontSize: 12, fontWeight: 700 }}>
          ⚠ The engine did not accept that — {rack.error}. The rack shows what is running.
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {/* ── CHANNEL PRESETS — Arm → Take (the same bar as the master rack's), Save As ── */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: 8, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
            <span style={LABEL}>Preset</span>
            <span style={{ fontSize: 13, fontWeight: 800 }}>{activePreset ?? "— (your own settings)"}</span>
            <select value={armed?.name ?? ""} onChange={e => setArmed(presets.presets.find(p => p.name === e.target.value) ?? null)}
              style={{ minHeight: TOUCH, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", padding: "0 8px", fontSize: 13 }}
              title="ARM a preset: nothing changes until you press TAKE">
              <option value="">Arm a preset…</option>
              {presets.presets.map(p => <option key={p.name} value={p.name}>{p.name}{p.builtIn ? "" : " (yours)"}</option>)}
            </select>
            {armed && (
              <>
                <button style={BTN(true, "#f59e0b")} onClick={() => { rack.update(JSON.parse(JSON.stringify(armed.doc))); setArmed(null); setBand(null); }}
                  title={armed.doc.sections.ch.length ? `Replace ${slot}'s rack with ${armed.name} — its modules go IN (crossfaded, no click)` : `Empty ${slot}'s rack — nothing runs`}>TAKE ▸ {armed.name}</button>
                <button style={BTN()} onClick={() => setArmed(null)}>DISARM</button>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                  {armed.doc.sections.ch.length ? `replaces ${slot}'s rack: ${armed.doc.sections.ch.map(s => s.module ? CHANNEL_LABEL[s.module.type] : "").join(" → ")}, all IN` : `empties ${slot}'s rack`}
                </span>
              </>
            )}
            <div style={{ flex: 1 }} />
            <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="Save as…"
              style={{ minHeight: TOUCH, width: 140, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", padding: "0 8px", fontSize: 13 }} />
            <button style={BTN()} disabled={!saveName.trim()} onClick={async () => { const e = await presets.saveAs(saveName, doc); setPresetMsg(e); if (!e) setSaveName(""); }}>SAVE AS</button>
          </div>
          {presetMsg && <div style={{ fontSize: 12, color: "var(--accent-amber)" }}>{presetMsg}</div>}

          {/* ── STRIP ── */}
          <div style={{ display: "flex", alignItems: "stretch", gap: 8, padding: 10, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", flexWrap: "wrap" }}>
            <span style={{ ...LABEL, width: 74, alignSelf: "center", fontWeight: 900, color: "var(--text-secondary)" }}>{slot}</span>
            {doc.sections.ch.map((s, i) => s.module ? tile(s, i) : null)}
            {doc.sections.ch.length < CHANNEL_RACK_SLOTS && (
              <div style={{ minWidth: 190, minHeight: 84, border: "1px dashed var(--border-primary)", display: "flex", flexDirection: "column",
                            alignItems: "center", justifyContent: "center", gap: 6, padding: 8, color: "var(--text-tertiary)", fontSize: 11 }}>
                {doc.sections.ch.length === 0 && <span>empty · add</span>}
                <div style={{ display: "flex", gap: 6 }}>
                  {addable.map(t => (
                    <button key={t} style={BTN(false, SLOT_COLOR[t])} onClick={() => { rack.update(addChannelModule(doc, t)); setSelMod(t); }}
                      title={`Add ${CHANNEL_LABEL[t]} — it starts OUT: nothing changes on air until you press IN`}>+ {CHANNEL_LABEL[t]}</button>
                  ))}
                </div>
              </div>
            )}
            {doc.sections.ch.length > 0 && (
              <div style={{ alignSelf: "center", marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                {!confirmClear ? (
                  <button style={BTN()} onClick={() => setConfirmClear(true)}
                    title={`Empty ${slot}'s rack — removes every module. Asks first.`}>CLEAR RACK</button>
                ) : (
                  <div role="alertdialog" aria-label={`Clear ${slot}'s rack?`}
                       style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 8px", border: "1px solid #ef4444", background: "rgba(239,68,68,0.10)" }}>
                    <span style={{ fontSize: 12, fontWeight: 700 }}>Clear {slot}'s rack? Every module is removed; {slot} is untouched again.</span>
                    <button style={BTN(true, "#ef4444")} onClick={() => { setConfirmClear(false); setBand(null); rack.update(clearChannelRack(doc)); }}>CLEAR</button>
                    <button style={BTN()} onClick={() => setConfirmClear(false)} autoFocus>CANCEL</button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── EDITOR ── */}
          <div style={{ padding: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ ...LABEL, fontSize: 12 }}>
              editing: <b style={{ color: "var(--text-primary)" }}>{slot} · {shown ? CHANNEL_LABEL[shown] : "—"}</b>
              {(filters || peq) && !channelRackAudible(doc) && <span style={{ marginLeft: 10, textTransform: "none", letterSpacing: 0 }}>· nothing IN changes the sound — {slot} is untouched</span>}
            </div>
            {doc.sections.ch.length === 0 ? (
              <div style={{ color: "var(--text-tertiary)", fontSize: 13, lineHeight: 1.5 }}>
                {slot}'s rack is empty — the audio on this fader is untouched. Add <b>Filters</b> (a high-pass and low-pass), a <b>Gate</b>,
                a <b>PEQ</b> (four bands) or a <b>Comp</b>ressor — or take the <b>Voice</b> preset above. A new module starts <b>OUT</b>, so nothing
                changes on air until you press <b>IN</b>.
              </div>
            ) : (shown === "gate" || shown === "comp") ? dynEditor() : (!filters && !peq) ? (
              <div style={{ color: "var(--text-tertiary)", fontSize: 13 }}>Pick a module above to edit it.</div>
            ) : (
              <>
                <EqCurve doc={doc} filters={filters as any} peq={peq as any} onFilters={editF} onPeq={editQ} selected={band}
                         onSelect={b => { setBand(b); if (b != null) setSelMod("peq"); }} />
                {filters?.module && (shown === "filters" || !peq) && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <button style={BTN(filters.module.hpf.in, "var(--slot-filter)")} onClick={() => editF({ ...filters.module!, hpf: { ...filters.module!.hpf, in: !filters.module!.hpf.in } })}
                        title="The high-pass on its own (24 dB/oct). The FILTERS tile's IN switches both.">HPF {filters.module.hpf.in ? "IN" : "OUT"}</button>
                      <div style={{ flex: 1 }}><FreqKnob label="HPF" value={filters.module.hpf.freq} lo={HPF_HZ[0]} hi={HPF_HZ[1]} color="var(--slot-filter)"
                        onChange={v => editF({ ...filters.module!, hpf: { ...filters.module!.hpf, freq: v } })} hint="High-pass corner (−3 dB), 24 dB/octave below it." /></div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <button style={BTN(filters.module.lpf.in, "var(--slot-filter)")} onClick={() => editF({ ...filters.module!, lpf: { ...filters.module!.lpf, in: !filters.module!.lpf.in } })}
                        title="The low-pass on its own (24 dB/oct).">LPF {filters.module.lpf.in ? "IN" : "OUT"}</button>
                      <div style={{ flex: 1 }}><FreqKnob label="LPF" value={filters.module.lpf.freq} lo={LPF_HZ[0]} hi={LPF_HZ[1]} color="var(--slot-filter)"
                        onChange={v => editF({ ...filters.module!, lpf: { ...filters.module!.lpf, freq: v } })} hint="Low-pass corner (−3 dB), 24 dB/octave above it." /></div>
                    </div>
                    <button style={{ ...BTN(), alignSelf: "flex-start" }} onClick={() => rack.update(resetFilters(doc))}
                      title="HPF and LPF both OUT, back to 80 Hz / 18 kHz. The FILTERS tile's IN is kept. Crossfaded (20 ms), no click.">RESET FILTERS</button>
                  </div>
                )}
                {peq?.module && (shown === "peq" || !filters) && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button style={BTN(peq.in, "var(--slot-eq)")} onClick={() => rack.update(setChannelIn(doc, peq.id, !peq.in))} title="The PEQ IN / OUT (the same switch as the PEQ tile)">PEQ {peq.in ? "IN" : "OUT"}</button>
                      {peq.module.bands.map((b, i) => (
                        <button key={i} style={{ ...BTN(band === i, BAND_COLOR[i]), borderBottom: `3px solid ${BAND_COLOR[i]}` }} onClick={() => setBand(band === i ? null : i)}>BAND {i + 1}</button>
                      ))}
                      <button style={BTN()} onClick={() => rack.update(flatPeq(doc))}
                        title="Every band to 0 dB — frequency and width are kept. Crossfaded (20 ms), no click.">FLAT</button>
                    </div>
                    {band != null && (() => {
                      const b = peq.module!.bands[band]; const c = BAND_COLOR[band];
                      return (
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, borderLeft: `3px solid ${c}`, paddingLeft: 10 }}>
                          <FreqKnob label="Freq" value={b.freq} lo={PEQ_HZ[0]} hi={PEQ_HZ[1]} color={c} onChange={v => setQBand(band, { freq: v })} hint="The band's centre (or shelf corner)." />
                          <Num label="Gain" value={b.gain} unit=" dB" min={-PEQ_GAIN_DB} max={PEQ_GAIN_DB} step={0.5} color={c} onChange={v => setQBand(band, { gain: v })} hint="Boost or cut. 0 dB = the band does nothing (the engine skips it)." />
                          <Num label="Width" value={b.width} unit=" oct" min={PEQ_WIDTH_OCT[0]} max={PEQ_WIDTH_OCT[1]} step={0.05} color={c} onChange={v => setQBand(band, { width: v })} hint="Bandwidth in octaves (on the curve: the mouse wheel or a pinch). Narrow = surgical; wide = tonal." />
                          {(band === 0 || band === 3) && (
                            <button style={{ ...BTN(!!b.shelf, c), alignSelf: "flex-start" }} onClick={() => setQBand(band, { shelf: !b.shelf })}
                              title={band === 0 ? "Band 1 as a low shelf instead of a bell" : "Band 4 as a high shelf instead of a bell"}>{b.shelf ? (band === 0 ? "LOW SHELF" : "HIGH SHELF") : "BELL"}</button>
                          )}
                        </div>
                      );
                    })()}
                    {band == null && <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Drag a numbered node on the curve (sideways = frequency, up/down = gain; wheel or pinch = width), or pick a band.</div>}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── PINNED METERS: IN (pre-rack) and OUT (post-rack) ── */}
        <div style={{ flex: "0 1 220px", minWidth: 180, display: "flex", flexDirection: "column", gap: 8, padding: 10, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
          <span style={{ ...LABEL, fontWeight: 800 }}>{slot} · pre-fader</span>
          <div style={{ display: "flex", gap: 8, height: 180 }}>
            <div style={{ flex: 1, display: "flex" }}>
              <PeakAvgMeter source={{ stationUuid, ch: idx }} size="master" label="IN" title={`${slot} before its rack (what the strip meter shows)`} />
            </div>
            <div style={{ flex: 1, display: "flex" }}>
              <PeakAvgMeter source={{ stationUuid, ch: idx, post: true }} size="master" label="OUT" title={`${slot} after its rack — what the EQ did. Hatched = the running engine predates the channel EQ.`} />
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.4 }}>
            Both before the fader. The rack sits after trim and before the fader and duck.
          </div>
        </div>
      </div>
    </div>
  );
}

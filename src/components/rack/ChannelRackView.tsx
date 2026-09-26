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
import React, { useState } from "react";
import type { ChannelModule, ChannelModuleType, FilterModule, PeqModule, Slot } from "./rackTypes";
import {
  CHANNEL_LABEL, CHANNEL_RACK_SLOTS, addChannelModule, canMoveChannel, channelAddable, channelRackAudible, editChannelModule,
  moveChannelSlot, removeChannelSlot, setChannelIn, findChannel, type ChannelSlot,
} from "./channelRack";
import { SLOT_COLOR } from "./rackModel";
import { HPF_HZ, LPF_HZ, PEQ_HZ, PEQ_GAIN_DB, PEQ_WIDTH_OCT } from "./eqMath";
import EqCurve from "./EqCurve";
import { LABEL, MONO, TOUCH, BTN } from "./rackUi";
import { useChannelRack } from "../../hooks/useChannelRack";
import PeakAvgMeter from "../meter/PeakAvgMeter";
import { CH_INDEX } from "../meter/meterStore";

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
            : m.bands.map((b, k) => <span key={k} style={{ color: Math.abs(b.gain) > 1e-6 ? BAND_COLOR[k] : undefined }}>{k ? " · " : ""}{Math.abs(b.gain) > 1e-6 ? `${b.gain > 0 ? "+" : ""}${b.gain.toFixed(1)}` : "0"}</span>)}
        </div>
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
          </div>

          {/* ── EDITOR ── */}
          <div style={{ padding: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ ...LABEL, fontSize: 12 }}>
              editing: <b style={{ color: "var(--text-primary)" }}>{slot} · {shown ? CHANNEL_LABEL[shown] : "—"}</b>
              {(filters || peq) && !channelRackAudible(doc) && <span style={{ marginLeft: 10, textTransform: "none", letterSpacing: 0 }}>· nothing IN changes the sound — {slot} is untouched</span>}
            </div>
            {!filters && !peq ? (
              <div style={{ color: "var(--text-tertiary)", fontSize: 13, lineHeight: 1.5 }}>
                {slot}'s rack is empty — the audio on this fader is untouched. Add <b>Filters</b> (a high-pass and low-pass) or a <b>PEQ</b>
                (four bands). A new module starts <b>OUT</b>, so nothing changes on air until you press <b>IN</b>.
              </div>
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
                  </div>
                )}
                {peq?.module && (shown === "peq" || !filters) && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button style={BTN(peq.in, "var(--slot-eq)")} onClick={() => rack.update(setChannelIn(doc, peq.id, !peq.in))} title="The PEQ IN / OUT (the same switch as the PEQ tile)">PEQ {peq.in ? "IN" : "OUT"}</button>
                      {peq.module.bands.map((b, i) => (
                        <button key={i} style={{ ...BTN(band === i, BAND_COLOR[i]), borderBottom: `3px solid ${BAND_COLOR[i]}` }} onClick={() => setBand(band === i ? null : i)}>BAND {i + 1}</button>
                      ))}
                      <button style={BTN()} onClick={() => editQ({ ...peq.module!, bands: peq.module!.bands.map(b => ({ ...b, gain: 0 })) as PeqModule["bands"] })} title="Every band to 0 dB">FLAT</button>
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

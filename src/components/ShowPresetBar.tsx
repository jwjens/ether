// ShowPresetBar — SLICE 7: the show preset bar ON THE BOARD (docs/dsp-show-presets.md §2 · docs/help-show-presets.md).
//
// Above the faders, so it is in the dashboard AND the pop-out board. It shows the show last Taken ("SHOW: Morning
// Drive"), "· modified" when the board no longer matches it (derived value by value from a live snapshot, never a
// flag), and Arm → TAKE / DISARM, Save, Save As. Arm shows what TAKE would change and which channels are live and
// will wait. Everything the bar shows about the Take comes back from the blade (the audio service); the bar holds
// only what is being typed.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShowState } from "../hooks/useShowState";
import { useDeckConfig } from "./DeckConfigurator";
import { FLAT, armPreview, diffShow, liveSlots, type ShowPreset } from "../lib/showPresets";
import { useBoardName } from "../hooks/useBoardName";

const H = 30;
const btn = (tone?: string, on = false): React.CSSProperties => ({
  height: H, padding: "0 10px", fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", cursor: "pointer", borderRadius: 2,
  border: `1px solid ${on && tone ? tone : "var(--border-primary)"}`,
  background: on && tone ? `color-mix(in srgb, ${tone} 22%, transparent)` : "var(--bg-tertiary)",
  color: on && tone ? tone : "var(--text-secondary)",
});
const AMBER = "var(--accent-amber, #f59e0b)";

export default function ShowPresetBar({ deckStatus }: { deckStatus: Record<string, string | undefined> }) {
  const { state, reload, stationId } = useShowState();
  const { configs } = useDeckConfig();
  // ONE NAME PER FADER — the bar names channels by board letter, never the engine slot id (src/lib/boardName.ts).
  const name = useBoardName();
  const [presets, setPresets] = useState<ShowPreset[]>([]);
  const [flat, setFlat] = useState<ShowPreset | null>(null);
  const [foreign, setForeign] = useState(0);
  const [live, setLive] = useState<ShowPreset | null>(null);
  const [open, setOpen] = useState(false);
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const show = (window as any).ether?.show;

  const loadList = useCallback(async () => {
    if (stationId == null || !show?.list) return;
    try {
      const r = await show.list(stationId);
      setPresets(r?.presets || []);
      setFlat((r?.builtIns || [])[0] || null);
      setForeign(r?.foreign || 0);
    } catch { /* keep what is shown */ }
  }, [stationId]);
  const loadLive = useCallback(async () => {
    if (stationId == null || !show?.snapshot) return;
    try { const r = await show.snapshot(stationId); if (r?.ok) setLive(r.preset); } catch { /* keep */ }
  }, [stationId]);

  useEffect(() => { void loadList(); void loadLive(); }, [loadList, loadLive, state.current]);
  // "· modified" follows the board: re-snapshot on a Take landing, a board change, and every few seconds (a drag, a
  // rack edit in its window). One IPC read of the stores + the blade's levels.
  useEffect(() => {
    const t = setInterval(() => { void loadLive(); }, 3000);
    const ether = (window as any).ether;
    const ha = ether?.show?.onApplied?.(() => { void loadLive(); void reload(); });
    const hc = ether?.deckConfigs?.onChanged?.(() => { void loadLive(); });
    return () => { clearInterval(t); if (ha) ether.show.offApplied?.(ha); if (hc) ether.deckConfigs.offChanged?.(hc); };
  }, [loadLive, reload]);

  const all = useMemo(() => [...(flat ? [flat] : []), ...presets], [flat, presets]);
  const byName = (n: string | null) => all.find(p => p.name === n) || null;
  const current = byName(state.current);
  const modified = !!(current && live && diffShow(live, current, name).length);
  const armed = byName(state.armed);

  const onBoard = useMemo(() => {
    const on = (configs || []).filter(c => c.enabled).map(c => c.slot as string);
    return Array.from(new Set(["A", "B", "C", ...on]));
  }, [configs]);
  const channelOn = useMemo(() => Object.fromEntries((configs || []).map(c => [c.slot, (c as any).channelOn ?? true])), [configs]);
  const preview = useMemo(() => {
    if (!armed || !live) return null;
    return armPreview(diffShow(live, armed, name), liveSlots(onBoard, deckStatus, channelOn));
  }, [armed, live, onBoard, deckStatus, channelOn, name]);

  const arm = async (name: string) => {
    setMsg(null);
    if (!name) { await show?.disarm?.(stationId); setOpen(false); void reload(); return; }
    await show?.arm?.(stationId, name);
    setOpen(true);
    void reload();
  };
  const take = async () => {
    if (!armed) return;
    const r = await show?.take?.(stationId, armed.name);
    if (r?.ok) {
      const waiting = r.pending || [];
      setMsg({ tone: "ok", text: `Taken: ${armed.name}${waiting.length ? ` — ${waiting.map((s: string) => name(s)).join(", ")} ${waiting.length === 1 ? "is" : "are"} ON and will change when switched OFF (or TAKE NOW)` : ""}${r.stripped?.length ? ` · ignored ${r.stripped.length} setting(s) that belong to one computer` : ""}` });
      setOpen(false);
    } else setMsg({ tone: "bad", text: `Not taken — ${r?.reason || "no answer from the audio engine"}` });
    void reload(); void loadLive();
  };
  const save = async (name: string) => {
    const r = await show?.save?.(stationId, name);
    if (r?.ok) { setMsg({ tone: "ok", text: `Saved "${name}"` }); setSaveAs(null); void loadList(); }
    else setMsg({ tone: "bad", text: `Not saved — ${r?.reason || "no answer"}` });
  };

  if (state.unavailable) {
    return <div style={{ padding: "4px 8px", fontSize: 11, color: "var(--text-tertiary)", borderBottom: "1px solid var(--border-primary)" }}>SHOW PRESETS — {state.unavailable}</div>;
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border-primary)", background: "var(--bg-secondary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)" }}>SHOW</span>
        <span style={{ fontSize: 12, fontWeight: 800, color: "var(--text-primary)" }} title="The show preset last Taken on this station">
          {state.current ?? "—"}
        </span>
        {modified && <span style={{ fontSize: 11, color: AMBER }} title="The board no longer matches this show — a fader, a rack, the ducker or the layout has changed since it was Taken">· modified</span>}
        {state.pending.length > 0 && (
          <span style={{ fontSize: 11, color: AMBER, fontWeight: 700 }} title="These channels were ON when the show was Taken. They keep what they have until they are switched OFF, or you press TAKE NOW on the channel.">
            · waiting: {state.pending.map(p => name(p.slot)).join(", ")}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <select value={state.armed ?? ""} onChange={e => { void arm(e.target.value); }}
          title="ARM a show: nothing changes until you press TAKE"
          style={{ height: H, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", fontSize: 12, padding: "0 6px" }}>
          <option value="">Arm a show…</option>
          {all.map(p => <option key={p.name} value={p.name}>{p.name}{p.builtIn ? " (built in)" : ""}</option>)}
        </select>
        {armed && (
          <>
            <button style={btn(AMBER, true)} onClick={take} title={`Take ${armed.name}: channels that are OFF change now; channels that are ON wait until they go OFF`}>TAKE ▸ {armed.name}</button>
            <button style={btn()} onClick={() => setOpen(o => !o)} title="What TAKE will change">{open ? "▴" : "▾"}</button>
            <button style={btn()} onClick={() => { void arm(""); }}>DISARM</button>
          </>
        )}
        <button style={btn()} disabled={!state.current || state.current === FLAT}
          onClick={() => state.current && save(state.current)}
          title={state.current && state.current !== FLAT ? `Save the board as "${state.current}" (overwrites it)` : "Take a show first, or use Save As — the built-in Flat can't be overwritten"}>SAVE</button>
        {saveAs === null
          ? <button style={btn()} onClick={() => setSaveAs("")}>SAVE AS…</button>
          : (
            <>
              <input autoFocus value={saveAs} onChange={e => setSaveAs(e.target.value)} placeholder="Show name"
                onKeyDown={e => { if (e.key === "Enter" && saveAs.trim()) void save(saveAs.trim()); if (e.key === "Escape") setSaveAs(null); }}
                style={{ height: H, width: 150, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", padding: "0 6px", fontSize: 12 }} />
              <button style={btn()} disabled={!saveAs.trim()} onClick={() => void save(saveAs.trim())}>SAVE</button>
              <button style={btn()} onClick={() => setSaveAs(null)}>CANCEL</button>
            </>
          )}
      </div>
      {foreign > 0 && <div style={{ padding: "0 8px 4px", fontSize: 11, color: AMBER }}>{foreign} saved show(s) belong to another station and are not offered here.</div>}
      {msg && <div style={{ padding: "0 8px 4px", fontSize: 11, color: msg.tone === "ok" ? "var(--accent-green)" : "var(--accent-red, #ef4444)" }}>{msg.text}</div>}
      {armed && open && preview && (
        <div style={{ padding: "4px 8px 8px", fontSize: 11, color: "var(--text-secondary)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 800, letterSpacing: "0.08em", color: "var(--text-tertiary)", marginBottom: 2 }}>CHANGES NOW</div>
            {preview.now.length === 0 ? <div>nothing</div> : preview.now.map((c, i) => <div key={i}>{c.where} · {c.what}: {c.from} → <b>{c.to}</b></div>)}
          </div>
          <div>
            <div style={{ fontWeight: 800, letterSpacing: "0.08em", color: AMBER, marginBottom: 2 }}>
              WAITS — ON NOW{preview.waitingSlots.length ? ` (${preview.waitingSlots.map(name).join(", ")})` : ""}
            </div>
            {preview.waits.length === 0 ? <div>nothing — no channel that changes is ON</div> : preview.waits.map((c, i) => <div key={i}>{c.where} · {c.what}: {c.from} → <b>{c.to}</b></div>)}
            <div style={{ marginTop: 4, color: "var(--text-tertiary)" }}>A Take never switches a channel ON.</div>
          </div>
        </div>
      )}
    </div>
  );
}

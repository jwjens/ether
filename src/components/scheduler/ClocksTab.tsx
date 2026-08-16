// ClocksTab — the hour grid, with its private TalkPicker and SegmentPicker.
// Extracted verbatim from Scheduler.tsx (Phase A, 2026-08-10) — lines 605-674, 677-759, 782-end of the pre-split file.
// NO LOGIC CHANGED. Scheduler.tsx re-exports this so the tabbed panel, the three popouts
// (PopoutRenderer.tsx) and the embedded programming panel (App.tsx) behave identically.
// docs/schedule-manager-design-2026-08-10.md §8 Phase A
import { useState, useEffect, useRef } from "react";
import { queryScoped } from "../../db/stationScoped";
import { useActiveStation } from "../../hooks/useActiveStation";
import type { Clock, ClockSlot, Category } from "./types";
import { CLOCK_SLOT_TYPE_OPTIONS, fmtClockPos } from "./shared";

function TalkPicker({ onAdd, onBack }: {
  onAdd: (type: string, catId: number | null, durationMin: number, label: string) => void;
  onBack: () => void;
}) {
  const [customMin, setCustomMin] = useState("");
  const [customSec, setCustomSec] = useState("");

  const fire = (min: number, label: string) => onAdd("talk_break", null, min, label);

  const fireCustom = () => {
    const m = parseFloat(customMin) || 0;
    const s = parseFloat(customSec) || 0;
    const total = m + s / 60;
    if (total <= 0) return;
    const label = m > 0 && s > 0 ? `${m}:${String(Math.round(s)).padStart(2,"0")} talk`
                : m > 0            ? `${m}:00 talk`
                :                    `:${String(Math.round(s)).padStart(2,"0")} talk`;
    fire(total, label);
  };

  return (
    <div>
      {/* Preset buttons */}
      <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
        {[
          { l: ":15", m: 0.25 }, { l: ":30", m: 0.5 },
          { l: "1:00", m: 1 },   { l: "1:30", m: 1.5 },
          { l: "2:00", m: 2 },   { l: "3:00", m: 3 },
        ].map(({ l, m }) => (
          <button key={l} onClick={() => fire(m, l + " talk")} style={{
            flex: 1, padding: "8px 4px", borderRadius: 0, fontSize: "var(--t-small)", fontWeight: 700,
            cursor: "pointer", background: "rgba(124,58,237,0.2)",
            border: "1px solid rgba(124,58,237,0.4)", color: "#c4b5fd",
            transition: "all 0.1s",
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(124,58,237,0.4)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "rgba(124,58,237,0.2)"; }}
          >{l}</button>
        ))}
      </div>

      {/* Custom duration row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderRadius: 0, background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.2)" }}>
        <span style={{ fontSize: "var(--t-micro)", fontWeight: 700, color: "rgba(167,139,250,0.7)", letterSpacing: "0.08em", flexShrink: 0 }}>CUSTOM</span>
        <input
          type="number" min="0" max="59" placeholder="0"
          value={customMin}
          onChange={e => setCustomMin(e.target.value)}
          style={{ width: 44, padding: "5px 8px", borderRadius: 0, fontSize: "var(--t-lead)", fontWeight: 700, textAlign: "center", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'DM Mono', monospace" }}
        />
        <span style={{ fontSize: "var(--t-body)", color: "var(--text-tertiary)", fontWeight: 700 }}>m</span>
        <input
          type="number" min="0" max="59" placeholder="0"
          value={customSec}
          onChange={e => setCustomSec(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") fireCustom(); }}
          style={{ width: 44, padding: "5px 8px", borderRadius: 0, fontSize: "var(--t-lead)", fontWeight: 700, textAlign: "center", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'DM Mono', monospace" }}
        />
        <span style={{ fontSize: "var(--t-body)", color: "var(--text-tertiary)", fontWeight: 700 }}>s</span>
        <button
          onClick={fireCustom}
          disabled={!customMin && !customSec}
          style={{ marginLeft: 4, padding: "5px 14px", borderRadius: 0, fontSize: "var(--t-small)", fontWeight: 700, cursor: "pointer", background: "#a78bfa", border: "none", color: "#000", opacity: (!customMin && !customSec) ? 0.4 : 1, transition: "opacity 0.1s" }}
        >Add</button>
      </div>

      <button onClick={onBack} style={{ marginTop: 8, fontSize: "var(--t-micro)", color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer" }}>← Back</button>
    </div>
  );
}

function SegmentPicker({ cats, spotCats, onAdd, onClose }: {
  cats: Category[];
  spotCats: { id: number; name: string; color: string | null }[];
  onAdd: (type: string, catId: number | null, durationMin: number, label: string, spotCatId?: number | null) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"type" | "song" | "spots" | "talk">("type");

  return (
    <div style={{
      position: "absolute" as const, bottom: "calc(100% + 8px)", left: 0, right: 0,
      zIndex: 100, background: "var(--bg-secondary)",
      border: "1px solid var(--border-primary)", borderRadius: 0,
      padding: 14, boxShadow: "var(--e-float)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: "var(--t-micro)", fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)" }}>
          {step === "type" ? "ADD SEGMENT" : step === "song" ? "PICK CATEGORY" : step === "spots" ? "SPOTS — PICK CATEGORY" : "TALK BREAK"}
        </span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: "var(--t-lead)" }}>✕</button>
      </div>

      {step === "type" && (
        <div style={{ display: "flex", gap: 6 }}>
          {[
            { label: "Song", color: "var(--accent-blue)", next: "song" as const },
            { label: "Spots", color: "#ef4444", next: "spots" as const },
            { label: "Talk break", color: "#a78bfa", next: "talk" as const },
          ].map(b => (
            <button key={b.label} onClick={() => setStep(b.next)} style={{
              flex: 1, padding: "10px 6px", borderRadius: 0, fontSize: "var(--t-body)", fontWeight: 700,
              cursor: "pointer", background: b.color + "18", border: "1px solid " + b.color + "40", color: b.color,
            }}>{b.label}</button>
          ))}
        </div>
      )}

      {step === "song" && (
        <div>
          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 5, marginBottom: 8 }}>
            {cats.map(c => (
              <button key={c.id} onClick={() => onAdd("music", c.id, 3.5, c.name || c.code)} style={{
                padding: "5px 10px", borderRadius: 0, fontSize: "var(--t-small)", fontWeight: 700, cursor: "pointer",
                background: (c.color || "#444") + "25", border: "1px solid " + (c.color || "#444") + "55",
                color: "#fff",
              }}>
                <span style={{ color: c.color || "#fff", marginRight: 4 }}>{c.code}</span>{c.name}
              </button>
            ))}
            {cats.length === 0 && <span style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)" }}>No categories — add them in the Categories tab.</span>}
          </div>
          <button onClick={() => setStep("type")} style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer" }}>← Back</button>
        </div>
      )}

      {step === "spots" && (
        <div>
          {spotCats.length === 0 ? (
            <div style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)", marginBottom: 8 }}>Create a spot category in Spots &amp; Promos first.</div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 5, marginBottom: 8 }}>
              {spotCats.map(sc => (
                <button key={sc.id} onClick={() => onAdd("spot_break", null, 2, "Spots", sc.id)} style={{
                  padding: "5px 10px", borderRadius: 0, fontSize: "var(--t-small)", fontWeight: 700, cursor: "pointer",
                  background: (sc.color || "#ef4444") + "22", border: "1px solid " + (sc.color || "#ef4444") + "55", color: sc.color || "#fca5a5",
                }}>{sc.name}</button>
              ))}
              <button onClick={() => onAdd("spot_break", null, 2, "Spots", null)} style={{
                padding: "5px 10px", borderRadius: 0, fontSize: "var(--t-small)", fontWeight: 700, cursor: "pointer",
                background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", color: "var(--text-secondary)",
              }}>Any spot</button>
            </div>
          )}
          <button onClick={() => setStep("type")} style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer" }}>← Back</button>
        </div>
      )}

      {step === "talk" && (
        <TalkPicker onAdd={onAdd} onBack={() => setStep("type")} />
      )}
    </div>
  );
}

/** All optional — with none supplied, behaves exactly as before (see ShowsTabProps). §4.2
 *  `clockId`/`onSelectClock` make the clock selection CONTROLLED so the hub can focus a show's clock;
 *  uncontrolled (today's behaviour) when omitted. */
export interface ClocksTabProps {
  clocks?: Clock[];
  cats?: Category[];
  /** Spot categories from the store. Self-fetches when absent, so the tabs are unchanged. */
  spotCats?: { id: number; name: string; color: string | null; uuid: string }[];
  /** Hide the inline Spot Categories card. Set by the DOCKING SHELL only, where a dedicated Spots
   *  pane owns them — spots were cramping the clock grid, which is why they moved. The tabbed view
   *  and v1's fixed workspace keep the card, because neither has a Spots pane to send you to. */
  hideSpotCategories?: boolean;
  onMutated?: (tables?: string[]) => void;
  clockId?: number | null;
  onSelectClock?: (clockId: number | null) => void;
  /** Clock ids to highlight — the clocks using the selected category. */
  highlightClockIds?: number[];
  /** Per-clock rotation-goals verdict from library-health:goals. Rendered when given. */
  advisor?: Record<number, { rows: { category: string; target: number; slots: number; delta: number; unused: boolean }[]; musicSlots: number }>;
}

export function ClocksTab({ clocks: clocksProp, cats: catsProp, spotCats: spotCatsProp, hideSpotCategories, onMutated, clockId, onSelectClock, highlightClockIds, advisor }: ClocksTabProps = {}) {
  const hosted = !!onMutated;
  const controlled = clockId !== undefined;
  const { stationId, isReady } = useActiveStation();
  const [clocksLocal, setClocks]  = useState<Clock[]>([]);
  const [selectedLocal, setSelectedLocal] = useState<number | null>(null);
  const [slots, setSlots]         = useState<ClockSlot[]>([]);
  const [catsLocal, setCats]      = useState<Category[]>([]);
  // Hub-supplied when hosted, own state otherwise. `setSelected` routes to the hub when controlled,
  // so every existing setSelected(...) call site keeps working unchanged.
  const clocks = clocksProp ?? clocksLocal;
  const cats = catsProp ?? catsLocal;
  const selected = controlled ? (clockId ?? null) : selectedLocal;
  const setSelected = (id: number | null) => { if (controlled) onSelectClock?.(id); else setSelectedLocal(id); };
  const [spotCatsLocal, setSpotCats] = useState<{ id: number; name: string; color: string | null; uuid: string }[]>([]);
  // The clock editor NEEDS spot categories even though it no longer manages them: the segment
  // picker assigns one to a spot slot, a new break defaults to one, and the break rows list them.
  // So this is data flow, not ownership — which is why the Spots extraction was never a line move.
  const spotCats = spotCatsProp ?? spotCatsLocal;
  const [breaks, setBreaks]       = useState<{ id: number; uuid: string; minute: number; spot_category_id: number | null; count: number }[]>([]);
  const [breaksSaved, setBreaksSaved] = useState(false);
  const [spotCatCounts, setSpotCatCounts] = useState<Record<number, number>>({});
  // Eligible-spot counts per spot category (Generate's SPOT_SELECT criteria) + total active — drives the
  // per-break "0 eligible spots" warning so a break that would air nothing is a visible fact (v4.4.83).
  const [breakEligible, setBreakEligible] = useState<Record<number, number>>({});
  const [anyEligible, setAnyEligible] = useState(0);
  const [editSpotCat, setEditSpotCat] = useState<{ id: number; name: string; color: string } | null>(null);
  const [newSpotCatName, setNewSpotCatName] = useState("");
  const [newSpotCatColor, setNewSpotCatColor] = useState("#8868D8");
  const [newName, setNewName]     = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [showTalkPicker, setShowTalkPicker] = useState(false);
  const [showSpotPicker, setShowSpotPicker] = useState(false);
  const [dragIdx, setDragIdx]     = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ idx: number; edge: "top" | "bottom" } | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<number | null>(null);
  const [copiedSlot, setCopiedSlot] = useState<ClockSlot | null>(null);
  const [editCell, setEditCell] = useState<{ slotId: number; field: "type" | "cat" } | null>(null);

  // ── Fix: reload cats every time the tab is active ────────────
  const loadAll = async () => {
    // Hosted: report the write upward. The hub owns clocks/categories; spot-category counts stay
    // local because only this pane uses them.
    if (hosted) { onMutated!(["clocks", "categories", "clock_slots", "clock_breaks"]); loadSpotCats(); return; }
    if (!isReady) return;
    setClocks(await queryScoped<Clock>("SELECT * FROM clocks WHERE deleted_at IS NULL ORDER BY name", [], stationId));
    setCats(await queryScoped<Category>("SELECT * FROM categories ORDER BY priority, code", [], stationId));
    loadSpotCats();
  };

  // Spot categories (per station) — the source a timed break pulls from; managed here on the clock.
  const loadSpotCats = async () => {
    if (!isReady) return;
    setSpotCats(((await (window as any).ether.spotCategories.list(stationId))?.rows) || []);
    const counts = await queryScoped<{ spot_category_id: number; c: number }>(
      "SELECT spot_category_id, COUNT(*) c FROM spots WHERE spot_category_id IS NOT NULL AND deleted_at IS NULL GROUP BY spot_category_id", [], stationId);
    const map: Record<number, number> = {};
    for (const r of counts) map[r.spot_category_id] = r.c;
    setSpotCatCounts(map);
    // Eligible-per-category (the exact criteria Generate's SPOT_SELECT_BY_CATEGORY places by).
    const today = new Date().toISOString().slice(0, 10);
    const elig = await queryScoped<{ spot_category_id: number | null; c: number }>(
      `SELECT spot_category_id, COUNT(*) c FROM spots
         WHERE deleted_at IS NULL AND is_active = 1 AND file_path IS NOT NULL
           AND (start_date IS NULL OR start_date = '' OR start_date <= ?)
           AND (end_date   IS NULL OR end_date   = '' OR end_date   >= ?)
         GROUP BY spot_category_id`, [today, today], stationId);
    const em: Record<number, number> = {}; let any = 0;
    for (const r of elig) { if (r.spot_category_id != null) em[r.spot_category_id] = r.c; any += r.c; }
    setBreakEligible(em); setAnyEligible(any);
  };
  const addSpotCat = async () => {
    const name = newSpotCatName.trim(); if (!name) return;
    await (window as any).ether.spotCategories.create({ station_id: stationId, name, color: newSpotCatColor });
    setNewSpotCatName(""); loadSpotCats();
  };
  const saveSpotCat = async () => {
    if (!editSpotCat || !editSpotCat.name.trim()) return;
    await (window as any).ether.spotCategories.updateById(editSpotCat.id, { name: editSpotCat.name.trim(), color: editSpotCat.color });
    setEditSpotCat(null); loadSpotCats();
  };
  const removeSpotCat = async (c: { uuid: string; name: string }) => {
    const refs = await (window as any).ether.spotCategories.refs(c.uuid);
    const breaks = refs?.breaks || 0, spots = refs?.spots || 0;
    const msg = (breaks + spots === 0)
      ? `Delete spot category "${c.name}"?`
      : `Delete "${c.name}"?\n\nIt's used by ${breaks} timed break(s) and ${spots} spot(s). Deleting will set those breaks to "Any spot" and make those spots uncategorized. This changes what airs on the next Generate.\n\nDelete anyway?`;
    if (!confirm(msg)) return;
    await (window as any).ether.spotCategories.delete(c.uuid, stationId);
    loadSpotCats();
  };

  const loadSlots = async (clockId: number) => {
    // station_id scoping: manual JOIN — clock_slots.station_id filters scope; categories joined by FK
    const raw = await queryScoped<ClockSlot>(
      `SELECT cs.*, c.code as category_code, c.color as category_color,
              sc.name as spot_category_name, sc.color as spot_category_color
       FROM clock_slots cs
       LEFT JOIN categories c ON c.id = cs.category_id
       LEFT JOIN spot_categories sc ON sc.id = cs.spot_category_id
       WHERE cs.clock_id = ? AND cs.station_id = ? AND cs.deleted_at IS NULL ORDER BY cs.position`,
      [clockId, stationId],
      stationId,
      { skipScoping: true }
    );
    // Enrich music slots with a representative song
    const enriched = await Promise.all(raw.map(async s => {
      // Pinned slot — show the exact element it's locked to (by cart #).
      if (s.song_id) {
        try {
          const pin = await queryScoped<{ title: string; artist_name: string | null; duration_ms: number; cart_id: string | null }>(
            `SELECT s.title, a.name as artist_name, s.duration_ms, s.cart_id
             FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.id = ?`,
            [s.song_id], stationId, { skipScoping: true }
          );
          if (pin.length > 0) {
            const durMin = pin[0].duration_ms > 0 ? Math.round((pin[0].duration_ms / 60000) * 100) / 100 : s.duration_min;
            return { ...s, song_title: pin[0].title, song_artist: pin[0].artist_name, cart_id: pin[0].cart_id, duration_min: durMin };
          }
        } catch {}
        return s;
      }
      if (s.slot_type === "music" && s.category_id) {
        try {
          const songs = await queryScoped<{ id: number; title: string; artist_name: string | null; duration_ms: number; file_path: string }>(
            `SELECT s.id, s.title, a.name as artist_name, s.duration_ms, s.file_path
             FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
             WHERE s.category_id = ? ORDER BY RANDOM() LIMIT 1`,
            [s.category_id],
            stationId,
            { skipScoping: true }
          );
          if (songs.length > 0) {
            let durMs = songs[0].duration_ms;
            if ((!durMs || durMs < 1000) && songs[0].file_path) {
              try {
                const invoke = <T = any>(cmd: string, args?: any): Promise<T> => (window as any).ether.invoke(cmd, args);
                const durSec = await invoke<number>("get_file_duration", { filePath: songs[0].file_path });
                durMs = Math.round(durSec * 1000);
                if (durMs > 0) await (window as any).ether.songs.updateById(songs[0].id, { duration_ms: durMs });
              } catch {}
            }
            const durMin = durMs > 0
              ? Math.round((durMs / 60000) * 100) / 100
              : 3.5; // safe fallback
            return { ...s, song_title: songs[0].title, song_artist: songs[0].artist_name, duration_min: durMin };
          }
        } catch {}
      }
      return s;
    }));
    setSlots(enriched);
  };

  const loadBreaks = async (clockId: number) => {
    if (!isReady) return;
    const res = await (window as any).ether.clockBreaks.list(stationId, { clockId });
    setBreaks(((res?.rows) || []).map((r: any) => ({ id: r.id, uuid: r.uuid, minute: r.minute, spot_category_id: r.spot_category_id, count: r.count })));
  };

  // spotCatsProp in the deps: hosted, the Spots pane owns category CRUD, and its writes reach the
  // store — but the per-break "0 eligible spots" warning is computed HERE, from the spots table. Its
  // whole job is to be true (v4.4.83), so it re-checks whenever the store's category list changes.
  // Unhosted the prop is a stable undefined, so the tabbed view re-fetches exactly as before.
  useEffect(() => { if (hosted) { loadSpotCats(); } else { loadAll(); } }, [isReady, stationId, hosted, spotCatsProp]);
  useEffect(() => { if (selected) { loadSlots(selected); loadBreaks(selected); } else { setSlots([]); setBreaks([]); } }, [selected]);

  // ── Timed spot breaks (per clock; the generator reads clock_breaks) ──
  const flashSaved = () => { setBreaksSaved(true); setTimeout(() => setBreaksSaved(false), 1400); };
  const addBreak = async () => {
    if (!selected) return;
    await (window as any).ether.clockBreaks.create({ station_id: stationId, clock_id: selected, minute: 0, spot_category_id: spotCats[0]?.id ?? null, count: 1 });
    await loadBreaks(selected); flashSaved();
  };
  const updateBreak = async (id: number, patch: Partial<{ minute: number; spot_category_id: number | null; count: number }>) => {
    setBreaks(prev => prev.map(b => b.id === id ? { ...b, ...patch } : b)); // optimistic
    await (window as any).ether.clockBreaks.updateById(id, patch); flashSaved();
  };
  const removeBreak = async (b: { uuid: string }) => {
    await (window as any).ether.clockBreaks.delete(b.uuid, stationId);
    if (selected) await loadBreaks(selected); flashSaved();
  };

  const createClock = async () => {
    if (!newName.trim()) return;
    const res = await (window as any).ether.clocks.create({ station_id: stationId, name: newName.trim() });
    setNewName(""); loadAll(); setSelected(res.row.id);
  };

  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const deleteClock = async (id: number) => {
    try {
      await (window as any).ether.shows.clearClockReference(id, stationId);
      await (window as any).ether.clockSlots.clearByClockId(id, stationId);
      await (window as any).ether.clocks.deleteById(id);
      if (selected === id) { setSelected(null); setSlots([]); }
      setConfirmDelete(null);
      loadAll();
    } catch (e) {
      console.error("Delete clock failed:", e);
    }
  };

  const handleAdd = async (type: string, catId: number | null, durationMin: number, label: string, spotCatId: number | null = null) => {
    if (!selected) return;
    let dur = durationMin;
    if (type === "music" && catId) {
      try {
        const avg = await queryScoped<{ d: number }>(
          "SELECT AVG(duration_ms)/60000.0 as d FROM songs WHERE category_id=? AND duration_ms > 0",
          [catId], stationId
        );
        if (avg[0]?.d && avg[0].d > 0) dur = Math.round(avg[0].d * 100) / 100;
      } catch {}
    }
    await (window as any).ether.clockSlots.create({
      station_id: stationId, clock_id: selected, position: slots.length,
      slot_type: type, category_id: catId, spot_category_id: spotCatId, duration_min: dur, label,
    });
    setShowPicker(false);
    loadSlots(selected);
  };

  const removeSlot = async (id: number) => {
    await (window as any).ether.clockSlots.deleteById(id);
    if (selected) loadSlots(selected);
  };

  const duplicateSlot = async (s: ClockSlot) => {
    if (!selected) return;
    await (window as any).ether.clockSlots.create({
      station_id: stationId, clock_id: selected, position: slots.length,
      slot_type: s.slot_type, category_id: s.category_id, spot_category_id: s.spot_category_id ?? null, duration_min: s.duration_min, label: s.label,
    });
    loadSlots(selected);
  };

  const changeSlotType = async (id: number, type: string) => {
    await (window as any).ether.clockSlots.updateById(id, { slot_type: type });
    setEditCell(null);
    if (selected) loadSlots(selected);
  };

  const changeSpotCategory = async (id: number, spotCatId: number | null) => {
    await (window as any).ether.clockSlots.updateById(id, { spot_category_id: spotCatId });
    setEditCell(null);
    if (selected) loadSlots(selected);
  };

  const changeSlotCat = async (id: number, catId: number | null) => {
    await (window as any).ether.clockSlots.updateById(id, { category_id: catId });
    setEditCell(null);
    if (selected) loadSlots(selected);
  };

  // Pin a slot to ONE specific element by its cart # (or clear the pin). The generator then
  // places that exact song/jingle/talk break here instead of a random category pick.
  const pinSlotByCart = async (id: number) => {
    const cur = slots.find(s => s.id === id);
    const input = window.prompt("Pin this slot to a Cart # (blank to clear):", cur?.cart_id || "");
    if (input === null) return;
    const cart = input.trim();
    if (!cart) {
      await (window as any).ether.clockSlots.updateById(id, { song_id: null });
      if (selected) loadSlots(selected);
      return;
    }
    const rows = await queryScoped<{ id: number; title: string }>(
      "SELECT id, title FROM songs WHERE cart_id = ? AND deleted_at IS NULL LIMIT 1",
      [cart], stationId, { skipScoping: true }
    );
    if (!rows.length) { alert(`No library element has Cart #${cart}.`); return; }
    await (window as any).ether.clockSlots.updateById(id, { song_id: rows[0].id, label: rows[0].title });
    if (selected) loadSlots(selected);
  };

  const toggleChain = async (id: number, current: string) => {
    const next = current === "stop" ? "segue" : "stop";
    await (window as any).ether.clockSlots.updateById(id, { chain_type: next });
    if (selected) loadSlots(selected);
  };

  // ── Keyboard copy/paste ───────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "c") {
        const slot = slots.find(s => s.id === selectedSlotId);
        if (slot) { setCopiedSlot(slot); }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "v") {
        if (copiedSlot && selected) {
          (window as any).ether.clockSlots.create({
            station_id: stationId, clock_id: selected, position: slots.length,
            slot_type: copiedSlot.slot_type, category_id: copiedSlot.category_id, spot_category_id: copiedSlot.spot_category_id ?? null,
            duration_min: copiedSlot.duration_min, label: copiedSlot.label,
          }).then(() => loadSlots(selected));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedSlotId, copiedSlot, slots, selected]);

  // Close inline cell editor when clicking outside an editable cell
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-v1cell]")) setEditCell(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const handleDrop = async () => {
    const from = dragIdx;
    const target = dropTarget;
    setDragIdx(null); setDropTarget(null);
    if (from === null || !target) return;
    // Resolve the hovered row + edge into an insertion index, then account for removing
    // the dragged row first (indices above the removal shift down by one).
    let to = target.edge === "bottom" ? target.idx + 1 : target.idx;
    if (from < to) to -= 1;
    if (to === from) return; // no-op move
    const reordered = [...slots];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    // Optimistic: reflect the new order (and truthful positions) instantly — no DB re-query,
    // which would also re-randomize the music-slot song previews. Persist positions in the
    // background via the existing updateById path; display uses array order, not s.position.
    setSlots(reordered.map((s, i) => ({ ...s, position: i })));
    Promise.all(reordered.map((s, i) => (window as any).ether.clockSlots.updateById(s.id, { position: i })))
      .catch(() => { if (selected) loadSlots(selected); }); // reconcile from DB only if a write failed
  };

  // Compute cumulative clock positions
  const positions: number[] = [];
  let cum = 0;
  slots.forEach(s => { positions.push(cum); cum += s.duration_min; });
  const totalMin = cum;
  const remaining = Math.max(0, 60 - totalMin);
  const overrun = totalMin > 60;

  // Color per slot type
  const slotColor = (s: ClockSlot) => {
    if (s.slot_type === "music") return s.category_color || "var(--accent-blue)";
    return CLOCK_SLOT_TYPE_OPTIONS.find(o => o.value === s.slot_type)?.color ?? "#94a3b8";
  };

  const typeLabel = (s: ClockSlot) =>
    CLOCK_SLOT_TYPE_OPTIONS.find(o => o.value === s.slot_type)?.label ?? s.slot_type.toUpperCase().slice(0, 5);

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <h2 style={{ fontSize: "var(--t-head)", fontWeight: 800, color: "var(--text-primary)", margin: 0, fontFamily: "'Newsreader', Georgia, serif", letterSpacing: "-0.03em" }}>
            Clocks
          </h2>
          <p style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)", margin: "3px 0 0" }}>
            Build your hour — positions update live as you add segments
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input placeholder="New clock name..." value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && createClock()}
            style={{ padding: "7px 12px", borderRadius: 0, fontSize: "var(--t-body)", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", width: 160 }}
          />
          <button onClick={createClock} style={{ padding: "7px 14px", borderRadius: 0, fontSize: "var(--t-body)", fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
            Create
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16 }}>

        {/* Clock list sidebar */}
        <div style={{ width: 160, flexShrink: 0 }}>
          <div style={{ fontSize: "var(--t-micro)", fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", marginBottom: 8 }}>SAVED CLOCKS</div>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 3 }}>
            {clocks.map(c => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                {confirmDelete === c.id ? (
                  // Inline confirm row
                  <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 0, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)" }}>
                    <span style={{ fontSize: "var(--t-micro)", color: "#ef4444", flex: 1 }}>Delete?</span>
                    <button onClick={() => deleteClock(c.id)} style={{ fontSize: "var(--t-micro)", fontWeight: 700, color: "#ef4444", background: "none", border: "none", cursor: "pointer", padding: "1px 4px" }}>Yes</button>
                    <button onClick={() => setConfirmDelete(null)} style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: "1px 4px" }}>No</button>
                  </div>
                ) : (
                  <>
                    <button onClick={() => setSelected(c.id)} style={{
                      flex: 1, padding: "7px 10px", borderRadius: 0, fontSize: "var(--t-body)",
                      fontWeight: selected === c.id ? 700 : 400, textAlign: "left" as const, cursor: "pointer",
                      background: selected === c.id ? "rgb(from var(--accent-blue) r g b / 0.12)" : "var(--bg-secondary)",
                      border: selected === c.id ? "1px solid rgb(from var(--accent-blue) r g b / 0.3)"
                            // Context link: this clock uses the category selected in the Categories
                            // pane. Amber, so it reads as "related to your selection" rather than
                            // competing with the blue current-selection state.
                            : highlightClockIds?.includes(c.id) ? "1px solid var(--accent-amber)"
                            : "1px solid var(--border-primary)",
                      color: selected === c.id ? "var(--accent-blue)" : "var(--text-secondary)",
                    }}>
                      {c.name}
                      {advisor?.[c.id] && advisor[c.id].rows.length > 0 && (
                        <span style={{ display: "block", marginTop: 3, fontSize: "var(--t-micro)", fontFamily: "'DM Mono', monospace", color: "var(--accent-amber)", fontWeight: 400 }}>
                          {advisor[c.id].rows.slice(0, 2).map(r =>
                            `${r.category} target ${r.target}/hr, ${r.unused ? "not in clock" : r.slots + " slots"} — ${r.delta < 0 ? "under" : "over"} by ${Math.abs(r.delta)}`
                          ).join(" · ")}
                          {advisor[c.id].rows.length > 2 ? ` · +${advisor[c.id].rows.length - 2} more` : ""}
                        </span>
                      )}
                    </button>
                    <button onClick={() => setConfirmDelete(c.id)} style={{ padding: "5px 6px", background: "transparent", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: "var(--t-body)" }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
                    >✕</button>
                  </>
                )}
              </div>
            ))}
            {clocks.length === 0 && <div style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)", fontStyle: "italic", padding: "6px 4px" }}>No clocks yet</div>}
          </div>
        </div>

        {/* Main area */}
        {selected ? (
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" as const }}>

            {/* Time bar */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, padding: "7px 12px", background: "var(--bg-secondary)", borderRadius: 0, border: "1px solid var(--border-primary)" }}>
              <div style={{ flex: 1, height: 5, background: "var(--bg-tertiary)", borderRadius: 0, overflow: "hidden" }}>
                <div style={{ height: "100%", width: Math.min(totalMin/60*100, 100)+"%", background: overrun ? "#ef4444" : totalMin >= 55 ? "#34d399" : "var(--accent-blue)", borderRadius: 0, transition: "width 0.2s" }} />
              </div>
              <span style={{ fontSize: "var(--t-small)", fontWeight: 700, color: "var(--text-primary)", fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" as const }}>
                {totalMin.toFixed(1)} / 60 min
              </span>
              <span style={{ fontSize: "var(--t-micro)", color: overrun ? "#ef4444" : remaining < 1 ? "#34d399" : "var(--text-tertiary)", whiteSpace: "nowrap" as const }}>
                {overrun ? `+${(totalMin-60).toFixed(1)}m over` : remaining < 0.1 ? "Hour full ✓" : remaining.toFixed(1)+"m left"}
              </span>
              {copiedSlot && (
                <span style={{ fontSize: "var(--t-micro)", color: "#a78bfa", whiteSpace: "nowrap" as const }}>
                  ⎘ "{copiedSlot.label}" copied — Ctrl+V to paste
                </span>
              )}
            </div>

            {/* ── Spreadsheet table ── */}
            <div style={{ border: "1px solid var(--border-primary)", borderRadius: 0, overflow: "hidden", marginBottom: 8, order: 3 }}>

              {/* Column headers */}
              <div style={{
                display: "grid", gridTemplateColumns: "24px 52px 28px 68px 88px 1fr 1fr 60px 52px 52px",
                padding: "5px 10px", background: "var(--bg-tertiary)",
                borderBottom: "1px solid var(--border-primary)",
                fontSize: "var(--t-micro)", fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-secondary)",
                textTransform: "uppercase" as const,
              }}>
                <span></span>
                <span>POSITION</span>
                <span>#</span>
                <span>TYPE</span>
                <span>CATEGORY</span>
                <span>TITLE</span>
                <span>ARTIST</span>
                <span>CHAIN</span>
                <span style={{ textAlign: "right" as const }}>DURATION</span>
                <span></span>
              </div>

              {/* Rows */}
              <div style={{ maxHeight: 480, overflowY: "auto" as const }}>
                {slots.map((s, i) => {
                  const isSelected  = selectedSlotId === s.id;
                  const isEditType  = editCell?.slotId === s.id && editCell.field === "type";
                  const isEditCat   = editCell?.slotId === s.id && editCell.field === "cat";
                  const chainType   = s.chain_type || "segue";
                  const isDropTop = dropTarget?.idx === i && dropTarget.edge === "top";
                  const isDropBot = dropTarget?.idx === i && dropTarget.edge === "bottom";
                  return (
                  <div
                    key={s.id}
                    draggable
                    onClick={() => setSelectedSlotId(isSelected ? null : s.id)}
                    onDragStart={e => { e.dataTransfer.effectAllowed = "move"; setDragIdx(i); }}
                    onDragOver={e => {
                      e.preventDefault();
                      if (dragIdx === null) return;
                      const r = e.currentTarget.getBoundingClientRect();
                      const edge: "top" | "bottom" = (e.clientY - r.top) < r.height / 2 ? "top" : "bottom";
                      // Guard: only re-render when the drop target actually changes.
                      setDropTarget(prev => (prev && prev.idx === i && prev.edge === edge) ? prev : { idx: i, edge });
                    }}
                    onDragEnter={e => e.preventDefault()}
                    onDrop={e => { e.preventDefault(); handleDrop(); }}
                    onDragEnd={() => { setDragIdx(null); setDropTarget(null); }}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "24px 52px 28px 68px 88px 1fr 1fr 60px 52px 52px",
                      padding: "6px 10px",
                      minHeight: 44,
                      alignItems: "center",
                      cursor: "grab",
                      background: isSelected
                        ? "rgba(167,139,250,0.12)"
                        : i % 2 === 0 ? "var(--bg-secondary)" : "rgba(255,255,255,0.01)",
                      borderBottom: "1px solid rgba(255,255,255,0.03)",
                      borderLeft: `3px solid ${isSelected ? "#a78bfa" : slotColor(s)}`,
                      outline: isSelected ? "1px solid rgba(167,139,250,0.3)" : "none",
                      // Drop-position divider: crisp accent line at the edge the slot will land on.
                      boxShadow: isDropTop
                        ? "inset 0 3px 0 0 var(--accent-blue)"
                        : isDropBot
                        ? "inset 0 -3px 0 0 var(--accent-blue)"
                        : "none",
                      opacity: dragIdx === i ? 0.4 : 1,
                      transition: "background 0.1s",
                    }}
                  >
                    {/* Grip */}
                    <svg width="8" height="10" viewBox="0 0 8 10" fill="var(--text-tertiary)" style={{ opacity: 0.3 }}>
                      <circle cx="2" cy="2" r="1.1"/><circle cx="6" cy="2" r="1.1"/>
                      <circle cx="2" cy="5" r="1.1"/><circle cx="6" cy="5" r="1.1"/>
                      <circle cx="2" cy="8" r="1.1"/><circle cx="6" cy="8" r="1.1"/>
                    </svg>

                    {/* Clock position */}
                    <span style={{ fontSize: "var(--t-micro)", fontFamily: "'DM Mono', monospace", color: "var(--text-secondary)", letterSpacing: "0.03em", fontWeight: 600 }}>
                      {fmtClockPos(positions[i])}
                    </span>

                    {/* Row number */}
                    <span style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", fontWeight: 600 }}>{i + 1}</span>

                    {/* TYPE — double-click to edit */}
                    <div data-v1cell="1" style={{ paddingRight: 6 }}>
                      {isEditType ? (
                        <select
                          autoFocus
                          value={s.slot_type}
                          onChange={e => changeSlotType(s.id, e.target.value)}
                          onBlur={() => setEditCell(null)}
                          onClick={e => e.stopPropagation()}
                          style={{ fontSize: "var(--t-small)", width: "100%", background: "var(--bg-tertiary)", border: "1px solid var(--accent-blue)", color: "var(--text-primary)", outline: "none", padding: "2px 3px" }}
                        >
                          {CLOCK_SLOT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : (
                        <span
                          onDoubleClick={e => { e.stopPropagation(); setEditCell({ slotId: s.id, field: "type" }); }}
                          title="Double-click to change type"
                          style={{
                            display: "inline-block", fontSize: "var(--t-micro)", fontWeight: 800, letterSpacing: "0.07em",
                            padding: "2px 5px", borderRadius: 0, whiteSpace: "nowrap" as const,
                            background: slotColor(s) + "20", color: slotColor(s),
                            cursor: "text", userSelect: "none" as const,
                          }}
                        >{typeLabel(s)}</span>
                      )}
                    </div>

                    {/* CATEGORY — double-click to edit (music rows only) */}
                    <div data-v1cell="1" style={{ paddingRight: 6, overflow: "hidden" }}>
                      {s.slot_type === "music" ? (
                        isEditCat ? (
                          <select
                            autoFocus
                            value={s.category_id ?? ""}
                            onChange={e => changeSlotCat(s.id, e.target.value ? Number(e.target.value) : null)}
                            onBlur={() => setEditCell(null)}
                            onClick={e => e.stopPropagation()}
                            style={{ fontSize: "var(--t-small)", width: "100%", background: "var(--bg-tertiary)", border: "1px solid var(--accent-blue)", color: "var(--text-primary)", outline: "none", padding: "2px 3px" }}
                          >
                            <option value="">— none —</option>
                            {cats.map(c => <option key={c.id} value={c.id}>{c.code}{c.name ? ` — ${c.name}` : ""}</option>)}
                          </select>
                        ) : (
                          <span
                            onDoubleClick={e => { e.stopPropagation(); setEditCell({ slotId: s.id, field: "cat" }); }}
                            title="Double-click to change category"
                            style={{
                              fontSize: "var(--t-small)", fontWeight: 700, cursor: "text", userSelect: "none" as const,
                              color: s.category_color || "var(--text-secondary)",
                              display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
                            }}
                          >{s.category_code || "—"}</span>
                        )
                      ) : s.slot_type === "spot_break" ? (
                        // Spot slot: category is a permanently-visible dropdown (no double-click needed).
                        <select
                          value={s.spot_category_id ?? ""}
                          onChange={e => changeSpotCategory(s.id, e.target.value ? Number(e.target.value) : null)}
                          onClick={e => e.stopPropagation()}
                          title="Choose which spot category airs here"
                          style={{
                            fontSize: "var(--t-small)", width: "100%", background: "var(--bg-tertiary)",
                            border: "1px solid " + (s.spot_category_id ? ((s.spot_category_color || "#ef4444") + "88") : "var(--border-secondary)"),
                            color: s.spot_category_id ? (s.spot_category_color || "#ef4444") : "var(--text-tertiary)",
                            outline: "none", padding: "2px 3px", cursor: "pointer", fontWeight: 700,
                          }}
                        >
                          <option value="">Any spot</option>
                          {spotCats.map(sc => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
                        </select>
                      ) : (
                        <span style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)" }}>—</span>
                      )}
                    </div>

                    {/* Title */}
                    <span style={{ fontSize: "var(--t-body)", fontWeight: 600,
                      color: s.slot_type === "music" ? "var(--text-primary)" : slotColor(s),
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
                      paddingRight: 8,
                    }}>
                      {s.song_title || s.label || typeLabel(s)}
                    </span>

                    {/* Artist */}
                    <span style={{ fontSize: "var(--t-small)", fontWeight: 500, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, paddingRight: 8 }}>
                      {s.song_artist || ""}
                    </span>

                    {/* Chain type — click to toggle segue/stop */}
                    <button
                      onClick={async e => { e.stopPropagation(); await toggleChain(s.id, chainType); }}
                      title={chainType === "stop" ? "Stop — click to set Segue" : "Segue — click to set Stop"}
                      style={{
                        fontSize: "var(--t-micro)", fontWeight: 800, letterSpacing: "0.06em", padding: "2px 5px",
                        borderRadius: 0, cursor: "pointer", border: "none",
                        background: chainType === "stop" ? "rgba(239,68,68,0.15)" : "rgb(from var(--accent-blue) r g b / 0.08)",
                        color: chainType === "stop" ? "#ef4444" : "#64748b",
                        fontFamily: "'DM Mono', monospace",
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "0.7"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
                    >
                      {chainType === "stop" ? "STP" : "SEG"}
                    </button>

                    {/* Duration — editable when selected */}
                    {isSelected ? (
                      <input
                        type="number" min="0.08" step="0.25"
                        defaultValue={s.duration_min}
                        onClick={e => e.stopPropagation()}
                        onBlur={async e => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val) && val > 0 && val !== s.duration_min) {
                            await (window as any).ether.clockSlots.updateById(s.id, { duration_min: val });
                            if (selected) loadSlots(selected);
                          }
                        }}
                        onKeyDown={async e => {
                          if (e.key === "Enter") {
                            const val = parseFloat((e.target as HTMLInputElement).value);
                            if (!isNaN(val) && val > 0) {
                              await (window as any).ether.clockSlots.updateById(s.id, { duration_min: val });
                              if (selected) loadSlots(selected);
                            }
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                        style={{ width: 48, padding: "2px 5px", borderRadius: 0, fontSize: "var(--t-small)", textAlign: "right" as const, background: "var(--bg-tertiary)", border: "1px solid #a78bfa", color: "var(--text-primary)", outline: "none", fontFamily: "'DM Mono', monospace", fontWeight: 700 }}
                      />
                    ) : (
                      <span style={{ fontSize: "var(--t-small)", fontFamily: "'DM Mono', monospace", fontWeight: 600, color: "var(--text-secondary)", textAlign: "right" as const }}>
                        {s.duration_min < 1 ? Math.round(s.duration_min * 60) + "s" : s.duration_min.toFixed(1) + "m"}
                      </span>
                    )}

                    {/* Actions */}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 2 }}>
                      <button onClick={() => pinSlotByCart(s.id)} style={{ background: "none", border: "none", color: s.song_id ? "var(--accent-cyan)" : "var(--text-tertiary)", cursor: "pointer", fontSize: "var(--t-small)", padding: "2px 4px" }}
                        title={s.song_id ? `Pinned to Cart #${s.cart_id || "?"} — click to change/clear` : "Pin a specific element by Cart #"}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--accent-cyan)"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = s.song_id ? "var(--accent-cyan)" : "var(--text-tertiary)"; }}
                      >📌</button>
                      <button onClick={() => duplicateSlot(s)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: "var(--t-small)", padding: "2px 4px" }}
                        title="Duplicate slot"
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#34d399"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
                      >⎘</button>
                      <button onClick={() => removeSlot(s.id)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: "var(--t-small)", padding: "2px 4px" }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
                      >✕</button>
                    </div>
                  </div>
                );})}

                {slots.length === 0 && (
                  <div style={{ padding: "28px 16px", textAlign: "center" as const, color: "var(--text-tertiary)", fontSize: "var(--t-body)", fontStyle: "italic" }}>
                    Clock is empty — click "+ Add Segment" to start building your hour
                  </div>
                )}
              </div>

              {/* Footer row — end of hour */}
              {slots.length > 0 && (
                <div style={{
                  display: "grid", gridTemplateColumns: "24px 52px 28px 68px 88px 1fr 1fr 60px 52px 52px",
                  padding: "5px 10px", background: "var(--bg-tertiary)",
                  borderTop: "1px solid var(--border-primary)",
                  fontSize: "var(--t-micro)", color: overrun ? "#ef4444" : "#34d399",
                  fontFamily: "'DM Mono', monospace", fontWeight: 700,
                }}>
                  <span></span>
                  <span>{fmtClockPos(totalMin)}</span>
                  <span></span><span></span><span></span>
                  <span style={{ color: "var(--text-tertiary)", fontFamily: "'Inter', sans-serif", fontWeight: 400 }}>
                    {overrun ? `⚠ ${(totalMin-60).toFixed(1)}m over — remove segments` : remaining < 0.1 ? "✓ Hour complete" : `${remaining.toFixed(1)} min remaining`}
                  </span>
                  <span></span><span></span>
                  <span style={{ textAlign: "right" as const }}>{totalMin.toFixed(1)}m</span>
                  <span></span>
                </div>
              )}
            </div>

            {/* Quick-add category bar — pinned to the top (order:1 + sticky) so it never gets pushed below a long clock */}
            <div style={{ marginBottom: 8, order: 1, position: "sticky" as const, top: 0, zIndex: 5, background: "var(--bg-primary)", paddingTop: 4 }}>
              <div style={{ fontSize: "var(--t-micro)", fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-tertiary)", marginBottom: 5 }}>
                QUICK ADD
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as const }}>
                {cats.map(cat => (
                  <button
                    key={cat.id}
                    onClick={() => handleAdd("music", cat.id, 3.5, cat.name || cat.code)}
                    title={cat.name}
                    style={{
                      padding: "5px 10px", borderRadius: 0, fontSize: "var(--t-small)", fontWeight: 800,
                      cursor: "pointer", letterSpacing: "0.05em",
                      background: (cat.color || "#444") + "22",
                      border: "1px solid " + (cat.color || "#444") + "55",
                      color: cat.color || "#fff",
                      transition: "all 0.1s",
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLElement).style.background = (cat.color || "#444") + "44";
                      (e.currentTarget as HTMLElement).style.borderColor = (cat.color || "#444") + "99";
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLElement).style.background = (cat.color || "#444") + "22";
                      (e.currentTarget as HTMLElement).style.borderColor = (cat.color || "#444") + "55";
                    }}
                  >
                    {cat.code}
                  </button>
                ))}
                <div style={{ position: "relative" as const }}>
                  <button
                    onClick={() => { setShowSpotPicker(p => !p); setShowTalkPicker(false); setShowPicker(false); }}
                    style={{ padding: "5px 10px", borderRadius: 0, fontSize: "var(--t-small)", fontWeight: 800, cursor: "pointer", background: showSpotPicker ? "rgba(239,68,68,0.3)" : "rgba(239,68,68,0.12)", border: `1px solid ${showSpotPicker ? "rgba(239,68,68,0.6)" : "rgba(239,68,68,0.3)"}`, color: "#ef4444" }}
                  >
                    Spots
                  </button>
                  {showSpotPicker && (
                    <div style={{ position: "absolute" as const, top: "calc(100% + 6px)", left: 0, zIndex: 200, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: 12, minWidth: 240, boxShadow: "var(--e-float)" }}>
                      <div style={{ fontSize: "var(--t-micro)", fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", marginBottom: 8 }}>SPOTS — PICK CATEGORY</div>
                      {spotCats.length === 0 ? (
                        <span style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)" }}>Create a spot category in Spots &amp; Promos first.</span>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 5 }}>
                          {spotCats.map(sc => (
                            <button key={sc.id} onClick={() => { handleAdd("spot_break", null, 2, "Spots", sc.id); setShowSpotPicker(false); }} style={{
                              padding: "5px 10px", borderRadius: 0, fontSize: "var(--t-small)", fontWeight: 700, cursor: "pointer",
                              background: (sc.color || "#ef4444") + "22", border: "1px solid " + (sc.color || "#ef4444") + "55", color: sc.color || "#fca5a5",
                            }}>{sc.name}</button>
                          ))}
                          <button onClick={() => { handleAdd("spot_break", null, 2, "Spots", null); setShowSpotPicker(false); }} style={{
                            padding: "5px 10px", borderRadius: 0, fontSize: "var(--t-small)", fontWeight: 700, cursor: "pointer",
                            background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", color: "var(--text-secondary)",
                          }}>Any spot</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div style={{ position: "relative" as const }}>
                  <button
                    onClick={() => { setShowTalkPicker(p => !p); setShowSpotPicker(false); setShowPicker(false); }}
                    style={{ padding: "5px 10px", borderRadius: 0, fontSize: "var(--t-small)", fontWeight: 800, cursor: "pointer", background: showTalkPicker ? "rgba(167,139,250,0.3)" : "rgba(167,139,250,0.12)", border: `1px solid ${showTalkPicker ? "rgba(167,139,250,0.6)" : "rgba(167,139,250,0.3)"}`, color: "#a78bfa" }}
                  >
                    TALK
                  </button>
                  {showTalkPicker && (
                    <div style={{ position: "absolute" as const, top: "calc(100% + 6px)", left: 0, zIndex: 200, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: 12, minWidth: 320, boxShadow: "var(--e-float)" }}>
                      <div style={{ fontSize: "var(--t-micro)", fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", marginBottom: 8 }}>TALK BREAK DURATION</div>
                      <TalkPicker
                        onAdd={(type, catId, dur, label) => { handleAdd(type, catId, dur, label); setShowTalkPicker(false); }}
                        onBack={() => setShowTalkPicker(false)}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Add segment — kept with Quick Add at the top */}
            <div style={{ position: "relative" as const, order: 2 }}>
              {showPicker && (
                <SegmentPicker cats={cats} spotCats={spotCats} onAdd={handleAdd} onClose={() => setShowPicker(false)} />
              )}
              <button
                onClick={() => { setShowPicker(p => !p); if (!showPicker) loadAll(); }}
                style={{
                  width: "100%", padding: "9px", borderRadius: 0, fontSize: "var(--t-body)", fontWeight: 700,
                  background: showPicker ? "rgb(from var(--accent-blue) r g b / 0.1)" : "var(--bg-secondary)",
                  border: "1px dashed " + (showPicker ? "var(--accent-blue)" : "var(--border-secondary)"),
                  color: showPicker ? "var(--accent-blue)" : "var(--text-tertiary)", cursor: "pointer",
                }}
              >
                {showPicker ? "✕ Cancel" : "+ More Options"}
              </button>
            </div>

            {/* ── Spots row: categories + timed breaks, side by side (stack on narrow) ── */}
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 16, marginTop: 16, alignItems: "flex-start", order: 4 }}>

              {/* Spot Categories — HIDDEN in the docking shell, where the Spots pane owns them.
                  Kept in the tabbed view and v1's fixed workspace, neither of which has a Spots
                  pane to send you to. Spots cramping the clock grid is why they moved. */}
              {!hideSpotCategories && (<>
              {/* Spot Categories (per station) — managed here so categories + breaks work together */}
              <div style={{ flex: "1 1 340px", minWidth: 0, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: 16 }}>
                <div style={{ fontSize: "var(--t-lead)", fontWeight: 700, color: "var(--text-primary)", marginBottom: 3, fontFamily: "'Newsreader', Georgia, serif" }}>Spot Categories</div>
                <div style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)", marginBottom: 12 }}>Group your spots (e.g. Local Sponsors, Top-of-Hour IDs) — a timed break pulls from one. Also editable in Spots &amp; Promos.</div>
                {spotCats.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column" as const, marginBottom: 12 }}>
                    {spotCats.map((c, i) => (
                      <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: i < spotCats.length - 1 ? "1px solid var(--border-primary)" : "none" }}>
                        {editSpotCat?.id === c.id ? (
                          <>
                            <input type="color" value={editSpotCat.color} onChange={e => setEditSpotCat({ ...editSpotCat, color: e.target.value })} style={{ width: 24, height: 24, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", cursor: "pointer", padding: 0, flexShrink: 0 }} />
                            <input value={editSpotCat.name} autoFocus onChange={e => setEditSpotCat({ ...editSpotCat, name: e.target.value })} onKeyDown={e => { if (e.key === "Enter") saveSpotCat(); if (e.key === "Escape") setEditSpotCat(null); }}
                              style={{ flex: 1, minWidth: 0, padding: "5px 8px", borderRadius: 0, fontSize: "var(--t-body)", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
                            <button onClick={saveSpotCat} style={{ padding: "4px 10px", fontSize: "var(--t-small)", fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Save</button>
                            <button onClick={() => setEditSpotCat(null)} style={{ padding: "4px 8px", fontSize: "var(--t-small)", fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <span style={{ width: 12, height: 12, background: c.color || "var(--accent-blue)", flexShrink: 0 }} />
                            <span style={{ flex: 1, minWidth: 0, fontSize: "var(--t-body)", fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{c.name}</span>
                            <span style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>{spotCatCounts[c.id] || 0} spots</span>
                            <button onClick={() => setEditSpotCat({ id: c.id, name: c.name, color: c.color || "#8868D8" })} style={{ padding: "3px 8px", fontSize: "var(--t-micro)", fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer", flexShrink: 0 }}>Rename</button>
                            <button onClick={() => removeSpotCat(c)} title="Delete category" style={{ padding: "3px 7px", fontSize: "var(--t-micro)", fontWeight: 700, background: "transparent", color: "var(--text-tertiary)", border: "none", cursor: "pointer", flexShrink: 0 }}>✕</button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="color" value={newSpotCatColor} onChange={e => setNewSpotCatColor(e.target.value)} title="Category color" style={{ width: 28, height: 28, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", cursor: "pointer", padding: 0, flexShrink: 0 }} />
                  <input placeholder="New category…" value={newSpotCatName} onChange={e => setNewSpotCatName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addSpotCat(); }}
                    style={{ flex: 1, minWidth: 0, padding: "6px 10px", borderRadius: 0, fontSize: "var(--t-body)", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
                  <button onClick={addSpotCat} style={{ padding: "6px 12px", fontSize: "var(--t-body)", fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", flexShrink: 0 }}>Add</button>
                </div>
              </div>
              </>)}

              {/* Timed Spot Breaks (per clock) — anchor spots to a minute; music fills around them */}
              <div style={{ flex: "1 1 340px", minWidth: 0, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                <div style={{ fontSize: "var(--t-lead)", fontWeight: 700, color: "var(--text-primary)", fontFamily: "'Newsreader', Georgia, serif" }}>Timed Spot Breaks</div>
                <span style={{ fontSize: "var(--t-micro)", fontWeight: 700, fontFamily: "'DM Mono', monospace", color: "var(--accent-green)", opacity: breaksSaved ? 1 : 0, transition: "opacity 0.2s" }}>✓ Saved</span>
              </div>
              <div style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)", marginBottom: 12 }}>
                Air spots at set minutes past the hour on this clock — music fills around them. :00 = exact top of hour; other minutes land at the nearest song boundary (a song is never cut). Empty = no timed breaks (this clock plays its slots in order). Changes save automatically — <strong style={{ color: "var(--text-secondary)" }}>Generate in the Calendar</strong> to air them.
              </div>
              {breaks.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 8, marginBottom: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 90px 34px", gap: 8, fontSize: "var(--t-micro)", fontWeight: 800, color: "var(--text-tertiary)", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>
                    <span>Min past hr</span><span>Spot category</span><span>Spots</span><span></span>
                  </div>
                  {breaks.map(b => {
                    // Foreign = the break points at a category id that isn't one of THIS station's spot
                    // categories (e.g. a stale id left by the per-station category split). Eligible = spots
                    // Generate could actually place here; 0 → this break airs nothing.
                    const foreign = b.spot_category_id != null && !spotCats.some(sc => sc.id === b.spot_category_id);
                    const elig = b.spot_category_id == null ? anyEligible : (breakEligible[b.spot_category_id] || 0);
                    return (
                    <div key={b.id}>
                    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 90px 34px", gap: 8, alignItems: "center" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontSize: "var(--t-lead)", color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>:</span>
                        <input type="text" inputMode="numeric" value={String(b.minute)}
                          onFocus={e => e.currentTarget.select()}
                          onChange={e => { const n = parseInt(e.target.value.replace(/\D/g, ''), 10); updateBreak(b.id, { minute: isNaN(n) ? 0 : Math.max(0, Math.min(59, n)) }); }}
                          style={{ width: 66, padding: "6px 8px", borderRadius: 0, fontSize: "var(--t-lead)", fontFamily: "'DM Mono', monospace", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", textAlign: "center" as const }} />
                      </div>
                      <select value={foreign ? "" : (b.spot_category_id ?? "")} onChange={e => updateBreak(b.id, { spot_category_id: e.target.value === "" ? null : parseInt(e.target.value, 10) })}
                        style={{ padding: "6px 10px", borderRadius: 0, fontSize: "var(--t-lead)", background: "var(--bg-tertiary)", border: `1px solid ${elig === 0 ? "rgba(251,191,36,0.55)" : "var(--border-primary)"}`, color: b.spot_category_id == null ? "var(--text-tertiary)" : "var(--text-primary)", outline: "none", cursor: "pointer" }}>
                        <option value="">Any spot</option>
                        {spotCats.map(sc => <option key={sc.id} value={sc.id}>{sc.name} ({breakEligible[sc.id] || 0})</option>)}
                      </select>
                      <input type="text" inputMode="numeric" value={String(b.count)}
                        onFocus={e => e.currentTarget.select()}
                        onChange={e => { const n = parseInt(e.target.value.replace(/\D/g, ''), 10); updateBreak(b.id, { count: isNaN(n) ? 1 : Math.max(1, Math.min(10, n)) }); }}
                        style={{ width: 74, padding: "6px 8px", borderRadius: 0, fontSize: "var(--t-lead)", fontFamily: "'DM Mono', monospace", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", textAlign: "center" as const }} />
                      <button onClick={() => removeBreak(b)} title="Remove break" style={{ padding: "6px 9px", fontSize: "var(--t-body)", fontWeight: 700, background: "transparent", color: "var(--text-tertiary)", border: "none", cursor: "pointer" }}>✕</button>
                    </div>
                    {elig === 0 && (
                      <div style={{ marginTop: 3, marginLeft: 118, fontSize: "var(--t-micro)", fontWeight: 700, color: "#fbbf24", letterSpacing: "0.02em" }}>
                        ⚠ 0 eligible spots — this break airs nothing.{" "}
                        {foreign ? "This category belongs to another station — re-pick one below."
                          : b.spot_category_id == null ? "No active spots on this station yet."
                          : "Add or activate a spot in this category (Spots & Promos)."}
                      </div>
                    )}
                    </div>
                    );
                  })}
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button onClick={addBreak} style={{ padding: "7px 14px", borderRadius: 0, fontSize: "var(--t-body)", fontWeight: 700, background: "#ef4444", color: "#fff", border: "none", cursor: "pointer" }}>+ Add break</button>
                {spotCats.length === 0 && <span style={{ fontSize: "var(--t-small)", color: "var(--accent-amber)" }}>Add a spot category first (left) — a break needs one to pull from.</span>}
              </div>
              </div>

            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-tertiary)", fontSize: "var(--t-body)", fontStyle: "italic" }}>
            Select a clock or create a new one
          </div>
        )}
      </div>
    </div>
  );
}


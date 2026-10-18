// THE SURFACE WINDOW — a screen you build yourself (docs/screen-builder-design-2026-10-18.md §2.2, §2.5, §5).
//
// Opened from ☰ → Screens as its own pop-out window ("screen" = a new screen; "screen:<layout uuid>" = a saved one,
// so each saved screen is its own window with its own machine-local position in popout-bounds.json).
//
//   · dockview is the one layout engine (as the Schedule Manager uses it). Every pane is a ModuleFrame: the app's own
//     registered component (src/modules/registry.ts), never a copy.
//   · ONE STATION PER LAYOUT (decision 1): the window takes the active station when it opens and keeps it — every
//     pane is under that one ModuleSurface / StationScope, and a station switch elsewhere does not move it.
//   · EDIT vs LIVE (§2.2): in edit, the palette adds modules and panes can be dragged, split, tabbed, sized and closed;
//     in live, it is locked — no drag, no resize, no close. Nothing a module does is blocked in either mode.
//   · LAYOUTS ARE DATA (decision 3): Save writes a screen_layouts row (screen_layouts:save, synced, station-scoped);
//     Open lists this station's layouts; reopening restores the exact panes, sizes and module options.
//
// Help: docs/help-screen-builder.md.
import { useCallback, useEffect, useRef, useState } from "react";
import { DockviewReact, DockviewDefaultTab } from "dockview-react";
import type { DockviewApi, DockviewReadyEvent, IDockviewPanelProps, IDockviewPanelHeaderProps } from "dockview-react";
import "dockview/dist/styles/dockview.css";
import { useActiveStation, type ScopedStation } from "../hooks/useActiveStation";
import { ModuleSurface, ModuleFrame } from "../modules/ModuleFrame";
import { MODULES, moduleEntry, type ModuleType } from "../modules/registry";
import { buildLayoutDoc, parseLayoutDoc, nextPaneId, PANE_COMPONENT, type PaneSpec } from "../modules/layoutPayload";
import { askText } from "../lib/askText";

/** What dockview renders for every pane: the module the pane's params name, in its frame. */
export function ModulePane(props: IDockviewPanelProps<PaneSpec>) {
  const p = props.params;
  return <ModuleFrame type={p.type as ModuleType} instanceId={p.instanceId} options={p.options} />;
}
const COMPONENTS = { [PANE_COMPONENT]: ModulePane };
/** Live: the tab shows its name and offers no close. */
const LockedTab = (p: IDockviewPanelHeaderProps) => <DockviewDefaultTab {...p} hideClose />;

/** The empty state (doors before rooms): a new screen says what it is and the one action that fills it. */
function EmptyScreen() {
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, color: "var(--text-tertiary)", padding: 24, textAlign: "center" }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-secondary)" }}>An empty screen</div>
      <div style={{ fontSize: 12 }}>Press EDIT, then add Carts, Program Log or Song Library from the bar above.</div>
    </div>
  );
}

export function defaultOptions(type: ModuleType): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const opt of moduleEntry(type).options) o[opt.key] = opt.default;
  return o;
}

const btn = (on = false): React.CSSProperties => ({
  padding: "4px 10px", fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", cursor: "pointer", borderRadius: 0,
  background: on ? "var(--accent-blue)" : "transparent", color: on ? "#fff" : "var(--text-secondary)",
  border: `1px solid ${on ? "var(--accent-blue)" : "var(--border-primary)"}`,
});

export default function ScreenSurface({ layoutUuid }: { layoutUuid?: string | null }) {
  const active = useActiveStation();
  // Taken once, when the window opens: the layout's one station (decision 1).
  const [station] = useState<ScopedStation>(() => ({ id: active.stationId, name: active.stationName, uuid: active.stationUuid }));
  const [layout, setLayout] = useState<{ uuid: string | null; name: string | null }>({ uuid: layoutUuid ?? null, name: null });
  const [editing, setEditing] = useState(!layoutUuid);
  const [status, setStatus] = useState("");
  const [openList, setOpenList] = useState<any[] | null>(null);
  const apiRef = useRef<DockviewApi | null>(null);
  const panesRef = useRef<Record<string, PaneSpec>>({});
  const ether = (window as any).ether;

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    api.onDidRemovePanel(p => { delete panesRef.current[p.id]; });
    if (!layoutUuid) return;
    void (async () => {
      const res = await ether?.invoke?.("screen_layouts:get", layoutUuid, station.id);
      if (!res?.ok || !res.row) { setStatus(res?.error || "That screen is not saved on this station."); return; }
      try {
        const doc = parseLayoutDoc(res.row.payload, MODULES.map(m => m.type));
        panesRef.current = doc.panes;
        api.fromJSON(doc.dockview);
        setLayout({ uuid: res.row.uuid, name: res.row.name });
      } catch (e: any) { setStatus(`Could not open this screen: ${e?.message || e}`); }
    })();
  }, [layoutUuid, station.id, ether]);

  // Live is locked: no drag and drop, no resizing.
  useEffect(() => { try { apiRef.current?.updateOptions({ disableDnd: !editing, locked: !editing } as any); } catch { /* not ready */ } }, [editing]);

  const addModule = (type: ModuleType) => {
    const api = apiRef.current; if (!api) return;
    const entry = moduleEntry(type);
    const present = Object.values(panesRef.current).some(p => p.type === type);
    if (entry.instances === "one" && present) { setStatus(`${entry.title} can be placed once.`); return; }
    const id = nextPaneId(type, Object.keys(panesRef.current));
    const spec: PaneSpec = { type, instanceId: id, options: defaultOptions(type) };
    panesRef.current[id] = spec;
    // A new module opens beside the last one (a split, so every module is visible); drag it to tab or re-split.
    const last = api.panels[api.panels.length - 1];
    api.addPanel({ id, component: PANE_COMPONENT, title: entry.title, params: spec,
      ...(last ? { position: { referencePanel: last.id, direction: "right" as const } } : {}) });
  };

  const save = async () => {
    const api = apiRef.current; if (!api) return;
    const name = layout.name ?? await askText("Name this screen:", "My screen");
    if (!name || !name.trim()) return;
    const doc = buildLayoutDoc(api.toJSON(), panesRef.current);
    const res = await ether?.invoke?.("screen_layouts:save", {
      uuid: layout.uuid ?? undefined, station_id: station.id, station_uuid: station.uuid || null,
      owner_user_uuid: null, name: name.trim(), payload: JSON.stringify(doc),
    });
    if (!res?.ok) { setStatus(`Not saved: ${res?.error || "no answer"}`); return; }
    setLayout({ uuid: res.row.uuid, name: res.row.name });
    setStatus(`Saved “${res.row.name}”.`);
  };

  const showOpen = async () => {
    const res = await ether?.invoke?.("screen_layouts:list", station.id, null);
    if (!res?.ok) { setStatus(`Could not list screens: ${res?.error || "no answer"}`); return; }
    setOpenList(res.rows || []);
  };
  const openWindow = (key: string) => { try { ether?.invoke?.("window:popout", key); } catch { /* not in electron */ } };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg-primary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: "var(--text-primary)" }}>{layout.name ?? "Unsaved screen"}</span>
        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>· {station.name || `station ${station.id}`}</span>
        <button style={btn(editing)} onClick={() => setEditing(e => !e)} title={editing ? "Lock the screen (LIVE)" : "Arrange the screen (EDIT)"}>{editing ? "EDIT" : "LIVE"}</button>
        {editing && MODULES.map(m => (
          <button key={m.type} style={btn()} onClick={() => addModule(m.type)} title={`Add ${m.title}`}>+ {m.title}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button style={btn()} onClick={() => void save()}>SAVE</button>
        <button style={btn()} onClick={() => void showOpen()}>OPEN…</button>
        <button style={btn()} onClick={() => openWindow(`screen:new-${Date.now()}`)}>NEW SCREEN</button>
        {status && <span role="status" style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{status}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <ModuleSurface station={station}>
          <DockviewReact
            className="ether-dock dockview-theme-dark"
            components={COMPONENTS as any}
            onReady={onReady}
            disableDnd={!editing}
            locked={!editing}
            defaultTabComponent={editing ? undefined : LockedTab}
            watermarkComponent={EmptyScreen}
          />
        </ModuleSurface>
      </div>
      {openList && (
        <div onClick={() => setOpenList(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ minWidth: 320, maxHeight: "70vh", overflowY: "auto", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8, color: "var(--text-primary)" }}>Screens on {station.name || `station ${station.id}`}</div>
            {openList.length === 0 && <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No saved screens yet. Build one and press SAVE.</div>}
            {openList.map(r => (
              <button key={r.uuid} style={{ ...btn(), display: "block", width: "100%", textAlign: "left", marginBottom: 4 }}
                onClick={() => { setOpenList(null); openWindow(`screen:${r.uuid}`); }}>{r.name}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useCallback, useRef, useEffect } from "react";
import {
  WidgetInstance, WidgetType, WidgetDefinition,
  WIDGET_REGISTRY, DEFAULT_LAYOUT, GRID_COLS, GRID_ROWS, CELL_SIZE
} from "./WidgetRegistry";
import { query } from "../db/client";
import { useActiveStation } from "../hooks/useActiveStation";

// ── Persistence ───────────────────────────────────────────────

async function saveLayout(widgets: WidgetInstance[], stationId: number) {
  try {
    await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'canvas_layout', JSON.stringify(widgets));
  } catch {}
}

async function loadLayout(): Promise<WidgetInstance[] | null> {
  try {
    const rows = await query<{ value: string }>(
      "SELECT value FROM station_config_kv WHERE key = 'canvas_layout'"
    );
    if (rows.length > 0) return JSON.parse(rows[0].value);
  } catch {}
  return null;
}

// ── Collision detection ───────────────────────────────────────

function overlaps(a: WidgetInstance, b: WidgetInstance): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function isInBounds(w: WidgetInstance): boolean {
  return w.x >= 0 && w.y >= 0 && w.x + w.w <= GRID_COLS && w.y + w.h <= GRID_ROWS;
}

function wouldCollide(candidate: WidgetInstance, others: WidgetInstance[]): boolean {
  return others.some(o => o.id !== candidate.id && overlaps(candidate, o));
}

// ── ID generator ──────────────────────────────────────────────

function genId(type: WidgetType, widgets: WidgetInstance[]): string {
  const existing = widgets.filter(w => w.type === type).length;
  return `${type}-${existing + 1}-${Date.now()}`;
}

// ── Find first free position for a new widget ─────────────────

function findFreePosition(
  w: number, h: number,
  widgets: WidgetInstance[]
): { x: number; y: number } | null {
  for (let y = 0; y <= GRID_ROWS - h; y++) {
    for (let x = 0; x <= GRID_COLS - w; x++) {
      const candidate = { id: "__test__", type: "deck" as WidgetType, x, y, w, h, config: {} };
      if (!wouldCollide(candidate, widgets)) return { x, y };
    }
  }
  return null;
}

// ── Canvas engine hook ────────────────────────────────────────

export interface LayoutProfile {
  id: string;
  name: string;
  widgets: WidgetInstance[];
  updatedAt: number;
}

export interface CanvasEngineState {
  widgets: WidgetInstance[];
  selected: string | null;
  editMode: boolean;
  activeLayoutName: string;
  layouts: LayoutProfile[];
  saveCurrentLayout: (name: string) => Promise<void>;
  loadLayout: (id: string) => void;
  deleteLayout: (id: string) => void;
  renameActive: (name: string) => void;
  addWidget: (type: WidgetType, config?: Record<string, any>) => void;
  removeWidget: (id: string) => void;
  moveWidget: (id: string, x: number, y: number) => void;
  resizeWidget: (id: string, w: number, h: number) => void;
  updateConfig: (id: string, config: Record<string, any>) => void;
  setSelected: (id: string | null) => void;
  setEditMode: (v: boolean) => void;
  resetLayout: () => void;
  getWidget: (id: string) => WidgetInstance | undefined;
  canAdd: (type: WidgetType) => boolean;
}

export function useCanvasEngine(): CanvasEngineState {
  const { stationId } = useActiveStation();
  const [widgets, setWidgets] = useState<WidgetInstance[]>(DEFAULT_LAYOUT);
  const [selected, setSelected] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false); // always starts false — never persisted
  const [loaded, setLoaded] = useState(false);
  const [activeLayoutName, setActiveLayoutName] = useState("Live Assist");
  const [layouts, setLayouts] = useState<LayoutProfile[]>([]);
  const saveTimer = useRef<any>(null);

  // Load saved layouts on mount
  useEffect(() => {
    (async () => {
      // Load active layout — check version to avoid stale layouts
      const LAYOUT_VERSION = "2"; // bump this to force reset on breaking layout changes
      const saved = await loadLayout();
      let versionRows: { value: string }[] = [];
      try { versionRows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'canvas_layout_version'"); } catch {}
      const savedVersion = versionRows[0]?.value;
      if (saved && saved.length > 0 && savedVersion === LAYOUT_VERSION) {
        setWidgets(saved);
      } else {
        // New install or version bump — use default layout and save version
        try { await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'canvas_layout_version', LAYOUT_VERSION); } catch {}
      }
      // Load layout profiles
      try {
        const rows = await query<{ value: string }>(
          "SELECT value FROM station_config_kv WHERE key = 'canvas_profiles'"
        );
        if (rows.length > 0) {
          const profiles = JSON.parse(rows[0].value) as LayoutProfile[];
          setLayouts(profiles);
        }
        // Always start with Live Assist name — user loads custom layouts explicitly
      } catch {}
      setLoaded(true);
    })();
  }, []);

  // Debounced auto-save whenever widgets change
  useEffect(() => {
    if (!loaded) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveLayout(widgets, stationId), 1000);
    return () => clearTimeout(saveTimer.current);
  }, [widgets, loaded]);

  const addWidget = useCallback((type: WidgetType, config: Record<string, any> = {}) => {
    const def = WIDGET_REGISTRY[type];
    setWidgets(prev => {
      // Check if multiple instances are allowed
      if (!def.allowMultiple && prev.some(w => w.type === type)) return prev;

      // For decks, auto-assign the next available slot label
      let finalConfig = { ...config };
      if (type === "deck") {
        const existingDecks = prev.filter(w => w.type === "deck").length;
        finalConfig.deckSlot = existingDecks === 0 ? "A" : existingDecks === 1 ? "B" : "C";
        finalConfig.deckNumber = existingDecks + 1;
      }

      const pos = findFreePosition(def.defaultW, def.defaultH, prev);
      if (!pos) return prev; // no room

      const instance: WidgetInstance = {
        id: genId(type, prev),
        type,
        x: pos.x, y: pos.y,
        w: def.defaultW, h: def.defaultH,
        config: finalConfig,
        label: type === "deck" ? `Deck ${prev.filter(w => w.type === "deck").length + 1}` : def.label,
      };
      return [...prev, instance];
    });
  }, []);

  const removeWidget = useCallback((id: string) => {
    setWidgets(prev => prev.filter(w => w.id !== id));
    setSelected(null);
  }, []);

  const moveWidget = useCallback((id: string, x: number, y: number) => {
    setWidgets(prev => {
      const widget = prev.find(w => w.id === id);
      if (!widget) return prev;
      const updated = { ...widget, x: Math.max(0, Math.min(x, GRID_COLS - widget.w)), y: Math.max(0, Math.min(y, GRID_ROWS - widget.h)) };
      if (!isInBounds(updated)) return prev;
      return prev.map(w => w.id === id ? updated : w);
    });
  }, []);

  const resizeWidget = useCallback((id: string, w: number, h: number) => {
    setWidgets(prev => {
      const widget = prev.find(ww => ww.id === id);
      if (!widget) return prev;
      const def = WIDGET_REGISTRY[widget.type];
      const newW = Math.max(def.minW, Math.min(w, def.maxW || GRID_COLS));
      const newH = Math.max(def.minH, Math.min(h, def.maxH || GRID_ROWS));
      const updated = { ...widget, w: newW, h: newH };
      if (!isInBounds(updated)) return prev;
      return prev.map(ww => ww.id === id ? updated : ww);
    });
  }, []);

  const updateConfig = useCallback((id: string, config: Record<string, any>) => {
    setWidgets(prev => prev.map(w => w.id === id ? { ...w, config: { ...w.config, ...config } } : w));
  }, []);

  const resetLayout = useCallback(() => {
    setWidgets(DEFAULT_LAYOUT);
    setActiveLayoutName("Live Assist");
  }, []);

  const saveCurrentLayout = useCallback(async (name: string) => {
    const profile: LayoutProfile = {
      id: name.toLowerCase().replace(/\s+/g, "-") + "-" + Date.now(),
      name,
      widgets,
      updatedAt: Date.now(),
    };
    setLayouts(prev => {
      const existing = prev.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
      const next = existing >= 0
        ? prev.map((p, i) => i === existing ? profile : p)
        : [...prev, profile];
      (window as any).ether.stationConfigKv.upsertByKey(stationId, 'canvas_profiles', JSON.stringify(next)).catch(() => {});
      return next;
    });
    setActiveLayoutName(name);
    await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'canvas_active_name', name).catch(() => {});
    await saveLayout(widgets, stationId);
  }, [widgets]);

  const loadLayoutProfile = useCallback((id: string) => {
    setLayouts(prev => {
      const profile = prev.find(p => p.id === id);
      if (!profile) return prev;
      setWidgets(profile.widgets);
      setActiveLayoutName(profile.name);
      saveLayout(profile.widgets, stationId).catch(() => {});
      (window as any).ether.stationConfigKv.upsertByKey(stationId, 'canvas_active_name', profile.name).catch(() => {});
      return prev;
    });
  }, []);

  const deleteLayout = useCallback((id: string) => {
    setLayouts(prev => {
      const next = prev.filter(p => p.id !== id);
      (window as any).ether.stationConfigKv.upsertByKey(stationId, 'canvas_profiles', JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const renameActive = useCallback((name: string) => {
    setActiveLayoutName(name);
    (window as any).ether.stationConfigKv.upsertByKey(stationId, 'canvas_active_name', name).catch(() => {});
  }, []);

  const getWidget = useCallback((id: string) => widgets.find(w => w.id === id), [widgets]);

  const canAdd = useCallback((type: WidgetType) => {
    const def = WIDGET_REGISTRY[type];
    if (!def.allowMultiple && widgets.some(w => w.type === type)) return false;
    if (type === "deck" && widgets.filter(w => w.type === "deck").length >= 3) return false;
    return true;
  }, [widgets]);

  return {
    widgets, selected, editMode,
    activeLayoutName, layouts,
    addWidget, removeWidget, moveWidget, resizeWidget,
    updateConfig, setSelected,
    setEditMode, resetLayout, getWidget, canAdd,
    saveCurrentLayout,
    loadLayout: loadLayoutProfile,
    deleteLayout,
    renameActive,
  };
}

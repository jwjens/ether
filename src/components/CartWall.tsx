import { useState, useEffect, useCallback } from "react";
import { query, execute, queryOne } from "../db/client";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";

interface CartSlot {
  id: number;
  slot_number: number;
  title: string | null;
  file_path: string | null;
  color: string;
  hotkey: string | null;
}

const COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#22c55e",
  "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6",
  "#6366f1", "#d946ef", "#0ea5e9", "#84cc16",
];

const DEFAULT_HOTKEYS = [
  "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12",
  "1","2","3","4","5","6","7","8","9","0",
  "Numpad1","Numpad2","Numpad3","Numpad4","Numpad5","Numpad6","Numpad7","Numpad8","Numpad9","Numpad0",
  "","",
];

function titleFromFile(p: string) {
  return (p.split(/[\\/]/).pop() || p).replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
}

export default function CartWall() {
  const [slots, setSlots] = useState<(CartSlot | null)[]>([]);
  const [playing, setPlaying] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [editColor, setEditColor] = useState("#3f3f46");
  const [editTitle, setEditTitle] = useState("");
  const [editHotkey, setEditHotkey] = useState("");
  const audioRefs = new Map<number, HTMLAudioElement>();

  const TOTAL_SLOTS = 32;

  const load = async () => {
    const rows = await query<CartSlot>("SELECT * FROM cart_slots ORDER BY slot_number");
    const grid: (CartSlot | null)[] = [];
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      grid.push(rows.find(r => r.slot_number === i) || null);
    }
    setSlots(grid);
  };
  useEffect(() => { load(); }, []);

  // Fire a cart
  const fireCart = useCallback(async (slotNum: number) => {
    const slot = slots[slotNum];
    if (!slot || !slot.file_path) return;

    // Stop if already playing
    if (playing === slotNum) {
      const el = audioRefs.get(slotNum);
      if (el) { el.pause(); el.currentTime = 0; }
      setPlaying(null);
      return;
    }

    // Stop any playing cart
    if (playing !== null) {
      const el = audioRefs.get(playing);
      if (el) { el.pause(); el.currentTime = 0; }
    }

    try {
      const bytes = await readFile(slot.file_path);
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRefs.set(slotNum, audio);
      audio.onended = () => { setPlaying(null); URL.revokeObjectURL(url); };
      audio.play();
      setPlaying(slotNum);
    } catch (e) {
      console.error("Cart play error:", e);
    }
  }, [slots, playing]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (s && s.hotkey && e.code === s.hotkey) {
          e.preventDefault();
          fireCart(i);
          return;
        }
      }
      // Default F1-F12 mapping for first 12 slots
      if (e.code.startsWith("F") && e.code.length <= 3) {
        const num = parseInt(e.code.substring(1)) - 1;
        if (num >= 0 && num < slots.length && slots[num]) {
          e.preventDefault();
          fireCart(num);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [slots, fireCart]);

  // Assign audio to a slot
  const assignSlot = async (slotNum: number) => {
    const files = await open({
      multiple: false,
      title: "Select audio for Cart " + (slotNum + 1),
      filters: [{ name: "Audio", extensions: ["mp3", "flac", "ogg", "wav", "m4a", "aac"] }]
    });
    if (!files) return;
    const filePath = Array.isArray(files) ? files[0] : files;
    const title = titleFromFile(filePath);
    const color = COLORS[slotNum % COLORS.length];
    const hotkey = slotNum < 12 ? "F" + (slotNum + 1) : "";

    const existing = await queryOne<{ id: number }>("SELECT id FROM cart_slots WHERE slot_number = ?", [slotNum]);
    if (existing) {
      await execute("UPDATE cart_slots SET title=?, file_path=?, color=?, hotkey=? WHERE slot_number=?", [title, filePath, color, hotkey, slotNum]);
    } else {
      await execute("INSERT INTO cart_slots (slot_number, title, file_path, color, hotkey) VALUES (?,?,?,?,?)", [slotNum, title, filePath, color, hotkey]);
    }
    load();
  };

  const clearSlot = async (slotNum: number) => {
    await execute("DELETE FROM cart_slots WHERE slot_number = ?", [slotNum]);
    load();
  };

  const saveEdit = async () => {
    if (editing === null) return;
    await execute("UPDATE cart_slots SET title=?, color=?, hotkey=? WHERE slot_number=?", [editTitle, editColor, editHotkey, editing]);
    setEditing(null);
    load();
  };

  const startEdit = (slot: CartSlot) => {
    setEditing(slot.slot_number);
    setEditTitle(slot.title || "");
    setEditColor(slot.color);
    setEditHotkey(slot.hotkey || "");
  };

  return (
    <div className="space-y-3">
      {/* Edit modal */}
      {editing !== null && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50" onClick={() => setEditing(null)}>
          <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4 w-80 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-zinc-100">Edit Cart {editing + 1}</h3>
            <div>
              <label className="text-[10px] text-zinc-500 uppercase">Title</label>
              <input className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={editTitle} onChange={e => setEditTitle(e.target.value)} />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 uppercase">Hotkey</label>
              <input className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Press a key..." value={editHotkey} onKeyDown={e => { e.preventDefault(); setEditHotkey(e.code); }} readOnly />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 uppercase">Color</label>
              <div className="flex gap-1 flex-wrap mt-1">
                {COLORS.map(c => (
                  <button key={c} onClick={() => setEditColor(c)} className="w-6 h-6 rounded" style={{ backgroundColor: c, border: editColor === c ? "2px solid white" : "2px solid transparent" }} />
                ))}
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 bg-zinc-700 rounded text-xs text-zinc-300">Cancel</button>
              <button onClick={saveEdit} className="px-3 py-1.5 bg-blue-600 rounded text-xs font-bold text-white">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Cart grid */}
      <div className="grid grid-cols-8 gap-1.5">
        {slots.map((slot, i) => (
          <div key={i} className="relative group">
            {slot && slot.file_path ? (
              <button
                onClick={() => fireCart(i)}
                onContextMenu={(e) => { e.preventDefault(); startEdit(slot); }}
                className={"aspect-square rounded-lg flex flex-col items-center justify-center text-center p-1 transition-all " + (playing === i ? "ring-2 ring-white scale-95" : "hover:scale-105 hover:brightness-110")}
                style={{ backgroundColor: slot.color }}>
                <span className="text-[10px] font-bold text-white leading-tight truncate w-full">{slot.title || "Cart " + (i + 1)}</span>
                <span className="text-[8px] text-white opacity-60 mt-0.5">{slot.hotkey ? slot.hotkey.replace("Key", "").replace("Digit", "").replace("Numpad", "Num") : ""}</span>
                {playing === i && <span className="text-[8px] text-white font-bold animate-pulse mt-0.5">PLAYING</span>}
              </button>
            ) : (
              <button
                onClick={() => assignSlot(i)}
                className="aspect-square rounded-lg flex flex-col items-center justify-center bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 border-dashed">
                <span className="text-[10px] text-zinc-600">+</span>
                <span className="text-[8px] text-zinc-700">{i < 12 ? "F" + (i + 1) : ""}</span>
              </button>
            )}
            {/* Quick clear button */}
            {slot && <button onClick={() => clearSlot(i)} className="absolute -top-1 -right-1 w-4 h-4 bg-zinc-800 rounded-full text-[8px] text-zinc-500 hover:text-red-400 hover:bg-red-900 opacity-0 group-hover:opacity-100 flex items-center justify-center">x</button>}
          </div>
        ))}
      </div>
      <div className="text-[9px] text-zinc-600">Click empty slot to assign audio. Click filled slot to play/stop. Right-click to edit title, color, hotkey. Hover + X to clear.</div>
    </div>
  );
}
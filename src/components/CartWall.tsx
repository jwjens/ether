import { useState, useEffect, useCallback } from "react";
import { query, execute, queryOne } from "../db/client";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";

interface CartSlot {
  id: number; slot_number: number; title: string | null;
  file_path: string | null; color: string; hotkey: string | null;
}

const COLORS = ["#ef4444","#f97316","#f59e0b","#22c55e","#3b82f6","#8b5cf6","#ec4899","#14b8a6","#6366f1","#d946ef","#0ea5e9","#84cc16"];

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
  const audioMap = new Map<number, HTMLAudioElement>();
  const TOTAL = 16;

  const load = async () => {
    const rows = await query<CartSlot>("SELECT * FROM cart_slots ORDER BY slot_number");
    const g: (CartSlot | null)[] = [];
    for (let i = 0; i < TOTAL; i++) g.push(rows.find(r => r.slot_number === i) || null);
    setSlots(g);
  };
  useEffect(() => { load(); }, []);

  const fireCart = useCallback(async (n: number) => {
    const slot = slots[n];
    if (!slot || !slot.file_path) return;
    if (playing === n) { const el = audioMap.get(n); if (el) { el.pause(); el.currentTime = 0; } setPlaying(null); return; }
    if (playing !== null) { const el = audioMap.get(playing); if (el) { el.pause(); el.currentTime = 0; } }
    try {
      const bytes = await readFile(slot.file_path);
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioMap.set(n, audio);
      audio.onended = () => { setPlaying(null); URL.revokeObjectURL(url); };
      audio.play(); setPlaying(n);
    } catch (e) { console.error(e); }
  }, [slots, playing]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      for (let i = 0; i < slots.length; i++) { const s = slots[i]; if (s && s.hotkey && e.code === s.hotkey) { e.preventDefault(); fireCart(i); return; } }
      if (e.code.startsWith("F") && e.code.length <= 3) { const n = parseInt(e.code.substring(1)) - 1; if (n >= 0 && n < slots.length && slots[n]) { e.preventDefault(); fireCart(n); } }
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [slots, fireCart]);

  const assignSlot = async (n: number) => {
    const f = await open({ multiple: false, title: "Select audio for Cart " + (n + 1), filters: [{ name: "Audio", extensions: ["mp3","flac","ogg","wav","m4a","aac"] }] });
    if (!f) return;
    const fp = Array.isArray(f) ? f[0] : f;
    const title = titleFromFile(fp); const color = COLORS[n % COLORS.length]; const hk = n < 12 ? "F" + (n + 1) : "";
    const ex = await queryOne<{ id: number }>("SELECT id FROM cart_slots WHERE slot_number = ?", [n]);
    if (ex) await execute("UPDATE cart_slots SET title=?, file_path=?, color=?, hotkey=? WHERE slot_number=?", [title, fp, color, hk, n]);
    else await execute("INSERT INTO cart_slots (slot_number, title, file_path, color, hotkey) VALUES (?,?,?,?,?)", [n, title, fp, color, hk]);
    load();
  };

  const clearSlot = async (n: number) => { await execute("DELETE FROM cart_slots WHERE slot_number = ?", [n]); load(); };
  const saveEdit = async () => { if (editing === null) return; await execute("UPDATE cart_slots SET title=?, color=?, hotkey=? WHERE slot_number=?", [editTitle, editColor, editHotkey, editing]); setEditing(null); load(); };

  return (
    <div>
      {editing !== null && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50" onClick={() => setEditing(null)}>
          <div className="bg-zinc-900 rounded-lg border border-zinc-700 p-4 w-80 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-zinc-100">Edit Cart {(editing || 0) + 1}</h3>
            <div><label className="text-[10px] text-zinc-500 uppercase">Title</label><input className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={editTitle} onChange={e => setEditTitle(e.target.value)} /></div>
            <div><label className="text-[10px] text-zinc-500 uppercase">Hotkey</label><input className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Press a key..." value={editHotkey} onKeyDown={e => { e.preventDefault(); setEditHotkey(e.code); }} readOnly /></div>
            <div><label className="text-[10px] text-zinc-500 uppercase">Color</label><div className="flex gap-1 flex-wrap mt-1">{COLORS.map(c => (<button key={c} onClick={() => setEditColor(c)} className="w-6 h-6 rounded" style={{ backgroundColor: c, border: editColor === c ? "2px solid white" : "2px solid transparent" }} />))}</div></div>
            <div className="flex gap-2 justify-end"><button onClick={() => setEditing(null)} className="px-3 py-1.5 bg-zinc-700 rounded text-xs text-zinc-300">Cancel</button><button onClick={saveEdit} className="px-3 py-1.5 bg-blue-600 rounded text-xs font-bold text-white">Save</button></div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-8 gap-3 ">
        {slots.map((slot, i) => {
          if (slot && slot.file_path) {
            return (
              <div key={i} className="relative group">
                <button onClick={() => fireCart(i)} draggable onDragStart={(e) => { e.dataTransfer.setData("application/cart", JSON.stringify({ filePath: slot.file_path, title: slot.title || "Cart " + (i+1), artist: "" })); e.dataTransfer.effectAllowed = "copy"; }} onContextMenu={(e) => { e.preventDefault(); setEditing(slot.slot_number); setEditTitle(slot.title || ""); setEditColor(slot.color); setEditHotkey(slot.hotkey || ""); }} className={"w-full rounded-lg flex flex-col items-center justify-center text-center transition-all " + (playing === i ? "ring-2 ring-white scale-95" : "hover:brightness-125")} style={{ backgroundColor: slot.color, aspectRatio: "1", minHeight: "0" }}>
                  <span className="text-sm font-bold text-white leading-tight px-1 truncate w-full">{slot.title}</span>
                  <span className="text-[10px] text-white opacity-50 mt-1">{slot.hotkey ? slot.hotkey.replace("Key","").replace("Digit","") : ""}</span>
                  {playing === i && <span className="text-[10px] text-white font-bold animate-pulse">PLAYING</span>}
                </button>
                <button onClick={() => clearSlot(i)} className="absolute -top-1 -right-1 w-4 h-4 bg-zinc-900 rounded-full text-[8px] text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100 flex items-center justify-center border border-zinc-700">x</button>
              </div>
            );
          }
          return (
            <button key={i} onClick={() => assignSlot(i)} className="w-full rounded-lg flex flex-col items-center justify-center" style={{ background: "var(--bg-tertiary)", border: "2px dashed var(--border-secondary)", cursor: "pointer", aspectRatio: "1", minHeight: "0" }}>
              <span className="text-2xl text-zinc-600">+</span>
              {i < 12 && <span className="text-xs text-zinc-600 mt-1">{"F" + (i + 1)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

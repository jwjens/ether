import { useState, useEffect, useCallback } from "react";
import { query, execute, queryOne } from "../db/client";
const open = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
const readFile = (p: string) => (window as any).ether.fs.readFile(p);

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
  const [flashing, setFlashing] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [editColor, setEditColor] = useState("#3f3f46");
  const [editTitle, setEditTitle] = useState("");
  const [editHotkey, setEditHotkey] = useState("");
  const audioMap = new Map<number, HTMLAudioElement>();
  const TOTAL = 18;

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
    setFlashing(n); setTimeout(() => setFlashing(f => f === n ? null : f), 180);
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
      <style>{`
        @keyframes cart-flash {
          0%   { opacity: 1; }
          25%  { opacity: 0.25; }
          100% { opacity: 1; }
        }
        .cart-flash { animation: cart-flash 0.18s ease-out; }
      `}</style>

      {editing !== null && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50" onClick={() => setEditing(null)}>
          <div style={{ background: "#111118", border: "1px solid #2a2a38" }} className="p-4 w-80 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-zinc-100">Edit Cart {(editing || 0) + 1}</h3>
            <div><label className="text-[10px] text-zinc-500 uppercase">Title</label><input className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 text-xs text-zinc-100" value={editTitle} onChange={e => setEditTitle(e.target.value)} /></div>
            <div><label className="text-[10px] text-zinc-500 uppercase">Hotkey</label><input className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 text-xs text-zinc-100" placeholder="Press a key..." value={editHotkey} onKeyDown={e => { e.preventDefault(); setEditHotkey(e.code); }} readOnly /></div>
            <div><label className="text-[10px] text-zinc-500 uppercase">Color</label><div className="flex gap-1 flex-wrap mt-1">{COLORS.map(c => (<button key={c} onClick={() => setEditColor(c)} className="w-6 h-6" style={{ backgroundColor: c, border: editColor === c ? "2px solid white" : "2px solid transparent" }} />))}</div></div>
            <div className="flex gap-2 justify-end"><button onClick={() => setEditing(null)} className="px-3 py-1.5 bg-zinc-700 text-xs text-zinc-300">Cancel</button><button onClick={saveEdit} className="px-3 py-1.5 bg-blue-600 text-xs font-bold text-white">Save</button></div>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "6px" }}>
        {slots.map((slot, i) => {
          if (slot && slot.file_path) {
            const isPlaying = playing === i;
            const isFlashing = flashing === i;
            return (
              <div key={i} className="relative group" style={{ minHeight: 80 }}>
                <button
                  onClick={() => fireCart(i)}
                  draggable
                  onDragStart={(e) => { e.dataTransfer.setData("application/cart", JSON.stringify({ filePath: slot.file_path, title: slot.title || "Cart " + (i+1), artist: "" })); e.dataTransfer.effectAllowed = "copy"; }}
                  onContextMenu={(e) => { e.preventDefault(); setEditing(slot.slot_number); setEditTitle(slot.title || ""); setEditColor(slot.color); setEditHotkey(slot.hotkey || ""); }}
                  className={isFlashing ? "cart-flash" : ""}
                  style={{
                    width: "100%", height: "100%", minHeight: 80,
                    background: isPlaying ? "#1c1c28" : "#111118",
                    borderLeft: `4px solid ${slot.color}`,
                    borderTop: "1px solid #2a2a38",
                    borderRight: "1px solid #2a2a38",
                    borderBottom: isPlaying ? `2px solid ${slot.color}` : "1px solid #2a2a38",
                    display: "flex", flexDirection: "column",
                    alignItems: "flex-start", justifyContent: "space-between",
                    padding: "8px 8px 6px 10px",
                    cursor: "pointer", transition: "filter 0.1s",
                    boxShadow: isPlaying ? `inset 0 0 0 1px ${slot.color}33` : "none",
                  }}
                  onMouseEnter={e => { if (!isPlaying) (e.currentTarget as HTMLElement).style.filter = "brightness(1.2)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = "brightness(1)"; }}
                >
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#e4e4f0", lineHeight: 1.3, wordBreak: "break-word", textAlign: "left", maxWidth: "100%" }}>
                    {slot.title}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", justifyContent: "space-between" }}>
                    {isPlaying
                      ? <span style={{ fontSize: 9, fontWeight: 700, color: slot.color, letterSpacing: "0.08em" }}>▶ PLAYING</span>
                      : <span style={{ fontSize: 9, color: "#555568" }}>{slot.hotkey ? slot.hotkey.replace("Key","").replace("Digit","") : ""}</span>
                    }
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: isPlaying ? slot.color : "transparent", flexShrink: 0, boxShadow: isPlaying ? `0 0 6px ${slot.color}` : "none" }} />
                  </div>
                </button>
                <button onClick={() => clearSlot(i)} style={{ position: "absolute", top: 3, right: 3, width: 14, height: 14, background: "#0e0e14", border: "1px solid #2a2a38", fontSize: 8, color: "#555568", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }} className="opacity-0 group-hover:opacity-100 hover:!text-red-400">×</button>
              </div>
            );
          }
          return (
            <button
              key={i}
              onClick={() => assignSlot(i)}
              style={{
                minHeight: 80, width: "100%",
                background: "#0b0b10",
                border: "1.5px dashed #2a2a38",
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                gap: 4, cursor: "pointer", transition: "border-color 0.15s",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#3a3a50"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#2a2a38"; }}
            >
              <span style={{ fontSize: 16, color: "#333344" }}>+</span>
              <span style={{ fontSize: 9, color: "#333344", letterSpacing: "0.06em" }}>
                {i < 12 ? "F" + (i + 1) : "Empty"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

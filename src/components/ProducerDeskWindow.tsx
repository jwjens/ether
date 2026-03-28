// ProducerDeskWindow.tsx
// Rendered when the app is launched with #desk hash.
// Fills the entire OS window — no floating panel chrome needed
// since the OS window itself handles drag/resize/minimize.

import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";

// ── Reuse all types and constants from ProducerDesk ──────────
type NoteColor = "yellow" | "pink" | "cyan" | "green" | "purple" | "white";
type ItemType  = "note" | "image" | "link";

interface BoardItem {
  id: string; type: ItemType;
  x: number; y: number; w: number; h: number;
  text?: string; color?: NoteColor;
  src?: string; caption?: string;
  url?: string; title?: string;
}

interface Message { role: "user" | "assistant"; content: string; }

const NOTE_COLORS: Record<NoteColor, { bg: string; border: string; text: string }> = {
  yellow: { bg: "#fef9c3", border: "#fde047", text: "#713f12" },
  pink:   { bg: "#fce7f3", border: "#f9a8d4", text: "#831843" },
  cyan:   { bg: "#e0f2fe", border: "#7dd3fc", text: "#0c4a6e" },
  green:  { bg: "#dcfce7", border: "#86efac", text: "#14532d" },
  purple: { bg: "#f3e8ff", border: "#d8b4fe", text: "#581c87" },
  white:  { bg: "rgba(255,255,255,0.05)", border: "rgba(255,255,255,0.1)", text: "rgba(255,255,255,0.8)" },
};

const DARK_NOTE: Record<NoteColor, { bg: string; border: string; text: string }> = {
  yellow: { bg: "#2a2410", border: "rgba(253,224,71,0.25)",  text: "#fde047"  },
  pink:   { bg: "#28101c", border: "rgba(249,168,212,0.25)", text: "#f9a8d4"  },
  cyan:   { bg: "#0c1e28", border: "rgba(125,211,252,0.25)", text: "#7dd3fc"  },
  green:  { bg: "#0d2016", border: "rgba(134,239,172,0.25)", text: "#86efac"  },
  purple: { bg: "#1a1028", border: "rgba(216,180,254,0.25)", text: "#d8b4fe"  },
  white:  { bg: "rgba(255,255,255,0.05)", border: "rgba(255,255,255,0.1)", text: "rgba(255,255,255,0.8)" },
};

async function askAI(messages: Message[]): Promise<string> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 1000,
        system: "You are a creative producer assistant for radio, podcast, and broadcast. Be concise, creative, and practical.",
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      }),
    });
    const d = await r.json();
    return d.content?.[0]?.text || "No response";
  } catch { return "Couldn't reach AI right now."; }
}

export default function ProducerDeskWindow() {
  const [tab, setTab]       = useState<"board" | "ai">("board");
  const [savedMsg, setSavedMsg] = useState("");

  // Board
  const [items, setItems] = useState<BoardItem[]>(() => {
    try {
      const s = localStorage.getItem("ether_producer_desk");
      if (s) { const p = JSON.parse(s); if (Array.isArray(p) && p.length > 0) return p; }
    } catch {}
    return [
      { id:"1", type:"note", x:30, y:30, w:200, h:160, text:"Episode ideas\n\n• Guest topics\n• Music breaks\n• Sponsor spots", color:"yellow" },
      { id:"2", type:"note", x:250, y:30, w:200, h:130, text:"Research links\n\n", color:"cyan" },
    ];
  });
  const [draggingItem, setDraggingItem] = useState<string|null>(null);
  const itemDragStart = useRef({ mx:0, my:0, ox:0, oy:0 });
  const [resizingItem, setResizingItem] = useState<string|null>(null);
  const resizeStart = useRef({ mx:0, my:0, ox:0, oy:0, ow:0, oh:0, handle:"" });
  const boardRef = useRef<HTMLDivElement>(null);
  const [selectedNote, setSelectedNote] = useState<string|null>(null);

  // AI
  const [messages, setMessages] = useState<Message[]>([
    { role:"assistant", content:"Hey! I'm your producer AI. Ask me anything — episode ideas, interview questions, segment structure, topic research, title suggestions." }
  ]);
  const [input, setInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  // Persist
  useEffect(() => {
    if (items.length === 0) return;
    try { localStorage.setItem("ether_producer_desk", JSON.stringify(items)); } catch {}
  }, [items]);

  const saveDesk = () => {
    try {
      localStorage.setItem("ether_producer_desk", JSON.stringify(items));
      setSavedMsg("Saved");
      setTimeout(() => setSavedMsg(""), 2000);
    } catch {}
  };

  const setItemsAndSave = (updater: (prev: BoardItem[]) => BoardItem[]) => {
    setItems(prev => {
      const next = updater(prev);
      try { localStorage.setItem("ether_producer_desk", JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveDesk(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items]);

  // Copy / paste
  const [clipboard, setClipboard] = useState<BoardItem|null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "c" && selectedNote) {
        const item = items.find(i => i.id === selectedNote);
        if (item) { setClipboard(item); }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "v" && clipboard) {
        const id = Date.now().toString();
        const newItem = { ...clipboard, id, x: clipboard.x + 20, y: clipboard.y + 20 };
        setItemsAndSave(p => [...p, newItem]);
        setSelectedNote(id);
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedNote && !(e.target instanceof HTMLTextAreaElement)) {
          setItemsAndSave(p => p.filter(i => i.id !== selectedNote));
          setSelectedNote(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedNote, clipboard, items]);

  // Board item drag
  const startItemDrag = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const item = items.find(i => i.id === id)!;
    setDraggingItem(id);
    itemDragStart.current = { mx:e.clientX, my:e.clientY, ox:item.x, oy:item.y };
  };

  useEffect(() => {
    if (!draggingItem) return;
    const onMove = (e: MouseEvent) => {
      setItemsAndSave(p => p.map(i => i.id === draggingItem ? {
        ...i,
        x: Math.max(0, itemDragStart.current.ox + e.clientX - itemDragStart.current.mx),
        y: Math.max(0, itemDragStart.current.oy + e.clientY - itemDragStart.current.my),
      } : i));
    };
    const onUp = () => setDraggingItem(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [draggingItem]);

  // Card resize
  useEffect(() => {
    if (!resizingItem) return;
    const onMove = (e: MouseEvent) => {
      const { mx, my, ox, oy, ow, oh, handle } = resizeStart.current;
      const dx = e.clientX - mx;
      const dy = e.clientY - my;
      setItems(p => p.map(i => {
        if (i.id !== resizingItem) return i;
        let { x, y, w, h } = { x: ox, y: oy, w: ow, h: oh };
        if (handle.includes("e")) w = Math.max(120, ow + dx);
        if (handle.includes("s")) h = Math.max(80,  oh + dy);
        if (handle.includes("w")) { w = Math.max(120, ow - dx); x = ox + ow - w; }
        if (handle.includes("n")) { h = Math.max(80,  oh - dy); y = oy + oh - h; }
        return { ...i, x, y, w, h };
      }));
    };
    const onUp = (e: MouseEvent) => { setResizingItem(null); setItemsAndSave(p => p); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); }
  }, [resizingItem]);

  const startResize = (e: React.MouseEvent, id: string, handle: string) => {
    e.stopPropagation();
    e.preventDefault();
    const item = items.find(i => i.id === id)!;
    setResizingItem(id);
    resizeStart.current = { mx: e.clientX, my: e.clientY, ox: item.x, oy: item.y, ow: item.w, oh: item.h, handle };
  };

  // Paste image from system clipboard
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = (ev) => {
            const src = ev.target?.result as string;
            const id = Date.now().toString();
            setItemsAndSave(p => [...p, {
              id, type: "image" as const,
              x: 60 + Math.random() * 100, y: 60 + Math.random() * 80,
              w: 240, h: 180,
              src, caption: file.name || "Pasted image",
            }]);
            setSelectedNote(id);
          };
          reader.readAsDataURL(file);
          e.preventDefault();
          return;
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const addNote = (color: NoteColor = "yellow") => {
    const id = Date.now().toString();
    setItemsAndSave(p => [...p, { id, type:"note", x:40+Math.random()*200, y:80+Math.random()*100, w:200, h:160, text:"", color }]);
    setSelectedNote(id);
  };

  const addSongCard = () => {
    const songTitle = prompt("Song title:");
    if (!songTitle) return;
    const artist = prompt("Artist:") || "Unknown Artist";
    const id = Date.now().toString();
    setItemsAndSave(p => [...p, {
      id, type: "note" as const,
      x: 40 + Math.random() * 200, y: 80 + Math.random() * 100,
      w: 230, h: 100,
      text: `♪ ${songTitle}\n${artist}\n\n→ Send to Queue ↗`,
      color: "purple" as NoteColor,
    }]);
    // Immediately emit to queue — no filePath from the Desk window
    emit("desk-send-to-queue", { title: songTitle, artist, filePath: "" }).catch(() => {});
    setSelectedNote(id);
  };

  const addLink = () => {
    const url = prompt("Paste a URL:");
    if (!url) return;
    setItemsAndSave(p => [...p, { id:Date.now().toString(), type:"link", x:40+Math.random()*200, y:80+Math.random()*100, w:240, h:80, url, title:url.replace(/^https?:\/\//, "").split("/")[0] }]);
  };

  const handleImageDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file?.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const boardRect = boardRef.current?.getBoundingClientRect();
      setItemsAndSave(p => [...p, { id:Date.now().toString(), type:"image", x:e.clientX-(boardRect?.left||0)-75, y:e.clientY-(boardRect?.top||0)-75, w:220, h:170, src:ev.target?.result as string, caption:file.name }]);
    };
    reader.readAsDataURL(file);
  };

  const pinToBoard = (content: string) => {
    setItemsAndSave(p => [...p, { id:Date.now().toString(), type:"note", x:40+Math.random()*150, y:80+Math.random()*80, w:220, h:190, text:content, color:"purple" }]);
    setTab("board");
  };

  const sendMessage = async () => {
    if (!input.trim() || aiLoading) return;
    const msg: Message = { role:"user", content:input.trim() };
    setMessages(p => [...p, msg]);
    setInput("");
    setAiLoading(true);
    const reply = await askAI([...messages, msg]);
    setMessages(p => [...p, { role:"assistant", content:reply }]);
    setAiLoading(false);
  };

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, aiLoading]);

  // Set window title
  useEffect(() => {
    document.title = "Ether — Producer Desk";
  }, []);

  return (
    <div style={{
      display:"flex", flexDirection:"column" as const, height:"100vh",
      background:"linear-gradient(160deg, rgba(18,18,26,0.99) 0%, rgba(10,10,16,1) 100%)",
      fontFamily:"'Inter', system-ui, sans-serif",
      color:"rgba(255,255,255,0.85)",
      overflow:"hidden",
    }}>

      {/* ── Titlebar — data-tauri-drag-region makes it draggable ── */}
      <div
        data-tauri-drag-region
        style={{
          display:"flex", alignItems:"center", gap:10,
          padding:"10px 16px",
          borderBottom:"1px solid rgba(255,255,255,0.06)",
          flexShrink:0,
          background:"rgba(255,255,255,0.02)",
          cursor:"default",
        }}
      >
        {/* App icon */}
        <div style={{ width:22, height:22, borderRadius:6, background:"linear-gradient(135deg, #38bdf8, #a78bfa)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, flexShrink:0 }}>✦</div>

        <div style={{ flex:1, display:"flex", alignItems:"center", gap:6 }} data-tauri-drag-region>
          <span style={{ fontSize:11, fontWeight:800, color:"rgba(255,255,255,0.7)", letterSpacing:"0.08em", textTransform:"uppercase" as const, fontFamily:"'Syne', sans-serif" }}>
            Producer Desk
          </span>
          <span style={{ fontSize:9, color:"rgba(255,255,255,0.2)", letterSpacing:"0.04em" }}>— Ether</span>
        </div>

        {/* Save */}
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {savedMsg ? (
            <span style={{ fontSize:9, color:"#34d399", fontWeight:800, letterSpacing:"0.08em" }}>✓ SAVED</span>
          ) : (
            <button onClick={saveDesk} style={{ padding:"3px 10px", borderRadius:6, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", color:"rgba(255,255,255,0.3)", fontSize:9, fontWeight:700, cursor:"pointer", transition:"all 0.15s", letterSpacing:"0.06em", textTransform:"uppercase" as const }}
              onMouseEnter={e=>{ const el=e.currentTarget as HTMLElement; el.style.background="rgba(52,211,153,0.1)"; el.style.borderColor="rgba(52,211,153,0.3)"; el.style.color="#34d399"; }}
              onMouseLeave={e=>{ const el=e.currentTarget as HTMLElement; el.style.background="rgba(255,255,255,0.04)"; el.style.borderColor="rgba(255,255,255,0.08)"; el.style.color="rgba(255,255,255,0.3)"; }}
            >Save</button>
          )}

          {/* Tab switcher */}
          <div style={{ display:"flex", gap:1, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:8, padding:"2px" }}>
            {(["board","ai"] as const).map(id => (
              <button key={id} onClick={()=>setTab(id)} style={{
                padding:"3px 11px", borderRadius:6, border:"none",
                background:tab===id?"rgba(255,255,255,0.10)":"none",
                color:tab===id?"rgba(255,255,255,0.88)":"rgba(255,255,255,0.28)",
                fontSize:10, fontWeight:tab===id?700:400, cursor:"pointer", transition:"all 0.15s",
              }}>
                {id==="board" ? "Board" : "✦ AI"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── BOARD ── */}
      {tab==="board" && (
        <div style={{ flex:1, display:"flex", flexDirection:"column" as const, minHeight:0 }}>
          {/* Toolbar */}
          <div style={{ display:"flex", alignItems:"center", gap:5, padding:"7px 16px", borderBottom:"1px solid rgba(255,255,255,0.05)", flexShrink:0 }}>
            <span style={{ fontSize:9, color:"rgba(255,255,255,0.22)", fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase" as const, marginRight:4 }}>Note</span>
            {(["yellow","pink","cyan","green","purple"] as NoteColor[]).map(c => (
              <button key={c} onClick={()=>addNote(c)} title={`${c} note`} style={{
                width:16, height:16, borderRadius:4,
                background:NOTE_COLORS[c].bg, border:`1.5px solid ${NOTE_COLORS[c].border}`,
                cursor:"pointer", padding:0, transition:"transform 0.12s, box-shadow 0.12s",
                boxShadow:"0 1px 3px rgba(0,0,0,0.5)",
              }}
                onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.transform="scale(1.3) translateY(-1px)";}}
                onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.transform="scale(1)";}}
              />
            ))}
            <div style={{ width:1, height:12, background:"rgba(255,255,255,0.08)", margin:"0 3px" }} />
            <button onClick={addLink} style={{ display:"flex", alignItems:"center", gap:4, padding:"3px 9px", borderRadius:6, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", color:"rgba(255,255,255,0.4)", fontSize:10, fontWeight:600, cursor:"pointer", transition:"all 0.15s" }}
              onMouseEnter={e=>{const el=e.currentTarget as HTMLElement; el.style.background="rgba(255,255,255,0.09)"; el.style.color="rgba(255,255,255,0.8)";}}
              onMouseLeave={e=>{const el=e.currentTarget as HTMLElement; el.style.background="rgba(255,255,255,0.04)"; el.style.color="rgba(255,255,255,0.4)";}}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              Link
            </button>
            <button onClick={addSongCard} style={{ display:"flex", alignItems:"center", gap:4, padding:"3px 9px", borderRadius:6, background:"rgba(139,92,246,0.1)", border:"1px solid rgba(139,92,246,0.2)", color:"rgba(139,92,246,0.85)", fontSize:10, fontWeight:600, cursor:"pointer", transition:"all 0.15s" }}
              onMouseEnter={e=>{const el=e.currentTarget as HTMLElement; el.style.background="rgba(139,92,246,0.2)"; el.style.color="#a78bfa";}}
              onMouseLeave={e=>{const el=e.currentTarget as HTMLElement; el.style.background="rgba(139,92,246,0.1)"; el.style.color="rgba(139,92,246,0.85)";}}>
              ♪ Song → Queue
            </button>
            <button onClick={()=>setTab("ai")} style={{ display:"flex", alignItems:"center", gap:4, padding:"3px 9px", borderRadius:6, background:"rgba(167,139,250,0.07)", border:"1px solid rgba(167,139,250,0.15)", color:"rgba(167,139,250,0.7)", fontSize:10, fontWeight:600, cursor:"pointer", transition:"all 0.15s" }}
              onMouseEnter={e=>{const el=e.currentTarget as HTMLElement; el.style.background="rgba(167,139,250,0.15)"; el.style.color="#a78bfa";}}
              onMouseLeave={e=>{const el=e.currentTarget as HTMLElement; el.style.background="rgba(167,139,250,0.07)"; el.style.color="rgba(167,139,250,0.7)";}}>
              ✦ Ask AI
            </button>
            <span style={{ marginLeft:"auto", fontSize:9, color:"rgba(255,255,255,0.12)", letterSpacing:"0.03em" }}>
              {items.length > 0 ? `${items.length} items` : "Drop images · add notes · ask AI"}
            </span>
          </div>

          {/* Canvas */}
          <div ref={boardRef} onDragOver={e=>e.preventDefault()} onDrop={handleImageDrop} onClick={()=>setSelectedNote(null)} style={{
            flex:1, position:"relative" as const, overflow:"hidden",
            background:"rgba(8,8,14,0.95)",
            backgroundImage:"radial-gradient(circle, rgba(255,255,255,0.055) 1px, transparent 1px)",
            backgroundSize:"22px 22px",
          }}>
            {items.map(item => (
              <BoardCard
                key={item.id} item={item}
                selected={selectedNote===item.id}
                dragging={draggingItem===item.id}
                onDragStart={startItemDrag}
                onResize={(e,handle)=>startResize(e,item.id,handle)}
                onSelect={setSelectedNote}
                onChange={(id,u)=>setItemsAndSave(p=>p.map(i=>i.id===id?{...i,...u}:i))}
                onDelete={id=>setItemsAndSave(p=>p.filter(i=>i.id!==id))}
                onPin={pinToBoard}
              />
            ))}
            {items.length===0 && (
              <div style={{ position:"absolute" as const, inset:0, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column" as const, gap:8, pointerEvents:"none" }}>
                <div style={{ fontSize:32, opacity:0.12 }}>✦</div>
                <div style={{ fontSize:13, fontWeight:600, color:"rgba(255,255,255,0.12)", letterSpacing:"0.02em" }}>Your producer board is empty</div>
                <div style={{ fontSize:10, color:"rgba(255,255,255,0.08)" }}>Add notes · drop images · paste links · ask AI</div>
              </div>
            )}
          </div>

          {/* Status bar */}
          <div style={{ flexShrink:0, padding:"4px 16px", borderTop:"1px solid rgba(255,255,255,0.05)", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <span style={{ fontSize:9, color:"rgba(255,255,255,0.15)", letterSpacing:"0.03em" }}>Auto-saves · shared with Ether main window</span>
            <span style={{ fontSize:9, color:savedMsg?"#34d399":"rgba(255,255,255,0.1)" }}>{savedMsg || "⌘S to save"}</span>
          </div>
        </div>
      )}

      {/* ── AI ── */}
      {tab==="ai" && (
        <div style={{ flex:1, display:"flex", flexDirection:"column" as const, minHeight:0 }}>
          <div ref={chatRef} style={{ flex:1, overflowY:"auto" as const, padding:"16px 18px", display:"flex", flexDirection:"column" as const, gap:12 }}>
            {messages.map((msg,i) => (
              <div key={i} style={{ display:"flex", gap:10, flexDirection:msg.role==="user"?"row-reverse":"row" }}>
                {msg.role==="assistant" && (
                  <div style={{ width:26, height:26, borderRadius:8, background:"linear-gradient(135deg, rgba(167,139,250,0.3), rgba(56,189,248,0.3))", border:"1px solid rgba(167,139,250,0.2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, flexShrink:0, marginTop:2 }}>✦</div>
                )}
                <div style={{
                  maxWidth:"78%", padding:"10px 13px",
                  borderRadius:msg.role==="user"?"13px 13px 4px 13px":"4px 13px 13px 13px",
                  background:msg.role==="user"?"linear-gradient(135deg, rgba(56,189,248,0.2), rgba(56,189,248,0.12))":"rgba(255,255,255,0.05)",
                  border:msg.role==="user"?"1px solid rgba(56,189,248,0.2)":"1px solid rgba(255,255,255,0.07)",
                  color:"rgba(255,255,255,0.82)", fontSize:12, lineHeight:1.7,
                }}>
                  <div style={{ whiteSpace:"pre-wrap" }}>{msg.content}</div>
                  {msg.role==="assistant" && i>0 && (
                    <button onClick={()=>pinToBoard(msg.content)} style={{ marginTop:8, display:"flex", alignItems:"center", gap:4, background:"none", border:"none", color:"rgba(167,139,250,0.5)", fontSize:10, cursor:"pointer", padding:0, fontWeight:600, transition:"color 0.15s" }}
                      onMouseEnter={e=>(e.currentTarget as HTMLElement).style.color="#a78bfa"}
                      onMouseLeave={e=>(e.currentTarget as HTMLElement).style.color="rgba(167,139,250,0.5)"}
                    >✦ Pin to board</button>
                  )}
                </div>
              </div>
            ))}
            {aiLoading && (
              <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                <div style={{ width:26, height:26, borderRadius:8, background:"linear-gradient(135deg, rgba(167,139,250,0.3), rgba(56,189,248,0.3))", border:"1px solid rgba(167,139,250,0.2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11 }}>✦</div>
                <div style={{ display:"flex", gap:4, padding:"11px 14px", background:"rgba(255,255,255,0.05)", borderRadius:"4px 13px 13px 13px", border:"1px solid rgba(255,255,255,0.07)" }}>
                  {[0,1,2].map(i => <div key={i} style={{ width:5, height:5, borderRadius:"50%", background:"rgba(167,139,250,0.6)", animation:`bounce 1.2s ease-in-out ${i*0.15}s infinite` }} />)}
                </div>
              </div>
            )}
          </div>

          {/* Quick prompts */}
          <div style={{ padding:"8px 16px 6px", display:"flex", gap:5, flexWrap:"wrap" as const, flexShrink:0, borderTop:"1px solid rgba(255,255,255,0.05)" }}>
            {["5 episode title ideas","Interview questions","Segment structure","Trending podcast topics","Write episode description"].map(p => (
              <button key={p} onClick={()=>setInput(p)} style={{ padding:"3px 9px", borderRadius:20, border:"1px solid rgba(255,255,255,0.08)", background:"rgba(255,255,255,0.03)", color:"rgba(255,255,255,0.35)", fontSize:10, cursor:"pointer", transition:"all 0.12s", whiteSpace:"nowrap" as const }}
                onMouseEnter={e=>{const el=e.currentTarget as HTMLElement; el.style.borderColor="rgba(167,139,250,0.3)"; el.style.color="rgba(167,139,250,0.8)"; el.style.background="rgba(167,139,250,0.07)";}}
                onMouseLeave={e=>{const el=e.currentTarget as HTMLElement; el.style.borderColor="rgba(255,255,255,0.08)"; el.style.color="rgba(255,255,255,0.35)"; el.style.background="rgba(255,255,255,0.03)";}}>
                {p}
              </button>
            ))}
          </div>

          {/* Input */}
          <div style={{ padding:"10px 14px", borderTop:"1px solid rgba(255,255,255,0.05)", display:"flex", gap:8, flexShrink:0, alignItems:"center" }}>
            <input value={input} onChange={e=>setInput(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage();}}}
              placeholder="Ask anything about your episode..."
              style={{ flex:1, padding:"9px 14px", borderRadius:10, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.08)", color:"rgba(255,255,255,0.85)", fontSize:12, outline:"none", fontFamily:"inherit", transition:"border-color 0.15s" }}
              onFocus={e=>(e.currentTarget as HTMLElement).style.borderColor="rgba(167,139,250,0.35)"}
              onBlur={e=>(e.currentTarget as HTMLElement).style.borderColor="rgba(255,255,255,0.08)"}
            />
            <button onClick={sendMessage} disabled={aiLoading||!input.trim()} style={{
              width:36, height:36, borderRadius:10, border:"none",
              background:input.trim()&&!aiLoading?"rgba(167,139,250,0.8)":"rgba(255,255,255,0.05)",
              color:input.trim()&&!aiLoading?"#fff":"rgba(255,255,255,0.2)",
              cursor:input.trim()&&!aiLoading?"pointer":"default",
              display:"flex", alignItems:"center", justifyContent:"center",
              transition:"all 0.15s", flexShrink:0,
              boxShadow:input.trim()&&!aiLoading?"0 2px 12px rgba(167,139,250,0.3)":"none",
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes bounce { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-5px)} }
      `}</style>
    </div>
  );
}

// ── Board card ────────────────────────────────────────────────
// ── Resize handles ─────────────────────────────────────────────
function ResizeHandles({ onResize }: { onResize: (e: React.MouseEvent, handle: string) => void }) {
  const H = 8; // handle size px
  const handles: { handle: string; style: React.CSSProperties }[] = [
    // Corners
    { handle:"nw", style:{ top:-H/2, left:-H/2,   cursor:"nw-resize" } },
    { handle:"ne", style:{ top:-H/2, right:-H/2,  cursor:"ne-resize" } },
    { handle:"se", style:{ bottom:-H/2, right:-H/2, cursor:"se-resize" } },
    { handle:"sw", style:{ bottom:-H/2, left:-H/2,  cursor:"sw-resize" } },
    // Edges
    { handle:"n",  style:{ top:-H/2,    left:"50%", transform:"translateX(-50%)", cursor:"n-resize",  width:24, height:H } },
    { handle:"s",  style:{ bottom:-H/2, left:"50%", transform:"translateX(-50%)", cursor:"s-resize",  width:24, height:H } },
    { handle:"e",  style:{ right:-H/2,  top:"50%",  transform:"translateY(-50%)", cursor:"e-resize",  width:H,  height:24 } },
    { handle:"w",  style:{ left:-H/2,   top:"50%",  transform:"translateY(-50%)", cursor:"w-resize",  width:H,  height:24 } },
  ];
  return (
    <>
      {handles.map(({ handle, style }) => (
        <div key={handle}
          onMouseDown={e => { e.stopPropagation(); onResize(e, handle); }}
          style={{
            position:"absolute", width:H, height:H, borderRadius:2,
            background:"rgba(56,189,248,0.9)", border:"1.5px solid #fff",
            boxShadow:"0 1px 4px rgba(0,0,0,0.4)",
            zIndex:200,
            ...style,
          }}
        />
      ))}
    </>
  );
}

function BoardCard({ item, selected, dragging, onDragStart, onResize, onSelect, onChange, onDelete, onPin }: {
  item: BoardItem; selected: boolean; dragging: boolean;
  onDragStart: (e: React.MouseEvent, id: string) => void;
  onResize: (e: React.MouseEvent, handle: string) => void;
  onSelect: (id: string|null) => void;
  onChange: (id: string, u: Partial<BoardItem>) => void;
  onDelete: (id: string) => void;
  onPin: (content: string) => void;
}) {
  const dn = item.color ? DARK_NOTE[item.color] : DARK_NOTE.white;

  // Outer wrapper — no overflow clip so handles are visible outside card bounds
  const wrapper: React.CSSProperties = {
    position:"absolute", left:item.x, top:item.y, width:item.w, minHeight:item.h,
    zIndex:selected||dragging?100:1, userSelect:"none",
  };
  // Inner card — clips content, has shadow and border
  const base: React.CSSProperties = {
    width:"100%", height:"100%", minHeight:item.h,
    borderRadius:12, cursor:dragging?"grabbing":"grab",
    boxShadow:selected?"0 12px 40px rgba(0,0,0,0.6), 0 0 0 1.5px rgba(56,189,248,0.5)":dragging?"0 20px 50px rgba(0,0,0,0.7)":"0 4px 16px rgba(0,0,0,0.4), 0 0 0 0.5px rgba(255,255,255,0.06)",
    transition:dragging?"none":"box-shadow 0.2s", overflow:"hidden",
    position:"relative",
  };

  if (item.type==="note") return (
    <div style={wrapper}>
    <div style={{...base, background:dn.bg, border:`1px solid ${dn.border}`}}
      onMouseDown={e=>{onSelect(item.id);onDragStart(e,item.id);}}
      onClick={e=>{e.stopPropagation();onSelect(item.id);}}>
      <div style={{height:2, background:`linear-gradient(90deg,${dn.border},transparent)`}} />
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"5px 8px 0",opacity:selected?1:0.4,transition:"opacity 0.15s"}}>
        {/* Font controls */}
        <div style={{display:"flex",alignItems:"center",gap:3}} onMouseDown={e=>e.stopPropagation()}>
          <button onClick={e=>{e.stopPropagation();onChange(item.id,{fontBold:!item.fontBold});}}
            style={{background:item.fontBold?"rgba(255,255,255,0.2)":"none",border:"1px solid rgba(255,255,255,0.15)",borderRadius:4,cursor:"pointer",fontSize:11,fontWeight:800,color:dn.text,padding:"1px 6px",lineHeight:1.4}}>B</button>
          <button onClick={e=>{e.stopPropagation();onChange(item.id,{fontSize:Math.max(9,(item.fontSize||12)-1)});}}
            style={{background:"none",border:"1px solid rgba(255,255,255,0.15)",borderRadius:4,cursor:"pointer",fontSize:11,color:dn.text,padding:"1px 5px",lineHeight:1.4}}>−</button>
          <span style={{fontSize:9,color:dn.text,opacity:0.6,minWidth:16,textAlign:"center",fontFamily:"'DM Mono',monospace"}}>{item.fontSize||12}</span>
          <button onClick={e=>{e.stopPropagation();onChange(item.id,{fontSize:Math.min(48,(item.fontSize||12)+1)});}}
            style={{background:"none",border:"1px solid rgba(255,255,255,0.15)",borderRadius:4,cursor:"pointer",fontSize:11,color:dn.text,padding:"1px 5px",lineHeight:1.4}}>+</button>
        </div>
        <button onClick={e=>{e.stopPropagation();onDelete(item.id);}} style={{background:"none",border:"none",cursor:"pointer",fontSize:13,color:dn.text,opacity:0.4,padding:0,lineHeight:1}}
          onMouseEnter={e=>(e.currentTarget as HTMLElement).style.opacity="1"}
          onMouseLeave={e=>(e.currentTarget as HTMLElement).style.opacity="0.4"}>×</button>
      </div>
      <textarea value={item.text||""} onChange={e=>onChange(item.id,{text:e.target.value})}
        onMouseDown={e=>e.stopPropagation()} placeholder="Type your note..."
        style={{width:"100%",background:"none",border:"none",outline:"none",padding:"4px 13px 13px",fontSize:item.fontSize||12,lineHeight:1.75,color:dn.text,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:item.fontBold?700:400,resize:"none",minHeight:item.h-32,cursor:"text",boxSizing:"border-box",opacity:0.9}} />
      {/* Resize handles — visible when selected */}
    </div>
      {selected && <ResizeHandles onResize={onResize} />}
    </div>
  );

  if (item.type==="image") return (
    <div style={wrapper}>
    <div style={{...base, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", overflow:"hidden"}}
      onMouseDown={e=>{onSelect(item.id);onDragStart(e,item.id);}}>
      <img src={item.src} alt={item.caption} style={{width:"100%",height:item.h-28,objectFit:"cover",display:"block"}} />
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"5px 10px"}}>
        <span style={{fontSize:9,color:"rgba(255,255,255,0.3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{item.caption}</span>
        <button onClick={e=>{e.stopPropagation();onDelete(item.id);}} style={{background:"none",border:"none",cursor:"pointer",fontSize:13,color:"rgba(255,255,255,0.25)",padding:0,lineHeight:1,flexShrink:0}}>×</button>
      </div>
    </div>
      {selected && <ResizeHandles onResize={onResize} />}
    </div>
  );

  if (item.type==="link") return (
    <div style={wrapper}>
    <div style={{...base, background:"rgba(56,189,248,0.05)", border:"1px solid rgba(56,189,248,0.15)", padding:"10px 12px", display:"flex", alignItems:"center", gap:10}}
      onMouseDown={e=>{onSelect(item.id);onDragStart(e,item.id);}}>
      <div style={{width:26,height:26,borderRadius:7,background:"rgba(56,189,248,0.1)",border:"1px solid rgba(56,189,248,0.2)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(56,189,248,0.7)" strokeWidth="2" strokeLinecap="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:11,fontWeight:600,color:"#7dd3fc",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.title}</div>
        <div style={{fontSize:9,color:"rgba(255,255,255,0.2)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1}}>{item.url}</div>
      </div>
      <div style={{display:"flex",gap:6,flexShrink:0}}>
        <a href={item.url} target="_blank" rel="noreferrer" onMouseDown={e=>e.stopPropagation()} style={{fontSize:11,color:"#7dd3fc",textDecoration:"none",fontWeight:700,opacity:0.7}}>↗</a>
        <button onClick={e=>{e.stopPropagation();onDelete(item.id);}} style={{background:"none",border:"none",cursor:"pointer",fontSize:13,color:"rgba(255,255,255,0.2)",padding:0,lineHeight:1}}>×</button>
      </div>
    </div>
      {selected && <ResizeHandles onResize={onResize} />}
    </div>
  );

  return null;
}

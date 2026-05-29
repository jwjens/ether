import { useState, useEffect, useRef, useCallback } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";

// ── Types ─────────────────────────────────────────────────────

type NoteColor = "yellow" | "pink" | "cyan" | "green" | "purple" | "white";
type ItemType = "note" | "image" | "link" | "ai";

interface BoardItem {
  id: string;
  type: ItemType;
  x: number;
  y: number;
  w: number;
  h: number;
  // note
  text?: string;
  color?: NoteColor;
  fontSize?: number;
  fontBold?: boolean;
  // image
  src?: string;
  caption?: string;
  // link
  url?: string;
  title?: string;
  // ai
  question?: string;
  answer?: string;
  loading?: boolean;
  // show notes metadata
  createdAt?: string;       // ISO timestamp set at creation
  showName?: string;        // current show name at creation time
  linkedTrack?: { title: string; artist: string } | null;
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

const NOTE_COLORS: Record<NoteColor, { bg: string; border: string; text: string }> = {
  yellow: { bg: "#fef9c3", border: "#fde047", text: "#713f12" },
  pink:   { bg: "#fce7f3", border: "#f9a8d4", text: "#831843" },
  cyan:   { bg: "#e0f2fe", border: "#7dd3fc", text: "#0c4a6e" },
  green:  { bg: "#dcfce7", border: "#86efac", text: "#14532d" },
  purple: { bg: "#f3e8ff", border: "#d8b4fe", text: "#581c87" },
  white:  { bg: "var(--bg-secondary)", border: "var(--border-primary)", text: "var(--text-primary)" },
};

// ── AI call — routed through Electron main process ────────────
async function askAI(messages: Message[]): Promise<string> {
  try {
    const ether = (window as any).ether;
    if (ether?.invoke) {
      return await ether.invoke("ai:ask", messages);
    }
    // Fallback for plain browser dev mode
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      }),
    });
    const d = await r.json();
    return d.content?.[0]?.text || "No response";
  } catch (e: any) {
    return `Couldn't reach AI: ${e.message}`;
  }
}

// ── Main Component ────────────────────────────────────────────

interface Props {
  onClose: () => void;
  episodeTitle?: string;
  nowPlaying?: string;
  nowPlayingTrack?: { title: string; artist: string } | null;
}

export default function ProducerDesk({ onClose, episodeTitle, nowPlaying, nowPlayingTrack }: Props) {
  const { stationId, isReady } = useActiveStation();
  // Window position/size
  const [minimized, setMinimized] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [pos, setPos] = useState({ x: 80, y: 80 });
  const [size, setSize] = useState({ w: 860, h: 580 });
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const dragStart = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });
  const resizeStart = useRef({ mx: 0, my: 0, ow: 0, oh: 0 });
  const windowRef = useRef<HTMLDivElement>(null);

  // Tabs
  const [tab, setTab] = useState<"board" | "ai">("board");

  // Board items — load from localStorage on mount
  const [items, setItems] = useState<BoardItem[]>(() => {
    try {
      const saved = localStorage.getItem("ether_producer_desk");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    // Default starter board
    return [
      { id: "1", type: "note", x: 20, y: 20, w: 180, h: 140, text: "Episode ideas\n\n• Guest topics\n• Music breaks\n• Sponsor spots", color: "yellow" },
      { id: "2", type: "note", x: 220, y: 20, w: 180, h: 120, text: "Research links\n\n", color: "cyan" },
    ];
  });
  const [draggingItem, setDraggingItem] = useState<string | null>(null);
  const itemDragStart = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });
  const boardRef = useRef<HTMLDivElement>(null);
  const [selectedNote, setSelectedNote] = useState<string | null>(null);

  // AI chat
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: `Hey! I'm your producer AI. Ask me anything — episode ideas, interview questions, segment structure, topic research, title suggestions... What are we working on${episodeTitle ? ` for "${episodeTitle}"` : ""}?` }
  ]);
  const [input, setInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const [aiKeyConfigured, setAiKeyConfigured] = useState<boolean | null>(null);

  // Show notes context
  const [currentShowName, setCurrentShowName] = useState<string>("");
  const [archiveOpen, setArchiveOpen]         = useState(false);
  const [archiveSearch, setArchiveSearch]     = useState("");
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [exportFlash, setExportFlash]         = useState(false);

  // ── Save ─────────────────────────────────────────────────────
  const saveDesk = () => {
    try {
      localStorage.setItem("ether_producer_desk", JSON.stringify(items));
      setSavedMsg("Saved!");
      setTimeout(() => setSavedMsg(""), 2000);
    } catch {
      setSavedMsg("Failed");
      setTimeout(() => setSavedMsg(""), 2000);
    }
  };

  const setItemsAndSave = (updater: (prev: BoardItem[]) => BoardItem[]) => {
    setItems(prev => {
      const next = updater(prev);
      try { localStorage.setItem("ether_producer_desk", JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // Belt-and-suspenders: also save on any items change
  useEffect(() => {
    if (items.length === 0) return; // don't overwrite with empty on first render edge case
    try { localStorage.setItem("ether_producer_desk", JSON.stringify(items)); } catch {}
  }, [items]);

  // ── Window drag ──────────────────────────────────────────────
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    dragStart.current = { mx: e.clientX, my: e.clientY, ox: pos.x, oy: pos.y };
  }, [pos]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      setPos({
        x: Math.max(0, dragStart.current.ox + e.clientX - dragStart.current.mx),
        y: Math.max(0, dragStart.current.oy + e.clientY - dragStart.current.my),
      });
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [dragging]);

  // ── Window resize ────────────────────────────────────────────
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing(true);
    resizeStart.current = { mx: e.clientX, my: e.clientY, ow: size.w, oh: size.h };
  }, [size]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      setSize({
        w: Math.max(500, resizeStart.current.ow + e.clientX - resizeStart.current.mx),
        h: Math.max(400, resizeStart.current.oh + e.clientY - resizeStart.current.my),
      });
    };
    const onUp = () => setResizing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [resizing]);

  // ── Board item drag ──────────────────────────────────────────
  const startItemDrag = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const item = items.find(i => i.id === id)!;
    setDraggingItem(id);
    itemDragStart.current = { mx: e.clientX, my: e.clientY, ox: item.x, oy: item.y };
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

  // ── Add items ────────────────────────────────────────────────
  const addNote = (color: NoteColor = "yellow") => {
    const id = Date.now().toString();
    const now = new Date();
    setItemsAndSave(p => [...p, {
      id, type: "note",
      x: 40 + Math.random() * 200, y: 40 + Math.random() * 100,
      w: 190, h: 150,
      text: "", color,
      createdAt: now.toISOString(),
      showName: currentShowName,
    }]);
    setSelectedNote(id);
  };

  const addFromTemplate = (tpl: string) => {
    const templates: Record<string, string> = {
      intro:    "SHOW INTRO\n\nGood [morning/afternoon/evening], you're listening to [Station]. I'm [Name].\n\nToday on the show:\n• \n• \n• ",
      sponsor:  "SPONSOR READ — [Sponsor Name]\n\n[Opening line]\n\n[Key messages]\n• \n• \n\n[CTA + Tagline]",
      bio:      "ARTIST BIO — [Artist Name]\n\nOrigin: \nGenre: \nNotable works: \n\nFun fact: \n\nOn-air tease: ",
      weather:  "WEATHER / TRAFFIC\n\nTemp: \nConditions: \nWind: \n\nTraffic:\n• \n• ",
      shoutout: "LISTENER SHOUTOUT\n\nName: \nLocation: \nMessage: \n\nOn-air response: ",
    };
    const id = Date.now().toString();
    const now = new Date();
    setItemsAndSave(p => [...p, {
      id, type: "note" as const,
      x: 40 + Math.random() * 200, y: 40 + Math.random() * 100,
      w: 230, h: 200,
      text: templates[tpl] || "",
      color: "white" as NoteColor,
      createdAt: now.toISOString(),
      showName: currentShowName,
    }]);
    setSelectedNote(id);
    setTemplateMenuOpen(false);
  };

  const linkToCurrentTrack = (noteId: string) => {
    if (!nowPlayingTrack) return;
    setItemsAndSave(p => p.map(i =>
      i.id === noteId ? { ...i, linkedTrack: { ...nowPlayingTrack } } : i
    ));
  };

  const pushToCart = async (text: string) => {
    try {
      const rows = await queryScoped<{ slot_number: number }>("SELECT slot_number FROM cart_slots ORDER BY slot_number", [], stationId);
      const used = new Set(rows.map(r => r.slot_number));
      let slot = -1;
      for (let i = 0; i < 18; i++) { if (!used.has(i)) { slot = i; break; } }
      if (slot === -1) { alert("All 18 cart slots are full."); return; }
      const label = text.slice(0, 40).replace(/\n/g, " ").trim();
      await (window as any).ether.cartSlots.upsertBySlotNumber(stationId, slot, { title: label, file_path: null, color: "#f59e0b", hotkey: "" });
    } catch (e) { console.error("Cart push failed", e); }
  };

  const exportNotes = async () => {
    const lines: string[] = [`=== DeskProducer Notes — ${new Date().toDateString()} ===`, ""];
    items.filter(i => i.type === "note" && i.text).forEach(i => {
      if (i.showName || i.createdAt) {
        const ts = i.createdAt
          ? new Date(i.createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
          : "";
        lines.push(`[${[i.showName, ts].filter(Boolean).join(" · ")}]`);
      }
      if (i.linkedTrack) lines.push(`♪ ${i.linkedTrack.title} — ${i.linkedTrack.artist}`);
      lines.push(i.text || "");
      lines.push("");
    });
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setExportFlash(true);
      setTimeout(() => setExportFlash(false), 2000);
    } catch {}
  };

  const addLink = () => {
    const url = prompt("Paste a URL:");
    if (!url) return;
    const id = Date.now().toString();
    setItemsAndSave(p => [...p, {
      id, type: "link",
      x: 40 + Math.random() * 200, y: 40 + Math.random() * 100,
      w: 220, h: 80,
      url, title: url.replace(/^https?:\/\//, "").split("/")[0],
    }]);
  };

  const handleImageDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const id = Date.now().toString();
      const boardRect = boardRef.current?.getBoundingClientRect();
      setItemsAndSave(p => [...p, {
        id, type: "image",
        x: e.clientX - (boardRect?.left || 0) - 75,
        y: e.clientY - (boardRect?.top || 0) - 75,
        w: 200, h: 160,
        src: ev.target?.result as string,
        caption: file.name,
      }]);
    };
    reader.readAsDataURL(file);
  };

  // ── AI key check ─────────────────────────────────────────────
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.invoke) { setAiKeyConfigured(true); return; }
    Promise.all([ether.invoke("ai:getKeyStatus"), ether.invoke("ai:getProvider")])
      .then(([status, provider]: any[]) => setAiKeyConfigured(!!(status?.[provider])))
      .catch(() => setAiKeyConfigured(true));
  }, []);

  // ── Current show name ────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const hour = new Date().getHours();
        const shows = await queryScoped<{ name: string; start_hour: number; end_hour: number }>(
          "SELECT name, start_hour, end_hour FROM shows WHERE is_active = 1 ORDER BY start_hour",
          [], stationId
        );
        const curr = shows.find(s => {
          if (s.end_hour === 0 || s.end_hour === s.start_hour) return hour >= s.start_hour;
          if (s.end_hour > s.start_hour) return hour >= s.start_hour && hour < s.end_hour;
          return hour >= s.start_hour || hour < s.end_hour;
        });
        setCurrentShowName(curr?.name ?? "");
      } catch {}
    };
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Iris voice-to-note: "Iris, note this <content>" ──────────
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.iris) return;
    const h = ether.iris.onCommand((c: { action: string; label: string }) => {
      const raw = (c.label || c.action || "").toLowerCase();
      if (!raw.includes("note")) return;
      const text = (c.label || c.action)
        .replace(/^iris[,.]?\s*/i, "")
        .replace(/^note\s+(this\s+)?/i, "")
        .trim();
      const id = Date.now().toString();
      const now = new Date();
      setItemsAndSave(p => [...p, {
        id, type: "note" as const,
        x: 40 + Math.random() * 200, y: 40 + Math.random() * 100,
        w: 220, h: 160,
        text: text || "(Iris note)",
        color: "cyan" as NoteColor,
        createdAt: now.toISOString(),
        showName: currentShowName,
      }]);
    });
    return () => ether.iris.offCommand(h);
  }, [currentShowName]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Iris live-wire presence (L1): lit when Iris's SSE stream is connected ──
  const [irisLive, setIrisLive] = useState(false);
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.iris?.onConnected) return;
    const h = ether.iris.onConnected((v: boolean) => setIrisLive(!!v));
    return () => ether.iris.offConnected?.(h);
  }, []);

  // ── AI chat ──────────────────────────────────────────────────
  const sendMessage = async () => {
    if (!input.trim() || aiLoading) return;
    const userMsg: Message = { role: "user", content: input.trim() };
    setMessages(p => [...p, userMsg]);
    setInput("");
    setAiLoading(true);
    const reply = await askAI([...messages, userMsg]);
    setMessages(p => [...p, { role: "assistant", content: reply }]);
    setAiLoading(false);
  };

  const sendQuick = async (prompt: string) => {
    if (aiLoading) return;
    const userMsg: Message = { role: "user", content: prompt };
    setMessages(p => [...p, userMsg]);
    setAiLoading(true);
    const reply = await askAI([...messages, userMsg]);
    if (reply === "__NO_KEY__") {
      setAiKeyConfigured(false);
      setMessages(p => p.slice(0, -1)); // remove the user message
    } else {
      setMessages(p => [...p, { role: "assistant", content: reply }]);
    }
    setAiLoading(false);
  };

  const sendWeather = async () => {
    if (aiLoading) return;
    const ether = (window as any).ether;
    let weatherCtx = "";
    if (ether?.invoke) {
      const data = await ether.invoke("weather:getLasVegas").catch(() => null);
      if (data) weatherCtx = `Current Las Vegas conditions: ${data.temp}°F (feels like ${data.feels_like}°F), ${data.description}, humidity ${data.humidity}%, wind ${data.wind_speed} mph. `;
    }
    const prompt = weatherCtx
      ? `${weatherCtx}Give me a brief, broadcast-ready weather report for Las Vegas.`
      : "What's the current weather in Las Vegas? Give me a quick on-air-ready summary.";
    sendQuick(prompt);
  };

  const quickButtons: { label: string; action: () => void }[] = [
    { label: "Weather", action: sendWeather },
    { label: "News",    action: () => sendQuick("What are the top news stories right now? Summarize the 3 most interesting ones briefly.") },
    { label: "Now Playing", action: () => sendQuick(nowPlaying ? `Tell me something interesting about "${nowPlaying}" I can say on air — fun facts, artist background, why this song matters.` : "What's a good way to introduce the current song on air?") },
    { label: "Break Idea",  action: () => sendQuick("Give me a creative, engaging break idea I can do right now in a live radio show.") },
    { label: "Show Notes",  action: () => sendQuick("Write brief, punchy show notes for this segment of the show.") },
  ];

  // Pin AI response to board
  const pinToBoard = (content: string) => {
    const id = Date.now().toString();
    setItemsAndSave(p => [...p, {
      id, type: "note",
      x: 40 + Math.random() * 150, y: 40 + Math.random() * 80,
      w: 210, h: 180,
      text: content, color: "purple",
    }]);
    setTab("board");
  };

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, aiLoading]);

  // Ctrl+S to save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveDesk(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items]);

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div
      ref={windowRef}
      style={{
        position: "fixed" as const,
        left: pos.x, top: pos.y,
        width: minimized ? 300 : size.w,
        height: minimized ? "auto" : size.h,
        zIndex: 11000,
        borderRadius: 0,
        background: "linear-gradient(160deg, rgba(18,18,26,0.97) 0%, rgba(12,12,20,0.98) 100%)",
        border: "1px solid rgba(255,255,255,0.07)",
        boxShadow: "0 40px 100px rgba(0,0,0,0.8), 0 0 0 0.5px rgba(255,255,255,0.04), inset 0 1px 0 rgba(255,255,255,0.06)",
        display: "flex", flexDirection: "column" as const,
        overflow: "hidden",
        fontFamily: "'Inter', system-ui, sans-serif",
        userSelect: dragging || draggingItem ? "none" : "auto" as any,
        cursor: dragging ? "grabbing" : "default",
      }}
    >
      {/* ── Title bar ── */}
      <div
        onMouseDown={startDrag}
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "12px 16px",
          borderBottom: minimized ? "none" : "1px solid rgba(255,255,255,0.05)",
          cursor: "grab", flexShrink: 0, userSelect: "none",
        }}
      >
        {/* Traffic lights */}
        <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
          <div style={{ width: 11, height: 11, borderRadius: "50%", background: "rgba(255,95,87,0.2)", border: "0.5px solid rgba(255,95,87,0.25)" }} title="Close with × →" />
          <button
            onClick={() => setMinimized(m => !m)}
            style={{ width: 11, height: 11, borderRadius: "50%", background: "#ffbd2e", border: "none", cursor: "pointer", padding: 0, transition: "all 0.15s", boxShadow: "0 0 8px rgba(255,189,46,0.5)" }}
            title={minimized ? "Expand" : "Minimize"}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.transform = "scale(1.2)"}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.transform = "scale(1)"}
          />
          <div style={{ width: 11, height: 11, borderRadius: "50%", background: "rgba(255,255,255,0.07)", border: "0.5px solid rgba(255,255,255,0.1)" }} />
        </div>

        {/* Wordmark */}
        <div style={{ flex: 1, paddingLeft: 6 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{
              fontSize: 12, fontWeight: 800, color: "rgba(255,255,255,0.85)",
              letterSpacing: "0.04em", textTransform: "uppercase" as const,
              fontFamily: "'Syne', sans-serif",
            }}>Desk</span>
            {!minimized && episodeTitle && (
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.22)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, maxWidth: 160 }}>
                {episodeTitle}
              </span>
            )}
          </div>
        </div>

        {/* Iris presence (L1 live-wire) */}
        {!minimized && (
          <div title={irisLive ? "Iris connected — live wire active" : "Iris offline"}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 0,
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%",
              background: irisLive ? "#34d399" : "rgba(255,255,255,0.18)",
              boxShadow: irisLive ? "0 0 6px rgba(52,211,153,0.7)" : "none", transition: "all 0.2s" }} />
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" as const,
              color: irisLive ? "#34d399" : "rgba(255,255,255,0.25)" }}>Iris</span>
          </div>
        )}

        {/* Right controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {!minimized && (
            savedMsg ? (
              <span style={{ fontSize: 9, color: "#34d399", fontWeight: 800, letterSpacing: "0.08em" }}>✓ SAVED</span>
            ) : (
              <button onMouseDown={e => e.stopPropagation()} onClick={saveDesk}
                style={{ padding: "3px 9px", borderRadius: 0, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.3)", fontSize: 9, fontWeight: 700, cursor: "pointer", transition: "all 0.15s", letterSpacing: "0.06em", textTransform: "uppercase" as const }}
                onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = "rgba(52,211,153,0.1)"; el.style.borderColor = "rgba(52,211,153,0.3)"; el.style.color = "#34d399"; }}
                onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "rgba(255,255,255,0.04)"; el.style.borderColor = "rgba(255,255,255,0.08)"; el.style.color = "rgba(255,255,255,0.3)"; }}
              >Save</button>
            )
          )}

          {!minimized && (
            <div style={{ display: "flex", gap: 1, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 0, padding: "2px" }}>
              {(["board", "ai"] as const).map(id => (
                <button key={id} onMouseDown={e => e.stopPropagation()} onClick={() => setTab(id)} style={{
                  padding: "3px 11px", borderRadius: 0, border: "none",
                  background: tab === id ? "rgba(255,255,255,0.10)" : "none",
                  color: tab === id ? "rgba(255,255,255,0.88)" : "rgba(255,255,255,0.28)",
                  fontSize: 10, fontWeight: tab === id ? 700 : 400,
                  cursor: "pointer", transition: "all 0.15s", letterSpacing: "0.01em",
                }}>
                  {id === "board" ? "Board" : "✦ AI"}
                </button>
              ))}
            </div>
          )}

          <button onMouseDown={e => e.stopPropagation()} onClick={onClose}
            style={{ background: "none", border: "none", color: "rgba(255,255,255,0.18)", fontSize: 15, cursor: "pointer", lineHeight: 1, padding: "0 2px", transition: "color 0.15s" }}
            title="Close — board is saved"
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.65)"}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.18)"}
          >×</button>
        </div>
      </div>

      {/* ── BOARD TAB ── */}
      {!minimized && tab === "board" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, minHeight: 0 }}>

          {/* Toolbar */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)", flexShrink: 0 }}>
            {/* Color swatches */}
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              {(["yellow", "pink", "cyan", "green", "purple"] as NoteColor[]).map(c => (
                <button key={c} onClick={() => addNote(c)} title={`Add ${c} note`} style={{
                  width: 16, height: 16, borderRadius: 0,
                  background: NOTE_COLORS[c].bg,
                  border: `1.5px solid ${NOTE_COLORS[c].border}`,
                  cursor: "pointer", padding: 0,
                  transition: "transform 0.12s, box-shadow 0.12s",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
                }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1.3) translateY(-1px)"; (e.currentTarget as HTMLElement).style.boxShadow = "0 3px 8px rgba(0,0,0,0.6)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; (e.currentTarget as HTMLElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.5)"; }}
                />
              ))}
            </div>

            <div style={{ width: 1, height: 12, background: "rgba(255,255,255,0.08)", margin: "0 3px" }} />

            <button onClick={addLink} style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 9px", borderRadius: 0,
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
              color: "rgba(255,255,255,0.4)", fontSize: 10, fontWeight: 600, cursor: "pointer",
              transition: "all 0.15s",
            }}
              onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = "rgba(255,255,255,0.09)"; el.style.color = "rgba(255,255,255,0.8)"; }}
              onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "rgba(255,255,255,0.04)"; el.style.color = "rgba(255,255,255,0.4)"; }}
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              Link
            </button>

            {/* Template dropdown */}
            <div style={{ position: "relative" }} onMouseDown={e => e.stopPropagation()}>
              <button onClick={() => setTemplateMenuOpen(o => !o)} style={{
                display: "flex", alignItems: "center", gap: 3,
                padding: "3px 9px", borderRadius: 0,
                background: templateMenuOpen ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "rgba(255,255,255,0.5)", fontSize: 10, fontWeight: 600, cursor: "pointer",
              }}>+ Template</button>
              {templateMenuOpen && (
                <div style={{
                  position: "absolute", top: "100%", left: 0, zIndex: 500, marginTop: 2,
                  background: "#1a1a24", border: "1px solid rgba(255,255,255,0.12)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
                  minWidth: 160,
                }}>
                  {[
                    ["intro",    "Show Intro"],
                    ["sponsor",  "Sponsor Read"],
                    ["bio",      "Artist Bio"],
                    ["weather",  "Weather / Traffic"],
                    ["shoutout", "Listener Shoutout"],
                  ].map(([k, label]) => (
                    <button key={k} onClick={() => addFromTemplate(k)} style={{
                      display: "block", width: "100%", textAlign: "left",
                      padding: "8px 12px", background: "none", border: "none",
                      color: "rgba(255,255,255,0.75)", fontSize: 11, cursor: "pointer",
                      borderBottom: "1px solid rgba(255,255,255,0.05)",
                    }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.07)"}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "none"}
                    >{label}</button>
                  ))}
                </div>
              )}
            </div>

            <button onClick={() => setTab("ai")} style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 9px", borderRadius: 0,
              background: "rgba(167,139,250,0.07)", border: "1px solid rgba(167,139,250,0.15)",
              color: "rgba(167,139,250,0.7)", fontSize: 10, fontWeight: 600, cursor: "pointer",
              transition: "all 0.15s",
            }}
              onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = "rgba(167,139,250,0.15)"; el.style.color = "#a78bfa"; }}
              onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "rgba(167,139,250,0.07)"; el.style.color = "rgba(167,139,250,0.7)"; }}
            >
              ✦ Ask AI
            </button>

            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
              <button onClick={() => setArchiveOpen(o => !o)} title="Past Notes" style={{
                padding: "3px 9px", borderRadius: 0,
                background: archiveOpen ? "rgba(56,189,248,0.12)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${archiveOpen ? "rgba(56,189,248,0.3)" : "rgba(255,255,255,0.08)"}`,
                color: archiveOpen ? "#7dd3fc" : "rgba(255,255,255,0.35)",
                fontSize: 10, fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
              }}>📂 Past Notes</button>
              <button onClick={exportNotes} title="Copy all notes to clipboard" style={{
                padding: "3px 9px", borderRadius: 0,
                background: exportFlash ? "rgba(52,211,153,0.15)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${exportFlash ? "rgba(52,211,153,0.4)" : "rgba(255,255,255,0.08)"}`,
                color: exportFlash ? "#34d399" : "rgba(255,255,255,0.35)",
                fontSize: 10, fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
              }}>{exportFlash ? "✓ Copied" : "↑ Export"}</button>
            </div>
          </div>

          {/* Canvas — dark dot grid */}
          <div
            ref={boardRef}
            onDragOver={e => e.preventDefault()}
            onDrop={handleImageDrop}
            onClick={() => setSelectedNote(null)}
            style={{
              flex: 1, position: "relative" as const, overflow: "hidden",
              background: "rgba(8,8,14,0.95)",
              backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.055) 1px, transparent 1px)",
              backgroundSize: "22px 22px",
            }}
          >
            {items.map(item => (
              <BoardItemCard
                key={item.id}
                item={item}
                selected={selectedNote === item.id}
                dragging={draggingItem === item.id}
                onDragStart={startItemDrag}
                onSelect={setSelectedNote}
                onChange={(id, updates) => setItemsAndSave(p => p.map(i => i.id === id ? { ...i, ...updates } : i))}
                onDelete={id => setItemsAndSave(p => p.filter(i => i.id !== id))}
                onPin={pinToBoard}
                onLink={nowPlayingTrack ? linkToCurrentTrack : undefined}
                onCart={text => pushToCart(text)}
                nowPlayingTrack={nowPlayingTrack}
              />
            ))}

            {items.length === 0 && (
              <div style={{ position: "absolute" as const, inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column" as const, gap: 8, pointerEvents: "none" }}>
                <div style={{ fontSize: 32, opacity: 0.15 }}>✦</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.15)", letterSpacing: "0.02em" }}>Empty board</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.08)" }}>Add notes · drop images · paste links</div>
              </div>
            )}
          </div>

          {/* Status bar */}
          <div style={{ flexShrink: 0, padding: "5px 16px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.18)", letterSpacing: "0.03em" }}>
              Auto-saves to this browser
            </span>
            {savedMsg ? (
              <span style={{ fontSize: 9, color: "#34d399", fontWeight: 700 }}>✓ Saved</span>
            ) : (
              <span style={{ fontSize: 9, color: "rgba(255,255,255,0.12)" }}>⌘S</span>
            )}
          </div>
        </div>
      )}

      {/* ── AI TAB ── */}
      {!minimized && tab === "ai" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, minHeight: 0 }}>
          {/* No-key disclaimer */}
          {aiKeyConfigured === false && (
            <div style={{ margin: "16px 18px", padding: "12px 16px", borderRadius: 0, background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.2)", fontSize: 12, color: "rgba(251,191,36,0.9)", lineHeight: 1.6 }}>
              AI features require your own API key — add yours in{" "}
              <span style={{ fontWeight: 700 }}>Settings → AI &amp; Integrations</span>.
            </div>
          )}
          {/* Messages */}
          <div ref={chatRef} style={{ flex: 1, overflowY: "auto" as const, padding: "16px 18px", display: "flex", flexDirection: "column" as const, gap: 12 }}>
            {messages.map((msg, i) => (
              <div key={i} style={{ display: "flex", gap: 10, flexDirection: msg.role === "user" ? "row-reverse" : "row" }}>
                {msg.role === "assistant" && (
                  <div style={{ width: 26, height: 26, borderRadius: 0, background: "linear-gradient(135deg, rgba(167,139,250,0.3), rgba(56,189,248,0.3))", border: "1px solid rgba(167,139,250,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, flexShrink: 0, marginTop: 2 }}>✦</div>
                )}
                <div style={{
                  maxWidth: "78%",
                  padding: "10px 13px",
                  borderRadius: msg.role === "user" ? "13px 13px 4px 13px" : "4px 13px 13px 13px",
                  background: msg.role === "user"
                    ? "linear-gradient(135deg, rgba(56,189,248,0.2), rgba(56,189,248,0.12))"
                    : "rgba(255,255,255,0.05)",
                  border: msg.role === "user"
                    ? "1px solid rgba(56,189,248,0.2)"
                    : "1px solid rgba(255,255,255,0.07)",
                  color: "rgba(255,255,255,0.82)",
                  fontSize: 12, lineHeight: 1.7,
                }}>
                  <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
                  {msg.role === "assistant" && i > 0 && (
                    <button onClick={() => pinToBoard(msg.content)} style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "rgba(167,139,250,0.5)", fontSize: 10, cursor: "pointer", padding: 0, fontWeight: 600, transition: "color 0.15s" }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "#a78bfa"}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "rgba(167,139,250,0.5)"}
                    >
                      ✦ Pin to board
                    </button>
                  )}
                </div>
              </div>
            ))}
            {aiLoading && (
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <div style={{ width: 26, height: 26, borderRadius: 0, background: "linear-gradient(135deg, rgba(167,139,250,0.3), rgba(56,189,248,0.3))", border: "1px solid rgba(167,139,250,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>✦</div>
                <div style={{ display: "flex", gap: 4, padding: "11px 14px", background: "rgba(255,255,255,0.05)", borderRadius: "4px 13px 13px 13px", border: "1px solid rgba(255,255,255,0.07)" }}>
                  {[0, 1, 2].map(i => (
                    <div key={i} style={{ width: 5, height: 5, borderRadius: "50%", background: "rgba(167,139,250,0.6)", animation: `bounce 1.2s ease-in-out ${i * 0.15}s infinite` }} />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Quick-tap buttons */}
          <div style={{ padding: "8px 16px 6px", display: "flex", gap: 5, flexWrap: "wrap" as const, flexShrink: 0, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
            {quickButtons.map(({ label, action }) => (
              <button key={label} onClick={action} disabled={aiLoading} style={{
                padding: "4px 11px", borderRadius: 0,
                border: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(255,255,255,0.03)",
                color: aiLoading ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.55)",
                fontSize: 10, cursor: aiLoading ? "default" : "pointer", transition: "all 0.12s",
                whiteSpace: "nowrap" as const, letterSpacing: "0.01em", fontWeight: 600,
              }}
                onMouseEnter={e => { if (!aiLoading) { const el = e.currentTarget as HTMLElement; el.style.borderColor = "rgba(167,139,250,0.4)"; el.style.color = "#a78bfa"; el.style.background = "rgba(167,139,250,0.1)"; } }}
                onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = "rgba(255,255,255,0.08)"; el.style.color = aiLoading ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.55)"; el.style.background = "rgba(255,255,255,0.03)"; }}
              >{label}</button>
            ))}
          </div>

          {/* Input */}
          <div style={{ padding: "10px 14px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder="Ask anything about your episode..."
              style={{
                flex: 1, padding: "9px 14px", borderRadius: 0,
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "rgba(255,255,255,0.85)", fontSize: 12, outline: "none",
                fontFamily: "inherit", transition: "border-color 0.15s",
              }}
              onFocus={e => (e.currentTarget as HTMLElement).style.borderColor = "rgba(167,139,250,0.35)"}
              onBlur={e => (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.08)"}
            />
            <button onClick={sendMessage} disabled={aiLoading || !input.trim()} style={{
              width: 36, height: 36, borderRadius: 0, border: "none",
              background: input.trim() && !aiLoading ? "rgba(167,139,250,0.8)" : "rgba(255,255,255,0.05)",
              color: input.trim() && !aiLoading ? "#fff" : "rgba(255,255,255,0.2)",
              cursor: input.trim() && !aiLoading ? "pointer" : "default",
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all 0.15s", flexShrink: 0,
              boxShadow: input.trim() && !aiLoading ? "0 2px 12px rgba(167,139,250,0.3)" : "none",
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Past Notes archive drawer ── */}
      {archiveOpen && !minimized && (
        <div style={{
          position: "absolute", top: 48, right: 0, bottom: 0, width: 280, zIndex: 200,
          background: "#12121a", borderLeft: "1px solid rgba(255,255,255,0.08)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}>
          <div style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.5)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Past Notes</div>
            <input
              value={archiveSearch}
              onChange={e => setArchiveSearch(e.target.value)}
              placeholder="Search notes..."
              style={{
                width: "100%", padding: "5px 8px", boxSizing: "border-box",
                background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                color: "rgba(255,255,255,0.75)", fontSize: 11, outline: "none", borderRadius: 0,
                fontFamily: "inherit",
              }}
            />
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
            {(() => {
              const noteItems = items.filter(i => i.type === "note" && i.text);
              const q = archiveSearch.toLowerCase();
              const filtered = q ? noteItems.filter(i =>
                (i.text || "").toLowerCase().includes(q) ||
                (i.showName || "").toLowerCase().includes(q) ||
                (i.linkedTrack?.title || "").toLowerCase().includes(q) ||
                (i.linkedTrack?.artist || "").toLowerCase().includes(q)
              ) : noteItems;
              // Group by date + show
              const groups: Record<string, typeof filtered> = {};
              filtered.forEach(i => {
                const d = i.createdAt ? new Date(i.createdAt).toDateString() : "Untagged";
                const key = i.showName ? `${i.showName} · ${d}` : d;
                (groups[key] = groups[key] || []).push(i);
              });
              const entries = Object.entries(groups);
              if (entries.length === 0) return (
                <div style={{ padding: "20px 12px", textAlign: "center", fontSize: 11, color: "rgba(255,255,255,0.2)" }}>
                  {q ? "No matching notes" : "No notes yet"}
                </div>
              );
              return entries.map(([group, groupItems]) => (
                <div key={group}>
                  <div style={{ padding: "6px 12px 3px", fontSize: 9, fontWeight: 700, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", textTransform: "uppercase" as const }}>
                    {group}
                  </div>
                  {groupItems.map(i => (
                    <div key={i.id} style={{ padding: "6px 12px", borderBottom: "1px solid rgba(255,255,255,0.04)", cursor: "pointer" }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "none"}
                      onClick={() => setArchiveOpen(false)}
                    >
                      {i.linkedTrack && (
                        <div style={{ fontSize: 9, color: "#7dd3fc", marginBottom: 2 }}>
                          ♪ {i.linkedTrack.title}
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.65)", lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as any }}>
                        {i.text}
                      </div>
                      {i.createdAt && (
                        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", marginTop: 3 }}>
                          {new Date(i.createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ));
            })()}
          </div>
        </div>
      )}

      {/* ── Resize handle ── */}
      {!minimized && (
        <div onMouseDown={startResize} style={{ position: "absolute" as const, bottom: 0, right: 0, width: 20, height: 20, cursor: "se-resize", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
            <path d="M9 1L1 9M5 1L1 5M9 5L5 9" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
      )}

      <style>{`
        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-5px); }
        }
      `}</style>
    </div>
  );
}

// ── Board Item Card ───────────────────────────────────────────

interface CardProps {
  item: BoardItem;
  selected: boolean;
  dragging: boolean;
  onDragStart: (e: React.MouseEvent, id: string) => void;
  onSelect: (id: string | null) => void;
  onChange: (id: string, updates: Partial<BoardItem>) => void;
  onDelete: (id: string) => void;
  onPin: (content: string) => void;
  onLink?: (id: string) => void;
  onCart?: (text: string) => void;
  nowPlayingTrack?: { title: string; artist: string } | null;
}

// Richer note palette — warm paper tones on dark glass
const DARK_NOTE: Record<NoteColor, { bg: string; border: string; text: string; shadow: string }> = {
  yellow: { bg: "#2a2410", border: "rgba(253,224,71,0.25)", text: "#fde047",  shadow: "rgba(253,224,71,0.08)" },
  pink:   { bg: "#28101c", border: "rgba(249,168,212,0.25)", text: "#f9a8d4", shadow: "rgba(249,168,212,0.08)" },
  cyan:   { bg: "#0c1e28", border: "rgba(125,211,252,0.25)", text: "#7dd3fc", shadow: "rgba(125,211,252,0.08)" },
  green:  { bg: "#0d2016", border: "rgba(134,239,172,0.25)", text: "#86efac", shadow: "rgba(134,239,172,0.08)" },
  purple: { bg: "#1a1028", border: "rgba(216,180,254,0.25)", text: "#d8b4fe", shadow: "rgba(216,180,254,0.08)" },
  white:  { bg: "rgba(255,255,255,0.05)", border: "rgba(255,255,255,0.1)", text: "rgba(255,255,255,0.8)", shadow: "rgba(255,255,255,0.04)" },
};

function BoardItemCard({ item, selected, dragging, onDragStart, onSelect, onChange, onDelete, onPin, onLink, onCart, nowPlayingTrack }: CardProps) {
  const dn = item.color ? DARK_NOTE[item.color] : DARK_NOTE.white;
  const [isResizing, setIsResizing] = useState(false);
  const cardResizeData = useRef({ mx: 0, my: 0, ow: 0, oh: 0, ox: 0, oy: 0, dir: "se" as "se" | "sw" | "ne" | "nw" });

  const startCardResize = useCallback((e: React.MouseEvent, dir: "se" | "sw" | "ne" | "nw") => {
    e.preventDefault();
    e.stopPropagation();
    cardResizeData.current = { mx: e.clientX, my: e.clientY, ow: item.w, oh: item.h, ox: item.x, oy: item.y, dir };
    setIsResizing(true);
  }, [item.w, item.h, item.x, item.y]);

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e: MouseEvent) => {
      const { mx, my, ow, oh, ox, oy, dir } = cardResizeData.current;
      const dx = e.clientX - mx;
      const dy = e.clientY - my;
      const newW = Math.max(120, (dir === "se" || dir === "ne") ? ow + dx : ow - dx);
      const newH = Math.max(80, (dir === "se" || dir === "sw") ? oh + dy : oh - dy);
      const updates: Partial<BoardItem> = { w: newW, h: newH };
      if (dir === "sw" || dir === "nw") updates.x = Math.max(0, ox + ow - newW);
      if (dir === "ne" || dir === "nw") updates.y = Math.max(0, oy + oh - newH);
      onChange(item.id, updates);
    };
    const onUp = () => setIsResizing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [isResizing]); // eslint-disable-line react-hooks/exhaustive-deps

  const baseStyle: React.CSSProperties = {
    position: "absolute",
    left: item.x, top: item.y,
    width: item.w, minHeight: item.h,
    borderRadius: 0,
    boxShadow: selected
      ? `0 12px 40px rgba(0,0,0,0.6), 0 0 0 1.5px rgba(56,189,248,0.5), 0 0 24px ${dn.shadow}`
      : dragging
      ? `0 20px 50px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.1)`
      : `0 4px 16px rgba(0,0,0,0.4), 0 0 0 0.5px rgba(255,255,255,0.06)`,
    transition: dragging ? "none" : "box-shadow 0.2s",
    cursor: dragging ? "grabbing" : "grab",
    zIndex: selected || dragging ? 100 : 1,
    userSelect: "none" as const,
    overflow: "hidden",
  };

  if (item.type === "note") {
    const tsLabel = (() => {
      const parts: string[] = [];
      if (item.showName) parts.push(item.showName);
      if (item.createdAt) {
        const d = new Date(item.createdAt);
        parts.push(d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }));
        parts.push(d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }));
      }
      return parts.join(" · ");
    })();
    return (
      <div
        style={{ ...baseStyle, background: dn.bg, border: `1px solid ${dn.border}`, minHeight: undefined, height: item.h, display: "flex", flexDirection: "column" }}
        onMouseDown={e => { if (isResizing) return; onSelect(item.id); onDragStart(e, item.id); }}
        onClick={e => { e.stopPropagation(); onSelect(item.id); }}
      >
        {/* Top accent line */}
        <div style={{ height: 2, background: `linear-gradient(90deg, ${dn.border}, transparent)`, flexShrink: 0 }} />

        {/* Timestamp header — always visible */}
        {tsLabel && (
          <div style={{ padding: "4px 10px 0", fontSize: 8.5, color: dn.text, opacity: 0.38, letterSpacing: "0.04em", lineHeight: 1.3, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tsLabel}
          </div>
        )}

        {/* Linked track badge */}
        {item.linkedTrack && (
          <div onMouseDown={e => e.stopPropagation()} style={{ margin: "3px 8px 0", padding: "2px 7px", background: "rgba(56,189,248,0.1)", border: "1px solid rgba(56,189,248,0.2)", fontSize: 9, color: "#7dd3fc", display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            <span>♪</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {item.linkedTrack.title} — {item.linkedTrack.artist}
            </span>
            <button onClick={e => { e.stopPropagation(); onChange(item.id, { linkedTrack: null }); }}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#7dd3fc", opacity: 0.5, padding: 0, marginLeft: "auto", fontSize: 11, lineHeight: 1 }}>×</button>
          </div>
        )}

        {/* Header — font controls + action buttons + delete */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px 0", opacity: selected ? 1 : 0.35, transition: "opacity 0.15s", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 3 }} onMouseDown={e => e.stopPropagation()}>
            <button onClick={e => { e.stopPropagation(); onChange(item.id, { fontBold: !item.fontBold }); }}
              style={{ background: item.fontBold ? "rgba(255,255,255,0.15)" : "none", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 0, cursor: "pointer", fontSize: 11, fontWeight: 800, color: dn.text, padding: "1px 5px", lineHeight: 1.4 }}>B</button>
            <button onClick={e => { e.stopPropagation(); onChange(item.id, { fontSize: Math.max(9, (item.fontSize || 12) - 1) }); }}
              style={{ background: "none", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 0, cursor: "pointer", fontSize: 11, color: dn.text, padding: "1px 4px", lineHeight: 1.4 }}>−</button>
            <span style={{ fontSize: 9, color: dn.text, opacity: 0.5, minWidth: 16, textAlign: "center", fontFamily: "'DM Mono',monospace" }}>{item.fontSize || 12}</span>
            <button onClick={e => { e.stopPropagation(); onChange(item.id, { fontSize: Math.min(48, (item.fontSize || 12) + 1) }); }}
              style={{ background: "none", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 0, cursor: "pointer", fontSize: 11, color: dn.text, padding: "1px 4px", lineHeight: 1.4 }}>+</button>

            {/* Link to current track */}
            {onLink && (
              <button onClick={e => { e.stopPropagation(); onLink(item.id); }}
                title={nowPlayingTrack ? `Link: ${nowPlayingTrack.title}` : "No track playing"}
                style={{ background: "none", border: "1px solid rgba(56,189,248,0.25)", borderRadius: 0, cursor: "pointer", fontSize: 9, color: "#7dd3fc", opacity: 0.7, padding: "1px 5px", lineHeight: 1.4, marginLeft: 2 }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = "1"}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = "0.7"}
              >♪</button>
            )}

            {/* Push to cart wall */}
            {onCart && item.text && (
              <button onClick={e => { e.stopPropagation(); onCart(item.text || ""); }}
                title="Send to empty cart slot"
                style={{ background: "none", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 0, cursor: "pointer", fontSize: 9, color: "#f59e0b", opacity: 0.7, padding: "1px 5px", lineHeight: 1.4 }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = "1"}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = "0.7"}
              >→□</button>
            )}
          </div>
          <button onClick={e => { e.stopPropagation(); onDelete(item.id); }}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: dn.text, opacity: 0.4, padding: 0, lineHeight: 1, transition: "opacity 0.1s" }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = "1"}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = "0.4"}
          >×</button>
        </div>
        <textarea
          value={item.text || ""}
          onChange={e => onChange(item.id, { text: e.target.value })}
          onMouseDown={e => e.stopPropagation()}
          placeholder="Type your note..."
          style={{
            flex: 1, width: "100%", background: "none", border: "none", outline: "none",
            padding: "4px 13px 13px",
            fontSize: item.fontSize || 12, lineHeight: 1.75, color: dn.text,
            fontFamily: "'Inter', system-ui, sans-serif",
            fontWeight: item.fontBold ? 700 : 400,
            resize: "none",
            cursor: "text", boxSizing: "border-box",
            opacity: 0.9,
          }}
        />
        {/* 4-corner resize handles */}
        {(["se", "sw", "ne", "nw"] as const).map(dir => (
          <div key={dir} onMouseDown={e => startCardResize(e, dir)} style={{
            position: "absolute",
            bottom: dir === "se" || dir === "sw" ? 0 : undefined,
            top: dir === "ne" || dir === "nw" ? 0 : undefined,
            right: dir === "se" || dir === "ne" ? 0 : undefined,
            left: dir === "sw" || dir === "nw" ? 0 : undefined,
            width: 16, height: 16,
            cursor: `${dir}-resize`,
            zIndex: 10,
          }} />
        ))}
      </div>
    );
  }

  if (item.type === "image") {
    return (
      <div style={{ ...baseStyle, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", overflow: "hidden" }}
        onMouseDown={e => { onSelect(item.id); onDragStart(e, item.id); }}
      >
        <img src={item.src} alt={item.caption} style={{ width: "100%", height: item.h - 28, objectFit: "cover", display: "block" }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 10px" }}>
          <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{item.caption}</span>
          <button onClick={e => { e.stopPropagation(); onDelete(item.id); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "rgba(255,255,255,0.25)", padding: 0, lineHeight: 1, flexShrink: 0 }}>×</button>
        </div>
      </div>
    );
  }

  if (item.type === "link") {
    return (
      <div style={{ ...baseStyle, background: "rgba(56,189,248,0.05)", border: "1px solid rgba(56,189,248,0.15)", padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}
        onMouseDown={e => { onSelect(item.id); onDragStart(e, item.id); }}
      >
        <div style={{ width: 26, height: 26, borderRadius: 0, background: "rgba(56,189,248,0.1)", border: "1px solid rgba(56,189,248,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(56,189,248,0.7)" strokeWidth="2" strokeLinecap="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#7dd3fc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</div>
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>{item.url}</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <a href={item.url} target="_blank" rel="noreferrer" onMouseDown={e => e.stopPropagation()} style={{ fontSize: 11, color: "#7dd3fc", textDecoration: "none", fontWeight: 700, opacity: 0.7, transition: "opacity 0.1s" }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = "1"}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = "0.7"}
          >↗</a>
          <button onClick={e => { e.stopPropagation(); onDelete(item.id); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "rgba(255,255,255,0.2)", padding: 0, lineHeight: 1 }}>×</button>
        </div>
      </div>
    );
  }

  return null;
}


// ── Inline Producer Desk (for deck slot rendering) ────────────
export function InlineProducerDesk({ episodeTitle, nowPlaying }: { episodeTitle?: string; nowPlaying?: string }) {
  const [items, setItems] = useState<BoardItem[]>(() => {
    try { return JSON.parse(localStorage.getItem("ether_desk_items_inline") || "[]"); } catch { return []; }
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggingItem, setDraggingItem] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [inlineAiKeyConfigured, setInlineAiKeyConfigured] = useState<boolean | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

  useEffect(() => {
    localStorage.setItem("ether_desk_items_inline", JSON.stringify(items));
  }, [items]);

  // Drag implementation for inline board items
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const { id, startX, startY, origX, origY } = dragRef.current;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      setItems(p => p.map(i => i.id === id ? { ...i, x: Math.max(0, origX + dx), y: Math.max(0, origY + dy) } : i));
    };
    const onUp = () => {
      dragRef.current = null;
      setDraggingItem(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  const handleItemDragStart = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    const item = items.find(i => i.id === id);
    if (!item) return;
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, origX: item.x, origY: item.y };
    setDraggingItem(id);
    setSelectedId(id);
  };

  const addNote = (color: NoteColor = "yellow") => {
    const id = Math.random().toString(36).slice(2);
    setItems(p => [...p, { id, type: "note", x: 20 + Math.random() * 60, y: 60 + Math.random() * 80, w: 180, h: 140, text: "", color, fontSize: 12, fontBold: false }]);
    setSelectedId(id);
  };

  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatLoading]);

  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.invoke) { setInlineAiKeyConfigured(true); return; }
    Promise.all([ether.invoke("ai:getKeyStatus"), ether.invoke("ai:getProvider")])
      .then(([status, provider]: any[]) => setInlineAiKeyConfigured(!!(status?.[provider])))
      .catch(() => setInlineAiKeyConfigured(true));
  }, []);

  const sendChat = async (text?: string) => {
    const content = text ?? chatInput.trim();
    if (!content || chatLoading) return;
    const userMsg: Message = { role: "user", content };
    const next = [...chatMessages, userMsg];
    setChatMessages(next);
    if (!text) setChatInput("");
    setChatLoading(true);
    try {
      const reply = await askAI(next);
      if (reply === "__NO_KEY__") {
        setInlineAiKeyConfigured(false);
        setChatMessages(m => m.slice(0, -1));
      } else {
        setChatMessages(m => [...m, { role: "assistant", content: reply }]);
      }
    } catch { setChatMessages(m => [...m, { role: "assistant", content: "Error connecting to AI." }]); }
    setChatLoading(false);
  };

  const sendWeatherInline = async () => {
    const ether = (window as any).ether;
    let weatherCtx = "";
    if (ether?.invoke) {
      const data = await ether.invoke("weather:getLasVegas").catch(() => null);
      if (data) weatherCtx = `Current Las Vegas: ${data.temp}°F (feels ${data.feels_like}°F), ${data.description}, humidity ${data.humidity}%, wind ${data.wind_speed} mph. `;
    }
    sendChat((weatherCtx ? `${weatherCtx}Give me a brief broadcast-ready weather report.` : "What's the current weather in Las Vegas? Give me an on-air-ready summary."));
  };

  const inlineQuickButtons: { label: string; action: () => void }[] = [
    { label: "Weather",     action: sendWeatherInline },
    { label: "News",        action: () => sendChat("What are the top news stories right now? Summarize the 3 most interesting ones briefly.") },
    { label: "Now Playing", action: () => sendChat(nowPlaying ? `Tell me something interesting about "${nowPlaying}" I can say on air.` : "What's a good way to introduce the current song on air?") },
    { label: "Break Idea",  action: () => sendChat("Give me a creative, engaging break idea for a live radio show right now.") },
    { label: "Show Notes",  action: () => sendChat("Write brief, punchy show notes for this segment of the show.") },
  ];

  return (
    /* position:relative so the floating AI panel anchors to this component */
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "linear-gradient(160deg, rgba(18,18,26,0.97) 0%, rgba(12,12,20,0.98) 100%)", position: "relative", fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.05)", flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: "rgba(255,255,255,0.85)", letterSpacing: "0.04em", textTransform: "uppercase", fontFamily: "'Syne', sans-serif" }}>DESK</span>
        {episodeTitle && <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{episodeTitle}</span>}
        <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
          {(["yellow","pink","cyan","green","purple"] as NoteColor[]).map(c => (
            <button key={c} onClick={() => addNote(c)} style={{ width: 14, height: 14, borderRadius: "50%", background: NOTE_COLORS[c].border, border: "none", cursor: "pointer", flexShrink: 0 }} title={`Add ${c} note`} />
          ))}
          <button onClick={() => setChatOpen(o => !o)} style={{ marginLeft: 4, padding: "3px 8px", borderRadius: 0, background: chatOpen ? "rgba(139,92,246,0.3)" : "rgba(255,255,255,0.07)", border: "1px solid rgba(139,92,246,0.4)", color: "#a78bfa", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>✦ AI</button>
        </div>
      </div>

      {/* Board — always full remaining height, never affected by AI panel */}
      <div ref={boardRef} onClick={() => setSelectedId(null)} style={{ flex: 1, position: "relative", overflow: "hidden", backgroundImage: "radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)", backgroundSize: "20px 20px" }}>
        {items.length === 0 && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <span style={{ fontSize: 24 }}>📋</span>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.25)" }}>Click a color to add a note</span>
          </div>
        )}
        {items.map(item => (
          <BoardItemCard
            key={item.id}
            item={item}
            selected={selectedId === item.id}
            dragging={draggingItem === item.id}
            onSelect={() => setSelectedId(item.id)}
            onDragStart={(e: React.MouseEvent, id: string) => handleItemDragStart(e, id)}
            onChange={(id, updates) => setItems(p => p.map(i => i.id === id ? { ...i, ...updates } : i))}
            onDelete={() => { setItems(p => p.filter(i => i.id !== item.id)); setSelectedId(null); }}
            onPin={() => {}}
          />
        ))}
      </div>

      {/* AI floating overlay — sibling of board, never affects layout */}
      {chatOpen && (
        <div style={{
          position: "absolute", bottom: 10, right: 10,
          width: 320, height: 420,
          background: "rgba(10,10,18,0.97)",
          border: "1px solid rgba(139,92,246,0.3)",
          borderRadius: 0,
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 12px 48px rgba(0,0,0,0.7), 0 0 0 0.5px rgba(139,92,246,0.15)",
          zIndex: 50,
        }}>
          {/* Panel header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#a78bfa", letterSpacing: "0.06em", textTransform: "uppercase" }}>✦ AI Assistant</span>
            <button onClick={() => setChatOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.3)", fontSize: 16, lineHeight: 1, padding: "0 2px" }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.8)"}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.3)"}
            >×</button>
          </div>

          {/* No-key disclaimer */}
          {inlineAiKeyConfigured === false && (
            <div style={{ padding: "8px 12px", fontSize: 10, color: "rgba(251,191,36,0.85)", background: "rgba(251,191,36,0.07)", borderBottom: "1px solid rgba(251,191,36,0.15)", lineHeight: 1.5, flexShrink: 0 }}>
              AI features require an API key — add yours in <strong>Settings → AI &amp; Integrations</strong>.
            </div>
          )}

          {/* Messages */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            {chatMessages.length === 0 && inlineAiKeyConfigured !== false && (
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", textAlign: "center", padding: "20px 0" }}>
                Tap a button or ask anything
              </div>
            )}
            {chatMessages.map((m, i) => (
              <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{ maxWidth: "88%", padding: "7px 10px", borderRadius: m.role === "user" ? "10px 10px 3px 10px" : "3px 10px 10px 10px", background: m.role === "user" ? "rgba(139,92,246,0.25)" : "rgba(255,255,255,0.06)", border: m.role === "user" ? "1px solid rgba(139,92,246,0.3)" : "1px solid rgba(255,255,255,0.07)", fontSize: 11, color: "rgba(255,255,255,0.85)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{m.content}</div>
              </div>
            ))}
            {chatLoading && (
              <div style={{ display: "flex", gap: 4, padding: "6px 2px" }}>
                {[0,1,2].map(i => <div key={i} style={{ width: 5, height: 5, borderRadius: "50%", background: "#a78bfa", animation: `bounce 1.2s ease-in-out ${i*0.15}s infinite` }} />)}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Quick-tap buttons */}
          <div style={{ display: "flex", gap: 4, padding: "6px 10px", flexWrap: "wrap" as const, borderTop: "1px solid rgba(255,255,255,0.05)", flexShrink: 0 }}>
            {inlineQuickButtons.map(({ label, action }) => (
              <button key={label} onClick={action} disabled={chatLoading} style={{ padding: "3px 9px", borderRadius: 0, border: "1px solid rgba(139,92,246,0.25)", background: "rgba(139,92,246,0.07)", color: chatLoading ? "rgba(255,255,255,0.2)" : "rgba(167,139,250,0.8)", fontSize: 10, fontWeight: 600, cursor: chatLoading ? "default" : "pointer", whiteSpace: "nowrap" as const }}>{label}</button>
            ))}
          </div>

          {/* Input */}
          <div style={{ display: "flex", gap: 6, padding: "6px 10px 8px", flexShrink: 0 }}>
            <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") sendChat(); }} placeholder="Ask anything..." style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 0, padding: "5px 10px", fontSize: 11, color: "rgba(255,255,255,0.85)", outline: "none" }} />
            <button onClick={() => sendChat()} disabled={chatLoading || !chatInput.trim()} style={{ padding: "5px 12px", borderRadius: 0, background: chatInput.trim() && !chatLoading ? "#7c3aed" : "rgba(255,255,255,0.05)", border: "none", color: chatInput.trim() && !chatLoading ? "#fff" : "rgba(255,255,255,0.2)", fontSize: 11, fontWeight: 700, cursor: chatInput.trim() && !chatLoading ? "pointer" : "default" }}>Send</button>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useRef } from "react";
import { engine, DeckState } from "../audio/engine-rodio";
import { query, execute } from "../db/client";
const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);

// ── Types ────────────────────────────────────────────────────

interface LinerCard {
  id: number; title: string; body: string;
  category: string; color: string; pinned: number;
  created_at: number;
}

interface PrepNote {
  id: number; title: string; body: string;
  show_date: string; category: string; created_at: number;
}

const LINER_CATS = ["Station ID", "Promo", "Contest", "Weather", "Traffic", "News Tease", "Sweeper", "Custom"];
const LINER_COLORS: Record<string, string> = {
  "Station ID": "#38bdf8", "Promo": "#a78bfa", "Contest": "#fb923c",
  "Weather": "#34d399", "Traffic": "#fbbf24", "News Tease": "#f87171",
  "Sweeper": "#22d3ee", "Custom": "#94a3b8",
};

const NOTE_CATS = ["Topic", "Music Fact", "Artist Bio", "Listener Story", "Contest", "Local News", "Trivia", "Script"];

const SCRIPT_TEMPLATES: Record<string, string> = {
  "Song Intro": "Coming up next — [ARTIST] with [TITLE]. {Fun fact or connection to the last song}",
  "Artist Intro": "[ARTIST] — out of [CITY], [YEAR]. Known for [FACT]. This is [TITLE]...",
  "Coming Up Tease": "Still ahead — we've got [UPCOMING ARTIST] coming up in just a few minutes. Don't go anywhere.",
  "Legal ID": "[STATION NAME] — [CITY]. [SLOGAN].",
  "Contest Setup": "We're giving away [PRIZE]. Here's how to win — [RULES]. Call us at [NUMBER] when you hear the cue to call.",
  "Weather Toss": "Let's check in on your [MORNING/AFTERNOON/EVENING] — [WEATHER SUMMARY]. Right now it's [TEMP] degrees.",
  "Song Outro": "That was [ARTIST] — [TITLE]. [YEAR HIT/FACT]. You're listening to [STATION].",
  "Listener Shoutout": "Shoutout to [NAME] from [CITY/NEIGHBORHOOD] who [REASON]. This one's for you —",
};

function fmtMs(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// ── Mini On-Air Monitor ──────────────────────────────────────

function MiniMonitor({ onGoLive }: { onGoLive?: () => void }) {
  const [deckA, setDeckA] = useState<DeckState | null>(null);
  const [deckB, setDeckB] = useState<DeckState | null>(null);
  const [deckC, setDeckC] = useState<DeckState | null>(null);
  const [time, setTime] = useState(new Date());
  const [micActive, setMicActive] = useState(false);
  const micStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const unsub = engine.on((id, st) => {
      if (id === "A") setDeckA({...st});
      else if (id === "B") setDeckB({...st});
      else if (id === "C") setDeckC({...st});
    });
    const clock = setInterval(() => setTime(new Date()), 1000);
    return () => { unsub(); clearInterval(clock); };
  }, []);

  const toggleMic = async () => {
    if (micActive) {
      micStreamRef.current?.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
      setMicActive(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = stream;
        setMicActive(true);
      } catch { alert("Could not access microphone"); }
    }
  };

  const playing = [deckA, deckB, deckC].find(d => d?.status === "playing");
  const remaining = playing ? Math.max(0, (playing.durationSec - playing.positionSec) * 1000) : 0;
  const pct = playing && playing.durationSec > 0 ? (playing.positionSec / playing.durationSec) * 100 : 0;

  return (
    <div style={{
      background: "var(--bg-secondary)",
      border: `1px solid ${playing ? "rgba(52,211,153,0.3)" : "var(--border-primary)"}`,
      borderRadius: 14,
      overflow: "hidden",
      boxShadow: playing ? "0 0 20px rgba(52,211,153,0.08)" : "var(--shadow-sm)",
      transition: "border-color 0.3s, box-shadow 0.3s",
    }}>
      {/* Top bar */}
      <div style={{
        padding: "8px 14px",
        background: "var(--bg-tertiary)",
        borderBottom: "1px solid var(--border-primary)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: playing ? "#34d399" : "var(--text-tertiary)", boxShadow: playing ? "0 0 6px #34d399" : "none" }} />
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" as any, color: playing ? "#34d399" : "var(--text-tertiary)" }}>
            {playing ? "ON AIR" : "OFF AIR"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "var(--text-tertiary)" }}>
            {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
          <button onClick={onGoLive} style={{
            padding: "3px 10px", borderRadius: 6,
            fontSize: 9, fontWeight: 800, letterSpacing: "0.1em",
            background: "var(--accent-cyan)", color: "#000",
            border: "none", cursor: "pointer",
            textTransform: "uppercase",
          }}>▶ GO LIVE</button>
        </div>
      </div>

      <div style={{ padding: "14px 16px" }}>
        {/* Now playing */}
        {playing ? (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, letterSpacing: "-0.01em" }}>
              {playing.title}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>
              {playing.artist}
            </div>
            {/* Progress */}
            <div style={{ marginTop: 8, height: 3, background: "var(--bg-tertiary)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: pct + "%", background: remaining < 15000 ? "#f87171" : "#34d399", borderRadius: 2, transition: "width 0.5s linear, background 0.3s" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ fontSize: 9, color: "var(--text-tertiary)" }}>
                {fmtMs(playing.positionSec * 1000)} elapsed
              </span>
              <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", fontWeight: 500, color: remaining < 15000 ? "#f87171" : "#34d399" }}>
                {fmtMs(remaining)} left
              </span>
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: 10, padding: "10px 0" }}>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>Nothing playing</div>
          </div>
        )}

        {/* Deck mini indicators */}
        <div style={{ display: "flex", flexDirection: "column" as any, gap: 6, marginBottom: 12 }}>
          {[deckA, deckB, deckC].map((d, i) => {
            const id = ["A","B","C"][i];
            const color = i === 0 ? "#38bdf8" : i === 1 ? "#34d399" : "#a78bfa";
            const isOn = d?.status === "playing";
            const remaining = d && d.durationSec > 0 ? Math.max(0, d.durationSec - d.positionSec) : 0;
            const pct = d && d.durationSec > 0 ? (d.positionSec / d.durationSec) * 100 : 0;
            const isCritical = isOn && remaining < 15;
            return (
              <div key={id} style={{
                padding: "10px 12px",
                borderRadius: 10,
                background: isOn ? color + "18" : "var(--bg-tertiary)",
                border: `1px solid ${isOn ? color + (isCritical ? "80" : "50") : "var(--border-primary)"}`,
                boxShadow: isOn ? `0 0 16px ${color}25` : "none",
                transition: "all 0.3s ease",
                position: "relative" as any,
                overflow: "hidden",
              }}>
                {/* Progress bar strip at bottom */}
                {isOn && (
                  <div style={{ position: "absolute" as any, bottom: 0, left: 0, right: 0, height: 2, background: color + "30" }}>
                    <div style={{ height: "100%", width: pct + "%", background: isCritical ? "#f87171" : color, transition: "width 0.5s linear" }} />
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {/* Deck badge */}
                  <div style={{
                    width: 22, height: 22, borderRadius: 6, flexShrink: 0,
                    background: isOn ? color : color + "20",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <span style={{ fontSize: 10, fontWeight: 800, color: isOn ? "#000" : color, fontFamily: "'Syne', sans-serif" }}>{id}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: isOn ? 13 : 12,
                      fontWeight: isOn ? 700 : 400,
                      color: isOn ? "var(--text-primary)" : "var(--text-tertiary)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any,
                      letterSpacing: isOn ? "-0.01em" : "0",
                    }}>
                      {d?.title || "—"}
                    </div>
                    {d?.artist && (
                      <div style={{ fontSize: 10, color: isOn ? "var(--text-secondary)" : "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, marginTop: 1 }}>
                        {d.artist}
                      </div>
                    )}
                  </div>
                  {isOn && remaining > 0 && (
                    <span style={{
                      fontSize: 11, fontFamily: "'DM Mono', monospace", fontWeight: 500,
                      color: isCritical ? "#f87171" : color,
                      flexShrink: 0,
                      animation: isCritical ? "countdown-blink 0.5s ease-in-out infinite" : "none",
                    }}>
                      {Math.floor(remaining / 60)}:{String(Math.floor(remaining % 60)).padStart(2,"0")}
                    </span>
                  )}
                  {!isOn && d?.title && (
                    <span style={{ fontSize: 8, fontWeight: 700, color: color + "80", letterSpacing: "0.08em" }}>
                      {d.status === "paused" ? "PAUSED" : "READY"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Mic label + button */}
        <div style={{ fontSize: 10, color: "var(--text-tertiary)", textAlign: "center" as any, marginBottom: 4, letterSpacing: "0.04em" }}>
          Click to open your mic live on air
        </div>
        <button onClick={toggleMic} style={{
          width: "100%", padding: "8px",
          borderRadius: 9, fontSize: 11, fontWeight: 700,
          cursor: "pointer", border: "none",
          background: micActive ? "#ef4444" : "var(--bg-tertiary)",
          color: micActive ? "#fff" : "var(--text-tertiary)",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          boxShadow: micActive ? "0 0 16px rgba(239,68,68,0.4)" : "none",
          animation: micActive ? "onair-pulse 1.5s ease-in-out infinite" : "none",
          transition: "all 0.2s",
          letterSpacing: "0.06em",
        }}>
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
            <rect x="3" y="0" width="4" height="8" rx="2"/>
            <path d="M1 6c0 2.2 1.8 4 4 4s4-1.8 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
            <line x1="5" y1="10" x2="5" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <line x1="3" y1="13" x2="7" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          {micActive ? "MIC LIVE" : "LIVE MIC"}
        </button>
      </div>
    </div>
  );
}

// ── Liner Cards ──────────────────────────────────────────────

function LinerCards() {
  const [cards, setCards] = useState<LinerCard[]>([]);
  const [editing, setEditing] = useState<Partial<LinerCard> | null>(null);
  const [activeCard, setActiveCard] = useState<number | null>(null);
  const [filterCat, setFilterCat] = useState("all");

  const load = async () => {
    try {
      setCards(await query<LinerCard>("SELECT * FROM liner_cards ORDER BY pinned DESC, created_at DESC"));
    } catch {
      // Table might not exist yet
      await execute("CREATE TABLE IF NOT EXISTS liner_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, category TEXT DEFAULT 'Custom', color TEXT DEFAULT '#94a3b8', pinned INTEGER DEFAULT 0, created_at INTEGER DEFAULT (unixepoch()))");
      setCards([]);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing?.title || !editing?.body) return;
    if (editing.id) {
      await execute("UPDATE liner_cards SET title=?, body=?, category=?, color=?, pinned=? WHERE id=?",
        [editing.title, editing.body, editing.category || "Custom", editing.color || "#94a3b8", editing.pinned || 0, editing.id]);
    } else {
      await execute("INSERT INTO liner_cards (title, body, category, color, pinned) VALUES (?,?,?,?,?)",
        [editing.title, editing.body, editing.category || "Custom", LINER_COLORS[editing.category || "Custom"] || "#94a3b8", 0]);
    }
    setEditing(null); load();
  };

  const filtered = filterCat === "all" ? cards : cards.filter(c => c.category === filterCat);

  return (
    <div style={{ display: "flex", flexDirection: "column" as any, height: "100%", gap: 10 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase" as any, letterSpacing: "0.08em" }}>Liner Cards</span>
        <button onClick={() => setEditing({ category: "Station ID", color: "#38bdf8" })} style={{ padding: "4px 10px", borderRadius: 7, fontSize: 10, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>＋ New</button>
      </div>

      {/* Category filter */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as any, flexShrink: 0 }}>
        <button onClick={() => setFilterCat("all")} style={{ padding: "3px 9px", borderRadius: 20, fontSize: 9, fontWeight: 700, cursor: "pointer", background: filterCat === "all" ? "var(--text-primary)" : "var(--bg-tertiary)", color: filterCat === "all" ? "var(--bg-primary)" : "var(--text-tertiary)", border: "none" }}>ALL</button>
        {[...new Set(cards.map(c => c.category))].map(cat => (
          <button key={cat} onClick={() => setFilterCat(cat)} style={{ padding: "3px 9px", borderRadius: 20, fontSize: 9, fontWeight: 700, cursor: "pointer", background: filterCat === cat ? LINER_COLORS[cat] || "#94a3b8" : "var(--bg-tertiary)", color: filterCat === cat ? "#000" : "var(--text-tertiary)", border: "none" }}>{cat}</button>
        ))}
      </div>

      {/* Edit form */}
      {editing && (
        <div style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 10, padding: 12, flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input placeholder="Card title" value={editing.title || ""} onChange={e => setEditing({...editing, title: e.target.value})}
              style={{ flex: 1, padding: "6px 10px", borderRadius: 7, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
            <select value={editing.category || "Custom"} onChange={e => setEditing({...editing, category: e.target.value, color: LINER_COLORS[e.target.value] || "#94a3b8"})}
              style={{ padding: "6px 10px", borderRadius: 7, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}>
              {LINER_CATS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <textarea placeholder="Card copy — write exactly what you'll say..." value={editing.body || ""} onChange={e => setEditing({...editing, body: e.target.value})}
            rows={4}
            style={{ width: "100%", padding: "8px 10px", borderRadius: 7, fontSize: 13, lineHeight: 1.6, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", resize: "vertical" as any, boxSizing: "border-box" as any, fontFamily: "'Inter', sans-serif" }} />
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button onClick={save} style={{ padding: "5px 14px", borderRadius: 7, fontSize: 11, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Save</button>
            <button onClick={() => setEditing(null)} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11, background: "var(--bg-secondary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Cards grid */}
      <div style={{ flex: 1, overflowY: "auto" as any, display: "flex", flexDirection: "column" as any, gap: 8 }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center" as any, padding: "32px 16px", color: "var(--text-tertiary)", fontSize: 12 }}>No liner cards yet — create one above</div>
        ) : filtered.map(card => {
          const color = card.color || LINER_COLORS[card.category] || "#94a3b8";
          const isActive = activeCard === card.id;
          return (
            <div key={card.id} onClick={() => setActiveCard(isActive ? null : card.id)} style={{
              background: isActive ? color + "15" : "var(--bg-tertiary)",
              border: `1px solid ${isActive ? color + "50" : "var(--border-primary)"}`,
              borderLeft: `3px solid ${color}`,
              borderRadius: 10,
              padding: "10px 12px",
              cursor: "pointer",
              transition: "all 0.15s",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: isActive ? 8 : 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 8, fontWeight: 700, color, background: color + "20", padding: "2px 7px", borderRadius: 20, textTransform: "uppercase" as any, letterSpacing: "0.08em" }}>{card.category}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{card.title}</span>
                </div>
                <div style={{ display: "flex", gap: 4 }} onClick={e => e.stopPropagation()}>
                  <button onClick={() => setEditing(card)} style={{ padding: "2px 7px", borderRadius: 5, fontSize: 9, background: "var(--bg-secondary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Edit</button>
                  <button onClick={async () => { await execute("DELETE FROM liner_cards WHERE id=?", [card.id]); load(); }} style={{ padding: "2px 6px", borderRadius: 5, fontSize: 9, background: "transparent", color: "var(--text-tertiary)", border: "none", cursor: "pointer" }}>✕</button>
                </div>
              </div>
              {isActive && (
                <div style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text-primary)", whiteSpace: "pre-wrap" as any, fontWeight: 400 }}>
                  {card.body}
                </div>
              )}
              {!isActive && (
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, marginTop: 3 }}>
                  {card.body.substring(0, 80)}{card.body.length > 80 ? "…" : ""}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Script Writer ────────────────────────────────────────────

function ScriptWriter() {
  const [notes, setNotes] = useState<PrepNote[]>([]);
  const [activeNote, setActiveNote] = useState<Partial<PrepNote> | null>(null);
  const [template, setTemplate] = useState("");

  const load = async () => {
    try {
      setNotes(await query<PrepNote>("SELECT * FROM prep_notes ORDER BY created_at DESC LIMIT 50"));
    } catch {
      await execute("CREATE TABLE IF NOT EXISTS prep_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT DEFAULT '', show_date TEXT DEFAULT '', category TEXT DEFAULT 'Script', created_at INTEGER DEFAULT (unixepoch()))");
      setNotes([]);
    }
  };
  useEffect(() => { load(); }, []);

  const newNote = (cat = "Script") => {
    setActiveNote({ title: "", body: "", category: cat, show_date: new Date().toISOString().split("T")[0] });
  };

  const save = async () => {
    if (!activeNote?.title) return;
    if (activeNote.id) {
      await execute("UPDATE prep_notes SET title=?, body=?, category=?, show_date=? WHERE id=?",
        [activeNote.title, activeNote.body, activeNote.category, activeNote.show_date, activeNote.id]);
    } else {
      await execute("INSERT INTO prep_notes (title, body, category, show_date) VALUES (?,?,?,?)",
        [activeNote.title, activeNote.body || "", activeNote.category || "Script", activeNote.show_date || ""]);
    }
    setActiveNote(null); load();
  };

  const applyTemplate = (name: string) => {
    const t = SCRIPT_TEMPLATES[name];
    if (!t || !activeNote) return;
    setActiveNote({ ...activeNote, body: (activeNote.body ? activeNote.body + "\n\n" : "") + "── " + name + " ──\n" + t });
    setTemplate("");
  };

  const catColor: Record<string, string> = {
    Script: "#38bdf8", Topic: "#34d399", "Music Fact": "#a78bfa",
    "Artist Bio": "#fb923c", Trivia: "#fbbf24", "Local News": "#f87171",
    "Listener Story": "#22d3ee", Contest: "#ec4899",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" as any, height: "100%", gap: 10 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase" as any, letterSpacing: "0.08em" }}>Show Prep</span>
        <div style={{ display: "flex", gap: 6 }}>
          {["Script", "Topic", "Trivia"].map(cat => (
            <button key={cat} onClick={() => newNote(cat)} style={{ padding: "4px 10px", borderRadius: 7, fontSize: 10, fontWeight: 700, background: catColor[cat] + "20", color: catColor[cat], border: "1px solid " + catColor[cat] + "30", cursor: "pointer" }}>＋ {cat}</button>
          ))}
        </div>
      </div>

      {/* Editor */}
      {activeNote !== null && (
        <div style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 12, padding: 14, flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input placeholder="Title — e.g. Morning opener, Drake intro, Contest setup..." value={activeNote.title || ""} onChange={e => setActiveNote({...activeNote, title: e.target.value})}
              style={{ flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 13, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
            <select value={activeNote.category || "Script"} onChange={e => setActiveNote({...activeNote, category: e.target.value})}
              style={{ padding: "8px 10px", borderRadius: 8, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}>
              {NOTE_CATS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="date" value={activeNote.show_date || ""} onChange={e => setActiveNote({...activeNote, show_date: e.target.value})}
              style={{ padding: "8px 10px", borderRadius: 8, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
          </div>

          {/* Template picker */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as any, marginBottom: 8 }}>
            <span style={{ fontSize: 10, color: "var(--text-tertiary)", alignSelf: "center", flexShrink: 0 }}>Insert template:</span>
            {Object.keys(SCRIPT_TEMPLATES).map(name => (
              <button key={name} onClick={() => applyTemplate(name)} style={{ padding: "3px 8px", borderRadius: 6, fontSize: 9, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>{name}</button>
            ))}
          </div>

          <textarea
            placeholder="Write your break copy here... Use [BRACKETS] for things to fill in on air."
            value={activeNote.body || ""}
            onChange={e => setActiveNote({...activeNote, body: e.target.value})}
            rows={8}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 8, fontSize: 14, lineHeight: 1.8, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", resize: "vertical" as any, boxSizing: "border-box" as any, fontFamily: "'Inter', sans-serif" }}
          />

          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <button onClick={save} style={{ padding: "6px 16px", borderRadius: 8, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Save</button>
            <button onClick={() => setActiveNote(null)} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, background: "var(--bg-secondary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Notes list */}
      <div style={{ flex: 1, overflowY: "auto" as any, display: "flex", flexDirection: "column" as any, gap: 6 }}>
        {notes.length === 0 && !activeNote ? (
          <div style={{ textAlign: "center" as any, padding: "32px 16px" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 8, opacity: 0.4 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Start your show prep</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Write scripts, save topics, collect music facts — all in one place</div>
          </div>
        ) : notes.map((note, i) => {
          const color = catColor[note.category] || "#94a3b8";
          return (
            <div key={note.id}
              style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderLeft: `3px solid ${color}`, borderRadius: 10, padding: "10px 12px", cursor: "pointer" }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={e => (e.currentTarget.style.background = "var(--bg-tertiary)")}
              onClick={() => setActiveNote(note)}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 8, fontWeight: 700, color, background: color + "20", padding: "2px 7px", borderRadius: 20, textTransform: "uppercase" as any }}>{note.category}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{note.title}</span>
                </div>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  {note.show_date && <span style={{ fontSize: 9, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>{note.show_date}</span>}
                  <button onClick={async e => { e.stopPropagation(); if (!confirm("Delete?")) return; await execute("DELETE FROM prep_notes WHERE id=?", [note.id]); load(); }} style={{ padding: "2px 6px", borderRadius: 5, fontSize: 9, background: "transparent", color: "var(--text-tertiary)", border: "none", cursor: "pointer" }}>✕</button>
                </div>
              </div>
              {note.body && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{note.body.substring(0, 100)}{note.body.length > 100 ? "…" : ""}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main ShowPrep ────────────────────────────────────────────

export default function ShowPrep({ onGoLive }: { onGoLive?: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" as any, gap: 16, fontFamily: "'Inter', system-ui, sans-serif", height: "100%" }}>

      {/* Header */}
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Syne', sans-serif" }}>Show Prep</h1>
        <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "4px 0 0" }}>Write scripts, manage liner cards, and monitor the board — all without leaving this screen</p>
      </div>

      {/* Main 3-column layout */}
      <div style={{ display: "flex", gap: 14, flex: 1, minHeight: 0, overflow: "hidden" }}>

        {/* Col 1: Mini monitor */}
        <div style={{ width: 260, flexShrink: 0, display: "flex", flexDirection: "column" as any, gap: 10 }}>
          <MiniMonitor onGoLive={onGoLive} />

          {/* Quick tips */}
          <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 12, padding: "12px 14px" }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as any, marginBottom: 8 }}>Keyboard</div>
            {[["Space", "Play/Pause"], ["B", "Deck B"], ["Esc", "Stop all"]].map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <kbd style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", padding: "2px 6px", borderRadius: 4, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)" }}>{k}</kbd>
                <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Col 2: Liner cards */}
        <div style={{ width: 300, flexShrink: 0, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 14, padding: 14, display: "flex", flexDirection: "column" as any, overflow: "hidden" }}>
          <LinerCards />
        </div>

        {/* Col 3: Script writer */}
        <div style={{ flex: 1, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 14, padding: 14, display: "flex", flexDirection: "column" as any, overflow: "hidden", minWidth: 0 }}>
          <ScriptWriter />
        </div>
      </div>
    </div>
  );
}

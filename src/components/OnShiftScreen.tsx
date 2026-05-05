import { useState, useEffect, useRef } from "react";
import { queryOne } from "../db/client";
import { queryScoped, executeScopedInsert } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
import { engine } from "../audio/engine-rodio";
import { getNextTransition } from "../audio/showClock";

// ── Types ─────────────────────────────────────────────────────

interface Operator { id: number; name: string; initials: string; }
interface ShowInfo  { name: string; start_hour: number; end_hour: number; }
interface QueueItem { title: string; artist: string; durationMs?: number; duration_ms?: number; }

type ExperienceMode = "solo" | "standard" | "live_radio";

interface Props { onStart: (operator: Operator) => void; }

// ── Helpers ───────────────────────────────────────────────────

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function fmtTime(h: number): string {
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:00 ${suffix}`;
}

function fmtDur(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtSecs(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

// ── Component ─────────────────────────────────────────────────

export default function OnShiftScreen({ onStart }: Props) {
  const { stationId, isReady } = useActiveStation();
  const loadVersionRef = useRef(0);
  const [operators, setOperators]       = useState<Operator[]>([]);
  const [operator, setOperator]         = useState<Operator | null>(null);
  const [note, setNote]                 = useState("");
  const [noteSaved, setNoteSaved]       = useState(false);
  const [currentShow, setCurrentShow]   = useState<ShowInfo | null>(null);
  const [upcomingShows, setUpcomingShows] = useState<ShowInfo[]>([]);
  const [queueItems, setQueueItems]     = useState<QueueItem[]>([]);
  const [mode, setMode]                 = useState<ExperienceMode>("live_radio");
  const [songCount, setSongCount]       = useState(0);
  const [rulesOk, setRulesOk]           = useState(true);
  const [lastBackup, setLastBackup]     = useState<string | null>(null);
  const [nextBreakIn, setNextBreakIn]   = useState<string | null>(null);
  const [irisText, setIrisText]         = useState("");
  const [hasApiKey, setHasApiKey]       = useState(false);
  const [inviteUsed, setInviteUsed]     = useState(false);
  const [invitedBy, setInvitedBy]       = useState("Deniro");
  const [stationLogo, setStationLogo]   = useState<string | null>(null);
  const [showNewOp, setShowNewOp]       = useState(false);
  const [newName, setNewName]           = useState("");
  const [newInitials, setNewInitials]   = useState("");
  const [fadeOut, setFadeOut]           = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // ── Load all data ─────────────────────────────────────────────

  useEffect(() => {
    if (!isReady) return;
    async function doLoad() {
      const v = ++loadVersionRef.current;
      try {
        // Operators
        const ops = await queryScoped<Operator>("SELECT id, name, initials FROM operators ORDER BY id", [], stationId);
        if (v !== loadVersionRef.current) return;
        setOperators(ops);

        if (ops.length > 0) setOperator(ops[0]);

        // Experience mode
        const modeRow = await queryOne<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'experience_mode'");
        if (modeRow) setMode(modeRow.value as ExperienceMode);

        // Song count
        const sc = await queryOne<{ n: number }>("SELECT COUNT(*) as n FROM songs WHERE file_path IS NOT NULL");
        setSongCount(sc?.n ?? 0);

        // Rotation rules
        const rr = await (queryScoped<{ n: number }>("SELECT COUNT(*) as n FROM separation_rules WHERE is_active = 1", [], stationId).then(r => r[0] ?? null));
        setRulesOk((rr?.n ?? 0) > 0);

        // Last backup
        const bk = await queryOne<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'last_backup_time'");
        setLastBackup(bk?.value ?? null);

        // Invite metadata
        const inv = await queryOne<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'invite_used'");
        const invBy = await queryOne<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'invited_by'");
        setInviteUsed(inv?.value === "1");
        setInvitedBy(invBy?.value ?? "Deniro");

        // AI key check
        const aiKey = await queryOne<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'ai_key_anthropic'");
        setHasApiKey(!!aiKey?.value);

        // Station logo
        const logo = await queryOne<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'station_logo'");
        if (v !== loadVersionRef.current) return;
        setStationLogo(logo?.value ?? null);

        // Current show
        const now = new Date();
        const hour = now.getHours();
        const day = String(now.getDay());
        const shows = await queryScoped<ShowInfo>("SELECT name, start_hour, end_hour FROM shows WHERE is_active = 1 ORDER BY start_hour", [], stationId);
        const curr = shows.find(s => {
          if (!s.name) return false;
          const dayOk = true; // simplified — all shows checked
          if (s.end_hour === 0 || s.end_hour === s.start_hour) return hour >= s.start_hour;
          if (s.end_hour > s.start_hour) return hour >= s.start_hour && hour < s.end_hour;
          return hour >= s.start_hour || hour < s.end_hour;
        }) ?? null;
        setCurrentShow(curr);

        // Next 3 upcoming shows
        const upcoming = shows.filter(s => s !== curr && s.start_hour > hour).slice(0, 3);
        setUpcomingShows(upcoming);

        // Next transition countdown
        try {
          const nx = await getNextTransition();
          if (nx) {
            const secs = Math.max(0, Math.round((nx.startsAt.getTime() - now.getTime()) / 1000));
            setNextBreakIn(fmtSecs(secs));
          }
        } catch {}

      } catch (e) { console.error("[OnShift] Load error:", e); }
    }
    doLoad();
  }, [isReady, stationId]);

  // ── Load operator note when operator changes ──────────────────

  useEffect(() => {
    if (!operator) return;
    (async () => {
      try {
        const n = await (queryScoped<{ note: string }>(
          "SELECT note FROM operator_notes WHERE operator_id = ? ORDER BY updated_at DESC LIMIT 1",
          [operator.id], stationId
        ).then(r => r[0] ?? null));
        setNote(n?.note ?? "");
      } catch { setNote(""); }
    })();
  }, [operator?.id]);

  // ── Build Iris scripted greeting ──────────────────────────────

  useEffect(() => {
    if (!operator) return;
    const qItems = engine.getQueue();
    const previewCount = mode === "solo" ? 1 : mode === "standard" ? 2 : 4;
    setQueueItems(qItems.slice(0, previewCount));

    const qLen = qItems.length;
    const hasExplicit = qItems.some((q: any) => q.is_explicit === 1 || q.is_explicit === true);

    const showLine = currentShow ? `You're currently in "${currentShow.name}".` : "No show is scheduled right now.";
    const queueLine = qLen > 0
      ? `There ${qLen === 1 ? "is" : "are"} ${qLen} track${qLen === 1 ? "" : "s"} queued up.`
      : "The queue is empty — you may want to generate a log before going live.";
    const explicitLine = hasExplicit ? " Note: there are explicit tracks in the queue." : "";
    const noteLine = note.trim() ? ` Your last note: "${note.slice(0, 80)}${note.length > 80 ? "…" : ""}"` : "";
    const breakLine = nextBreakIn ? ` Next show transition in ${nextBreakIn}.` : "";

    let text: string;
    if (inviteUsed) {
      text = `${operator.name}, ${invitedBy} asked me to let you know he's been expecting you. Your station is ready and he left you a note on the desk.`;
    } else {
      text = `${greeting()}, ${operator.name}. ${showLine} ${queueLine}${explicitLine}${breakLine}${noteLine}`;
    }
    setIrisText(text.trim());
  }, [operator?.id, currentShow, note, nextBreakIn, inviteUsed, invitedBy, mode]);

  // ── Save note on blur ─────────────────────────────────────────

  const saveNote = async () => {
    if (!operator) return;
    try {
      await executeScopedInsert(
        "INSERT INTO operator_notes (operator_id, note, updated_at) VALUES (?, ?, unixepoch())",
        [operator.id, note], stationId
      );
      setNoteSaved(true);
      setTimeout(() => setNoteSaved(false), 1500);
    } catch {}
  };

  // ── Add new operator ──────────────────────────────────────────

  const addOperator = async () => {
    if (!newName.trim()) return;
    try {
      await executeScopedInsert("INSERT INTO operators (name, initials) VALUES (?, ?)", [newName.trim(), newInitials.trim() || newName.trim().charAt(0)], stationId);
      const ops = await queryScoped<Operator>("SELECT id, name, initials FROM operators ORDER BY id", [], stationId);
      setOperators(ops);
      const newest = ops[ops.length - 1];
      setOperator(newest);
      setNewName(""); setNewInitials(""); setShowNewOp(false);
    } catch {}
  };

  // ── Start shift ───────────────────────────────────────────────

  const startShift = async () => {
    if (!operator) return;
    setFadeOut(true);
    setTimeout(() => onStart(operator), 500);
  };

  // ── Styles ────────────────────────────────────────────────────

  const S = {
    bg:       "#0e0e12",
    card:     "#111118",
    border:   "#1e1e2e",
    text:     "#e0e0f0",
    muted:    "#4a4a6a",
    label:    "#252545",
    iris:     "#8878c0",
    purple:   "#6040c0",
    amber:    "#b87020",
  } as const;

  const queueVisible = mode === "solo" ? 1 : mode === "standard" ? 2 : 4;
  const qDisplay = engine.getQueue().slice(0, queueVisible);

  // ── Render ────────────────────────────────────────────────────

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9990,
      background: S.bg, fontFamily: "'Inter', system-ui, sans-serif",
      display: "flex", flexDirection: "column",
      opacity: fadeOut ? 0 : 1, transition: "opacity 0.5s ease",
    }}>
      {/* Top bar */}
      <div style={{ height: 1, background: S.border, flexShrink: 0 }} />

      {/* Main grid */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, overflow: "hidden" }}>

        {/* ── LEFT COLUMN ── */}
        <div style={{ borderRight: `1px solid ${S.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ flex: 1, overflowY: "auto", padding: "32px 36px" }}>

            {/* Station logo */}
            {stationLogo && (
              <div style={{ marginBottom: 24, display: "flex", alignItems: "center", gap: 14 }}>
                <img
                  src={stationLogo}
                  alt="Station logo"
                  style={{ height: 48, maxWidth: 120, objectFit: "contain", opacity: 0.9 }}
                />
              </div>
            )}

            {/* Operator selector */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", color: S.muted, textTransform: "uppercase", marginBottom: 10 }}>On Shift</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {operators.map(op => (
                  <button key={op.id} onClick={() => setOperator(op)} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "8px 14px", borderRadius: 0,
                    background: operator?.id === op.id ? S.purple + "20" : "transparent",
                    border: `1px solid ${operator?.id === op.id ? S.purple : S.border}`,
                    color: operator?.id === op.id ? S.text : S.muted,
                    cursor: "pointer", fontSize: 13, fontWeight: operator?.id === op.id ? 700 : 400,
                    transition: "all 0.12s",
                  }}>
                    <span style={{
                      width: 26, height: 26, borderRadius: 0, flexShrink: 0,
                      background: operator?.id === op.id ? S.purple : S.border,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 10, fontWeight: 800, color: "#fff",
                      fontFamily: "'Syne', sans-serif",
                    }}>{op.initials.slice(0, 2).toUpperCase()}</span>
                    {op.name}
                  </button>
                ))}
                {showNewOp ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                      placeholder="Full name"
                      style={{ padding: "6px 10px", background: S.card, border: `1px solid ${S.border}`, color: S.text, fontSize: 12, borderRadius: 0, width: 140, outline: "none" }} />
                    <input value={newInitials} onChange={e => setNewInitials(e.target.value.slice(0, 3))}
                      placeholder="Init"
                      style={{ padding: "6px 8px", background: S.card, border: `1px solid ${S.border}`, color: S.text, fontSize: 12, borderRadius: 0, width: 50, outline: "none", textAlign: "center" }} />
                    <button onClick={addOperator} style={{ padding: "6px 12px", background: S.purple, border: "none", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", borderRadius: 0 }}>Add</button>
                    <button onClick={() => setShowNewOp(false)} style={{ padding: "6px 10px", background: "none", border: `1px solid ${S.border}`, color: S.muted, fontSize: 11, cursor: "pointer", borderRadius: 0 }}>✕</button>
                  </div>
                ) : (
                  <button onClick={() => setShowNewOp(true)} style={{ padding: "8px 12px", background: "none", border: `1px dashed ${S.border}`, color: S.muted, fontSize: 11, cursor: "pointer", borderRadius: 0 }}>+ Add operator</button>
                )}
              </div>
            </div>

            {/* Greeting */}
            {operator && (
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: S.text, letterSpacing: "-0.03em", fontFamily: "'Syne', sans-serif", lineHeight: 1.2, marginBottom: 6 }}>
                  {greeting()},<br />{operator.name}.
                </div>
                <div style={{ fontSize: 12, color: S.muted }}>
                  {currentShow ? `On air: ${currentShow.name}` : "No scheduled show right now"}
                  {nextBreakIn && <span> · Next transition in {nextBreakIn}</span>}
                </div>
              </div>
            )}

            {/* Now on air */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", color: S.muted, textTransform: "uppercase", marginBottom: 8 }}>Now on air</div>
              <div style={{ background: S.card, border: `1px solid ${S.border}`, borderLeft: `3px solid ${S.purple}`, padding: "14px 16px" }}>
                {currentShow ? (
                  <>
                    <div style={{ fontSize: 14, fontWeight: 700, color: S.text, marginBottom: 2 }}>{currentShow.name}</div>
                    <div style={{ fontSize: 11, color: S.muted }}>{fmtTime(currentShow.start_hour)} – {fmtTime(currentShow.end_hour === 0 ? 24 : currentShow.end_hour)}</div>
                  </>
                ) : (
                  <div style={{ fontSize: 13, color: S.muted, fontStyle: "italic" }}>No show scheduled</div>
                )}
              </div>
            </div>

            {/* Coming up */}
            {upcomingShows.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", color: S.muted, textTransform: "uppercase", marginBottom: 8 }}>Coming up</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {upcomingShows.map((s, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: S.card, border: `1px solid ${S.border}` }}>
                      <div style={{ width: 4, height: 4, background: S.muted, flexShrink: 0 }} />
                      <span style={{ fontSize: 11, color: S.muted, fontFamily: "'DM Mono', monospace", minWidth: 60 }}>{fmtTime(s.start_hour)}</span>
                      <span style={{ fontSize: 12, color: S.text, fontWeight: 500 }}>{s.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Queue preview */}
            {qDisplay.length > 0 && (
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", color: S.muted, textTransform: "uppercase", marginBottom: 8 }}>
                  Queue preview
                  <span style={{ marginLeft: 8, color: S.label }}>{engine.getQueue().length} tracks</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {qDisplay.map((q, i) => {
                    const ms = (q as any).durationMs || (q as any).duration_ms || 0;
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", background: S.card, borderBottom: `1px solid ${S.border}`, borderLeft: `1px solid ${S.border}`, borderRight: `1px solid ${S.border}`, borderTop: i === 0 ? `1px solid ${S.border}` : "none" }}>
                        <span style={{ fontSize: 9, color: S.label, fontFamily: "'DM Mono', monospace", width: 14, textAlign: "right", flexShrink: 0 }}>{i + 1}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: S.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.title}</div>
                          <div style={{ fontSize: 10, color: S.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.artist}</div>
                        </div>
                        {ms > 0 && <span style={{ fontSize: 10, color: S.muted, fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>{fmtDur(ms)}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Start My Shift */}
          <div style={{ padding: "20px 36px", borderTop: `1px solid ${S.border}`, flexShrink: 0 }}>
            <button
              onClick={startShift}
              disabled={!operator}
              style={{
                width: "100%", padding: "16px", borderRadius: 0,
                background: operator ? S.purple : S.border,
                border: "none", color: "#fff",
                fontFamily: "'Syne', sans-serif", fontSize: 14, fontWeight: 800,
                letterSpacing: "0.06em", textTransform: "uppercase",
                cursor: operator ? "pointer" : "default",
                transition: "background 0.2s",
              }}
              onMouseEnter={e => { if (operator) (e.currentTarget as HTMLElement).style.background = "#7050d0"; }}
              onMouseLeave={e => { if (operator) (e.currentTarget as HTMLElement).style.background = S.purple; }}
            >
              Start My Shift →
            </button>
          </div>
        </div>

        {/* ── RIGHT COLUMN ── */}
        <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ flex: 1, overflowY: "auto", padding: "32px 36px" }}>

            {/* Iris panel */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: S.iris }} />
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", color: S.iris, textTransform: "uppercase" }}>Iris · Executive Producer</span>
              </div>
              <div style={{ background: S.card, border: `1px solid ${S.border}`, borderLeft: `2px solid ${S.iris}`, padding: "16px 18px" }}>
                {irisText ? (
                  <p style={{ fontSize: 13, color: S.text, lineHeight: 1.7, margin: 0 }}>{irisText}</p>
                ) : (
                  <p style={{ fontSize: 13, color: S.muted, lineHeight: 1.7, margin: 0, fontStyle: "italic" }}>Loading station data…</p>
                )}
              </div>
              {!hasApiKey && (
                <div style={{ fontSize: 10, color: S.muted, marginTop: 8, fontStyle: "italic" }}>
                  Add your API key in Settings → AI &amp; Integrations for live Iris intelligence.
                </div>
              )}
            </div>

            {/* Station health */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", color: S.muted, textTransform: "uppercase", marginBottom: 10 }}>Station Health</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {[
                  { label: "Library", value: `${songCount.toLocaleString()} tracks`, ok: songCount > 0 },
                  { label: "Explicit filter", value: "Active", ok: true },
                  { label: "Rotation rules", value: rulesOk ? "Active" : "No rules set", ok: rulesOk },
                  { label: "Last backup", value: lastBackup ? new Date(Number(lastBackup) * 1000).toLocaleDateString() : "Never", ok: !!lastBackup },
                  { label: "Next hard break", value: nextBreakIn ? `in ${nextBreakIn}` : "None scheduled", ok: !!nextBreakIn },
                ].map(row => (
                  <div key={row.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 14px", background: S.card, border: `1px solid ${S.border}` }}>
                    <span style={{ fontSize: 11, color: S.muted }}>{row.label}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: row.ok ? S.text : S.amber, fontFamily: "'DM Mono', monospace" }}>{row.value}</span>
                      <div style={{ width: 5, height: 5, borderRadius: "50%", background: row.ok ? "#34d399" : S.amber }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Personal notes */}
            {operator && (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", color: S.muted, textTransform: "uppercase" }}>Personal Notes</div>
                  {noteSaved && <span style={{ fontSize: 9, color: "#34d399", fontFamily: "'DM Mono', monospace" }}>SAVED</span>}
                </div>
                <textarea
                  ref={noteRef}
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  onBlur={saveNote}
                  placeholder="Your notes from last session…"
                  rows={5}
                  style={{
                    width: "100%", padding: "12px 14px",
                    background: S.card, border: `1px solid ${S.border}`,
                    color: S.text, fontSize: 12, lineHeight: 1.6,
                    borderRadius: 0, resize: "vertical", outline: "none",
                    fontFamily: "'Inter', system-ui, sans-serif",
                    boxSizing: "border-box",
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ height: 32, borderTop: `1px solid ${S.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <span style={{ fontSize: 9, color: "#1a1a28", letterSpacing: "0.14em", fontFamily: "'DM Mono', monospace" }}>BUILT BY DENIRO</span>
      </div>
    </div>
  );
}

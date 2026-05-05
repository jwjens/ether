// PDPicks.tsx — Program Director's pinned songs management page.
//
// Lets PDs pin specific songs to specific time slots:
//   - Recurring: "play this every weekday at 4 PM" (weekday bitmask)
//   - One-shot:  "play this at 8 AM Friday only"
//
// Pinned songs are honored by the scheduler BEFORE rotation runs (see
// loggen.ts pickSongsFromClock). They still respect separation rules
// unless force_play=1.
//
// This is the GSelector "PD Picks" / Wide Orbit "Mandatory Songs" feature.

import { useEffect, useState } from "react";
import { query, execute } from "../db/client";

interface PinnedRow {
  id: number;
  song_id: number;
  slot_hour: number;
  slot_position: number;
  recur_dow: number;       // bitmask 1=Sun .. 64=Sat, 0 = one-shot
  play_at_unix: number;
  start_unix: number;
  end_unix: number;
  force_play: number;
  pinned_by: string;
  reason: string;
  consumed_at: number;
  created_at: number;
  // joined
  title?: string;
  artist_name?: string;
  duration_ms?: number;
}

interface SongOption {
  id: number;
  title: string;
  artist_name: string;
  duration_ms: number;
}

const DOW_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function fmtHour(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  if (h < 12) return `${h} AM`;
  return `${h-12} PM`;
}

function fmtDow(mask: number): string {
  if (mask === 0) return "(one-shot)";
  if (mask === 127) return "Every day";
  if (mask === 62) return "Mon–Fri";
  if (mask === 65) return "Weekends";
  const days = DOW_LABELS.filter((_, i) => (mask >> i) & 1);
  return days.join(" ");
}

export default function PDPicks({ onClose }: { onClose?: () => void }) {
  const [pins, setPins] = useState<PinnedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<"all" | "recurring" | "oneshot" | "consumed">("all");

  const load = async () => {
    setLoading(true);
    try {
      const rows = await query<PinnedRow>(
        `SELECT p.*, s.title, s.duration_ms, a.name as artist_name
         FROM pinned_songs p
         JOIN songs s ON s.id = p.song_id
         LEFT JOIN artists a ON a.id = s.artist_id
         ORDER BY p.slot_hour, p.slot_position, p.created_at DESC`
      );
      setPins(rows);
    } catch (e) {
      console.error("[PDPicks] load failed:", e);
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const filtered = pins.filter(p => {
    if (filter === "recurring") return p.recur_dow !== 0;
    if (filter === "oneshot")   return p.recur_dow === 0 && !p.consumed_at;
    if (filter === "consumed")  return p.consumed_at > 0;
    return true;
  });

  const deletePin = async (id: number) => {
    if (!confirm("Remove this pin? The song will go back to normal rotation.")) return;
    await execute("DELETE FROM pinned_songs WHERE id = ?", [id]);
    load();
  };

  const reactivatePin = async (id: number) => {
    await execute("UPDATE pinned_songs SET consumed_at = 0 WHERE id = ?", [id]);
    load();
  };

  return (
    <div style={{ padding: 24, color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em" }}>PD Picks</h1>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
            Pin specific songs to specific time slots — they play before the rotation runs
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowForm(true)}
            style={{ padding: "8px 16px", borderRadius: 0, fontSize: 13, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
            + Pin a Song
          </button>
          {onClose && (
            <button onClick={onClose} style={btnStyle}>Close</button>
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
        {[
          { id: "all",       label: `All (${pins.length})` },
          { id: "recurring", label: `Recurring (${pins.filter(p => p.recur_dow !== 0).length})` },
          { id: "oneshot",   label: `One-shot pending (${pins.filter(p => p.recur_dow === 0 && !p.consumed_at).length})` },
          { id: "consumed",  label: `Consumed (${pins.filter(p => p.consumed_at > 0).length})` },
        ].map(t => (
          <button key={t.id} onClick={() => setFilter(t.id as any)} style={{
            padding: "6px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600,
            background: filter === t.id ? "var(--accent-blue)" : "var(--bg-secondary)",
            color:      filter === t.id ? "#fff" : "var(--text-secondary)",
            border: filter === t.id ? "none" : "1px solid var(--border-primary)",
            cursor: "pointer",
          }}>{t.label}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: "center" as any, color: "var(--text-tertiary)" }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center" as any, background: "var(--bg-secondary)", border: "1px dashed var(--border-primary)" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>No pins {filter !== "all" ? `in this filter` : "yet"}</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Click <b>+ Pin a Song</b> to start scheduling specific tracks</div>
        </div>
      ) : (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as any, fontSize: 12 }}>
            <thead>
              <tr style={{ background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)" }}>
                {["Slot","Song","Artist","When","Force","Reason","Pinned by",""].map(h => (
                  <th key={h} style={{ padding: "10px 12px", textAlign: "left" as any, fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id} style={{ borderBottom: "1px solid var(--border-primary)", opacity: p.consumed_at ? 0.5 : 1 }}>
                  <td style={{ padding: "8px 12px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                    {fmtHour(p.slot_hour)} <span style={{ color: "var(--text-tertiary)" }}>· slot {p.slot_position}</span>
                  </td>
                  <td style={{ padding: "8px 12px", color: "var(--text-primary)", fontWeight: 600 }}>{p.title || `#${p.song_id}`}</td>
                  <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>{p.artist_name || "—"}</td>
                  <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>
                    {p.recur_dow === 0
                      ? `One-shot ${new Date(p.play_at_unix * 1000).toLocaleString()}`
                      : fmtDow(p.recur_dow)}
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    {p.force_play
                      ? <span style={{ padding: "2px 6px", fontSize: 10, fontWeight: 700, background: "rgba(245,158,11,0.18)", color: "#f59e0b", letterSpacing: "0.04em" }}>FORCE</span>
                      : <span style={{ color: "var(--text-tertiary)", fontSize: 11 }}>—</span>}
                  </td>
                  <td style={{ padding: "8px 12px", color: "var(--text-secondary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.reason}</td>
                  <td style={{ padding: "8px 12px", color: "var(--text-secondary)", fontWeight: 600 }}>{p.pinned_by}</td>
                  <td style={{ padding: "8px 12px" }}>
                    {p.consumed_at > 0 && (
                      <button onClick={() => reactivatePin(p.id)} style={miniBtn} title="Reactivate this one-shot pin">↻</button>
                    )}
                    <button onClick={() => deletePin(p.id)} style={{ ...miniBtn, color: "#ef4444", marginLeft: 4 }}>Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <PinForm onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); load(); }} />
      )}
    </div>
  );
}

// ── Pin creation form ──
function PinForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [songId, setSongId]               = useState<number | null>(null);
  const [songSearch, setSongSearch]       = useState("");
  const [songResults, setSongResults]     = useState<SongOption[]>([]);
  const [selectedSong, setSelectedSong]   = useState<SongOption | null>(null);
  const [slotHour, setSlotHour]           = useState(8);
  const [slotPosition, setSlotPosition]   = useState(0);
  const [pinMode, setPinMode]             = useState<"recurring" | "oneshot">("recurring");
  const [recurDow, setRecurDow]           = useState(62); // Mon-Fri default
  const [oneShotDate, setOneShotDate]     = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [forcePlay, setForcePlay]         = useState(false);
  const [pinnedBy, setPinnedBy]           = useState("");
  const [reason, setReason]               = useState("");
  const [saving, setSaving]               = useState(false);

  // Search songs as user types
  useEffect(() => {
    if (!songSearch.trim()) { setSongResults([]); return; }
    const t = setTimeout(async () => {
      const rows = await query<SongOption>(
        `SELECT s.id, s.title, COALESCE(a.name, '') as artist_name, COALESCE(s.duration_ms, 0) as duration_ms
         FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
         WHERE s.title LIKE ? OR a.name LIKE ?
         ORDER BY s.title LIMIT 20`,
        [`%${songSearch}%`, `%${songSearch}%`]
      );
      setSongResults(rows);
    }, 200);
    return () => clearTimeout(t);
  }, [songSearch]);

  const save = async () => {
    if (!selectedSong) { alert("Pick a song first"); return; }
    setSaving(true);
    try {
      let playAtUnix = 0;
      if (pinMode === "oneshot") {
        const d = new Date(oneShotDate); d.setHours(slotHour, 0, 0, 0);
        playAtUnix = Math.floor(d.getTime() / 1000);
      }
      await execute(
        `INSERT INTO pinned_songs
         (uuid, song_id, slot_hour, slot_position, recur_dow, play_at_unix, start_unix, end_unix, force_play, pinned_by, reason)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          selectedSong.id, slotHour, slotPosition,
          pinMode === "recurring" ? recurDow : 0,
          playAtUnix,
          forcePlay ? 1 : 0,
          pinnedBy, reason,
        ]
      );
      onSaved();
    } catch (e: any) {
      alert("Save failed: " + (e?.message || e));
      setSaving(false);
    }
  };

  const toggleDow = (i: number) => {
    setRecurDow(d => d ^ (1 << i));
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
        width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto",
        padding: "20px 22px", borderRadius: 0,
      }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, marginBottom: 14 }}>Pin a Song</h3>

        <Field label="Search song">
          <input value={songSearch} onChange={e => setSongSearch(e.target.value)} placeholder="Title or artist..." style={inputStyle} autoFocus />
          {songResults.length > 0 && !selectedSong && (
            <div style={{ marginTop: 6, maxHeight: 180, overflowY: "auto", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
              {songResults.map(s => (
                <div key={s.id} onClick={() => { setSelectedSong(s); setSongSearch(""); setSongResults([]); }}
                  style={{ padding: "8px 10px", cursor: "pointer", borderBottom: "1px solid var(--border-primary)", fontSize: 12 }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--bg-secondary)"}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
                >
                  <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>{s.title}</div>
                  <div style={{ color: "var(--text-tertiary)", fontSize: 11 }}>{s.artist_name}</div>
                </div>
              ))}
            </div>
          )}
        </Field>

        {selectedSong && (
          <div style={{ marginBottom: 12, padding: "8px 12px", background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.2)" }}>
            <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}>{selectedSong.title}</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2, display: "flex", justifyContent: "space-between" }}>
              <span>{selectedSong.artist_name}</span>
              <button onClick={() => setSelectedSong(null)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 11, cursor: "pointer", padding: 0 }}>change</button>
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Hour of day">
            <select value={slotHour} onChange={e => setSlotHour(parseInt(e.target.value, 10))} style={inputStyle}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
            </select>
          </Field>
          <Field label="Slot position (in hour)">
            <input type="number" min={0} max={20} value={slotPosition} onChange={e => setSlotPosition(parseInt(e.target.value || "0", 10))} style={inputStyle} />
          </Field>
        </div>

        <Field label="Pin mode">
          <div style={{ display: "flex", gap: 6 }}>
            {[
              { id: "recurring" as const, label: "Recurring (every week)" },
              { id: "oneshot"   as const, label: "One-shot (specific date)" },
            ].map(m => (
              <button key={m.id} onClick={() => setPinMode(m.id)} style={{
                flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 12, fontWeight: 600,
                background: pinMode === m.id ? "var(--accent-blue)" : "var(--bg-tertiary)",
                color:      pinMode === m.id ? "#fff" : "var(--text-secondary)",
                border: pinMode === m.id ? "none" : "1px solid var(--border-primary)",
                cursor: "pointer",
              }}>{m.label}</button>
            ))}
          </div>
        </Field>

        {pinMode === "recurring" ? (
          <Field label="Days of week">
            <div style={{ display: "flex", gap: 4 }}>
              {DOW_LABELS.map((d, i) => (
                <button key={i} onClick={() => toggleDow(i)} style={{
                  flex: 1, padding: "10px 0", borderRadius: 0, fontSize: 12, fontWeight: 700,
                  background: (recurDow >> i) & 1 ? "var(--accent-blue)" : "var(--bg-tertiary)",
                  color:      (recurDow >> i) & 1 ? "#fff" : "var(--text-secondary)",
                  border: (recurDow >> i) & 1 ? "none" : "1px solid var(--border-primary)",
                  cursor: "pointer",
                }}>{d}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {[
                { label: "Weekdays", mask: 62 },
                { label: "Weekends", mask: 65 },
                { label: "Every day", mask: 127 },
              ].map(p => (
                <button key={p.label} onClick={() => setRecurDow(p.mask)} style={{
                  padding: "4px 10px", fontSize: 11, fontWeight: 600,
                  background: "var(--bg-tertiary)", color: "var(--text-tertiary)",
                  border: "1px solid var(--border-primary)", borderRadius: 0, cursor: "pointer",
                }}>{p.label}</button>
              ))}
            </div>
          </Field>
        ) : (
          <Field label="Date">
            <input type="date" value={oneShotDate} onChange={e => setOneShotDate(e.target.value)} style={inputStyle} />
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
              Will play at {fmtHour(slotHour)} on {oneShotDate}
            </div>
          </Field>
        )}

        <Field label="">
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={forcePlay} onChange={e => setForcePlay(e.target.checked)} />
            <span><b>Force play</b> — ignore artist/song separation rules</span>
          </label>
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 10 }}>
          <Field label="Pinned by"><input value={pinnedBy} onChange={e => setPinnedBy(e.target.value)} placeholder="initials" style={inputStyle} /></Field>
          <Field label="Reason / note"><input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. New release · Sponsor request · PD pick" style={inputStyle} /></Field>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border-primary)" }}>
          <button onClick={onClose} style={btnStyle}>Cancel</button>
          <button onClick={save} disabled={saving || !selectedSong}
            style={{ ...btnStyle, background: selectedSong ? "var(--accent-blue)" : "var(--bg-tertiary)", color: selectedSong ? "#fff" : "var(--text-tertiary)", border: "none", cursor: selectedSong ? "pointer" : "not-allowed" }}>
            {saving ? "Saving…" : "Pin Song"}
          </button>
        </div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
const miniBtn: React.CSSProperties = {
  padding: "3px 8px", borderRadius: 0, fontSize: 10, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "7px 10px", borderRadius: 0, fontSize: 13,
  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", outline: "none", boxSizing: "border-box",
};
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      {label && <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, letterSpacing: "0.04em", textTransform: "uppercase" as any }}>{label}</div>}
      {children}
    </div>
  );
}

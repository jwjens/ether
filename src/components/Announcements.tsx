import { useState, useEffect } from "react";
import { query, execute, queryOne } from "../db/client";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { engine } from "../audio/engine-rodio";

interface Announcement {
  id: number; title: string; file_path: string;
  trigger_time: string; days: string;
  duck_music: number; resume_music: number;
  duck_level: number; is_active: number;
  last_played_at: number | null;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtTime(t: string): string {
  const [h, m] = t.split(":");
  const hr = parseInt(h);
  return (hr === 0 ? 12 : hr > 12 ? hr - 12 : hr) + ":" + m + " " + (hr >= 12 ? "PM" : "AM");
}

let announcementTimer: any = null;
let lastFiredMinute = "";

async function checkAnnouncements() {
  const now = new Date();
  const currentTime = String(now.getHours()).padStart(2,"0") + ":" + String(now.getMinutes()).padStart(2,"0");
  const currentDay = String(now.getDay());
  if (currentTime === lastFiredMinute) return;
  try {
    const announcements = await query<Announcement>("SELECT * FROM announcements WHERE is_active = 1 AND trigger_time = ?", [currentTime]);
    for (const ann of announcements) {
      if (!ann.days.includes(currentDay)) continue;
      const nowEpoch = Math.floor(Date.now() / 1000);
      if (ann.last_played_at && nowEpoch - ann.last_played_at < 120) continue;
      lastFiredMinute = currentTime;
      const deckA = engine.getDeck("A");
      const deckB = engine.getDeck("B");
      if (ann.duck_music) { deckA?.setVolume(ann.duck_level); deckB?.setVolume(ann.duck_level); }
      try {
        const bytes = await readFile(ann.file_path);
        const blob = new Blob([bytes], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (ann.duck_music && ann.resume_music) { deckA?.setVolume(1); deckB?.setVolume(1); }
        };
        audio.play();
        await execute("UPDATE announcements SET last_played_at = unixepoch() WHERE id = ?", [ann.id]);
      } catch (e) {
        if (ann.duck_music) { deckA?.setVolume(1); deckB?.setVolume(1); }
      }
    }
  } catch {}
}

export function startAnnouncementEngine() {
  if (announcementTimer) clearInterval(announcementTimer);
  announcementTimer = setInterval(checkAnnouncements, 10000);
}
export function stopAnnouncementEngine() {
  if (announcementTimer) clearInterval(announcementTimer);
  announcementTimer = null;
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div onClick={() => onChange(!value)} style={{ width: 36, height: 20, borderRadius: 10, cursor: "pointer", background: value ? "var(--accent-blue)" : "var(--bg-tertiary)", border: "1px solid " + (value ? "var(--accent-blue)" : "var(--border-secondary)"), position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
        <div style={{ position: "absolute", top: 3, left: value ? 18 : 3, width: 12, height: 12, borderRadius: 6, background: "#fff", transition: "left 0.2s" }} />
      </div>
      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{label}</span>
    </div>
  );
}

export default function Announcements() {
  const [list, setList] = useState<Announcement[]>([]);
  const [editing, setEditing] = useState<Partial<Announcement> | null>(null);

  const load = async () => {
    setList(await query<Announcement>("SELECT * FROM announcements ORDER BY trigger_time"));
  };
  useEffect(() => { load(); startAnnouncementEngine(); }, []);

  const addNew = async () => {
    const files = await open({ multiple: false, title: "Select announcement audio", filters: [{ name: "Audio", extensions: ["mp3","flac","ogg","wav","m4a","aac"] }] });
    if (!files) return;
    const filePath = Array.isArray(files) ? files[0] : files;
    const title = (filePath.split(/[\\/]/).pop() || "").replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
    setEditing({ title, file_path: filePath, trigger_time: "17:30", days: "0123456", duck_music: 1, resume_music: 1, duck_level: 0.1, is_active: 1 });
  };

  const save = async () => {
    if (!editing) return;
    if (editing.id) {
      await execute("UPDATE announcements SET title=?, trigger_time=?, days=?, duck_music=?, resume_music=?, duck_level=?, is_active=? WHERE id=?",
        [editing.title, editing.trigger_time, editing.days, editing.duck_music ? 1 : 0, editing.resume_music ? 1 : 0, editing.duck_level, editing.is_active ? 1 : 0, editing.id]);
    } else {
      await execute("INSERT INTO announcements (title, file_path, trigger_time, days, duck_music, resume_music, duck_level, is_active) VALUES (?,?,?,?,?,?,?,?)",
        [editing.title, editing.file_path, editing.trigger_time, editing.days, editing.duck_music ? 1 : 0, editing.resume_music ? 1 : 0, editing.duck_level, editing.is_active ? 1 : 0]);
    }
    setEditing(null); load();
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this announcement?")) return;
    await execute("DELETE FROM announcements WHERE id=?", [id]); load();
  };

  const toggleDay = (day: string) => {
    if (!editing) return;
    const days = editing.days || "0123456";
    setEditing({ ...editing, days: days.includes(day) ? days.replace(day, "") : days + day });
  };

  const testPlay = async (ann: Announcement) => {
    try {
      const bytes = await readFile(ann.file_path);
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.play();
    } catch (e) { alert("Could not play: " + e); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" as any, gap: 16, fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Syne', sans-serif" }}>Scheduled Announcements</h1>
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "4px 0 0" }}>Auto-play audio at specific times — music ducks, announcement plays, music resumes</p>
        </div>
        <button onClick={addNew} style={{ padding: "8px 16px", borderRadius: 10, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", flexShrink: 0, boxShadow: "0 2px 8px rgba(14,165,233,0.3)" }}>
          ＋ Add Announcement
        </button>
      </div>

      {/* Edit panel */}
      {editing && (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 14, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 16, fontFamily: "'Syne', sans-serif" }}>
            {editing.id ? "Edit" : "New"} Announcement
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 10, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as any, marginBottom: 5 }}>Title</div>
              <input value={editing.title || ""} onChange={e => setEditing({...editing, title: e.target.value})}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" as any }} />
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as any, marginBottom: 5 }}>Trigger Time</div>
              <input type="time" value={editing.trigger_time || "17:30"} onChange={e => setEditing({...editing, trigger_time: e.target.value})}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" as any }} />
            </div>
          </div>

          {/* Days */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as any, marginBottom: 8 }}>Active Days</div>
            <div style={{ display: "flex", gap: 6 }}>
              {DAY_NAMES.map((name, i) => {
                const active = (editing.days || "").includes(String(i));
                return (
                  <button key={i} onClick={() => toggleDay(String(i))} style={{
                    padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer",
                    background: active ? "var(--accent-blue)" : "var(--bg-tertiary)",
                    color: active ? "#fff" : "var(--text-tertiary)",
                    border: active ? "none" : "1px solid var(--border-primary)",
                  }}>{name}</button>
                );
              })}
            </div>
          </div>

          {/* Duck settings */}
          <div style={{ display: "flex", gap: 20, alignItems: "center", marginBottom: 14, padding: "12px 14px", background: "var(--bg-tertiary)", borderRadius: 10, border: "1px solid var(--border-primary)" }}>
            <Toggle value={!!editing.duck_music} onChange={v => setEditing({...editing, duck_music: v ? 1 : 0})} label="Duck music while playing" />
            {!!editing.duck_music && (
              <>
                <Toggle value={!!editing.resume_music} onChange={v => setEditing({...editing, resume_music: v ? 1 : 0})} label="Resume music after" />
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
                  <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Duck to {Math.round((editing.duck_level || 0.1) * 100)}%</span>
                  <input type="range" min="0" max="50" value={Math.round((editing.duck_level || 0.1) * 100)} onChange={e => setEditing({...editing, duck_level: parseInt(e.target.value) / 100})}
                    style={{ width: 100, accentColor: "var(--accent-blue)" }} />
                </div>
              </>
            )}
          </div>

          <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>
            File: {editing.file_path}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={save} style={{ padding: "8px 18px", borderRadius: 8, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Save</button>
            <button onClick={() => setEditing(null)} style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* List */}
      {list.length === 0 ? (
        <div style={{ textAlign: "center" as any, padding: "56px 24px", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 16 }}>
          <div style={{ fontSize: 36, marginBottom: 12, display: "flex", justifyContent: "center" }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>No announcements scheduled</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 20, maxWidth: 400, margin: "0 auto 20px" }}>
            Add closing announcements, park alerts, legal station IDs, or any timed audio
          </div>
          <button onClick={addNew} style={{ padding: "9px 20px", borderRadius: 10, fontSize: 13, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
            ＋ Add First Announcement
          </button>
        </div>
      ) : (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 14, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as any, fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
                {["Title", "Time", "Days", "Duck", "Status", ""].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left" as any, fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((a, i) => (
                <tr key={a.id}
                  style={{ borderBottom: i < list.length - 1 ? "1px solid var(--border-primary)" : "none", opacity: a.is_active ? 1 : 0.5 }}
                  onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <td style={{ padding: "12px 14px", color: "var(--text-primary)", fontWeight: 500 }}>{a.title}</td>
                  <td style={{ padding: "12px 14px", fontFamily: "'DM Mono', monospace", fontSize: 13, color: "var(--accent-cyan)", fontWeight: 500 }}>{fmtTime(a.trigger_time)}</td>
                  <td style={{ padding: "12px 14px" }}>
                    <div style={{ display: "flex", gap: 3 }}>
                      {DAY_NAMES.map((name, j) => {
                        const on = a.days.includes(String(j));
                        return (
                          <span key={j} style={{
                            fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 5,
                            background: on ? "rgba(56,189,248,0.15)" : "var(--bg-tertiary)",
                            color: on ? "var(--accent-blue)" : "var(--text-tertiary)",
                          }}>{name[0]}</span>
                        );
                      })}
                    </div>
                  </td>
                  <td style={{ padding: "12px 14px", color: "var(--text-tertiary)", fontSize: 12 }}>
                    {a.duck_music ? `↓ ${Math.round(a.duck_level * 100)}%` : "—"}
                  </td>
                  <td style={{ padding: "12px 14px" }}>
                    <button onClick={async () => { await execute("UPDATE announcements SET is_active=? WHERE id=?", [a.is_active ? 0 : 1, a.id]); load(); }} style={{
                      padding: "4px 10px", borderRadius: 20, fontSize: 10, fontWeight: 700, cursor: "pointer", border: "none",
                      background: a.is_active ? "rgba(52,211,153,0.15)" : "var(--bg-tertiary)",
                      color: a.is_active ? "var(--accent-green)" : "var(--text-tertiary)",
                    }}>{a.is_active ? "ON" : "OFF"}</button>
                  </td>
                  <td style={{ padding: "12px 14px" }}>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button onClick={() => testPlay(a)} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 10, fontWeight: 700, background: "rgba(52,211,153,0.12)", color: "var(--accent-green)", border: "none", cursor: "pointer" }}>▶ Test</button>
                      <button onClick={() => setEditing(a)} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 10, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Edit</button>
                      <button onClick={() => remove(a.id)} style={{ padding: "5px 8px", borderRadius: 7, fontSize: 10, color: "var(--text-tertiary)", background: "transparent", border: "none", cursor: "pointer" }}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tips card */}
      <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 14, padding: "14px 18px" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as any, marginBottom: 10 }}>Common setups</div>
        <div style={{ display: "flex", flexDirection: "column" as any, gap: 6 }}>
          {[
            { label: "Theme park closing", detail: '"Park closes in 30 min" at 8:30 PM, "15 minutes" at 8:45 PM, "Closing" at 9:00 PM' },
            { label: "Legal station ID", detail: "Top of every hour, every day" },
            { label: "Event alerts", detail: "One-time announcements on specific days only" },
          ].map(tip => (
            <div key={tip.label} style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{tip.label}: </span>
              {tip.detail}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

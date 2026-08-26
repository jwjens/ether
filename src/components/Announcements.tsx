import { useState, useEffect } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation, getActiveStationIdSync } from "../hooks/useActiveStation";
const open = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
const readFile = (p: string) => (window as any).ether.fs.readFile(p);
import { getEngine } from "../audio/engine-registry";

interface Announcement {
  id: number;
  /** The row's stable identity. main's fireAnnouncement keys on this, not the integer id — the same
   *  uuid the sync layer uses, so a hand-fire and a peer see the same row. */
  uuid: string;
  title: string; file_path: string;
  trigger_time: string; days: string;
  /** DEPRECATED (slice 4). The old fake-duck settings. Written at their schema defaults so a build
   *  older than slice 4 still opens and reads sane values; nothing in this build acts on them. The
   *  real duck is the source channel's DUCK ON plus Preferences → Ducker, per station. */
  duck_music: number; resume_music: number; duck_level: number;
  is_active: number;
  /** 'absolute' = fire at trigger_time. 'close_offset' = fire close_offset_min before THAT
   *  weekday's closing time, so a station that shuts earlier on Sunday announces earlier too. */
  trigger_type: "absolute" | "close_offset";
  close_offset_min: number;
  last_played_at: number | null;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Seconds are shown ONLY when they are non-zero. Every row that sits on the minute — which is most
// of them — reads exactly as it always has, and a :30 trigger is unmistakable when it is there.
// A stored 'HH:MM' has no seconds part and means :00, so it renders unchanged.
function fmtTime(t: string): string {
  const [h, m, s] = String(t || "").split(":");
  const hr = parseInt(h);
  const sec = Number(s || 0);
  return (hr === 0 ? 12 : hr > 12 ? hr - 12 : hr) + ":" + m +
         (sec ? ":" + String(sec).padStart(2, "0") : "") + " " + (hr >= 12 ? "PM" : "AM");
}

// (RETIRED 2026-08-25, slice 5) A setInterval lived here and fired scheduled announcements from the
// RENDERER — so they only fired while this panel's window happened to be open. A trigger that
// depends on someone having a panel on screen is not a broadcast feature. It also kept
// lastFiredMinute in a module-level global shared by every station, so one station's fire could
// suppress another's.
//
// Firing now lives in main (startAnnouncementScheduler), runs for EVERY station on a 15s tick, and
// uses the same fireAnnouncement() a hand-fire does — the only way the two can be relied on to
// behave the same.
//
// These exports remain as no-ops because App.tsx calls them on mount; removing the call sites is a
// separate tidy, and a no-op is honest where a second timer would not be.
export function startAnnouncementEngine() { /* main owns the schedule now */ }
export function stopAnnouncementEngine()  { /* main owns the schedule now */ }

// ── DATE-SPECIFIC CLOSING TIMES (v46) ───────────────────────────────────────────────────────────
// docs/station-date-overrides-design-2026-08-26.md.
//
// The seven weekday fields above are the RECURRING pattern. This is the exception layer: pick a date
// that differs — a holiday, a special event, a seasonal change — and give it its own closing time.
//
// It lives HERE, immediately under the weekday defaults it overrides, rather than in a calendar
// surface of its own. The exception belongs next to the rule, and this panel already has a door.
//
// THREE STATES PER DATE, and the difference between the last two is the only subtlety in the
// feature, so the buttons say it in words rather than leaving it to an icon:
//   • no override   → the date uses its weekday default
//   • a time        → the date closes at that time
//   • a BLANK time  → the date has NO closing time, so nothing closing-relative fires that day —
//                     exactly what a blank weekday default already does. No suppression logic.
const DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Local 'YYYY-MM-DD'. Built from local parts, NEVER toISOString() — that is UTC and would name the
 *  wrong day for every evening closing time west of Greenwich, which is where the parks are. */
function ymd(d: Date): string {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function DateClosingCalendar({ stationId, weekdayDefaults }: { stationId: number | null; weekdayDefaults: Record<string, string> }) {
  const today = new Date();
  const [month, setMonth]       = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [rows, setRows]         = useState<Record<string, string>>({});   // 'YYYY-MM-DD' -> closing_time ('' = none)
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft]       = useState("");
  const [err, setErr]           = useState<string | null>(null);

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const dim   = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const lead  = first.getDay();

  const load = async () => {
    if (stationId == null) return;
    const from = ymd(first);
    const to   = ymd(new Date(month.getFullYear(), month.getMonth(), dim));
    try {
      const r = await (window as any).ether.announcements.listDateClosingTimes(stationId, from, to);
      if (r?.ok) setRows(Object.fromEntries((r.rows || []).map((x: any) => [x.date, x.closing_time ?? ""])));
    } catch { /* the grid simply shows no overrides, which is honest */ }
  };
  useEffect(() => { load(); }, [stationId, month.getFullYear(), month.getMonth()]);

  const has = (d: string) => Object.prototype.hasOwnProperty.call(rows, d);

  const write = async (date: string, value: string) => {
    if (stationId == null) return;
    setErr(null);
    try {
      const r = await (window as any).ether.announcements.setDateClosingTime(stationId, date, value);
      if (!r?.ok) { setErr(r?.error || "could not save"); return; }
      await load();
    } catch (e: any) { setErr(String(e?.message || e)); }
  };
  const clear = async (date: string) => {
    if (stationId == null) return;
    setErr(null);
    try {
      await (window as any).ether.announcements.clearDateClosingTime(stationId, date);
      await load();
    } catch (e: any) { setErr(String(e?.message || e)); }
  };

  const pick = (d: string) => { setSelected(d); setDraft(has(d) ? rows[d] : ""); setErr(null); };

  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= dim; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const monthLabel = month.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const navBtn = { padding: "2px 9px", fontSize: 13, fontWeight: 800, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", lineHeight: 1.6 };

  // What ACTUALLY happens on the selected date, and where it came from. Stated, never left to be
  // inferred from precedence — the whole point of an override layer is that the answer is visible.
  const selDow  = selected ? new Date(Number(selected.slice(0, 4)), Number(selected.slice(5, 7)) - 1, Number(selected.slice(8, 10))).getDay() : 0;
  const selWeek = weekdayDefaults[String(selDow)] || "";
  const resolved = selected
    ? (has(selected)
        ? (rows[selected] ? fmtTime(rows[selected]) : "no closing time") + " — this date"
        : (selWeek ? fmtTime(selWeek) + " — " + DOW_FULL[selDow] + " default"
                   : "no closing time — the " + DOW_FULL[selDow] + " default is blank"))
    : "";

  return (
    <div style={{ marginTop: 12, padding: "12px 14px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as any, flex: 1 }}>
          Closing time — specific dates
        </div>
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} title="Previous month" style={navBtn}>‹</button>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", minWidth: 120, textAlign: "center" as any }}>{monthLabel}</div>
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} title="Next month" style={navBtn}>›</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {DAY_NAMES.map(n => (
          <div key={n} style={{ fontSize: 9, fontWeight: 700, color: "var(--text-tertiary)", textAlign: "center" as any, padding: "2px 0" }}>{n}</div>
        ))}
        {cells.map((d, i) => {
          if (d == null) return <div key={"b" + i} />;
          const key     = ymd(new Date(month.getFullYear(), month.getMonth(), d));
          const over    = has(key);
          const blank   = over && !rows[key];
          const isToday = key === ymd(today);
          const isSel   = key === selected;
          return (
            <button key={key} onClick={() => pick(key)}
              title={over ? (blank ? "No closing time this date" : rows[key]) : "Uses the weekday default"}
              style={{
                padding: "4px 2px", minHeight: 34, cursor: "pointer", fontSize: 11, lineHeight: 1.15,
                background: isSel ? "var(--accent-blue)" : over ? "var(--bg-secondary)" : "transparent",
                color: isSel ? "#fff" : "var(--text-primary)",
                border: "1px solid " + (isToday ? "var(--accent-cyan)" : over ? "var(--border-secondary)" : "var(--border-primary)"),
                display: "flex", flexDirection: "column" as any, alignItems: "center", justifyContent: "center", gap: 1,
              }}>
              <span style={{ fontWeight: isToday ? 800 : 500 }}>{d}</span>
              {over && (
                <span style={{ fontSize: 8, fontFamily: "'DM Mono', monospace", color: isSel ? "#fff" : blank ? "var(--accent-amber)" : "var(--accent-cyan)" }}>
                  {blank ? "none" : rows[key].slice(0, 5)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selected ? (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border-primary)" }}>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>
            <strong style={{ color: "var(--text-primary)" }}>{selected}</strong> closes at{" "}
            <strong style={{ color: "var(--accent-cyan)" }}>{resolved}</strong>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" as any }}>
            <input type="time" step={1} value={draft} onChange={e => setDraft(e.target.value)}
              style={{ padding: "5px 7px", fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
            <button onClick={() => write(selected, draft)} disabled={!draft}
              style={{ padding: "5px 10px", fontSize: 11, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: draft ? "pointer" : "not-allowed", opacity: draft ? 1 : 0.5 }}>
              Set for this date
            </button>
            <button onClick={() => write(selected, "")}
              style={{ padding: "5px 10px", fontSize: 11, background: "var(--bg-secondary)", color: "var(--accent-amber)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
              No closing time this date
            </button>
            {has(selected) && (
              <button onClick={() => clear(selected)}
                style={{ padding: "5px 10px", fontSize: 11, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
                Use {DOW_FULL[selDow]} default
              </button>
            )}
          </div>
          {err && <div style={{ fontSize: 10, color: "var(--accent-red)", marginTop: 5 }}>{err}</div>}
        </div>
      ) : (
        <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 8, lineHeight: 1.4 }}>
          {Object.keys(rows).length === 0
            ? "No dates set this month — every date uses its weekday closing time above. Click a date to give it its own."
            : "Click a date to set, blank, or reset its closing time."}
        </div>
      )}
    </div>
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div onClick={() => onChange(!value)} style={{ width: 36, height: 20, borderRadius: 0, cursor: "pointer", background: value ? "var(--accent-blue)" : "var(--bg-tertiary)", border: "1px solid " + (value ? "var(--accent-blue)" : "var(--border-secondary)"), position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
        <div style={{ position: "absolute", top: 3, left: value ? 18 : 3, width: 12, height: 12, borderRadius: 0, background: "#fff", transition: "left 0.2s" }} />
      </div>
      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{label}</span>
    </div>
  );
}

export default function Announcements() {
  const { stationId, isReady } = useActiveStation();
  const [list, setList] = useState<Announcement[]>([]);
  const [editing, setEditing] = useState<Partial<Announcement> | null>(null);

  const load = async () => {
    if (!isReady) return;
    setList(await queryScoped<Announcement>("SELECT * FROM announcements ORDER BY trigger_time", [], stationId));
  };
  useEffect(() => { load(); startAnnouncementEngine(); }, [isReady]);

  const addNew = async () => {
    const files = await open({ multiple: false, title: "Select announcement audio", filters: [{ name: "Audio", extensions: ["mp3","flac","ogg","wav","m4a","aac"] }] });
    if (!files) return;
    const filePath = Array.isArray(files) ? files[0] : files;
    const title = (filePath.split(/[\\/]/).pop() || "").replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
    setEditing({ title, file_path: filePath, trigger_time: "17:30:00", days: "0123456", duck_music: 1, resume_music: 1, duck_level: 0.1, is_active: 1, trigger_type: "absolute", close_offset_min: 30 });
  };

  const save = async () => {
    if (!editing) return;
    if (editing.id) {
      await (window as any).ether.announcements.updateById(editing.id, {
        title: editing.title, trigger_time: editing.trigger_time, days: editing.days,
        duck_music: editing.duck_music ? 1 : 0, resume_music: editing.resume_music ? 1 : 0,
        duck_level: editing.duck_level, is_active: editing.is_active ? 1 : 0,
        trigger_type: editing.trigger_type || "absolute",
        close_offset_min: Number(editing.close_offset_min ?? 0),
      });
    } else {
      await (window as any).ether.announcements.create({
        station_id: stationId, title: editing.title, file_path: editing.file_path,
        trigger_time: editing.trigger_time, days: editing.days,
        duck_music: editing.duck_music ? 1 : 0, resume_music: editing.resume_music ? 1 : 0,
        duck_level: editing.duck_level, is_active: editing.is_active ? 1 : 0,
        trigger_type: editing.trigger_type || "absolute",
        close_offset_min: Number(editing.close_offset_min ?? 0),
      });
    }
    setEditing(null); load();
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this announcement?")) return;
    await (window as any).ether.announcements.deleteById(id); load();
  };

  const toggleDay = (day: string) => {
    if (!editing) return;
    const days = editing.days || "0123456";
    setEditing({ ...editing, days: days.includes(day) ? days.replace(day, "") : days + day });
  };

  // Can this station air an announcement at all? Asked once, so the AIR button explains itself
  // instead of failing at the moment someone presses it.
  const [airSlot, setAirSlot] = useState<string | null>(null);
  const [fireMsg, setFireMsg] = useState<string | null>(null);
  // CLOSING TIME, SEVEN PER STATION (slice 5). Jeff's ruling: it varies by day of week, and the
  // seven rows are the default view — a park that shuts earlier on Sunday is the ordinary case, not
  // an exception to reveal behind a toggle.
  const [closing, setClosing] = useState<Record<string, string>>({});
  const loadClosing = () => {
    if (stationId == null) return;
    (window as any).ether.announcements.getClosingTimes(stationId)
      .then((r: any) => { if (r?.ok) setClosing(Object.fromEntries(Object.entries(r.times).map(([k, v]) => [k, (v as string) || ""]))); })
      .catch(() => { /* the panel shows empty fields, which is honest: nothing is set */ });
  };
  useEffect(loadClosing, [stationId]);
  const saveClosing = async (dow: number, hhmm: string) => {
    setClosing(c => ({ ...c, [dow]: hhmm }));
    if (stationId == null) return;
    try { await (window as any).ether.announcements.setClosingTime(stationId, dow, hhmm); }
    catch (e) { console.error("[announce] closing time save failed:", e); }
  };
  useEffect(() => {
    if (stationId == null) return;
    (window as any).ether.announcements.canFire(stationId)
      .then((r: any) => setAirSlot(r?.ready ? r.slot : null))
      .catch(() => setAirSlot(null));
  }, [stationId]);

  // ON AIR — through the engine, on the source channel patched to Announcement. This is the one
  // that listeners hear. Distinct from Test below, which is a local audition and always has been.
  const airPlay = async (ann: Announcement) => {
    setFireMsg(null);
    try {
      const r: any = await (window as any).ether.announcements.fire(stationId, ann.uuid);
      if (r?.ok) setFireMsg(`"${r.title}" is on air on channel ${r.slot}`);
      else setFireMsg(r?.error || "could not fire");
    } catch (e: any) { setFireMsg(String(e?.message || e)); }
  };

  /** AUDITION ONLY — plays out of this machine's default output, NOT the program bus. It has always
   *  been local; it is labelled so now, because "it played when I pressed Test" is exactly how a
   *  feature that never reached air went unnoticed for its whole life. */
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
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Newsreader', Georgia, serif" }}>Scheduled Announcements</h1>
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "4px 0 0" }}>Play audio at set times on a SOURCE channel — the programme ducks under it and comes back, mid-song.</p>
          {!airSlot && (
            <p style={{ fontSize: 11, color: "var(--accent-amber, #fbbf24)", margin: "6px 0 0" }}>
              No source channel is patched to <strong>Announcement</strong> on this station, so nothing can
              go to air. Press <strong>+</strong> on the board, choose <strong>Announcement</strong>, and
              turn <strong>DUCK ON</strong> for the programme to step back.
            </p>
          )}
          {fireMsg && (
            <p style={{ fontSize: 11, color: "var(--text-secondary)", margin: "6px 0 0" }}>{fireMsg}</p>
          )}

          {/* ── CLOSING TIME, one per day ────────────────────────────────────────────────────
              Beside the announcements it governs, not buried in Preferences: an operator setting a
              "30 minutes before closing" announcement needs to see what closing means today. */}
          <div style={{ marginTop: 14, padding: "12px 14px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as any, marginBottom: 6 }}>
              Closing time — this station, per day
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as any }}>
              {DAY_NAMES.map((name, i) => (
                <label key={i} style={{ display: "flex", flexDirection: "column" as any, gap: 3 }}>
                  <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontWeight: 700 }}>{name}</span>
                  <input
                    type="time"
                    step={1}
                    value={closing[String(i)] || ""}
                    onChange={e => saveClosing(i, e.target.value)}
                    style={{ padding: "5px 7px", fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
                </label>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 6, lineHeight: 1.4 }}>
              Used by announcements set to fire <strong>before closing</strong>. Each day is its own
              time, so a day you close earlier announces earlier. A day left blank fires no
              closing-relative announcement at all — nothing is guessed.
            </div>
          </div>
          <DateClosingCalendar stationId={stationId} weekdayDefaults={closing} />
        </div>
        <button onClick={addNew} style={{ padding: "8px 16px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", flexShrink: 0, boxShadow: "0 2px 8px rgba(14,165,233,0.3)" }}>
          ＋ Add Announcement
        </button>
      </div>

      {/* Edit panel */}
      {editing && (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 16, fontFamily: "'Newsreader', Georgia, serif" }}>
            {editing.id ? "Edit" : "New"} Announcement
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 10, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as any, marginBottom: 5 }}>Title</div>
              <input value={editing.title || ""} onChange={e => setEditing({...editing, title: e.target.value})}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" as any }} />
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as any, marginBottom: 5 }}>Trigger</div>
              <select
                value={editing.trigger_type || "absolute"}
                onChange={e => setEditing({ ...editing, trigger_type: e.target.value as any })}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" as any }}>
                <option value="absolute">At a set time</option>
                <option value="close_offset">Before closing</option>
              </select>
              {(editing.trigger_type || "absolute") === "absolute" ? (
                <input type="time" step={1} value={editing.trigger_time || "17:30:00"} onChange={e => setEditing({...editing, trigger_time: e.target.value})}
                  style={{ width: "100%", marginTop: 6, padding: "9px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" as any }} />
              ) : (
                <>
                  <select
                    value={String(editing.close_offset_min ?? 30)}
                    onChange={e => setEditing({ ...editing, close_offset_min: Number(e.target.value) })}
                    style={{ width: "100%", marginTop: 6, padding: "9px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" as any }}>
                    <option value="30">30 minutes before closing</option>
                    <option value="15">15 minutes before closing</option>
                    <option value="5">5 minutes before closing</option>
                    <option value="1">1 minute before closing</option>
                    <option value="0">At closing time</option>
                  </select>
                  {/* Says WHICH closing time it means, because that is the whole point of the
                      seven-per-day setting below: a station that shuts earlier on Sunday announces
                      earlier on Sunday, without a second announcement existing. */}
                  <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 4, lineHeight: 1.35 }}>
                    Uses each day's own closing time, set below. A day with no closing time set does
                    not fire this announcement — nothing is guessed.
                  </div>
                </>
              )}
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
                    padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 700, cursor: "pointer",
                    background: active ? "var(--accent-blue)" : "var(--bg-tertiary)",
                    color: active ? "#fff" : "var(--text-tertiary)",
                    border: active ? "none" : "1px solid var(--border-primary)",
                  }}>{name}</button>
                );
              })}
            </div>
          </div>

          {/* (REMOVED 2026-08-25) "Duck music while playing", "Resume music after" and a "Duck to
              N%" slider stood here. They were the OLD fake duck — the renderer path that wrote deck
              A and B's faders directly — and slice 4 replaced that with the real one. Jeff confirmed
              by ear that neither the toggle nor the percentage did anything.

              A dead control beside a working one is worse than no control: it is how an operator
              mis-sets the duck and then distrusts the feature that does work. An announcement now
              ducks because it PLAYS ON A SOURCE CHANNEL WITH DUCK ON, and how far it ducks is that
              station's setting in Preferences → Ducker. One place, one truth.

              The duck_music / resume_music / duck_level COLUMNS stay in the schema, deliberately: a
              build older than slice 4 still reads them, and a migration that reaches customers must
              leave the database openable by the previous build (the 4.4.151 rule). They are written
              at their schema defaults and read by nothing. */}
          <div style={{ marginBottom: 14, padding: "10px 14px", background: "var(--bg-tertiary)", borderRadius: 0, border: "1px solid var(--border-primary)" }}>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Ducking is set per station in <strong>Preferences → Ducker</strong>.
            </div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 3, lineHeight: 1.4 }}>
              This announcement ducks the programme because it plays on a source channel with
              <strong> DUCK ON</strong>. Depth, hold and release are that station's settings and apply
              to every source alike.
            </div>
          </div>

          <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>
            File: {editing.file_path}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={save} style={{ padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Save</button>
            <button onClick={() => setEditing(null)} style={{ padding: "8px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* List */}
      {list.length === 0 ? (
        <div style={{ textAlign: "center" as any, padding: "56px 24px", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0 }}>
          <div style={{ fontSize: 36, marginBottom: 12, display: "flex", justifyContent: "center" }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>No announcements scheduled</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 20, maxWidth: 400, margin: "0 auto 20px" }}>
            Add closing announcements, park alerts, legal station IDs, or any timed audio
          </div>
          <button onClick={addNew} style={{ padding: "9px 20px", borderRadius: 0, fontSize: 13, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
            ＋ Add First Announcement
          </button>
        </div>
      ) : (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, overflow: "hidden" }}>
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
                            fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 0,
                            background: on ? "rgb(from var(--accent-blue) r g b / 0.15)" : "var(--bg-tertiary)",
                            color: on ? "var(--accent-blue)" : "var(--text-tertiary)",
                          }}>{name[0]}</span>
                        );
                      })}
                    </div>
                  </td>
                  <td style={{ padding: "12px 14px", color: "var(--text-tertiary)", fontSize: 12 }}>
                    {/* The ducker owns this now — depth/hold live in Preferences > Ducker, per
                        station, and apply to every source. These per-announcement duck columns are
                        vestigial: left in the schema so an older build can still open the database,
                        but nothing reads them. */}
                    <span title="Ducking is set per station in Preferences → Ducker">—</span>
                  </td>
                  <td style={{ padding: "12px 14px" }}>
                    <button onClick={async () => { await (window as any).ether.announcements.updateById(a.id, { is_active: a.is_active ? 0 : 1 }); load(); }} style={{
                      padding: "4px 10px", borderRadius: 0, fontSize: 10, fontWeight: 700, cursor: "pointer", border: "none",
                      background: a.is_active ? "rgba(52,211,153,0.15)" : "var(--bg-tertiary)",
                      color: a.is_active ? "var(--accent-green)" : "var(--text-tertiary)",
                    }}>{a.is_active ? "ON" : "OFF"}</button>
                  </td>
                  <td style={{ padding: "12px 14px" }}>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button
                        onClick={() => airPlay(a)}
                        disabled={!airSlot}
                        title={airSlot
                          ? `Play on air now, on source channel ${airSlot}`
                          : "No source channel is patched to Announcement on this station — press + on the board and choose Announcement"}
                        style={{
                          padding: "5px 10px", borderRadius: 0, fontSize: 10, fontWeight: 700, border: "none",
                          background: airSlot ? "rgb(from var(--accent-cyan) r g b / 0.15)" : "var(--bg-tertiary)",
                          color: airSlot ? "var(--accent-cyan)" : "var(--text-tertiary)",
                          cursor: airSlot ? "pointer" : "not-allowed",
                        }}>▶ AIR</button>
                      <button onClick={() => testPlay(a)} title="Audition on this machine only — does NOT go to air" style={{ padding: "5px 10px", borderRadius: 0, fontSize: 10, fontWeight: 700, background: "rgba(52,211,153,0.12)", color: "var(--accent-green)", border: "none", cursor: "pointer" }}>▶ Test</button>
                      <button onClick={() => setEditing(a)} style={{ padding: "5px 10px", borderRadius: 0, fontSize: 10, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Edit</button>
                      <button onClick={() => remove(a.id)} style={{ padding: "5px 8px", borderRadius: 0, fontSize: 10, color: "var(--text-tertiary)", background: "transparent", border: "none", cursor: "pointer" }}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tips card */}
      <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "14px 18px" }}>
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

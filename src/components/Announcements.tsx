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
  /** DEAD (v47). The schedule moved to announcement_schedule — an announcement can now play at many
   *  times on many days, which one column pair cannot express. Kept on the type because the columns
   *  still exist (a build older than v47 opens the same database and reads them), but NOTHING in
   *  this build writes or reads them: the panel edits entries and the tick iterates entries. */
  trigger_time: string; days: string;
  /** DEPRECATED (slice 4). The old fake-duck settings. Written at their schema defaults so a build
   *  older than slice 4 still opens and reads sane values; nothing in this build acts on them. The
   *  real duck is the source channel's DUCK ON plus Preferences → Ducker, per station. */
  duck_music: number; resume_music: number; duck_level: number;
  is_active: number;
  /** DEAD (v47), same as trigger_time/days above — these are properties of a SCHEDULE ENTRY now,
   *  not of the announcement, which is what makes "the same chime at 8:45 Friday and 7:45 Sunday"
   *  expressible at all. */
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

// (REMOVED 2026-08-26) The seven weekday CLOSING TIME fields and the closing-time calendar stood
// here. Jeff's rule: announcements only, no closing-time concept — an entry has a clock time, and
// nothing scheduled means nothing plays. Both were deleted rather than hidden, along with the
// "before closing" trigger, so there is one way to say when something airs and nothing to reason
// about. The date_closing_times table and its IPC still exist and are simply unused by this panel.

/** Local 'YYYY-MM-DD'. Built from local parts, NEVER toISOString() — that is UTC and would name the
 *  wrong day for every evening announcement west of Greenwich, which is where the parks are. */
function ymd(d: Date): string {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/** A month grid for MULTI-SELECTING real calendar dates. Clicking a date toggles it and the others
 *  stay selected, so a whole season can be picked one date at a time and given one schedule.
 *  ‹ › move across months and the selection survives — the dates you picked in October are still
 *  selected when you page into November. */
function DatePicker({ selected, onToggle, onClearAll, entries }: {
  selected: Set<string>;
  onToggle: (d: string) => void;
  onClearAll: () => void;
  entries: ScheduleEntry[];
}) {
  const today = new Date();
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const dim   = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const lead  = first.getDay();

  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= dim; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const monthLabel = month.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const navBtn = { padding: "2px 9px", fontSize: 13, fontWeight: 800, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", lineHeight: 1.6 };

  // Selecting a whole run of dates one click at a time is the common case for a season, so the week
  // headers select and deselect that weekday across the visible month.
  const toggleColumn = (col: number) => {
    for (let d = 1; d <= dim; d++) {
      const dt = new Date(month.getFullYear(), month.getMonth(), d);
      if (dt.getDay() === col) onToggle(ymd(dt));
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} title="Previous month" style={navBtn}>‹</button>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", flex: 1, textAlign: "center" as any }}>{monthLabel}</div>
        <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} title="Next month" style={navBtn}>›</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {DAY_NAMES.map((n, i) => (
          <button key={i} onClick={() => toggleColumn(i)} title={`Select every ${n} this month`}
            style={{ fontSize: 9, fontWeight: 700, color: "var(--text-tertiary)", textAlign: "center" as any,
                     padding: "3px 0", background: "transparent", border: "none", cursor: "pointer" }}>{n[0]}</button>
        ))}
        {cells.map((d, i) => {
          if (d == null) return <div key={"b" + i} />;
          const key   = ymd(new Date(month.getFullYear(), month.getMonth(), d));
          const n     = entries.filter(e => e.date === key).length;
          const isSel = selected.has(key);
          return (
            <button key={key} onClick={() => onToggle(key)}
              title={n ? `${n} announcement${n === 1 ? "" : "s"} on this date` : "Nothing scheduled on this date"}
              style={{
                padding: "3px 2px", minHeight: 32, cursor: "pointer", fontSize: 11, lineHeight: 1.1,
                background: isSel ? "var(--accent-blue)" : n ? "var(--bg-secondary)" : "transparent",
                color: isSel ? "#fff" : "var(--text-primary)",
                border: "1px solid " + (key === ymd(today) ? "var(--accent-cyan)" : isSel ? "var(--accent-blue)" : n ? "var(--border-secondary)" : "var(--border-primary)"),
                display: "flex", flexDirection: "column" as any, alignItems: "center", justifyContent: "center",
              }}>
              <span style={{ fontWeight: key === ymd(today) ? 800 : 500 }}>{d}</span>
              {n > 0 && (
                <span style={{ fontSize: 8, fontWeight: 700, color: isSel ? "#fff" : "var(--accent-green)" }}>♪{n}</span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <div style={{ fontSize: 10, color: "var(--text-tertiary)", flex: 1, lineHeight: 1.4 }}>
          Click each date you want — they <strong>add up</strong>, and stay selected as you move
          between months. Click a weekday letter to take every one of them this month.
        </div>
        {selected.size > 0 && (
          <button onClick={onClearAll}
            style={{ padding: "4px 9px", fontSize: 10, background: "var(--bg-secondary)", color: "var(--text-secondary)",
                     border: "1px solid var(--border-primary)", cursor: "pointer", whiteSpace: "nowrap" as any }}>
            Clear {selected.size}
          </button>
        )}
      </div>
    </div>
  );
}

// ── THE SCHEDULE (v47) ───────────────────────────────────────────────────────────────────────────
// docs/announcement-schedule-frame-design-2026-08-26.md.
//
// An announcement is an ASSET — a title and an audio file. WHEN it plays is a separate row, and
// there can be many.
//
// ONE ENTRY = one (announcement, time) on ONE SPECIFIC CALENDAR DATE. There is no weekday or
// recurring concept (Jeff, 2026-08-26): dates are multi-selected on the calendar and a line added to
// five dates writes five rows. What plays on a day is exactly what was put on that day, so nothing
// has to be resolved, overridden, or reasoned about.

interface ScheduleEntry {
  uuid: string;
  announcement_uuid: string;
  /** Always 'date' from v48. The column and the 'weekday' value remain in the schema so an older
   *  build can still open the database; nothing here writes or reads them. */
  scope: "weekday" | "date";
  days: string | null;
  date: string | null;
  trigger_type: "absolute" | "close_offset";
  trigger_time: string | null;
  close_offset_min: number;
  sort_order: number;
  last_played_at: number | null;
}

/** One line of the schedule: WHICH announcement, and at WHAT TIME. That is the whole entry. */
/** 'HH:MM' or 'HH:MM:SS' → 'HH:MM:SS'. The picker emits either depending on how it was filled in;
 *  entries store one shape so the list and the scheduler read the same string. */
function toHms(v: string): string {
  const p = String(v || "").split(":");
  if (p.length < 2) return "";
  const n = (x: string) => String(Number(x) || 0).padStart(2, "0");
  return `${n(p[0])}:${n(p[1])}:${p.length > 2 ? n(p[2]) : "00"}`;
}

/** A LINE of the schedule. One line is one announcement at one time, and — because a line added to
 *  several dates is several rows — it carries the rows it stands for so an edit reaches all of them. */
interface Line {
  key: string;                 // announcement_uuid | time
  announcement_uuid: string;
  trigger_time: string;
  rows: ScheduleEntry[];       // the underlying per-date rows within the current selection
}

function EntryRow({ line, assets, selectedCount, onPatch, onDelete }: {
  line: Line;
  assets: Announcement[];
  selectedCount: number;
  onPatch: (patch: any) => void;
  onDelete: () => void;
}) {
  const fld = {
    padding: "7px 9px", fontSize: 12, background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none",
  };
  const missing = !assets.some(a => a.uuid === line.announcement_uuid);

  // THE TIME FIELD IS A DRAFT WHILE IT HAS FOCUS. Fully controlled + write-per-keystroke was why a
  // typed second digit replaced the first: "1" is an INCOMPLETE time, the picker emits "", we saved
  // "", the list reloaded, and the field snapped back. Keystrokes go to local state; the write
  // happens on blur or Enter.
  const [draft, setDraft]   = useState(line.trigger_time || "");
  const [typing, setTyping] = useState(false);
  useEffect(() => { if (!typing) setDraft(line.trigger_time || ""); }, [line.trigger_time, typing]);

  const commit = () => {
    setTyping(false);
    const v = toHms(draft);
    if (!v) { setDraft(line.trigger_time || ""); return; }
    if (v === (line.trigger_time || "")) { setDraft(v); return; }
    setDraft(v);
    onPatch({ trigger_time: v });
  };

  // How many of the selected dates this line actually covers. Said out loud whenever it is not all
  // of them: editing a line that only exists on 2 of your 5 selected dates changes those 2, and a
  // silent partial edit is how a date quietly keeps an old time.
  const partial = line.rows.length < selectedCount;

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
      <select value={line.announcement_uuid} onChange={e => onPatch({ announcement_uuid: e.target.value })}
        style={{ ...fld, flex: 1, minWidth: 0, borderColor: missing ? "var(--accent-red)" : "var(--border-primary)" }}>
        {/* An entry whose announcement is gone says so rather than silently showing the first item in
            the list — a schedule that quietly points somewhere else is how the wrong audio airs. */}
        {missing && <option value={line.announcement_uuid}>⚠ announcement missing</option>}
        {assets.map(a => <option key={a.uuid} value={a.uuid}>{a.title}</option>)}
      </select>

      <span title={line.rows.map(r => r.date).join(", ")}
        style={{ fontSize: 9, fontWeight: 700, padding: "3px 7px", whiteSpace: "nowrap" as any,
                 background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
                 color: partial ? "var(--accent-amber)" : "var(--text-tertiary)" }}>
        {line.rows.length}{partial ? `/${selectedCount}` : ""} date{line.rows.length === 1 ? "" : "s"}
      </span>

      <input type="time" step={1}
        value={draft}
        onFocus={() => setTyping(true)}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        style={{ ...fld, width: 124, borderColor: draft ? "var(--border-primary)" : "var(--accent-amber)" }} />

      <button onClick={onDelete} title="Remove this line from the selected dates"
        style={{ padding: "7px 9px", fontSize: 12, background: "var(--bg-secondary)", color: "var(--accent-red)",
                 border: "1px solid var(--border-primary)", cursor: "pointer", lineHeight: 1 }}>✕</button>
    </div>
  );
}

// ── THE SCHEDULE BOARD ───────────────────────────────────────────────────────────────────────────
// Left: the calendar — multi-select the real dates you are scheduling. Right: the announcements and
// times for those dates.
//
// EVERYTHING IS DATE-KEYED. There is no weekday or recurring concept: an entry is one announcement
// at one time on ONE calendar date, so what plays on a day is exactly what you put on that day and
// nothing has to be resolved or overridden.
//
// A LINE IS NOT A ROW. Adding a line to five selected dates writes five rows, one per date, because
// that is what the scheduler reads. The list groups them back into one line by (announcement, time)
// so the operator edits what they built rather than five copies of it, and the row's date count says
// how many of the selection it really covers.
function ScheduleBoard({ stationId, assets, entries, reload }: {
  stationId: number | null; assets: Announcement[]; entries: ScheduleEntry[]; reload: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set([ymd(new Date())]));
  const [err, setErr] = useState<string | null>(null);
  const api = () => (window as any).ether.announcements;

  const toggle = (d: string) =>
    setSelected(prev => { const n = new Set(prev); n.has(d) ? n.delete(d) : n.add(d); return n; });

  const dates = [...selected].sort();

  // Group the selected dates' rows into lines by (announcement, time).
  const lines: Line[] = (() => {
    const map = new Map<string, Line>();
    for (const e of entries) {
      if (!e.date || !selected.has(e.date)) continue;
      const t = e.trigger_time || "";
      const key = e.announcement_uuid + "|" + t;
      if (!map.has(key)) map.set(key, { key, announcement_uuid: e.announcement_uuid, trigger_time: t, rows: [] });
      map.get(key)!.rows.push(e);
    }
    return [...map.values()].sort((a, b) => (a.trigger_time || "").localeCompare(b.trigger_time || ""));
  })();

  const add = async () => {
    if (stationId == null) return;
    if (!dates.length) { setErr("Select one or more dates on the calendar first."); return; }
    if (!assets.length) { setErr("There are no announcements yet — upload one below first."); return; }
    setErr(null);
    try {
      for (const d of dates) {
        const r = await api().createEntry({
          station_id: stationId, announcement_uuid: assets[0].uuid, scope: "date", date: d,
          trigger_type: "absolute", trigger_time: "17:30:00", close_offset_min: 0, sort_order: lines.length,
        });
        if (!r?.ok) { setErr(r?.error || "could not add"); break; }
      }
      reload();
    } catch (e: any) { setErr(String(e?.message || e)); }
  };

  // An edit reaches every row the line stands for, so "this announcement at this time on these
  // dates" behaves as the single thing the operator built it as.
  const patch = async (line: Line, p: any) => {
    setErr(null);
    try {
      for (const row of line.rows) {
        if ("announcement_uuid" in p) {
          // announcement_uuid is part of the row's identity for the sync refs, not patchable.
          await api().deleteEntry(row.uuid, stationId);
          await api().createEntry({
            station_id: stationId, announcement_uuid: p.announcement_uuid, scope: "date", date: row.date,
            trigger_type: "absolute", trigger_time: row.trigger_time, close_offset_min: 0, sort_order: row.sort_order,
          });
        } else {
          const r = await api().updateEntry(row.uuid, p);
          if (!r?.ok) { setErr(r?.error || "could not save"); break; }
        }
      }
      reload();
    } catch (e: any) { setErr(String(e?.message || e)); }
  };

  const del = async (line: Line) => {
    setErr(null);
    try {
      for (const row of line.rows) await api().deleteEntry(row.uuid, stationId);
      reload();
    } catch (e: any) { setErr(String(e?.message || e)); }
  };

  const box = { padding: "12px 14px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" };
  const cap = { fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as any, marginBottom: 8 };

  const label = dates.length === 0 ? "no dates selected"
    : dates.length === 1 ? new Date(Number(dates[0].slice(0, 4)), Number(dates[0].slice(5, 7)) - 1, Number(dates[0].slice(8, 10)))
        .toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    : `${dates.length} dates — ${dates[0]} to ${dates[dates.length - 1]}`;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 330px) 1fr", gap: 12, alignItems: "start" }}>
      <div style={box}>
        <div style={cap}>Dates</div>
        <DatePicker selected={selected} onToggle={toggle} onClearAll={() => setSelected(new Set())} entries={entries} />
      </div>

      <div style={box}>
        <div style={cap}>Schedule</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10, lineHeight: 1.45 }}>
          {dates.length
            ? <>Playing on <strong style={{ color: "var(--text-primary)" }}>{label}</strong>
                {dates.length > 1 && <span style={{ color: "var(--text-tertiary)" }}> — a new line is added to all {dates.length}</span>}</>
            : <>Select one or more dates on the calendar to build their schedule.</>}
        </div>

        <button onClick={add} disabled={!dates.length}
          style={{ padding: "7px 13px", fontSize: 11, fontWeight: 700, background: "var(--accent-blue)",
                   color: "#fff", border: "none", cursor: dates.length ? "pointer" : "not-allowed",
                   opacity: dates.length ? 1 : 0.5, marginBottom: 10 }}>
          ＋ Add Announcement
        </button>

        {dates.length > 0 && lines.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
            Nothing scheduled on {dates.length === 1 ? "this date" : "these dates"}, so nothing plays.
            Press <strong>＋ Add Announcement</strong>, then set its time.
          </div>
        )}

        {lines.map(l => (
          <EntryRow key={l.key} line={l} assets={assets} selectedCount={dates.length}
            onPatch={pp => patch(l, pp)} onDelete={() => del(l)} />
        ))}

        {err && <div style={{ fontSize: 10, color: "var(--accent-red)", marginTop: 6 }}>{err}</div>}
      </div>
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

  // The ASSETS. Ordered by title now, not by trigger_time — an announcement no longer HAS one time.
  const load = async () => {
    if (!isReady) return;
    setList(await queryScoped<Announcement>("SELECT * FROM announcements ORDER BY title", [], stationId));
  };

  // THE SCHEDULE (v47). Every entry for this station, loaded once and split by scope where it is
  // used — the whole set is a handful of rows, and one read keeps the weekday list and the calendar
  // from disagreeing with each other.
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [schedErr, setSchedErr] = useState<string | null>(null);
  const loadEntries = async () => {
    if (stationId == null) return;
    try {
      const r = await (window as any).ether.announcements.listSchedule(stationId, {});
      if (r?.ok) { setEntries(r.rows || []); setSchedErr(null); }
      // An honest failure, not an empty list: an empty schedule and a broken one look identical
      // otherwise, and "nothing is scheduled" is the more dangerous of the two to get wrong.
      else setSchedErr(r?.error || "the schedule could not be read");
    } catch (e: any) { setSchedErr(String(e?.message || e)); }
  };
  useEffect(() => { load(); loadEntries(); }, [isReady, stationId]);

  const addNew = async () => {
    const files = await open({ multiple: false, title: "Select announcement audio", filters: [{ name: "Audio", extensions: ["mp3","flac","ogg","wav","m4a","aac"] }] });
    if (!files) return;
    const filePath = Array.isArray(files) ? files[0] : files;
    const title = (filePath.split(/[\\/]/).pop() || "").replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
    // No time, no days: an announcement is an ASSET now. When it plays is set in the Schedule below.
    setEditing({ title, file_path: filePath, duck_music: 1, resume_music: 1, duck_level: 0.1, is_active: 1 });
  };

  const save = async () => {
    if (!editing) return;
    if (editing.id) {
      // trigger_time / days / trigger_type / close_offset_min are NOT written any more. They are
      // vestigial columns kept so an older build can still open the database; the schedule lives in
      // announcement_schedule and nothing else may write it.
      await (window as any).ether.announcements.updateById(editing.id, {
        title: editing.title, is_active: editing.is_active ? 1 : 0,
      });
    } else {
      await (window as any).ether.announcements.create({
        station_id: stationId, title: editing.title, file_path: editing.file_path,
        duck_music: 1, resume_music: 1, duck_level: 0.1, is_active: editing.is_active ? 1 : 0,
      });
    }
    setEditing(null); load(); loadEntries();
  };

  const remove = async (id: number) => {
    const a = list.find(x => x.id === id);
    const n = a ? entries.filter(e => e.announcement_uuid === a.uuid).length : 0;
    // Says what ELSE goes, because deleting the asset cascades its schedule entries. A delete that
    // silently removes rows the operator did not name is how a schedule quietly loses a slot.
    if (!confirm(n ? `Delete "${a?.title}" and remove it from ${n} schedule ${n === 1 ? "entry" : "entries"}?`
                   : "Delete this announcement?")) return;
    await (window as any).ether.announcements.deleteById(id); load(); loadEntries();
  };

  // Can this station air an announcement at all? Asked once, so the AIR button explains itself
  // instead of failing at the moment someone presses it.
  const [airSlot, setAirSlot] = useState<string | null>(null);
  const [fireMsg, setFireMsg] = useState<string | null>(null);
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

          {/* ── THE SCHEDULE (v47) ─────────────────────────────────────────────────────────────
              Pick the days (or a date) on the left; build that selection's list of announcements and
              times on the right.

              THERE IS NO CLOSING-TIME UI HERE, deliberately (Jeff, 2026-08-26). The seven weekday
              closing times and the closing-time calendar were removed outright, along with the
              "before closing" trigger. One rule, nothing to reason about: an entry has a time, and
              nothing scheduled means nothing plays. */}
          <div style={{ marginTop: 14 }}>
            {schedErr ? (
              <div style={{ padding: "12px 14px", background: "var(--bg-tertiary)", border: "1px solid var(--accent-red)", fontSize: 11, color: "var(--accent-red)", lineHeight: 1.5 }}>
                The schedule could not be read: {schedErr}
                <div style={{ color: "var(--text-tertiary)", marginTop: 4 }}>
                  Nothing will fire until this is resolved. Close Ether fully and reopen — the
                  database upgrade runs on launch and retries itself.
                </div>
              </div>
            ) : (
              <ScheduleBoard stationId={stationId} assets={list} entries={entries} reload={loadEntries} />
            )}
          </div>
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

          {/* AN ANNOUNCEMENT IS AN ASSET (v47). Title and audio file — that is all it is.
              The trigger type, the time and the Active Days checkboxes used to live here; they were
              deleted rather than hidden, because WHEN this plays is no longer a property of the
              announcement. One announcement can now play at several times on several days, so its
              schedule lives in the Schedule section and nowhere else. */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as any, marginBottom: 5 }}>Title</div>
            <input value={editing.title || ""} onChange={e => setEditing({...editing, title: e.target.value})}
              style={{ width: "100%", padding: "9px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" as any }} />
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 6, lineHeight: 1.45 }}>
              {editing.id
                ? "When this plays is set in Schedule, below — it can appear on as many days and at as many times as you need."
                : "Save it, then add it to a day in Schedule below to give it a time."}
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
                {["Title", "Scheduled", "Duck", "Status", ""].map(h => (
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
                  {/* WHERE this plays, summarised from the schedule. "Not scheduled" is a real and
                      important state: an announcement with no entry never fires, and that has to be
                      visible in the list rather than discovered when it does not go to air. */}
                  <td style={{ padding: "12px 14px", fontSize: 12 }}>
                    {(() => {
                      const mine = entries.filter(e => e.announcement_uuid === a.uuid && e.date);
                      if (!mine.length) return <span style={{ color: "var(--accent-amber)" }}>not scheduled</span>;
                      const dates = [...new Set(mine.map(e => e.date))].sort();
                      const times = [...new Set(mine.map(e => e.trigger_time || ""))].sort();
                      // The next date it plays plus how many in total — enough to know it is live and
                      // when it next matters, without turning a table cell into a calendar.
                      const today = ymd(new Date());
                      const next  = dates.find(d => (d as string) >= today) || dates[dates.length - 1];
                      const when  = times.length === 1 && times[0] ? fmtTime(times[0]) : `${times.length} times`;
                      return <span style={{ color: "var(--accent-cyan)", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>
                        {next} {when}{dates.length > 1 ? ` · ${dates.length} dates` : ""}
                      </span>;
                    })()}
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

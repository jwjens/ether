import { useState, useEffect } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation, getActiveStationIdSync } from "../hooks/useActiveStation";
const open = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
const readFile = (p: string) => (window as any).ether.fs.readFile(p);
import { getEngine } from "../audio/engine-registry";
import { diffSchedule } from "../lib/scheduleDiff";

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
// about. The table, its IPC, its sync handler and its registry entry were removed outright in v49.

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
          Click a date to load its schedule. Click more and they <strong>add up</strong> — they stay
          selected across months, and Apply writes to all of them. A weekday letter takes every one
          of them in this month.
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
  /** v53. Set when an offset row's computed time had already passed — the closing time moved out
   *  from under it — so a skip is visible rather than silent. Cleared when the row fires. */
  skipped_at: number | null;
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

/** A line in the EDITOR. Nothing here exists in the database until APPLY — `id` is a local handle so
 *  React can key rows that have no uuid yet. */
interface Draft { id: number; announcement_uuid: string; trigger_time: string; }
let _draftSeq = 0;

function DraftRow({ line, assets, onPatch, onDelete }: {
  line: Draft;
  assets: Announcement[];
  onPatch: (patch: Partial<Draft>) => void;
  onDelete: () => void;
}) {
  const fld = {
    padding: "7px 9px", fontSize: 12, background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none",
  };
  const missing = !assets.some(a => a.uuid === line.announcement_uuid);

  // THE TIME FIELD IS A DRAFT WHILE IT HAS FOCUS. A fully controlled field that re-rendered on every
  // keystroke was why a typed second digit replaced the first: "1" is an INCOMPLETE time, so the
  // picker emits "" and the value snapped back. Keystrokes go to local state; the line is updated on
  // blur or Enter. (Nothing reaches the database either way until APPLY.)
  const [draft, setDraft]   = useState(line.trigger_time || "");
  const [typing, setTyping] = useState(false);
  useEffect(() => { if (!typing) setDraft(line.trigger_time || ""); }, [line.trigger_time, typing]);

  const commit = () => {
    setTyping(false);
    const v = toHms(draft);
    if (!v) { setDraft(line.trigger_time || ""); return; }
    setDraft(v);
    if (v !== line.trigger_time) onPatch({ trigger_time: v });
  };

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
      <select value={line.announcement_uuid} onChange={e => onPatch({ announcement_uuid: e.target.value })}
        style={{ ...fld, flex: 1, minWidth: 0, borderColor: missing ? "var(--accent-red)" : "var(--border-primary)" }}>
        {missing && <option value={line.announcement_uuid}>⚠ announcement missing</option>}
        {assets.map(a => <option key={a.uuid} value={a.uuid}>{a.title}</option>)}
      </select>

      <input type="time" step={1}
        value={draft}
        onFocus={() => setTyping(true)}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        style={{ ...fld, width: 124, borderColor: draft ? "var(--border-primary)" : "var(--accent-amber)" }} />

      <button onClick={onDelete} title="Remove this line"
        style={{ padding: "7px 9px", fontSize: 12, background: "var(--bg-secondary)", color: "var(--accent-red)",
                 border: "1px solid var(--border-primary)", cursor: "pointer", lineHeight: 1 }}>✕</button>
    </div>
  );
}

// ── BY MINUTES — announcements timed from closing ────────────────────────────────────────────────
//
// Jeff, 2026-08-31. Define the offsets ONCE and they fire correctly every night, because each row
// resolves at fire time against THAT DAY'S closing time (electron/main.js dueTimeFor). The same
// "-30" fires at 17:30 on an 18:00 Sunday and 21:30 on a 22:00 Saturday, with nothing rewritten in
// between — that is the whole feature, and it is why these rows carry no clock time of their own.
//
// SAME TWO GESTURES AS MANUAL: pick the nights on the calendar, build the list, press APPLY. No new
// recurrence concept — the multi-select IS the recurrence, exactly as it is for absolute entries, so
// nothing v48 deliberately removed comes back.
//
// NEGATIVE IS BEFORE CLOSE. -30 means thirty minutes before; 0 is closing time itself.
interface OffsetDraft { id: number; announcement_uuid: string; offset: number; }
let _offsetSeq = 0;

function ByMinutesBoard({ stationId, assets, entries, reload, closing }: {
  stationId: number | null; assets: Announcement[]; entries: ScheduleEntry[]; reload: () => void;
  closing: ClosingCfg;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [draft, setDraft]       = useState<OffsetDraft[]>([]);
  const [dirty, setDirty]       = useState(false);
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState<string | null>(null);
  const [msg, setMsg]           = useState<string | null>(null);
  const api = () => (window as any).ether.announcements;

  const linesFor = (d: string): OffsetDraft[] =>
    entries.filter(e => e.date === d && e.trigger_type === "close_offset")
      .sort((a, b) => (a.close_offset_min ?? 0) - (b.close_offset_min ?? 0))
      .map(e => ({ id: ++_offsetSeq, announcement_uuid: e.announcement_uuid, offset: e.close_offset_min ?? 0 }));

  const toggleDate = (d: string) => {
    if (selected.size === 0) { setSelected(new Set([d])); setDraft(linesFor(d)); setDirty(false); return; }
    const n = new Set(selected);
    n.has(d) ? n.delete(d) : n.add(d);
    setSelected(n);
    if (n.size === 0) { setDraft([]); setDirty(false); }
  };
  const clearAll = () => { setSelected(new Set()); setDraft([]); setDirty(false); setErr(null); setMsg(null); };
  const dates = [...selected].sort();

  const addLine = () => {
    if (!assets.length) { setErr("There are no announcements yet — upload one below first."); return; }
    setDraft(d => [...d, { id: ++_offsetSeq, announcement_uuid: assets[0].uuid, offset: -30 }]);
    setDirty(true); setMsg(null);
  };
  const patchLine  = (id: number, p: Partial<OffsetDraft>) => { setDraft(d => d.map(l => l.id === id ? { ...l, ...p } : l)); setDirty(true); setMsg(null); };
  const removeLine = (id: number) => { setDraft(d => d.filter(l => l.id !== id)); setDirty(true); setMsg(null); };

  // What a rule actually fires at on a given date. Shown per line for TWO different selected dates
  // where they differ, because seeing one rule produce two times is what makes the model legible.
  const dowOf = (ymd: string) => new Date(`${ymd}T12:00:00`).getDay();
  const firesAt = (offset: number, date: string): string | null => {
    const c = resolveClosingCfg(closing, date, dowOf(date));
    if (!c) return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(c);
    if (!m) return null;
    const total = ((Number(m[1]) * 60 + Number(m[2]) + offset) % 1440 + 1440) % 1440;
    const h = Math.floor(total / 60), mi = total % 60;
    const ampm = h >= 12 ? "PM" : "AM";
    return `${h % 12 === 0 ? 12 : h % 12}:${String(mi).padStart(2, "0")} ${ampm}`;
  };
  // Two example dates from the selection whose closing times differ — the pair worth showing.
  const examples = (() => {
    if (!dates.length) return [];
    const seen = new Map<string, string>();
    for (const d of dates) {
      const c = resolveClosingCfg(closing, d, dowOf(d)) || "—";
      if (!seen.has(c)) seen.set(c, d);
      if (seen.size === 2) break;
    }
    return [...seen.values()];
  })();

  const apply = async () => {
    if (stationId == null || !dates.length) return;
    if (draft.some(l => !Number.isFinite(l.offset))) { setErr("Every line needs a number of minutes."); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      let created = 0, removed = 0, kept = 0;
      for (const d of dates) {
        // ONLY close_offset rows on this date are touched. The MANUAL tab's absolute entries for the
        // same night are left exactly as they are — applying one tab must never silently wipe the
        // other's work, which is the whole risk of two editors over one table.
        const existing = entries.filter(e => e.date === d && e.trigger_type === "close_offset");
        const key = (u: string, o: number) => `${u}|${o}`;
        const want = new Map(draft.map(l => [key(l.announcement_uuid, l.offset), l]));
        const have = new Map(existing.map(e => [key(e.announcement_uuid, e.close_offset_min ?? 0), e]));

        // An unchanged line KEEPS its row, and therefore its last_played_at and its 120s guard.
        // Delete-and-recreate would clear the stamp and let a row that already fired tonight fire
        // again — the same rule the MANUAL tab's diffSchedule exists to protect.
        for (const [k, e] of have) if (!want.has(k)) { await api().deleteEntry(e.uuid, stationId); removed++; }
        for (const [k, l] of want) {
          if (have.has(k)) { kept++; continue; }
          const r = await api().createEntry({
            station_id: stationId, announcement_uuid: l.announcement_uuid, scope: "date", date: d,
            trigger_type: "close_offset", trigger_time: null, close_offset_min: l.offset, sort_order: 0,
          });
          if (!r?.ok) throw new Error(r?.error || "could not write an entry");
          created++;
        }
      }
      reload();
      setMsg(`Applied to ${dates.length} date${dates.length === 1 ? "" : "s"} — ${created} added, ${removed} removed${kept ? `, ${kept} unchanged` : ""}.`);
      setSelected(new Set()); setDraft([]); setDirty(false);
    } catch (e: any) {
      setErr(String(e?.message || e));
      reload();
    } finally { setBusy(false); }
  };

  const box = { padding: "12px 14px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" };
  const cap = { fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as any, marginBottom: 8 };
  const noClosing = !closing.default && Object.keys(closing.byWeekday).length === 0 && Object.keys(closing.byDate).length === 0;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 330px) 1fr minmax(200px, 240px)", gap: 12, alignItems: "start" }}>
      <div style={box}>
        <div style={cap}>Dates</div>
        <DatePicker selected={selected} onToggle={toggleDate} onClearAll={clearAll} entries={entries} />
      </div>

      <div style={box}>
        <div style={cap}>Minutes before closing</div>

        {/* An offset rule is meaningless without a closing time, and this says so BEFORE the operator
            builds a list that could never fire. */}
        {noClosing && (
          <div style={{ fontSize: 11, color: "var(--accent-red, #ef4444)", lineHeight: 1.5, marginBottom: 10 }}>
            No closing time is set. Announcements timed from closing cannot fire until one is —
            set it on the right.
          </div>
        )}

        {dates.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
            Click a date to see and edit its timed-from-closing announcements. Click more dates to set
            them all together. Nothing is written until you press <strong>Apply</strong>.
          </div>
        ) : (
          <>
            {draft.map(l => (
              <div key={l.id} style={{ display: "grid", gridTemplateColumns: "92px 1fr 20px", gap: 6, alignItems: "center", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="number" step={5} value={l.offset}
                    onChange={e => patchLine(l.id, { offset: parseInt(e.target.value, 10) || 0 })}
                    aria-label="Minutes relative to closing"
                    style={{ width: 56, fontSize: 12, padding: "4px 6px", borderRadius: 6, background: "var(--bg-secondary)",
                             color: "var(--text-primary)", border: "1px solid var(--border-primary)", fontVariantNumeric: "tabular-nums" }} />
                  <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>min</span>
                </div>
                <div>
                  <select
                    value={l.announcement_uuid}
                    onChange={e => patchLine(l.id, { announcement_uuid: e.target.value })}
                    style={{ width: "100%", fontSize: 12, padding: "4px 6px", borderRadius: 6, background: "var(--bg-secondary)",
                             color: "var(--text-primary)", border: "1px solid var(--border-primary)" }}>
                    {assets.map(a => <option key={a.uuid} value={a.uuid}>{a.title}</option>)}
                  </select>
                  {/* The same rule, on two different nights. This is the feature made visible. */}
                  <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
                    {l.offset === 0 ? "at closing" : `${Math.abs(l.offset)} min ${l.offset < 0 ? "before" : "after"} close`}
                    {examples.map(d => {
                      const t = firesAt(l.offset, d);
                      return t ? <span key={d}> · {d} → {t}</span> : null;
                    })}
                  </div>
                </div>
                <button onClick={() => removeLine(l.id)} title="Remove"
                        style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14, padding: 0 }}>×</button>
              </div>
            ))}

            <button onClick={addLine} disabled={busy}
                    style={{ fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 6, cursor: "pointer", marginTop: 4,
                             background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)" }}>
              + Add Announcement
            </button>

            {draft.length === 0 && (
              <p style={{ fontSize: 11, color: "var(--text-tertiary)", margin: "8px 0 0", lineHeight: 1.5 }}>
                Empty. Applying now would clear the timed-from-closing announcements on {dates.length === 1 ? "this date" : "these dates"}.
              </p>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
              <button onClick={apply} disabled={busy || !dirty}
                      style={{ fontSize: 12, fontWeight: 800, padding: "8px 14px", borderRadius: 6,
                               cursor: busy || !dirty ? "default" : "pointer", opacity: busy || !dirty ? 0.5 : 1,
                               background: "var(--accent-blue)", color: "#fff", border: "none" }}>
                {busy ? "Applying…" : `APPLY to ${dates.length} date${dates.length === 1 ? "" : "s"}`}
              </button>
              <button onClick={clearAll} disabled={busy}
                      style={{ fontSize: 12, padding: "8px 12px", borderRadius: 6, cursor: "pointer",
                               background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)" }}>
                Cancel
              </button>
            </div>
            <p style={{ fontSize: 10, color: "var(--text-tertiary)", margin: "6px 0 0", lineHeight: 1.5 }}>
              Apply replaces only the timed-from-closing announcements on the selected dates. Fixed-time
              announcements on those dates are left alone.
            </p>
          </>
        )}

        {err && <div style={{ fontSize: 11, color: "var(--accent-red)", marginTop: 8 }}>{err}</div>}
        {msg && <div style={{ fontSize: 11, color: "var(--accent-green)", marginTop: 8 }}>{msg}</div>}
      </div>

      <ClosingTimeField stationId={stationId} />
    </div>
  );
}

// ── CLOSING TIME: the shape, shared by the field and anything that resolves it ──────────────────
// One station_config_kv row, key `closing_time`. Resolution is byDate -> byWeekday -> default, and
// byWeekday is keyed 0-6 SUNDAY FIRST to match Date#getDay, electron/main.js and the Park Ops
// backend. All four must agree or the station fires at an hour the phone never showed.
export interface ClosingCfg {
  default: string | null;
  byWeekday: Record<string, string>;
  byDate: Record<string, string>;
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Tolerant by design: a corrupt or half-written value reads as "nothing set", never as a partial
 *  config that would resolve to a time nobody chose. */
export function parseClosingCfg(raw: string | null | undefined): ClosingCfg {
  const empty: ClosingCfg = { default: null, byWeekday: {}, byDate: {} };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return empty;
    return {
      default: typeof v.default === "string" && v.default ? v.default : null,
      byWeekday: (v.byWeekday && typeof v.byWeekday === "object") ? v.byWeekday : {},
      byDate: (v.byDate && typeof v.byDate === "object") ? v.byDate : {},
    };
  } catch { return empty; }
}

/** byDate -> byWeekday -> default. `dow` is 0-6, Sunday first. */
export function resolveClosingCfg(cfg: ClosingCfg, dateStr: string, dow: number): string | null {
  const d = cfg.byDate?.[dateStr];
  if (typeof d === "string" && d) return d;
  const w = cfg.byWeekday?.[String(dow)];
  if (typeof w === "string" && w) return w;
  return cfg.default || null;
}

// ── CLOSING TIME (2026-08-31) ────────────────────────────────────────────────────────────────────
//
// THIS REVERSES THE 2026-08-26 REMOVAL, deliberately and on a different design. What was removed
// then was seven weekday closing times plus a per-date override calendar (v46), backed by its own
// synced table — an exception layer nobody could reason about, whose last consumer went with the
// weekday scope in v48. The table was dropped in v49 and is NOT coming back.
//
// What replaces it is one value: a single station_config_kv row, key `closing_time`, holding
// { default, byWeekday, byDate } and resolved date -> weekday -> default. Only `default` is
// editable, here and on Park Ops; the other two keys exist so the shape does not have to change if
// scope is ever ruled on again.
//
// WHY IT IS BACK: Park Ops (park.ether-cast.com/<slug>) put the closing time in a park operator's
// hand on their phone, and the studio needs to set the same value. It is ONE value with two
// surfaces — this field and that page write the identical KV row through the identical sanctioned
// writer, so they cannot disagree.
function ClosingTimeField({ stationId }: { stationId: number | null }) {
  const [cfg, setCfg] = useState<ClosingCfg>({ default: null, byWeekday: {}, byDate: {} });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newDate, setNewDate] = useState("");

  const read = async () => {
    if (stationId == null) return;
    try {
      const r = await (window as any).ether.stationConfigKv.list(stationId);
      const rows: any[] = Array.isArray(r) ? r : (r?.rows ?? []);
      const raw = rows.find(x => x?.key === "closing_time" && !x?.deleted_at)?.value ?? null;
      setCfg(parseClosingCfg(raw));
      setErr(null);
    } catch (e: any) { setErr(String(e?.message || e)); }
  };
  useEffect(() => { read(); }, [stationId]);

  // THE HARD RULE (Jeff, 2026-08-31), enforced in ONE place so no caller can get it wrong:
  // "Changing a SINGLE day's closing time affects ONLY that day. It must NEVER touch the rest of the
  // calendar, a following Sunday, the weekday pattern, or any other date."
  //
  // Every edit routes through here as a MUTATOR over the current config — read, apply one change,
  // write back. The mutator may only touch the key it owns; scripts/smoke-closing-isolation.js pins
  // that as a property (change one thing, assert exactly the intended dates moved).
  //
  // Read-modify-write against THIS install's own row, never a cached or mirrored copy, so a
  // concurrent change from elsewhere cannot be carried back in a stale form.
  const commit = async (mutate: (c: ClosingCfg) => ClosingCfg) => {
    if (stationId == null) return;
    setBusy(true); setErr(null);
    try {
      const r = await (window as any).ether.stationConfigKv.list(stationId);
      const rows: any[] = Array.isArray(r) ? r : (r?.rows ?? []);
      const raw = rows.find(x => x?.key === "closing_time" && !x?.deleted_at)?.value ?? null;
      const next = mutate(parseClosingCfg(raw));
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, "closing_time", JSON.stringify(next));
      setCfg(next);
      // Park Ops reads the mirrored copy. Without this the operator's phone shows the old closing
      // time for up to a minute — and the two surfaces disagreeing is what this feature cannot afford.
      window.dispatchEvent(new CustomEvent("ether:ops-push"));
    } catch (e: any) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const setDefault = (t: string) => commit(c => ({ ...c, default: t || null }));
  const setWeekday = (dow: number, t: string) => commit(c => {
    const bw = { ...c.byWeekday };
    if (t) bw[String(dow)] = t; else delete bw[String(dow)];   // cleared → falls back to default
    return { ...c, byWeekday: bw };
  });
  const setDate = (date: string, t: string) => commit(c => {
    const bd = { ...c.byDate };
    if (t) bd[date] = t; else delete bd[date];                 // cleared → falls back to the pattern
    return { ...c, byDate: bd };
  });

  const inputStyle: React.CSSProperties = {
    width: "100%", fontSize: 13, fontWeight: 600, padding: "4px 6px", borderRadius: 6,
    background: "var(--bg-tertiary)", color: "var(--text-primary)",
    border: "1px solid var(--border-primary)", fontVariantNumeric: "tabular-nums",
  };
  const rowStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "58px 1fr", gap: 6, alignItems: "center", marginBottom: 4 };
  const dates = Object.keys(cfg.byDate).sort();

  return (
    <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 10 }}>
        Park closes
      </div>

      {/* Read top to bottom in the order it RESOLVES: a specific date wins, then the weekday, then
          the default. The layout is the precedence, so there is nothing to memorise. */}
      <div style={rowStyle}>
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Every day</span>
        <input type="time" style={inputStyle} disabled={stationId == null || busy}
               value={cfg.default ?? ""} onChange={e => setDefault(e.target.value)} aria-label="Default closing time" />
      </div>

      <div style={{ height: 1, background: "var(--border-primary)", margin: "10px 0" }} />

      {DOW_LABELS.map((label, dow) => (
        <div key={dow} style={rowStyle}>
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{label}</span>
          <input type="time" style={inputStyle} disabled={stationId == null || busy}
                 value={cfg.byWeekday[String(dow)] ?? ""} onChange={e => setWeekday(dow, e.target.value)}
                 aria-label={`${label} closing time`}
                 placeholder={cfg.default ?? ""} />
        </div>
      ))}
      <p style={{ fontSize: 10, color: "var(--text-tertiary)", margin: "6px 0 0", lineHeight: 1.5 }}>
        Blank means that day uses the every-day time.
      </p>

      <div style={{ height: 1, background: "var(--border-primary)", margin: "10px 0" }} />

      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 6 }}>
        One-off dates
      </div>
      {dates.length === 0 && (
        <p style={{ fontSize: 11, color: "var(--text-tertiary)", margin: "0 0 6px", lineHeight: 1.5 }}>
          None. A date set here overrides the pattern for that day only.
        </p>
      )}
      {dates.map(d => (
        <div key={d} style={{ display: "grid", gridTemplateColumns: "1fr 84px 20px", gap: 6, alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>{d}</span>
          <input type="time" style={inputStyle} disabled={busy}
                 value={cfg.byDate[d] ?? ""} onChange={e => setDate(d, e.target.value)} aria-label={`Closing time for ${d}`} />
          <button onClick={() => setDate(d, "")} disabled={busy} title="Remove this override"
                  style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14, padding: 0 }}>×</button>
        </div>
      ))}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6, marginTop: 6 }}>
        <input type="date" style={inputStyle} disabled={busy} value={newDate}
               onChange={e => setNewDate(e.target.value)} aria-label="Add a one-off closing date" />
        <button
          disabled={busy || !newDate || !!cfg.byDate[newDate]}
          onClick={() => { setDate(newDate, cfg.default || "22:00"); setNewDate(""); }}
          style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 6, cursor: "pointer",
                   background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)" }}>
          Add
        </button>
      </div>

      {err && <p style={{ fontSize: 11, color: "var(--accent-red, #ef4444)", margin: "10px 0 0" }}>{err}</p>}
      <p style={{ fontSize: 11, color: "var(--text-secondary)", margin: "10px 0 0", lineHeight: 1.5 }}>
        The same closing time the Park Ops page shows. Announcements timed by minutes-before-close are
        measured from whichever of these applies that day.
      </p>
      {!cfg.default && Object.keys(cfg.byWeekday).length === 0 && (
        <p style={{ fontSize: 11, color: "var(--text-tertiary)", margin: "6px 0 0", lineHeight: 1.5 }}>
          Nothing set — announcements timed from closing cannot fire until one of these has a time.
        </p>
      )}
    </div>
  );
}

// ── THE SCHEDULE BOARD — select, edit, APPLY ─────────────────────────────────────────────────────
//
// SELECT the date(s) on the left, EDIT the list on the right, press APPLY. Nothing is written until
// APPLY, and APPLY makes each selected date's schedule EXACTLY what is in the editor. Then the
// selection and the editor clear, so what you are editing is never in doubt.
//
// This replaced a live-accumulating editor that wrote on every keystroke and grouped rows across
// whatever happened to be selected. It could show a line as "24 dates" — a number that came from the
// selection rather than from anything the operator had built — and it was never clear what an edit
// was about to change. Each date owns its own list now, and the editor is a staging area for exactly
// one commit.
//
// LOADING RULE, so the editor is never silently replaced under a half-finished edit:
//   • start from an empty selection and click a date  → the editor LOADS that date's schedule
//   • click more dates                                → the editor is left alone; APPLY writes it to all of them
//   • deselect a date                                 → the editor is left alone
//   • APPLY or Clear                                  → selection and editor both empty
// So "click one date and edit it" and "build a batch for many dates" are the same two gestures, and
// loading a day then adding dates is how a day gets copied onto others.
function ScheduleBoard({ stationId, assets, entries, reload }: {
  stationId: number | null; assets: Announcement[]; entries: ScheduleEntry[]; reload: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [draft, setDraft]       = useState<Draft[]>([]);
  const [dirty, setDirty]       = useState(false);
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState<string | null>(null);
  const [msg, setMsg]           = useState<string | null>(null);
  const api = () => (window as any).ether.announcements;

  const linesFor = (d: string): Draft[] =>
    entries.filter(e => e.date === d)
      .slice()
      .sort((a, b) => (a.trigger_time || "").localeCompare(b.trigger_time || ""))
      .map(e => ({ id: ++_draftSeq, announcement_uuid: e.announcement_uuid, trigger_time: e.trigger_time || "" }));

  // Computed OUTSIDE the state updater, deliberately. React double-invokes updaters in development,
  // so seeding the editor from inside one would run linesFor twice and could load a stale list over
  // a fresh click. The updater stays pure; the editor is set alongside it.
  const toggleDate = (d: string) => {
    setErr(null); setMsg(null);
    if (selected.size === 0) {
      // Starting a fresh selection LOADS that date's schedule — this is the "click one day and edit
      // it" gesture. Once a selection exists the editor is the operator's; adding or removing dates
      // never reaches in and rewrites it under a half-finished edit.
      setSelected(new Set([d]));
      setDraft(linesFor(d));
      setDirty(false);
      return;
    }
    const n = new Set(selected);
    n.has(d) ? n.delete(d) : n.add(d);
    setSelected(n);
    if (n.size === 0) { setDraft([]); setDirty(false); }
  };

  const clearAll = () => { setSelected(new Set()); setDraft([]); setDirty(false); setErr(null); setMsg(null); };

  const dates = [...selected].sort();

  const addLine = () => {
    if (!assets.length) { setErr("There are no announcements yet — upload one below first."); return; }
    setDraft(d => [...d, { id: ++_draftSeq, announcement_uuid: assets[0].uuid, trigger_time: "17:30:00" }]);
    setDirty(true); setMsg(null);
  };
  const patchLine  = (id: number, p: Partial<Draft>) => { setDraft(d => d.map(l => l.id === id ? { ...l, ...p } : l)); setDirty(true); setMsg(null); };
  const removeLine = (id: number) => { setDraft(d => d.filter(l => l.id !== id)); setDirty(true); setMsg(null); };

  // ── APPLY ──────────────────────────────────────────────────────────────────────────────────────
  // Per date, a DIFF and not a wipe-and-rewrite. A line that is already on the date keeps its row —
  // and therefore its last_played_at, which is the 120s double-fire guard. Recreating every row on
  // every apply would reset that guard and let something re-fire inside its own window.
  const apply = async () => {
    if (stationId == null || !dates.length) return;
    const bad = draft.filter(l => !toHms(l.trigger_time));
    if (bad.length) { setErr("Every line needs a time before this can be applied."); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      let created = 0, removed = 0, kept = 0;
      const want = draft.map(l => ({ ...l, trigger_time: toHms(l.trigger_time) }));
      for (const d of dates) {
        // diffSchedule is in src/lib and has its own tests — the rule that an unchanged line keeps
        // its row (and therefore its 120s guard) is load-bearing enough to be tested, not asserted
        // in a comment.
        const { remove, create, keep } = diffSchedule(entries.filter(e => e.date === d), want);
        kept += keep.length;
        for (const e of remove) { await api().deleteEntry(e.uuid, stationId); removed++; }
        for (const l of create) {
          const r = await api().createEntry({
            station_id: stationId, announcement_uuid: l.announcement_uuid, scope: "date", date: d,
            trigger_type: "absolute", trigger_time: l.trigger_time, close_offset_min: 0, sort_order: 0,
          });
          if (!r?.ok) throw new Error(r?.error || "could not write an entry");
          created++;
        }
      }
      reload();
      setMsg(`Applied to ${dates.length} date${dates.length === 1 ? "" : "s"} — ${created} added, ${removed} removed${kept ? `, ${kept} unchanged` : ""}.`);
      setSelected(new Set()); setDraft([]); setDirty(false);
    } catch (e: any) {
      setErr(String(e?.message || e));
      reload();                                  // show whatever did land, rather than a stale editor
    } finally { setBusy(false); }
  };

  // What APPLY is about to overwrite. Stated before the press, never discovered after it.
  const willReplace = dates.filter(d => entries.some(e => e.date === d)).length;

  const box = { padding: "12px 14px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" };
  const cap = { fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as any, marginBottom: 8 };

  const label = dates.length === 0 ? ""
    : dates.length === 1 ? new Date(Number(dates[0].slice(0, 4)), Number(dates[0].slice(5, 7)) - 1, Number(dates[0].slice(8, 10)))
        .toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    : `${dates.length} dates — ${dates[0]} to ${dates[dates.length - 1]}`;

  return (
    // Three columns: dates, the schedule being edited, and the closing time. Closing time sits to the
    // RIGHT of the schedule rather than inside it, because it is not part of any one date's list — it
    // is a station-level value the whole board is measured against. Putting it in the editor would
    // imply APPLY writes it; it does not, it saves on its own.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 330px) 1fr minmax(200px, 240px)", gap: 12, alignItems: "start" }}>
      <div style={box}>
        <div style={cap}>Dates</div>
        <DatePicker selected={selected} onToggle={toggleDate} onClearAll={clearAll} entries={entries} />
      </div>

      <div style={box}>
        <div style={cap}>Schedule</div>

        {dates.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
            Click a date to see and edit its schedule. Click more dates to set them all together.
            Nothing is written until you press <strong>Apply</strong>.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10, lineHeight: 1.45 }}>
              Editing <strong style={{ color: "var(--text-primary)" }}>{label}</strong>
            </div>

            <button onClick={addLine}
              style={{ padding: "7px 13px", fontSize: 11, fontWeight: 700, background: "var(--bg-secondary)",
                       color: "var(--accent-blue)", border: "1px solid var(--border-primary)", cursor: "pointer", marginBottom: 10 }}>
              ＋ Add Announcement
            </button>

            {draft.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.5, marginBottom: 10 }}>
                Empty. Applying now would clear {dates.length === 1 ? "this date" : "these dates"} — nothing would play.
              </div>
            ) : (
              draft.map(l => (
                <DraftRow key={l.id} line={l} assets={assets}
                  onPatch={pp => patchLine(l.id, pp)} onDelete={() => removeLine(l.id)} />
              ))
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border-primary)" }}>
              <button onClick={apply} disabled={busy}
                style={{ padding: "9px 20px", fontSize: 12, fontWeight: 800, letterSpacing: "0.04em",
                         background: busy ? "var(--bg-secondary)" : "var(--accent-blue)", color: busy ? "var(--text-tertiary)" : "#fff",
                         border: "none", cursor: busy ? "wait" : "pointer" }}>
                {busy ? "Applying…" : `APPLY to ${dates.length} date${dates.length === 1 ? "" : "s"}`}
              </button>
              <button onClick={clearAll} disabled={busy}
                style={{ padding: "9px 14px", fontSize: 11, background: "var(--bg-secondary)", color: "var(--text-secondary)",
                         border: "1px solid var(--border-primary)", cursor: "pointer" }}>
                Cancel
              </button>
              {dirty && <span style={{ fontSize: 10, color: "var(--accent-amber)" }}>unapplied changes</span>}
            </div>

            {/* Said BEFORE the press. Apply sets each selected date's schedule to exactly this list,
                so a date that already had something loses whatever is not in the editor. */}
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 6, lineHeight: 1.45 }}>
              Apply replaces the schedule on {dates.length === 1 ? "the selected date" : `all ${dates.length} selected dates`} with
              exactly {draft.length === 0 ? "nothing" : `these ${draft.length} line${draft.length === 1 ? "" : "s"}`}.
              {willReplace > 0 && dates.length > 1 && (
                <span style={{ color: "var(--accent-amber)" }}> {willReplace} of them already {willReplace === 1 ? "has" : "have"} entries, which will be replaced.</span>
              )}
            </div>
          </>
        )}

        {err && <div style={{ fontSize: 11, color: "var(--accent-red)", marginTop: 8 }}>{err}</div>}
        {msg && <div style={{ fontSize: 11, color: "var(--accent-green)", marginTop: 8 }}>{msg}</div>}
      </div>

      <ClosingTimeField stationId={stationId} />
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
  // A FILTERED VIEW OVER THE ONE TYPED LIBRARY (docs/library-current-state.md, Option 1).
  //
  // `library_asset` is install-scoped and carries the global fields — title and file_path, the things
  // that are the same wherever the file is used. `announcements` carries what belongs to THIS station:
  // trigger time, days, duck settings. Joining them is what keeps the view station-scoped, and it is
  // the same global-vs-station-specific split RCS uses.
  //
  // queryScoped injects a bare `station_id = ?`, which resolves unambiguously to `announcements`
  // because library_asset deliberately has no such column.
  //
  // Filtering on la.deleted_at also fixes a quiet bug: the old query had no deleted_at test at all, so
  // a soft-deleted announcement kept rendering here — the same defect Spots fixed in v4.4.83.
  const load = async () => {
    if (!isReady) return;
    setList(await queryScoped<Announcement>(
      `SELECT a.*, la.title AS title, la.file_path AS file_path
         FROM library_asset la
         JOIN announcements a ON a.uuid = la.uuid
        WHERE la.type = 'ANNOUNCEMENT' AND la.deleted_at IS NULL AND a.deleted_at IS NULL
        ORDER BY la.title`, [], stationId));
  };

  // THE SCHEDULE (v47). Every entry for this station, loaded once and split by scope where it is
  // used — the whole set is a handful of rows, and one read keeps the weekday list and the calendar
  // from disagreeing with each other.
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [schedErr, setSchedErr] = useState<string | null>(null);
  // MANUAL is the existing absolute-time board; BY MINUTES times from closing. Two editors over one
  // table, which is exactly why each APPLY only ever touches its own trigger_type.
  const [tab, setTab] = useState<"manual" | "minutes">("manual");
  // Read ONCE here and handed to the BY MINUTES board, so the fire-time previews and the field the
  // operator is editing cannot disagree about what the closing time currently is.
  const [closing, setClosing] = useState<ClosingCfg>({ default: null, byWeekday: {}, byDate: {} });
  const loadClosing = async () => {
    if (stationId == null) return;
    try {
      const r = await (window as any).ether.stationConfigKv.list(stationId);
      const rows: any[] = Array.isArray(r) ? r : (r?.rows ?? []);
      setClosing(parseClosingCfg(rows.find(x => x?.key === "closing_time" && !x?.deleted_at)?.value ?? null));
    } catch { /* leave the last good value; the field itself reports its own errors */ }
  };
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
  useEffect(() => { load(); loadEntries(); loadClosing(); }, [isReady, stationId]);
  // The closing-time field pushes to Park Ops on save; the same event refreshes the previews here, so
  // changing Sunday's close visibly moves every "-30" line without a reload.
  useEffect(() => {
    const h = () => loadClosing();
    window.addEventListener("ether:ops-push", h);
    return () => window.removeEventListener("ether:ops-push", h);
  }, [stationId]);

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

              CLOSING TIME IS BACK (Jeff, 2026-08-31), and this comment used to say the opposite —
              so read the difference rather than assuming a reversal. What was removed on 2026-08-26
              was SEVEN WEEKDAY closing times plus a per-date override calendar on its own synced
              table (dropped in v49); that shape is not returning. What is here is ONE value in
              station_config_kv, edited in one field, shared with the Park Ops page that a park
              operator carries on their phone. The rule stays as simple as the removal intended:
              an entry has a time, or it is measured from the one closing time. */}
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
              <>
                {/* Two ways to time an announcement, and the tab says which one you are building.
                    MANUAL sets a clock time; BY MINUTES measures from that day's closing time. */}
                <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
                  {([["manual", "Manual"], ["minutes", "By minutes"]] as const).map(([id, label]) => (
                    <button key={id} onClick={() => setTab(id)}
                            style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase",
                                     padding: "6px 12px", borderRadius: 6, cursor: "pointer",
                                     background: tab === id ? "var(--accent-blue)" : "var(--bg-tertiary)",
                                     color: tab === id ? "#fff" : "var(--text-secondary)",
                                     border: "1px solid " + (tab === id ? "var(--accent-blue)" : "var(--border-primary)") }}>
                      {label}
                    </button>
                  ))}
                </div>
                {tab === "manual"
                  ? <ScheduleBoard stationId={stationId} assets={list} entries={entries} reload={loadEntries} />
                  : <ByMinutesBoard stationId={stationId} assets={list} entries={entries}
                                    reload={() => { loadEntries(); loadClosing(); }} closing={closing} />}
              </>
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
                      // The next date it plays plus how many in total — enough to know it is live and
                      // when it next matters, without turning a table cell into a calendar.
                      const today = ymd(new Date());
                      const next  = dates.find(d => (d as string) >= today) || dates[dates.length - 1];

                      // An offset entry has NO clock time of its own — its time is computed against
                      // that day's closing time when it fires. Describing it by trigger_time would
                      // read as blank, so it is described by the rule instead, which is also the
                      // thing the operator actually set.
                      const offs = mine.filter(e => e.trigger_type === "close_offset");
                      const abso = mine.filter(e => e.trigger_type !== "close_offset");
                      const parts: string[] = [];
                      if (abso.length) {
                        const times = [...new Set(abso.map(e => e.trigger_time || ""))].sort();
                        parts.push(times.length === 1 && times[0] ? fmtTime(times[0]) : `${times.length} times`);
                      }
                      if (offs.length) {
                        const os = [...new Set(offs.map(e => e.close_offset_min ?? 0))].sort((x, y) => x - y);
                        parts.push(os.length === 1
                          ? (os[0] === 0 ? "at closing" : `${Math.abs(os[0])} min ${os[0] < 0 ? "before" : "after"} close`)
                          : `${os.length} timed from closing`);
                      }
                      // A SKIP IS LOUD (v53). A row whose computed time had already passed never
                      // fired, and the operator has to see that here rather than discover it by
                      // noticing silence. Amber, next to the schedule it failed to keep.
                      const skipped = mine.filter(e => e.skipped_at).length;
                      return <span style={{ color: "var(--accent-cyan)", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>
                        {next} {parts.join(" + ")}{dates.length > 1 ? ` · ${dates.length} dates` : ""}
                        {skipped > 0 && (
                          <span style={{ color: "var(--accent-amber)" }}
                                title="Its computed time had already passed when the closing time moved, so it did not play.">
                            {" "}· {skipped} skipped
                          </span>
                        )}
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

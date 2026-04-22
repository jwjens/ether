// SchedulePreview.tsx — see what's about to play in the next 24 hours.
//
// This is the "log preview" feature GSelector and Wide Orbit have made
// the cornerstone of every PD's morning workflow. You see, hour by hour:
//
//   - The active show + format clock for that hour
//   - PD-pinned songs in their slots (highlighted)
//   - Empty slots that the rotation will fill at runtime
//   - Existing scheduled_log entries (already-built schedule)
//   - Conflicts: pin in a slot the clock doesn't have, etc.
//
// Future enhancement: drag-edit the slots inline. For v1 this is read-only
// preview + jump-to-edit links.

import { useEffect, useState } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";

interface ShowRow {
  id: number;
  name: string;
  start_hour: number;
  end_hour: number;
  day_of_week: number; // 0..6
  clock_id: number | null;
  clock_name?: string;
}

interface ClockSlot {
  id: number;
  clock_id: number;
  position: number;
  slot_type: string;        // 'music' | 'spot' | 'liner' | 'news' | 'sweeper' | 'jingle' | 'open'
  category_id: number | null;
  category_code?: string;
  category_color?: string;
}

interface PinnedRow {
  id: number;
  song_id: number;
  slot_hour: number;
  slot_position: number;
  recur_dow: number;
  play_at_unix: number;
  consumed_at: number;
  reason: string;
  pinned_by: string;
  title?: string;
  artist_name?: string;
}

interface ScheduledRow {
  id: number;
  log_date: string;
  hour: number;
  slot_type: string;
  song_id: number | null;
  status: string;
  title?: string;
  artist_name?: string;
}

const SLOT_COLORS: Record<string, string> = {
  music:    "#38bdf8",
  spot:     "#f59e0b",
  liner:    "#a78bfa",
  news:     "#ef4444",
  sweeper:  "#22c55e",
  jingle:   "#ec4899",
  open:     "#94a3b8",
};

function fmtHour(h: number): string {
  if (h === 0)  return "12 AM";
  if (h === 12) return "12 PM";
  if (h < 12)   return `${h} AM`;
  return `${h-12} PM`;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export default function SchedulePreview({ onClose }: { onClose?: () => void }) {
  const { stationId } = useActiveStation();
  const [shows, setShows] = useState<ShowRow[]>([]);
  const [clockSlots, setClockSlots] = useState<Record<number, ClockSlot[]>>({});
  const [pinnedByHour, setPinnedByHour] = useState<Record<string, PinnedRow[]>>({});
  const [scheduledByHour, setScheduledByHour] = useState<Record<string, ScheduledRow[]>>({});
  const [loading, setLoading] = useState(true);
  const [windowHours, setWindowHours] = useState<24 | 48 | 72>(24);

  // ── Build the preview window ──
  // Starts at the current hour and walks forward `windowHours` hours.
  // For each hour: figure out the active show (matches dow + hour range),
  // pull the clock's slots, attach pinned songs and scheduled_log rows.
  const buildPreview = async () => {
    setLoading(true);
    try {
      // 1. Load all active shows + their clock names
      // station_id scoping: manual JOIN — shows.station_id filters scope; format_clocks joined by FK
      const showRows = await queryScoped<ShowRow>(
        `SELECT sh.id, sh.name, sh.start_hour, sh.end_hour, sh.day_of_week, sh.clock_id,
                fc.name as clock_name
         FROM shows sh
         LEFT JOIN format_clocks fc ON fc.id = sh.clock_id
         WHERE sh.is_active = 1 AND sh.station_id = ?`,
        [stationId], stationId, { skipScoping: true }
      ).catch(() => []);
      setShows(showRows);

      // 2. Load all clock slots for the clocks we'll need
      const clockIds = Array.from(new Set(showRows.map(s => s.clock_id).filter(Boolean) as number[]));
      const slotsByClock: Record<number, ClockSlot[]> = {};
      if (clockIds.length > 0) {
        // station_id scoping: manual JOIN — clock_slots.station_id filters scope; categories joined by FK
        const slots = await queryScoped<ClockSlot>(
          `SELECT cs.*, c.code as category_code, c.color as category_color
           FROM clock_slots cs
           LEFT JOIN categories c ON c.id = cs.category_id
           WHERE cs.clock_id IN (${clockIds.map(() => "?").join(",")}) AND cs.station_id = ?
           ORDER BY cs.clock_id, cs.position`,
          [...clockIds, stationId],
          stationId,
          { skipScoping: true }
        ).catch(() => []);
        slots.forEach(s => {
          if (!slotsByClock[s.clock_id]) slotsByClock[s.clock_id] = [];
          slotsByClock[s.clock_id].push(s);
        });
      }
      setClockSlots(slotsByClock);

      // 3. Load pinned songs (recurring + upcoming one-shots)
      const now = Math.floor(Date.now() / 1000);
      const windowEnd = now + windowHours * 3600;
      // station_id scoping: pinned_songs is not a scoped table; filter via songs.station_id
      const pinnedRows = await queryScoped<PinnedRow>(
        `SELECT p.*, s.title, a.name as artist_name
         FROM pinned_songs p
         JOIN songs s ON s.id = p.song_id AND s.station_id = ?
         LEFT JOIN artists a ON a.id = s.artist_id
         WHERE (p.recur_dow != 0)
            OR (p.recur_dow = 0 AND p.play_at_unix >= ? AND p.play_at_unix <= ? AND p.consumed_at = 0)`,
        [stationId, now, windowEnd],
        stationId,
        { skipScoping: true }
      ).catch(() => []);

      // Bucket pinned by date+hour
      const pinBucket: Record<string, PinnedRow[]> = {};
      for (let h = 0; h < windowHours; h++) {
        const slot = new Date(); slot.setMinutes(0, 0, 0);
        slot.setHours(slot.getHours() + h);
        const dow = slot.getDay();
        const hour = slot.getHours();
        const key = `${slot.toISOString().slice(0, 10)}T${hour}`;
        const slotUnix = Math.floor(slot.getTime() / 1000);
        const matches = pinnedRows.filter(p =>
          p.slot_hour === hour && (
            // Recurring matching this dow
            (p.recur_dow !== 0 && (p.recur_dow & (1 << dow)) !== 0) ||
            // One-shot for this exact slot
            (p.recur_dow === 0 && p.play_at_unix >= slotUnix && p.play_at_unix < slotUnix + 3600)
          )
        );
        if (matches.length > 0) pinBucket[key] = matches.sort((a, b) => a.slot_position - b.slot_position);
      }
      setPinnedByHour(pinBucket);

      // 4. Load existing scheduled_log entries within the window (already-built schedule)
      const dates = new Set<string>();
      for (let h = 0; h < windowHours; h++) {
        const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + h);
        dates.add(d.toISOString().slice(0, 10));
      }
      const dateList = Array.from(dates);
      // station_id scoping: manual JOIN — scheduled_log.station_id + songs.station_id both filtered
      const scheduledRows = await queryScoped<ScheduledRow>(
        `SELECT sl.*, s.title, a.name as artist_name
         FROM scheduled_log sl
         LEFT JOIN songs s ON s.id = sl.song_id AND s.station_id = ?
         LEFT JOIN artists a ON a.id = s.artist_id
         WHERE sl.log_date IN (${dateList.map(() => "?").join(",")}) AND sl.station_id = ?
         ORDER BY sl.log_date, sl.hour, sl.id`,
        [stationId, ...dateList, stationId],
        stationId,
        { skipScoping: true }
      ).catch(() => []);

      const schedBucket: Record<string, ScheduledRow[]> = {};
      scheduledRows.forEach(r => {
        const key = `${r.log_date}T${r.hour}`;
        if (!schedBucket[key]) schedBucket[key] = [];
        schedBucket[key].push(r);
      });
      setScheduledByHour(schedBucket);
    } catch (e) {
      console.error("[SchedulePreview] buildPreview failed:", e);
    }
    setLoading(false);
  };

  useEffect(() => { buildPreview(); }, [windowHours]);

  // Find the active show for a given (dow, hour)
  const showFor = (dow: number, hour: number): ShowRow | null => {
    return shows.find(sh => {
      if (sh.day_of_week !== -1 && sh.day_of_week !== dow) return false;
      // Overnight shows wrap; daytime are simple range
      if (sh.end_hour > sh.start_hour) {
        return hour >= sh.start_hour && hour < sh.end_hour;
      } else if (sh.end_hour < sh.start_hour) {
        return hour >= sh.start_hour || hour < sh.end_hour;
      }
      return false;
    }) || null;
  };

  // Build the array of hour blocks to render
  const hours: { date: Date; key: string; show: ShowRow | null; slots: ClockSlot[]; pins: PinnedRow[]; scheduled: ScheduledRow[] }[] = [];
  for (let h = 0; h < windowHours; h++) {
    const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + h);
    const key = `${d.toISOString().slice(0, 10)}T${d.getHours()}`;
    const show = showFor(d.getDay(), d.getHours());
    const slots = (show?.clock_id && clockSlots[show.clock_id]) || [];
    hours.push({
      date: d, key, show, slots,
      pins: pinnedByHour[key] || [],
      scheduled: scheduledByHour[key] || [],
    });
  }

  return (
    <div style={{ padding: 24, color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em" }}>Schedule Preview</h1>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
            What's about to play — clocks, PD picks, and built schedule combined
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 4 }}>
            {([24, 48, 72] as const).map(h => (
              <button key={h} onClick={() => setWindowHours(h)} style={{
                padding: "6px 12px", borderRadius: 0, fontSize: 12, fontWeight: 600,
                background: windowHours === h ? "var(--accent-blue)" : "var(--bg-secondary)",
                color:      windowHours === h ? "#fff" : "var(--text-secondary)",
                border: windowHours === h ? "none" : "1px solid var(--border-primary)",
                cursor: "pointer",
              }}>{h}h</button>
            ))}
          </div>
          <button onClick={buildPreview} style={btnStyle}>↻ Refresh</button>
          {onClose && <button onClick={onClose} style={btnStyle}>Close</button>}
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 60, textAlign: "center" as any, color: "var(--text-tertiary)" }}>Building preview…</div>
      ) : hours.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center" as any, background: "var(--bg-secondary)", border: "1px dashed var(--border-primary)" }}>
          <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>No schedule data</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {hours.map(h => {
            const isCurrentHour = h.date.getHours() === new Date().getHours() && h.date.getDate() === new Date().getDate();
            const dayChanged = hours.indexOf(h) === 0 || h.date.toDateString() !== hours[hours.indexOf(h) - 1].date.toDateString();
            return (
              <div key={h.key}>
                {dayChanged && (
                  <div style={{ marginTop: hours.indexOf(h) === 0 ? 0 : 16, marginBottom: 6, fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em" }}>
                    {fmtDate(h.date)}
                  </div>
                )}
                <div style={{
                  background: "var(--bg-secondary)",
                  border: "1px solid " + (isCurrentHour ? "var(--accent-blue)" : "var(--border-primary)"),
                  display: "grid", gridTemplateColumns: "100px 1fr", overflow: "hidden",
                }}>
                  {/* Hour cell */}
                  <div style={{
                    padding: "12px 14px", borderRight: "1px solid var(--border-primary)",
                    background: isCurrentHour ? "rgba(56,189,248,0.08)" : "var(--bg-tertiary)",
                    display: "flex", flexDirection: "column", justifyContent: "center",
                  }}>
                    <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: isCurrentHour ? "var(--accent-blue)" : "var(--text-primary)" }}>
                      {fmtHour(h.date.getHours())}
                    </div>
                    {isCurrentHour && <div style={{ fontSize: 10, fontWeight: 700, color: "var(--accent-blue)", marginTop: 2, letterSpacing: "0.04em" }}>NOW</div>}
                  </div>

                  {/* Hour content */}
                  <div style={{ padding: "10px 14px" }}>
                    {/* Show header */}
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
                        {h.show?.name || <span style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>no show scheduled</span>}
                      </span>
                      {h.show?.clock_name && (
                        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                          clock: <span style={{ color: "var(--text-secondary)" }}>{h.show.clock_name}</span>
                        </span>
                      )}
                    </div>

                    {/* Slots row */}
                    {h.slots.length === 0 && h.pins.length === 0 && h.scheduled.length === 0 ? (
                      <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                        {h.show ? "Format clock has no slots — assign categories in Format Clocks" : "Will run filtered random rotation"}
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as any }}>
                        {/* Already-scheduled rows take priority over predicted slots */}
                        {h.scheduled.length > 0 ? (
                          h.scheduled.map((s, i) => (
                            <SlotChip key={s.id} type={s.slot_type} title={s.title} artist={s.artist_name}
                              status={s.status} index={i + 1} confirmed />
                          ))
                        ) : (
                          h.slots.map((s, i) => {
                            // See if a pin matches this slot position
                            const pin = h.pins.find(p => p.slot_position === i);
                            return <SlotChip key={s.id} type={s.slot_type} category={s.category_code}
                              categoryColor={s.category_color || undefined}
                              pinTitle={pin?.title} pinArtist={pin?.artist_name} pinReason={pin?.reason}
                              index={i + 1} />;
                          })
                        )}
                        {/* Pins that don't map to a slot position (overflow) — show separately */}
                        {h.scheduled.length === 0 && h.pins.filter(p => p.slot_position >= h.slots.length).map(p => (
                          <SlotChip key={"p" + p.id} type="music"
                            pinTitle={p.title} pinArtist={p.artist_name} pinReason={p.reason}
                            index={p.slot_position + 1} orphan />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Sub: slot chip ──
// Compact representation of one slot in the hour. Pinned songs show
// the song title + reason badge, non-pinned slots show category code only.
function SlotChip({
  type, category, categoryColor, title, artist, status, pinTitle, pinArtist, pinReason, index, confirmed, orphan,
}: {
  type: string; category?: string; categoryColor?: string;
  title?: string; artist?: string; status?: string;
  pinTitle?: string; pinArtist?: string; pinReason?: string;
  index: number; confirmed?: boolean; orphan?: boolean;
}) {
  const isPinned = !!pinTitle;
  const color = SLOT_COLORS[type] || "#94a3b8";
  return (
    <div title={pinReason ? `Pinned: ${pinReason}` : undefined} style={{
      padding: "4px 8px", display: "inline-flex", alignItems: "center", gap: 6,
      background: confirmed ? "rgba(34,197,94,0.10)" : isPinned ? "rgba(245,158,11,0.10)" : "var(--bg-tertiary)",
      border: "1px solid " + (orphan ? "#ef4444" : confirmed ? "#22c55e44" : isPinned ? "#f59e0b44" : "var(--border-primary)"),
      borderLeft: `3px solid ${categoryColor || color}`,
      fontSize: 11,
    }}>
      <span style={{ color: "var(--text-tertiary)", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 10 }}>{index}</span>
      {isPinned ? (
        <>
          <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 4px", background: "rgba(245,158,11,0.3)", color: "#f59e0b" }}>📌</span>
          <span style={{ color: "var(--text-primary)", fontWeight: 600, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pinTitle}</span>
          <span style={{ color: "var(--text-tertiary)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {pinArtist}</span>
        </>
      ) : confirmed ? (
        <>
          <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 4px", background: "rgba(34,197,94,0.25)", color: "#22c55e" }}>✓</span>
          <span style={{ color: "var(--text-primary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title || type}</span>
          {artist && <span style={{ color: "var(--text-tertiary)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {artist}</span>}
        </>
      ) : (
        <>
          <span style={{ color: "var(--text-secondary)", textTransform: "uppercase" as any, letterSpacing: "0.04em", fontWeight: 600 }}>{type === "music" ? (category || "MUSIC") : type.toUpperCase()}</span>
        </>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 0, fontSize: 12, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};

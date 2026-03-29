// src/components/ProgramLog.tsx
// Ether Program Log — one-stop scheduling, viewing, and export

import { useState, useEffect, useCallback, useRef } from "react";
import { query, execute } from "../db/client";
import { usePlan } from "../hooks/usePlan";

// ── Types ──────────────────────────────────────────────────────

interface ScheduledEntry {
  id: number; log_date: string; hour: number; position: number;
  slot_type: string; category_id: number | null;
  category_code: string | null; category_color: string | null;
  song_id: number | null; song_title: string | null;
  song_artist: string | null; duration_ms: number;
  label: string | null; status: string;
  overflow: number;
  fade_out_at_ms: number;
  fade_duration_ms: number;
}

interface HourBlock {
  hour: number;
  entries: ScheduledEntry[];
  show_name: string | null;
  clock_name: string | null;
  generating: boolean;
}

interface Show {
  id: number; name: string; start_hour: number; end_hour: number;
  clock_id: number | null; clock_name: string | null; color: string | null;
}

interface Rules {
  artist_sep_min: number; song_repeat_min: number;
  title_sep_min: number; max_same_category: number;
  artist_sep_strict: number; song_repeat_strict: number;
}

interface Song {
  id: number; title: string; artist_name: string | null;
  artist_id: number | null; category_id: number | null;
  duration_ms: number; last_played_at: number | null;
}

// ── Helpers ────────────────────────────────────────────────────

function fmtHour(h: number): string {
  if (h === 0) return "12 AM"; if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}
function fmtMs(ms: number): string {
  if (!ms) return "—";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function fmtDate(d: Date): string { return d.toISOString().slice(0, 10); }
function todayStr(): string { return fmtDate(new Date()); }
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS_SHORT = ["Su","Mo","Tu","We","Th","Fr","Sa"];

// ── Component ─────────────────────────────────────────────────

interface Props { onClose?: () => void; }

export default function ProgramLog({ onClose }: Props) {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [scheduledDates, setScheduledDates] = useState<Set<string>>(new Set());
  const [shows, setShows] = useState<Show[]>([]);
  const [hourBlocks, setHourBlocks] = useState<HourBlock[]>([]);
  const [globalStatus, setGlobalStatus] = useState("");
  const [filling, setFilling] = useState(false);
  const [expandedHours, setExpandedHours] = useState<Set<number>>(new Set());
  const [selectedShowId, setSelectedShowId] = useState<number | null>(null);
  const [hourModal, setHourModal] = useState<{ hour: number; block: HourBlock } | null>(null);
  const [assignModal, setAssignModal] = useState<{ hour: number; showName: string | null } | null>(null);
  const rundownRef = useRef<HTMLDivElement>(null);

  // ── Init DB ──────────────────────────────────────────────────
  useEffect(() => {
    execute(`CREATE TABLE IF NOT EXISTS scheduled_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_date TEXT NOT NULL, hour INTEGER NOT NULL, position INTEGER NOT NULL,
      slot_type TEXT NOT NULL DEFAULT 'music', category_id INTEGER,
      category_code TEXT, category_color TEXT, song_id INTEGER,
      song_title TEXT, song_artist TEXT, duration_ms INTEGER DEFAULT 0,
      label TEXT, status TEXT NOT NULL DEFAULT 'scheduled',
      overflow INTEGER DEFAULT 0,
      fade_out_at_ms INTEGER DEFAULT 0,
      fade_duration_ms INTEGER DEFAULT 8000,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`).catch(() => {});
    // Add columns if table already exists
    execute("ALTER TABLE scheduled_log ADD COLUMN overflow INTEGER DEFAULT 0").catch(() => {});
    execute("ALTER TABLE scheduled_log ADD COLUMN fade_out_at_ms INTEGER DEFAULT 0").catch(() => {});
    execute("ALTER TABLE scheduled_log ADD COLUMN fade_duration_ms INTEGER DEFAULT 8000").catch(() => {});
  }, []);

  // ── Load ─────────────────────────────────────────────────────

  const loadScheduledDates = useCallback(async () => {
    try {
      const rows = await query<{ log_date: string }>(
        "SELECT DISTINCT log_date FROM scheduled_log ORDER BY log_date"
      );
      setScheduledDates(new Set(rows.map(r => r.log_date)));
    } catch {}
  }, []);

  const loadShows = useCallback(async () => {
    try {
      const rows = await query<Show>(
        `SELECT s.*, c.name as clock_name FROM shows s
         LEFT JOIN clocks c ON c.id = s.clock_id ORDER BY s.start_hour`
      );
      setShows(rows);
    } catch {}
  }, []);

  const loadDayData = useCallback(async (date: string) => {
    try {
      const entries = await query<ScheduledEntry>(
        "SELECT * FROM scheduled_log WHERE log_date=? ORDER BY hour, position", [date]
      );
      // Group by hour and merge with shows
      const allShows = await query<Show>(
        `SELECT s.*, c.name as clock_name FROM shows s
         LEFT JOIN clocks c ON c.id = s.clock_id ORDER BY s.start_hour`
      );
      const blocks: HourBlock[] = [];
      // Only show hours that have a show OR have scheduled entries
      const scheduledHours = new Set(entries.map(e => e.hour));
      const showHours = new Set<number>();
      allShows.forEach(s => { for (let h = s.start_hour; h < s.end_hour; h++) showHours.add(h); });
      const allHours = new Set([...scheduledHours, ...showHours]);
      Array.from(allHours).sort((a,b) => a-b).forEach(hour => {
        const show = allShows.find(s => s.start_hour <= hour && s.end_hour > hour);
        blocks.push({
          hour, entries: entries.filter(e => e.hour === hour),
          show_name: show?.name || null,
          clock_name: show?.clock_name || null,
          generating: false,
        });
      });
      setHourBlocks(blocks);
    } catch {}
  }, []);

  useEffect(() => { loadScheduledDates(); loadShows(); }, []);
  useEffect(() => { loadDayData(selectedDate); }, [selectedDate, loadDayData]);

  // ── Scheduling engine ─────────────────────────────────────────

  const scheduleOneHour = async (date: string, hour: number): Promise<boolean> => {
    try {
      const showRows = await query<{ id: number; name: string; clock_id: number | null }>(
        "SELECT id, name, clock_id FROM shows WHERE start_hour <= ? AND end_hour > ? LIMIT 1", [hour, hour]
      );
      if (!showRows.length || !showRows[0].clock_id) return false;

      const clockSlots = await query<{
        position: number; slot_type: string; category_id: number | null;
        duration_min: number; label: string | null;
        category_code: string | null; category_color: string | null;
      }>(
        `SELECT cs.*, c.code as category_code, c.color as category_color
         FROM clock_slots cs LEFT JOIN categories c ON c.id = cs.category_id
         WHERE cs.clock_id = ? ORDER BY cs.position`,
        [showRows[0].clock_id]
      );
      if (!clockSlots.length) return false;

      let rules: Rules = { artist_sep_min:60, song_repeat_min:240, title_sep_min:120, max_same_category:3, artist_sep_strict:1, song_repeat_strict:1 };
      try {
        const r = await query<Rules>("SELECT * FROM scheduling_rules LIMIT 1");
        if (r.length) rules = { ...rules, ...r[0] };
      } catch {}

      const hourStartTs = new Date(`${date}T${String(hour).padStart(2,"0")}:00:00`).getTime() / 1000;
      const usedSongIds = new Set<number>();
      const usedArtistIds = new Set<number>();

      await execute("DELETE FROM scheduled_log WHERE log_date=? AND hour=?", [date, hour]);

      for (const slot of clockSlots) {
        if (slot.slot_type !== "music" || !slot.category_id) {
          await execute(
            `INSERT INTO scheduled_log (log_date,hour,position,slot_type,category_id,category_code,category_color,song_id,song_title,song_artist,duration_ms,label,status)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [date,hour,slot.position,slot.slot_type,slot.category_id,slot.category_code,slot.category_color,null,null,null,Math.round(slot.duration_min*60000),slot.label,"scheduled"]
          );
          continue;
        }

        const candidates = await query<Song>(
          `SELECT s.id, s.title, a.name as artist_name, s.artist_id, s.category_id, s.duration_ms, s.last_played_at
           FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
           WHERE s.category_id = ? ORDER BY COALESCE(s.last_played_at, 0) ASC`,
          [slot.category_id]
        );

        let picked: Song | null = null;
        let softFallback: Song | null = null;

        for (const song of candidates) {
          if (usedSongIds.has(song.id)) continue;
          const timeSince = song.last_played_at ? hourStartTs - song.last_played_at : 999999;
          if (rules.song_repeat_strict && timeSince < rules.song_repeat_min * 60) continue;
          if (rules.artist_sep_strict && song.artist_id && usedArtistIds.has(song.artist_id)) continue;
          const passesAll = timeSince >= rules.title_sep_min * 60 && (!song.artist_id || !usedArtistIds.has(song.artist_id));
          if (passesAll) { picked = song; break; }
          else if (!softFallback) softFallback = song;
        }
        if (!picked) picked = softFallback;

        // All songs exhausted — cycle back from the beginning ignoring usedSongIds
        if (!picked && candidates.length > 0) {
          for (const song of candidates) {
            const timeSince = song.last_played_at ? hourStartTs - song.last_played_at : 999999;
            // Only skip strict artist repeat within this hour
            if (rules.artist_sep_strict && song.artist_id && usedArtistIds.has(song.artist_id)) continue;
            picked = song; // take least-recently-played, ignore song repeat rule
            break;
          }
          // Absolute last resort — just take the first song
          if (!picked) picked = candidates[0];
        }

        if (picked) {
          usedSongIds.add(picked.id);
          if (picked.artist_id) usedArtistIds.add(picked.artist_id);
          await execute(
            `INSERT INTO scheduled_log (log_date,hour,position,slot_type,category_id,category_code,category_color,song_id,song_title,song_artist,duration_ms,label,status,overflow,fade_out_at_ms,fade_duration_ms)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [date,hour,slot.position,"music",slot.category_id,slot.category_code,slot.category_color,picked.id,picked.title,picked.artist_name,picked.duration_ms||Math.round(slot.duration_min*60000),picked.title,"scheduled",0,0,8000]
          );
          await execute("UPDATE songs SET last_played_at=? WHERE id=?", [hourStartTs+slot.position, picked.id]);
        } else {
          await execute(
            `INSERT INTO scheduled_log (log_date,hour,position,slot_type,category_id,category_code,category_color,song_id,song_title,song_artist,duration_ms,label,status,overflow,fade_out_at_ms,fade_duration_ms)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [date,hour,slot.position,"music",slot.category_id,slot.category_code,slot.category_color,null,null,null,Math.round(slot.duration_min*60000),"UNFILLED","unfilled",0,0,8000]
          );
        }
      }

      // ── Overflow song — fills remaining time, fades into next hour ──
      // Calculate how much time the hour has used
      const usedEntries = await query<{ total_ms: number }>(
        "SELECT SUM(duration_ms) as total_ms FROM scheduled_log WHERE log_date=? AND hour=?",
        [date, hour]
      );
      const usedMs   = usedEntries[0]?.total_ms || 0;
      const hourMs   = 60 * 60 * 1000;
      const remainMs = hourMs - usedMs;

      // Only add overflow if there's at least 30 seconds remaining
      if (remainMs >= 30000) {
        // Find the last music slot's category to match
        const lastMusicSlot = [...clockSlots].reverse().find(s => s.slot_type === "music" && s.category_id);
        if (lastMusicSlot?.category_id) {
          const overflowCandidates = await query<Song>(
            `SELECT s.id, s.title, a.name as artist_name, s.artist_id, s.category_id, s.duration_ms, s.last_played_at
             FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
             WHERE s.category_id = ? AND s.duration_ms > ?
             ORDER BY COALESCE(s.last_played_at, 0) ASC LIMIT 20`,
            [lastMusicSlot.category_id, remainMs] // song must be longer than remaining time
          );

          // Pick one not used this hour
          const overflowSong = overflowCandidates.find(s => !usedSongIds.has(s.id))
            || overflowCandidates[0];

          if (overflowSong) {
            const fadeDurationMs = 8000; // 8-second crossfade
            await execute(
              `INSERT INTO scheduled_log (log_date,hour,position,slot_type,category_id,category_code,category_color,song_id,song_title,song_artist,duration_ms,label,status,overflow,fade_out_at_ms,fade_duration_ms)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [date, hour, clockSlots.length, "music",
               lastMusicSlot.category_id, lastMusicSlot.category_code, lastMusicSlot.category_color,
               overflowSong.id, overflowSong.title, overflowSong.artist_name,
               overflowSong.duration_ms, overflowSong.title,
               "overflow", 1, remainMs, fadeDurationMs]
            );
            await execute("UPDATE songs SET last_played_at=? WHERE id=?", [hourStartTs + 3600, overflowSong.id]);
          }
        }
      }

      return true;
    } catch { return false; }
  };

  const generateHour = async (hour: number) => {
    setHourBlocks(prev => prev.map(b => b.hour === hour ? { ...b, generating: true } : b));
    setGlobalStatus(`Scheduling ${fmtHour(hour)}...`);
    const ok = await scheduleOneHour(selectedDate, hour);
    await loadDayData(selectedDate);
    loadScheduledDates();
    setExpandedHours(prev => new Set([...prev, hour]));
    setHourBlocks(prev => prev.map(b => b.hour === hour ? { ...b, generating: false } : b));
    setGlobalStatus(ok ? `✓ ${fmtHour(hour)} scheduled` : `↷ Skipped ${fmtHour(hour)} — no show or clock assigned`);
  };

  const fillDay = async () => {
    setFilling(true);
    setGlobalStatus("Filling day...");
    let count = 0;
    for (const block of hourBlocks) {
      if (block.clock_name) {
        setGlobalStatus(`Scheduling ${fmtHour(block.hour)}...`);
        const ok = await scheduleOneHour(selectedDate, block.hour);
        if (ok) count++;
      }
    }
    await loadDayData(selectedDate);
    loadScheduledDates();
    setExpandedHours(new Set(hourBlocks.map(b => b.hour)));
    setGlobalStatus(`✓ ${count} hours scheduled`);
    setFilling(false);
  };

  const clearHour = async (hour: number) => {
    await execute("DELETE FROM scheduled_log WHERE log_date=? AND hour=?", [selectedDate, hour]);
    loadDayData(selectedDate);
    loadScheduledDates();
  };

  const clearDay = async () => {
    await execute("DELETE FROM scheduled_log WHERE log_date=?", [selectedDate]);
    loadDayData(selectedDate);
    loadScheduledDates();
    setGlobalStatus("Day cleared");
  };

  // ── Export ────────────────────────────────────────────────────

  const { isPro } = usePlan();

  const exportCSV = () => {
    const rows = ["Hour,Position,Type,Title,Artist,Duration,Status"];
    hourBlocks.forEach(block => {
      if (!block.entries.length) return;
      block.entries.forEach(e => {
        rows.push([
          fmtHour(block.hour), e.position + 1,
          e.category_code || e.slot_type,
          `"${e.song_title || e.label || ""}"`,
          `"${e.song_artist || ""}"`,
          fmtMs(e.duration_ms), e.status
        ].join(","));
      });
    });
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `program_log_${selectedDate}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const exportPrint = () => {
    const dateLabel = new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    let html = `<html><head><title>Program Log — ${dateLabel}</title><style>
      body { font-family: 'Courier New', monospace; font-size: 11px; color: #000; margin: 20px; }
      h1 { font-size: 16px; margin-bottom: 4px; }
      h2 { font-size: 13px; margin: 16px 0 4px; border-bottom: 1px solid #000; padding-bottom: 2px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
      th { text-align: left; font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; border-bottom: 1px solid #666; padding: 2px 4px; }
      td { padding: 2px 4px; border-bottom: 1px solid #eee; }
      .type { font-weight: bold; font-size: 9px; }
      .unfilled { color: red; }
      @media print { body { margin: 10mm; } }
    </style></head><body>
    <h1>PROGRAM LOG</h1>
    <div>${dateLabel}</div>`;

    hourBlocks.forEach(block => {
      if (!block.entries.length) return;
      const totalMs = block.entries.reduce((s, e) => s + (e.duration_ms || 0), 0);
      html += `<h2>${fmtHour(block.hour)} — ${block.show_name || "Unassigned"} (${fmtMs(totalMs)})</h2>
      <table><tr><th>#</th><th>Type</th><th>Title</th><th>Artist</th><th>Duration</th></tr>`;
      block.entries.forEach((e, i) => {
        const isUnfilled = e.status === "unfilled";
        html += `<tr class="${isUnfilled ? "unfilled" : ""}">
          <td>${i+1}</td>
          <td class="type">${e.category_code || e.slot_type}</td>
          <td>${isUnfilled ? "⚠ UNFILLED" : (e.song_title || e.label || "")}</td>
          <td>${e.song_artist || ""}</td>
          <td>${fmtMs(e.duration_ms)}</td>
        </tr>`;
      });
      html += "</table>";
    });
    html += "</body></html>";
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); w.print(); }
  };

  const exportPDF = async () => {
    const dateLabel = new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric"
    });

    // Fetch station name
    let stationName = "Ether Technologies";
    try {
      const rows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key='station_name'");
      if (rows[0]?.value) stationName = rows[0].value;
    } catch {}

    // Fetch song metadata (BPM, LUFS) for entries that have song_ids
    const allSongIds = hourBlocks.flatMap(b => b.entries.map(e => e.song_id)).filter(id => id !== null);
    const songIds: number[] = [...new Set(allSongIds)] as number[];
    const songMeta: Record<number, { bpm: number | null; lufs: number | null; gain_db: number | null }> = {};
    if (songIds.length > 0) {
      try {
        const meta = await query<{ id: number; bpm: number | null; lufs_measured: number | null; gain_db: number | null }>(
          `SELECT id, bpm, lufs_measured, gain_db FROM songs WHERE id IN (${songIds.map(() => "?").join(",")})`,
          songIds
        );
        meta.forEach(m => { songMeta[m.id] = { bpm: m.bpm, lufs: m.lufs_measured, gain_db: m.gain_db }; });
      } catch {}
    }

    // Compute day totals
    const totalMs    = hourBlocks.reduce((s, b) => s + b.entries.reduce((ss, e) => ss + (e.duration_ms || 0), 0), 0);
    const totalSongs = hourBlocks.reduce((s, b) => s + b.entries.filter(e => e.slot_type === "music").length, 0);
    const totalSpots = hourBlocks.reduce((s, b) => s + b.entries.filter(e => e.slot_type === "spot_break").length, 0);
    const unfilled   = hourBlocks.reduce((s, b) => s + b.entries.filter(e => e.status === "unfilled").length, 0);
    const filledHrs  = hourBlocks.filter(b => b.entries.length > 0).length;

    const fmtRuntime = (ms: number) => {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
    };

    const catColors: Record<string, string> = {};
    hourBlocks.forEach(b => b.entries.forEach(e => {
      if (e.category_code && e.category_color) catColors[e.category_code] = e.category_color;
    }));

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>Traffic Report — ${stationName} — ${dateLabel}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 10px; color: #111;
    background: #fff;
  }
  .page { padding: 18mm 16mm; max-width: 210mm; margin: 0 auto; }

  /* Header */
  .report-header {
    display: flex; justify-content: space-between; align-items: flex-start;
    padding-bottom: 10px; margin-bottom: 14px;
    border-bottom: 3px solid #0ea5e9;
  }
  .report-header .logo-block .station { font-size: 20px; font-weight: 900; letter-spacing: -0.5px; color: #0ea5e9; }
  .report-header .logo-block .sub { font-size: 8px; letter-spacing: 2px; text-transform: uppercase; color: #888; margin-top: 2px; }
  .report-header .meta { text-align: right; }
  .report-header .meta .doc-title { font-size: 14px; font-weight: 800; color: #111; text-transform: uppercase; letter-spacing: 1px; }
  .report-header .meta .doc-date { font-size: 11px; color: #555; margin-top: 3px; }
  .report-header .meta .doc-gen { font-size: 8px; color: #aaa; margin-top: 2px; }

  /* Summary bar */
  .summary {
    display: grid; grid-template-columns: repeat(5, 1fr);
    gap: 8px; margin-bottom: 18px;
  }
  .summary-item {
    background: #f8fafc; border: 1px solid #e2e8f0;
    border-radius: 6px; padding: 8px 10px;
  }
  .summary-item .val { font-size: 18px; font-weight: 800; color: #0ea5e9; font-variant-numeric: tabular-nums; }
  .summary-item .lbl { font-size: 7.5px; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-top: 2px; }

  /* Hour section */
  .hour-block { margin-bottom: 16px; break-inside: avoid; }
  .hour-header {
    display: flex; justify-content: space-between; align-items: center;
    background: #0f172a; color: #fff;
    padding: 5px 10px; border-radius: 5px 5px 0 0;
  }
  .hour-header .hour-name { font-size: 11px; font-weight: 800; letter-spacing: 0.5px; }
  .hour-header .hour-meta { font-size: 8.5px; color: #94a3b8; }
  .hour-header .hour-total { font-size: 9px; font-weight: 700; color: #38bdf8; font-variant-numeric: tabular-nums; }

  table { width: 100%; border-collapse: collapse; }
  thead tr { background: #f1f5f9; }
  th {
    padding: 4px 6px; text-align: left;
    font-size: 7.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.8px; color: #64748b;
    border-bottom: 1px solid #e2e8f0;
  }
  td { padding: 4px 6px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:nth-child(even) { background: #fafafa; }
  tr.unfilled td { color: #ef4444 !important; }
  tr.overflow td { color: #a78bfa; background: #faf5ff; }

  .cat-badge {
    display: inline-block; padding: 1px 5px; border-radius: 3px;
    font-size: 7px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .status-badge {
    display: inline-block; padding: 1px 5px; border-radius: 3px;
    font-size: 7px; font-weight: 700;
  }
  .num { font-variant-numeric: tabular-nums; font-family: 'Courier New', monospace; }

  /* Footer */
  .report-footer {
    margin-top: 20px; padding-top: 8px;
    border-top: 1px solid #e2e8f0;
    display: flex; justify-content: space-between;
    font-size: 7.5px; color: #aaa;
  }

  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { padding: 10mm 12mm; }
    .hour-block { break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="report-header">
    <div class="logo-block">
      <div class="station">${stationName}</div>
      <div class="sub">Ether Technologies · Broadcast Automation</div>
    </div>
    <div class="meta">
      <div class="doc-title">Traffic Report</div>
      <div class="doc-date">${dateLabel}</div>
      <div class="doc-gen">Generated ${new Date().toLocaleString()}</div>
    </div>
  </div>

  <!-- Summary -->
  <div class="summary">
    <div class="summary-item"><div class="val">${filledHrs}</div><div class="lbl">Hours Scheduled</div></div>
    <div class="summary-item"><div class="val">${totalSongs}</div><div class="lbl">Songs</div></div>
    <div class="summary-item"><div class="val">${totalSpots}</div><div class="lbl">Spot Breaks</div></div>
    <div class="summary-item"><div class="val num">${fmtRuntime(totalMs)}</div><div class="lbl">Total Runtime</div></div>
    <div class="summary-item"><div class="val" style="color:${unfilled > 0 ? '#ef4444' : '#22c55e'}">${unfilled === 0 ? '✓ 0' : unfilled}</div><div class="lbl">Unfilled Slots</div></div>
  </div>

  <!-- Hour blocks -->
  ${hourBlocks.filter(b => b.entries.length > 0).map(block => {
    const blockMs   = block.entries.reduce((s, e) => s + (e.duration_ms || 0), 0);
    const blockSongs = block.entries.filter(e => e.slot_type === "music").length;
    const blockUnfilled = block.entries.filter(e => e.status === "unfilled").length;

    // Cumulative time tracker
    let cumMs = 0;

    return `
    <div class="hour-block">
      <div class="hour-header">
        <span class="hour-name">${fmtHour(block.hour)}${block.show_name ? " — " + block.show_name : ""}</span>
        <span class="hour-meta">${block.clock_name || ""}${blockUnfilled > 0 ? ` · ⚠ ${blockUnfilled} unfilled` : ""}</span>
        <span class="hour-total">${blockSongs} songs · ${fmtRuntime(blockMs)}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th style="width:24px">#</th>
            <th style="width:32px">Time</th>
            <th style="width:38px">Cat</th>
            <th>Title</th>
            <th>Artist</th>
            <th style="width:36px">BPM</th>
            <th style="width:44px">LUFS</th>
            <th style="width:40px">Dur</th>
            <th style="width:44px">Status</th>
          </tr>
        </thead>
        <tbody>
          ${block.entries.map((e, i) => {
            const isUnfilled = e.status === "unfilled";
            const isOverflow = e.overflow === 1;
            const meta: { bpm: number | null; lufs: number | null; gain_db: number | null } = e.song_id ? (songMeta[e.song_id] ?? { bpm: null, lufs: null, gain_db: null }) : { bpm: null, lufs: null, gain_db: null };
            const catColor = e.category_color || "#94a3b8";
            const catBg = catColor + "22";

            // Clock position MM:SS
            const posMin = Math.floor(cumMs / 60000);
            const posSec = Math.floor((cumMs % 60000) / 1000);
            const posStr = `:${String(posMin).padStart(2,"0")}:${String(posSec).padStart(2,"0")}`;
            cumMs += e.duration_ms || 0;

            const statusColor = isUnfilled ? "#ef4444" : isOverflow ? "#a78bfa" : e.status === "played" ? "#22c55e" : "#94a3b8";
            const statusBg    = statusColor + "18";
            const statusLabel = isOverflow ? "XFADE" : isUnfilled ? "EMPTY" : e.status.toUpperCase();

            return `<tr class="${isUnfilled ? "unfilled" : isOverflow ? "overflow" : ""}">
              <td class="num" style="color:#94a3b8">${i + 1}</td>
              <td class="num" style="color:#94a3b8;font-size:8px">${posStr}</td>
              <td>
                ${e.category_code
                  ? `<span class="cat-badge" style="background:${catBg};color:${catColor};border:1px solid ${catColor}55">${e.category_code}</span>`
                  : `<span style="color:#94a3b8;font-size:8px">${e.slot_type}</span>`}
              </td>
              <td style="font-weight:${isUnfilled ? "400" : "600"};max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                ${isUnfilled ? "⚠ No eligible song" : (e.song_title || e.label || "—")}
              </td>
              <td style="color:#555;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                ${e.song_artist || ""}
              </td>
              <td class="num" style="color:#64748b;font-size:9px">${meta.bpm ? Math.round(meta.bpm) : "—"}</td>
              <td class="num" style="color:#64748b;font-size:9px">${meta.lufs ? meta.lufs.toFixed(1) : "—"}</td>
              <td class="num" style="font-size:9px">${fmtMs(e.duration_ms)}</td>
              <td><span class="status-badge" style="background:${statusBg};color:${statusColor}">${statusLabel}</span></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
  }).join("")}

  <!-- Footer -->
  <div class="report-footer">
    <span>${stationName} · Program Log · ${selectedDate}</span>
    <span>Ether Technologies v1.5.2 · etherradio.app</span>
    <span>CONFIDENTIAL — For internal use only</span>
  </div>

</div>
</body>
</html>`;

    const w = window.open("", "_blank");
    if (w) {
      w.document.write(html);
      w.document.close();
      // Small delay so styles render before print dialog
      setTimeout(() => { w.print(); }, 400);
    }
  };

  // ── Calendar helpers ──────────────────────────────────────────

  const calDays = () => {
    const { year, month } = currentMonth;
    const first = new Date(year, month, 1).getDay();
    const total = new Date(year, month + 1, 0).getDate();
    const cells: (number|null)[] = Array(first).fill(null);
    for (let d = 1; d <= total; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  };

  const makeDate = (day: number) =>
    `${currentMonth.year}-${String(currentMonth.month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;

  // ── Computed ──────────────────────────────────────────────────

  const totalDayMs = hourBlocks.reduce((s, b) => s + b.entries.reduce((ss, e) => ss + (e.duration_ms||0), 0), 0);
  const scheduledHours = hourBlocks.filter(b => b.entries.length > 0).length;
  const unfilledCount = hourBlocks.reduce((s, b) => s + b.entries.filter(e => e.status === "unfilled").length, 0);

  // ── Render ────────────────────────────────────────────────────

  return (
    <div style={{
      display: "flex", height: "100%", fontFamily: "'Inter', system-ui, sans-serif",
      background: "var(--bg-primary)",
    }}>

      {/* ═══════════════════════════════════════════
          LEFT SIDEBAR
      ═══════════════════════════════════════════ */}
      <div style={{
        width: 220, flexShrink: 0, display: "flex", flexDirection: "column" as const,
        borderRight: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)",
      }}>

        {/* Header */}
        <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--border-primary)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 15, fontWeight: 800, fontFamily: "'Syne', sans-serif", color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
              Program Log
            </div>
            {onClose && (
              <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14, padding: "0 2px" }}>✕</button>
            )}
          </div>
          {globalStatus && (
            <div style={{ fontSize: 9, marginTop: 4, color: globalStatus.startsWith("✓") ? "#34d399" : globalStatus.startsWith("✗") ? "#ef4444" : "#94a3b8" }}>
              {globalStatus}
            </div>
          )}
        </div>

        {/* Mini calendar */}
        <div style={{ padding: "10px 10px 6px", borderBottom: "1px solid var(--border-primary)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <button onClick={() => setCurrentMonth(m => { const d = new Date(m.year, m.month-1); return { year: d.getFullYear(), month: d.getMonth() }; })}
              style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 13, padding: "0 2px" }}>‹</button>
            <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-primary)" }}>
              {MONTHS[currentMonth.month].slice(0,3)} {currentMonth.year}
            </span>
            <button onClick={() => setCurrentMonth(m => { const d = new Date(m.year, m.month+1); return { year: d.getFullYear(), month: d.getMonth() }; })}
              style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 13, padding: "0 2px" }}>›</button>
          </div>

          {/* Day headers */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 2 }}>
            {DAYS_SHORT.map(d => <div key={d} style={{ textAlign: "center" as const, fontSize: 8, color: "var(--text-tertiary)", fontWeight: 700, padding: "1px 0" }}>{d}</div>)}
          </div>

          {/* Days */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1 }}>
            {calDays().map((day, i) => {
              if (!day) return <div key={i} />;
              const ds = makeDate(day);
              const isSelected = ds === selectedDate;
              const hasData = scheduledDates.has(ds);
              const isToday = ds === todayStr();
              return (
                <button key={i} onClick={() => setSelectedDate(ds)} style={{
                  padding: "3px 0", borderRadius: 4, border: isToday ? "1px solid var(--accent-blue)" : "1px solid transparent",
                  background: isSelected ? "var(--accent-blue)" : "transparent",
                  color: isSelected ? "#fff" : isToday ? "var(--accent-blue)" : "var(--text-secondary)",
                  cursor: "pointer", fontSize: 10, fontWeight: isSelected ? 700 : 400,
                  position: "relative" as const, textAlign: "center" as const,
                }}>
                  {day}
                  {hasData && !isSelected && <div style={{ position: "absolute" as const, bottom: 1, left: "50%", transform: "translateX(-50%)", width: 3, height: 3, borderRadius: "50%", background: "#34d399" }} />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected date info */}
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-primary)" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
            {new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
            <div style={{ fontSize: 9, color: "var(--text-tertiary)" }}>
              <span style={{ color: "#34d399", fontWeight: 700 }}>{scheduledHours}</span> hours
            </div>
            <div style={{ fontSize: 9, color: "var(--text-tertiary)" }}>
              <span style={{ color: "var(--text-secondary)", fontWeight: 700 }}>{fmtMs(totalDayMs)}</span> total
            </div>
            {unfilledCount > 0 && (
              <div style={{ fontSize: 9, color: "#ef4444" }}>
                ⚠ {unfilledCount} unfilled
              </div>
            )}
          </div>
        </div>

        {/* Shows today */}
        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-primary)", flex: 1, overflowY: "auto" as const }}>
          <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-tertiary)", marginBottom: 6 }}>TODAY'S SHOWS</div>
          {shows.length === 0 && <div style={{ fontSize: 10, color: "var(--text-tertiary)", fontStyle: "italic" }}>No shows configured</div>}

          {/* All shows button */}
          <button onClick={() => setSelectedShowId(null)} style={{
            width: "100%", display: "flex", alignItems: "center", gap: 6,
            padding: "4px 6px", borderRadius: 5, marginBottom: 2, cursor: "pointer",
            background: selectedShowId === null ? "rgba(56,189,248,0.1)" : "rgba(255,255,255,0.02)",
            border: `1px solid ${selectedShowId === null ? "rgba(56,189,248,0.3)" : "var(--border-primary)"}`,
            textAlign: "left" as const,
          }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#94a3b8", flexShrink: 0 }} />
            <div style={{ fontSize: 10, fontWeight: selectedShowId === null ? 700 : 400, color: selectedShowId === null ? "#38bdf8" : "var(--text-secondary)" }}>
              All Shows
            </div>
          </button>

          {shows.map(s => {
            const isActive = selectedShowId === s.id;
            const showHours = hourBlocks.filter(b => b.show_name === s.name);
            const scheduled = showHours.filter(b => b.entries.length > 0).length;
            return (
              <button key={s.id} onClick={() => setSelectedShowId(isActive ? null : s.id)} style={{
                width: "100%", display: "flex", alignItems: "center", gap: 6,
                padding: "5px 6px", borderRadius: 5, marginBottom: 2, cursor: "pointer",
                background: isActive ? (s.color || "#3b82f6") + "18" : "rgba(255,255,255,0.02)",
                border: `1px solid ${isActive ? (s.color || "#3b82f6") + "50" : "var(--border-primary)"}`,
                textAlign: "left" as const, transition: "all 0.12s",
              }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: s.color || "#94a3b8", flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 10, fontWeight: isActive ? 700 : 500, color: isActive ? (s.color || "#38bdf8") : "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                    {s.name}
                  </div>
                  <div style={{ fontSize: 8, color: "var(--text-tertiary)" }}>
                    {fmtHour(s.start_hour)}–{fmtHour(s.end_hour)} · {s.clock_name || "no clock"}
                  </div>
                </div>
                <div style={{ fontSize: 8, color: scheduled > 0 ? "#34d399" : "var(--text-tertiary)", flexShrink: 0 }}>
                  {scheduled}/{showHours.length}h
                </div>
              </button>
            );
          })}
        </div>

        {/* Action buttons */}
        <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column" as const, gap: 6 }}>
          <button onClick={fillDay} disabled={filling}
            style={{ padding: "8px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: filling ? "default" : "pointer", background: "rgba(52,211,153,0.12)", color: "#34d399", border: "1px solid rgba(52,211,153,0.3)", opacity: filling ? 0.6 : 1 }}>
            {filling ? "⏳ Scheduling..." : "⚡ Fill Day"}
          </button>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
            <button onClick={exportCSV}
              style={{ padding: "6px 4px", borderRadius: 7, fontSize: 10, fontWeight: 700, cursor: "pointer", background: "rgba(56,189,248,0.1)", color: "#38bdf8", border: "1px solid rgba(56,189,248,0.25)" }}>
              ⬇ CSV
            </button>
            <button onClick={exportPrint}
              style={{ padding: "6px 4px", borderRadius: 7, fontSize: 10, fontWeight: 700, cursor: "pointer", background: "rgba(251,191,36,0.1)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.25)" }}>
              🖨 Print
            </button>
          </div>
          <button
            onClick={isPro ? exportPDF : () => window.dispatchEvent(new CustomEvent("ether:open-subscription"))}
            title={isPro ? "Export professional PDF traffic report" : "Pro plan required"}
            style={{
              padding: "6px 4px", borderRadius: 7, fontSize: 10, fontWeight: 700,
              cursor: "pointer",
              background: isPro ? "rgba(167,139,250,0.12)" : "rgba(167,139,250,0.06)",
              color: isPro ? "#a78bfa" : "#a78bfa88",
              border: `1px solid ${isPro ? "rgba(167,139,250,0.3)" : "rgba(167,139,250,0.15)"}`,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
            }}>
            {isPro ? "📄 PDF Report" : "🔒 PDF Report"}
          </button>
          <button onClick={clearDay}
            style={{ padding: "6px", borderRadius: 7, fontSize: 10, fontWeight: 600, cursor: "pointer", background: "transparent", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)" }}>
            Clear Day
          </button>
        </div>
      </div>

      {/* ═══════════════════════════════════════════
          MAIN RUNDOWN
      ═══════════════════════════════════════════ */}
      <div ref={rundownRef} style={{ flex: 1, overflowY: "auto" as const, display: "flex", flexDirection: "column" as const }}>

        {/* Day header */}
        <div style={{
          padding: "12px 20px", borderBottom: "1px solid var(--border-primary)",
          display: "flex", alignItems: "center", gap: 12, flexShrink: 0,
          background: "var(--bg-secondary)",
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Syne', sans-serif", color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
              {new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 1 }}>
              {scheduledHours} of {hourBlocks.length} hours scheduled · {fmtMs(totalDayMs)} total programming
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button
              onClick={() => setAssignModal({ hour: -1, showName: null })}
              style={{ padding: "5px 12px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer", background: "rgba(167,139,250,0.1)", border: "1px solid rgba(167,139,250,0.3)", color: "#a78bfa" }}>
              ⚙ Shows & Dayparts
            </button>
            <button onClick={() => setExpandedHours(new Set(hourBlocks.map(b => b.hour)))}
              style={{ padding: "5px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: "pointer", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)" }}>
              Expand All
            </button>
            <button onClick={() => setExpandedHours(new Set())}
              style={{ padding: "5px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: "pointer", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)" }}>
              Collapse All
            </button>
          </div>
        </div>

        {/* Empty state */}
        {hourBlocks.length === 0 && (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column" as const, gap: 12, color: "var(--text-tertiary)" }}>
            <div style={{ fontSize: 32, opacity: 0.2 }}>◷</div>
            <div style={{ fontSize: 13, fontStyle: "italic" }}>No shows configured for this day</div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>Add shows in Schedule → Show Scheduler</div>
          </div>
        )}

        {/* Hour blocks */}
        <div style={{ padding: "12px 20px", display: "flex", flexDirection: "column" as const, gap: 6 }}>
          {hourBlocks
            .filter(block => {
              if (selectedShowId === null) return true;
              const show = shows.find(s => s.id === selectedShowId);
              return show ? block.show_name === show.name : true;
            })
            .map(block => {
            const isExpanded = expandedHours.has(block.hour);
            const isScheduled = block.entries.length > 0;
            const blockMs = block.entries.reduce((s, e) => s + (e.duration_ms||0), 0);
            const unfilledInHour = block.entries.filter(e => e.status === "unfilled").length;

            return (
              <div key={block.hour} style={{
                border: `1px solid ${isScheduled ? "var(--border-primary)" : "rgba(255,255,255,0.04)"}`,
                borderLeft: `3px solid ${isScheduled ? (unfilledInHour > 0 ? "#ef4444" : "#34d399") : "rgba(255,255,255,0.08)"}`,
                borderRadius: 8, overflow: "hidden", background: "var(--bg-secondary)",
              }}>

                {/* Hour header row */}
                <div
                  onClick={() => setExpandedHours(prev => { const s = new Set(prev); isExpanded ? s.delete(block.hour) : s.add(block.hour); return s; })}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                    cursor: "pointer", background: isExpanded ? "rgba(255,255,255,0.02)" : "transparent",
                    transition: "background 0.1s",
                  }}
                >
                  {/* Chevron */}
                  <span style={{ fontSize: 9, color: "var(--text-tertiary)", transform: isExpanded ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform 0.15s", width: 10, flexShrink: 0 }}>▶</span>

                  {/* Hour label */}
                  <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: "var(--text-primary)", width: 52, flexShrink: 0 }}>
                    {fmtHour(block.hour)}
                  </span>

                  {/* Show name */}
                  <span style={{ fontSize: 11, color: isScheduled ? "var(--text-primary)" : "var(--text-tertiary)", flex: 1 }}>
                    {block.show_name || "—"}
                  </span>

                  {/* Clock name */}
                  {block.clock_name && (
                    <span style={{ fontSize: 9, color: "var(--text-tertiary)", marginRight: 4 }}>
                      {block.clock_name}
                    </span>
                  )}

                  {/* Stats */}
                  {isScheduled && (
                    <span style={{ fontSize: 9, color: "var(--text-tertiary)", marginRight: 8 }}>
                      {block.entries.length} tracks · {fmtMs(blockMs)}
                      {unfilledInHour > 0 && <span style={{ color: "#ef4444", marginLeft: 4 }}>⚠ {unfilledInHour} unfilled</span>}
                    </span>
                  )}

                  {/* Status dot */}
                  <div style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: isScheduled ? (unfilledInHour > 0 ? "#ef4444" : "#34d399") : "rgba(255,255,255,0.1)" }} />

                  {/* Generate / Re-gen button */}
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      if (!block.clock_name) {
                        // No clock assigned — open assign modal
                        setAssignModal({ hour: block.hour, showName: block.show_name });
                      } else {
                        generateHour(block.hour);
                      }
                    }}
                    disabled={block.generating}
                    style={{
                      padding: "3px 10px", borderRadius: 5, fontSize: 10, fontWeight: 700,
                      cursor: block.generating ? "default" : "pointer",
                      background: isScheduled ? "rgba(56,189,248,0.08)" : "rgba(52,211,153,0.12)",
                      color: isScheduled ? "#38bdf8" : "#34d399",
                      border: `1px solid ${isScheduled ? "rgba(56,189,248,0.25)" : "rgba(52,211,153,0.3)"}`,
                      opacity: block.generating ? 0.5 : 1, flexShrink: 0,
                    }}
                  >
                    {block.generating ? "..." : isScheduled ? "⟳ Regen" : "▶ Generate"}
                  </button>

                  {/* Deep Dive button — only when scheduled */}
                  {isScheduled && (
                    <button
                      onClick={e => { e.stopPropagation(); setHourModal({ hour: block.hour, block }); }}
                      style={{
                        padding: "3px 10px", borderRadius: 5, fontSize: 10, fontWeight: 700,
                        cursor: "pointer", background: "rgba(167,139,250,0.1)",
                        color: "#a78bfa", border: "1px solid rgba(167,139,250,0.3)", flexShrink: 0,
                      }}
                    >
                      ✎ Edit
                    </button>
                  )}

                  {/* Clear button */}
                  {isScheduled && (
                    <button
                      onClick={e => { e.stopPropagation(); clearHour(block.hour); }}
                      style={{ padding: "3px 6px", borderRadius: 5, fontSize: 10, cursor: "pointer", background: "transparent", border: "none", color: "var(--text-tertiary)", flexShrink: 0 }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
                    >✕</button>
                  )}
                </div>

                {/* Expanded track list */}
                {isExpanded && isScheduled && (
                  <div style={{ borderTop: "1px solid var(--border-primary)" }}>
                    {/* Column headers */}
                    <div style={{
                      display: "grid", gridTemplateColumns: "32px 48px 1fr 160px 56px 52px",
                      padding: "4px 12px", background: "var(--bg-tertiary)",
                      fontSize: 8, fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" as const,
                    }}>
                      <span>#</span><span>Type</span><span>Title</span><span>Artist</span>
                      <span style={{ textAlign: "right" as const }}>Duration</span>
                      <span style={{ textAlign: "right" as const }}>Status</span>
                    </div>

                    {block.entries.map((entry, i) => {
                      const color = entry.category_color || (entry.slot_type === "spot_break" ? "#ef4444" : entry.slot_type === "talk_break" ? "#a78bfa" : "#38bdf8");
                      const isUnfilled = entry.status === "unfilled";
                      const isOverflow = entry.overflow === 1;
                      return (
                        <div key={entry.id} style={{
                          display: "grid", gridTemplateColumns: "32px 48px 1fr 160px 56px 52px",
                          padding: "0 12px", minHeight: isOverflow ? 36 : 30, alignItems: "center",
                          background: isOverflow ? "rgba(167,139,250,0.06)" : i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                          borderBottom: "1px solid rgba(255,255,255,0.02)",
                          borderLeft: isOverflow ? "3px solid rgba(167,139,250,0.5)" : "3px solid transparent",
                        }}>
                          <span style={{ fontSize: 9, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>{i+1}</span>
                          <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: isOverflow ? "rgba(167,139,250,0.2)" : color+"20", color: isOverflow ? "#a78bfa" : color, letterSpacing: "0.06em", whiteSpace: "nowrap" as const }}>
                            {isOverflow ? "XFADE" : entry.category_code || entry.slot_type.toUpperCase()}
                          </span>
                          <div style={{ minWidth: 0, paddingRight: 8 }}>
                            <span style={{ fontSize: 11, fontWeight: 500, color: isUnfilled ? "#ef4444" : isOverflow ? "#a78bfa" : "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, display: "block" }}>
                              {isUnfilled ? "⚠ No eligible song" : entry.song_title || entry.label || "—"}
                            </span>
                            {isOverflow && (
                              <span style={{ fontSize: 8, color: "rgba(167,139,250,0.6)" }}>
                                Fades out at {fmtMs(entry.fade_out_at_ms)} · {fmtMs(entry.fade_duration_ms)} crossfade into next hour
                              </span>
                            )}
                          </div>
                          <span style={{ fontSize: 10, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, paddingRight: 8 }}>
                            {entry.song_artist || ""}
                          </span>
                          <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: isOverflow ? "#a78bfa" : "var(--text-tertiary)", textAlign: "right" as const }}>
                            {fmtMs(entry.duration_ms)}
                          </span>
                          <span style={{ fontSize: 8, textAlign: "right" as const, color: isOverflow ? "#a78bfa" : entry.status === "played" ? "#34d399" : isUnfilled ? "#ef4444" : "rgba(255,255,255,0.2)" }}>
                            {isOverflow ? "overflow" : entry.status}
                          </span>
                        </div>
                      );
                    })}

                    {/* Hour footer */}
                    <div style={{
                      display: "grid", gridTemplateColumns: "32px 48px 1fr 160px 56px 52px",
                      padding: "4px 12px", background: "var(--bg-tertiary)",
                      borderTop: "1px solid var(--border-primary)",
                      fontSize: 9, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace",
                    }}>
                      <span>{block.entries.length}</span><span></span>
                      <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 9, color: unfilledInHour > 0 ? "#ef4444" : "#34d399" }}>
                        {unfilledInHour > 0 ? `⚠ ${unfilledInHour} slots need more songs` : "✓ Complete"}
                      </span>
                      <span></span>
                      <span style={{ textAlign: "right" as const, fontWeight: 700, color: "var(--text-secondary)" }}>{fmtMs(blockMs)}</span>
                      <span></span>
                    </div>
                  </div>
                )}

                {/* Expanded but not scheduled */}
                {isExpanded && !isScheduled && (
                  <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border-primary)", fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                    {block.clock_name
                      ? `Click Generate to fill this hour with ${block.clock_name}`
                      : `Click Generate to assign a clock and schedule this hour`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Shows & Dayparts Modal ── */}
      {assignModal && (
        <ShowsDaypartsModal
          hour={assignModal.hour}
          onClose={() => setAssignModal(null)}
          onDone={async () => {
            setAssignModal(null);
            await loadShows();
            await loadDayData(selectedDate);
            generateHour(assignModal.hour);
          }}
        />
      )}

      {/* ── Hour Edit Modal ── */}
      {hourModal && (
        <HourModal
          date={selectedDate}
          hour={hourModal.hour}
          block={hourModal.block}
          onClose={() => setHourModal(null)}
          onSaved={() => { loadDayData(selectedDate); setHourModal(null); }}
        />
      )}
    </div>
  );
}

// ── HourModal — deep dive editor for a single scheduled hour ──

interface HourModalProps {
  date: string; hour: number; block: HourBlock;
  onClose: () => void; onSaved: () => void;
}

function HourModal({ date, hour, block, onClose, onSaved }: HourModalProps) {
  const [entries, setEntries] = useState<ScheduledEntry[]>(block.entries);
  const [swapTarget, setSwapTarget] = useState<ScheduledEntry | null>(null);
  const [songSearch, setSongSearch] = useState("");
  const [songResults, setSongResults] = useState<Song[]>([]);
  const [saving, setSaving] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  // Load full song library for a category
  const loadSongs = async (categoryId: number | null, search: string) => {
    if (!categoryId) return;
    try {
      const rows = await query<Song>(
        `SELECT s.id, s.title, a.name as artist_name, s.artist_id,
                s.category_id, s.duration_ms, s.last_played_at
         FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
         WHERE s.category_id = ?
           AND (s.title LIKE ? OR a.name LIKE ?)
         ORDER BY s.title ASC LIMIT 100`,
        [categoryId, `%${search}%`, `%${search}%`]
      );
      setSongResults(rows);
    } catch {}
  };

  useEffect(() => {
    if (swapTarget) loadSongs(swapTarget.category_id, songSearch);
  }, [swapTarget, songSearch]);

  const swapSong = async (newSong: Song) => {
    if (!swapTarget) return;
    // Update in DB
    await execute(
      `UPDATE scheduled_log SET song_id=?, song_title=?, song_artist=?, duration_ms=?
       WHERE id=?`,
      [newSong.id, newSong.title, newSong.artist_name, newSong.duration_ms, swapTarget.id]
    );
    // Update local state
    setEntries(prev => prev.map(e => e.id === swapTarget.id
      ? { ...e, song_id: newSong.id, song_title: newSong.title, song_artist: newSong.artist_name || null, duration_ms: newSong.duration_ms }
      : e
    ));
    setSwapTarget(null);
    setSongSearch("");
  };

  const reorderEntries = async (fromIdx: number, toIdx: number) => {
    const reordered = [...entries];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    // Update positions in DB
    await Promise.all(reordered.map((e, i) =>
      execute("UPDATE scheduled_log SET position=? WHERE id=?", [i, e.id])
    ));
    setEntries(reordered);
  };

  const totalMs = entries.reduce((s, e) => s + (e.duration_ms || 0), 0);

  return (
    <div style={{
      position: "fixed" as const, inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width: "min(900px, 95vw)", maxHeight: "85vh", display: "flex", flexDirection: "column" as const,
        background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
        borderRadius: 14, overflow: "hidden",
        boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
      }}>

        {/* Modal header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 12, padding: "14px 18px",
          borderBottom: "1px solid var(--border-primary)", flexShrink: 0,
          background: "var(--bg-tertiary)",
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, fontFamily: "'Syne', sans-serif", color: "var(--text-primary)" }}>
              {fmtHour(hour)} — {block.show_name || "Unassigned"}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 1 }}>
              {date} · {block.clock_name} · {entries.length} tracks · {fmtMs(totalMs)}
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
              Click a row to swap its song
            </div>
            <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14 }}>✕</button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "hidden", display: "flex", minHeight: 0 }}>

          {/* Track list */}
          <div style={{ flex: 1, overflowY: "auto" as const, minWidth: 0 }}>
            {/* Headers */}
            <div style={{
              display: "grid", gridTemplateColumns: "28px 44px 1fr 180px 60px",
              padding: "5px 14px", background: "var(--bg-tertiary)",
              borderBottom: "1px solid var(--border-primary)",
              fontSize: 8, fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" as const,
              position: "sticky" as const, top: 0, zIndex: 1,
            }}>
              <span></span><span>Type</span><span>Title</span><span>Artist</span>
              <span style={{ textAlign: "right" as const }}>Duration</span>
            </div>

            {entries.map((entry, i) => {
              const color = entry.category_color || "#38bdf8";
              const isSwapping = swapTarget?.id === entry.id;
              const isUnfilled = entry.status === "unfilled";

              return (
                <div
                  key={entry.id}
                  draggable
                  onDragStart={() => setDragFrom(i)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); if (dragFrom !== null && dragFrom !== i) reorderEntries(dragFrom, i); setDragFrom(null); }}
                  onClick={() => { if (entry.slot_type === "music") { setSwapTarget(isSwapping ? null : entry); setSongSearch(""); } }}
                  style={{
                    display: "grid", gridTemplateColumns: "28px 44px 1fr 180px 60px",
                    padding: "0 14px", minHeight: 34, alignItems: "center",
                    cursor: entry.slot_type === "music" ? "pointer" : "default",
                    background: isSwapping ? "rgba(167,139,250,0.1)" : i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                    borderBottom: "1px solid rgba(255,255,255,0.03)",
                    borderLeft: `3px solid ${isSwapping ? "#a78bfa" : isUnfilled ? "#ef4444" : color}`,
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={e => { if (!isSwapping && entry.slot_type === "music") (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
                  onMouseLeave={e => { if (!isSwapping) (e.currentTarget as HTMLElement).style.background = i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)"; }}
                >
                  {/* Drag grip */}
                  <svg width="8" height="10" viewBox="0 0 8 10" fill="var(--text-tertiary)" style={{ opacity: 0.25 }}>
                    <circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/>
                    <circle cx="2" cy="5" r="1"/><circle cx="6" cy="5" r="1"/>
                    <circle cx="2" cy="8" r="1"/><circle cx="6" cy="8" r="1"/>
                  </svg>

                  <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, background: color+"20", color, letterSpacing: "0.06em" }}>
                    {entry.category_code || entry.slot_type.toUpperCase()}
                  </span>

                  <div style={{ minWidth: 0, paddingRight: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: isUnfilled ? "#ef4444" : isSwapping ? "#a78bfa" : "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                      {isUnfilled ? "⚠ Unfilled — click to assign" : entry.song_title || entry.label || "—"}
                    </div>
                  </div>

                  <span style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, paddingRight: 8 }}>
                    {entry.song_artist || ""}
                  </span>

                  <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)", textAlign: "right" as const }}>
                    {fmtMs(entry.duration_ms)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Song swap panel */}
          {swapTarget && (
            <div style={{
              width: 300, flexShrink: 0, borderLeft: "1px solid var(--border-primary)",
              display: "flex", flexDirection: "column" as const, background: "var(--bg-primary)",
            }}>
              <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#a78bfa", marginBottom: 6 }}>
                  Swap: {swapTarget.category_code} slot #{entries.findIndex(e => e.id === swapTarget.id) + 1}
                </div>
                <input
                  autoFocus
                  placeholder="Search songs..."
                  value={songSearch}
                  onChange={e => setSongSearch(e.target.value)}
                  style={{
                    width: "100%", padding: "6px 10px", borderRadius: 7, fontSize: 11,
                    background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
                    color: "var(--text-primary)", outline: "none", boxSizing: "border-box" as const,
                  }}
                />
                <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 4 }}>
                  {songResults.length} songs in {swapTarget.category_code}
                </div>
              </div>

              <div style={{ flex: 1, overflowY: "auto" as const }}>
                {songResults.map(song => {
                  const isCurrent = song.id === swapTarget.song_id;
                  return (
                    <div
                      key={song.id}
                      onClick={() => swapSong(song)}
                      style={{
                        padding: "7px 12px", cursor: "pointer",
                        borderBottom: "1px solid rgba(255,255,255,0.03)",
                        background: isCurrent ? "rgba(167,139,250,0.08)" : "transparent",
                        borderLeft: isCurrent ? "2px solid #a78bfa" : "2px solid transparent",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={e => { if (!isCurrent) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
                      onMouseLeave={e => { if (!isCurrent) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                    >
                      <div style={{ fontSize: 11, fontWeight: 500, color: isCurrent ? "#a78bfa" : "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                        {isCurrent && "✓ "}{song.title}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 1 }}>
                        <span style={{ fontSize: 9, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1 }}>
                          {song.artist_name || "Unknown"}
                        </span>
                        <span style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)", flexShrink: 0 }}>
                          {fmtMs(song.duration_ms)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Modal footer */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 18px",
          borderTop: "1px solid var(--border-primary)", flexShrink: 0,
          background: "var(--bg-tertiary)", fontSize: 10, color: "var(--text-tertiary)",
        }}>
          <span>Drag rows to reorder · Click a music row to swap the song</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span style={{ fontFamily: "'DM Mono', monospace", color: "var(--text-secondary)" }}>
              {fmtMs(totalMs)} total
            </span>
            <button onClick={onSaved} style={{
              padding: "5px 16px", borderRadius: 7, fontSize: 11, fontWeight: 700,
              background: "rgba(52,211,153,0.15)", color: "#34d399",
              border: "1px solid rgba(52,211,153,0.3)", cursor: "pointer",
            }}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


// ── ShowsDaypartsModal — full shows & dayparts in a popup ─────

const HOURS_LIST = Array.from({length: 24}, (_, i) => i);

function fmtHourLocal(h: number): string {
  if (h === 0) return "12 AM"; if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

interface ShowsDaypartsModalProps {
  hour: number;
  onClose: () => void;
  onDone: () => void;
}

function ShowsDaypartsModal({ hour, onClose, onDone }: ShowsDaypartsModalProps) {
  const [modalShows, setModalShows] = useState<Show[]>([]);
  const [modalClocks, setModalClocks] = useState<{id:number;name:string}[]>([]);
  const [editing, setEditing] = useState<Partial<Show> | null>(null);

  const loadModal = async () => {
    setModalShows(await query<Show>(
      "SELECT s.*, c.name as clock_name FROM shows s LEFT JOIN clocks c ON c.id = s.clock_id ORDER BY s.start_hour"
    ));
    setModalClocks(await query<{id:number;name:string}>("SELECT id, name FROM clocks ORDER BY name"));
  };

  useEffect(() => { loadModal(); }, []);

  const save = async () => {
    if (!editing || !editing.name) return;
    if (editing.id) {
      await execute("UPDATE shows SET name=?, start_hour=?, end_hour=?, color=?, description=? WHERE id=?",
        [editing.name, editing.start_hour||0, editing.end_hour||0, editing.color||null, editing.description||null, editing.id]);
    } else {
      await execute("INSERT INTO shows (name, start_hour, end_hour, color, description) VALUES (?,?,?,?,?)",
        [editing.name, editing.start_hour||0, editing.end_hour||0, editing.color||null, editing.description||null]);
    }
    setEditing(null); loadModal();
  };

  const assignClock = async (showId: number, clockId: number | null) => {
    await execute("UPDATE shows SET clock_id=? WHERE id=?", [clockId, showId]);
    loadModal();
  };

  const removeShow = async (id: number) => {
    await execute("DELETE FROM shows WHERE id=?", [id]); loadModal();
  };

  // Check if the target hour now has a clock assigned
  const hasTargetHour = hour >= 0;
  const targetShow = hasTargetHour ? modalShows.find(s => s.start_hour <= hour && s.end_hour > hour) : null;
  const canGenerate = hasTargetHour && !!targetShow?.clock_id;

  return (
    <div style={{
      position: "fixed" as const, inset: 0, zIndex: 1001,
      background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width: "min(780px, 95vw)", maxHeight: "88vh", display: "flex",
        flexDirection: "column" as const, background: "var(--bg-secondary)",
        border: "1px solid var(--border-primary)", borderRadius: 14, overflow: "hidden",
        boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
      }}>

        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 18px", borderBottom: "1px solid var(--border-primary)",
          background: "var(--bg-tertiary)", flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, fontFamily: "'Syne', sans-serif", color: "var(--text-primary)" }}>
              Shows & Dayparts
            </div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>
              {hasTargetHour ? `Assign a clock to ${fmtHourLocal(hour)} then click Generate` : "Manage shows, dayparts and clock assignments"}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {hasTargetHour && !canGenerate && (
              <span style={{ fontSize: 10, color: "#fbbf24" }}>
                ⚠ Assign a clock to {fmtHourLocal(hour)} to enable Generate
              </span>
            )}
            <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14 }}>✕</button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto" as const, padding: "16px 18px" }}>

          {/* 24-hour timeline */}
          <div style={{ marginBottom: 14, padding: "10px 12px", background: "var(--bg-tertiary)", borderRadius: 9, border: "1px solid var(--border-primary)" }}>
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-tertiary)", marginBottom: 6 }}>24-HOUR TIMELINE</div>
            <div style={{ position: "relative" as const, height: 32, background: "rgba(255,255,255,0.04)", borderRadius: 5, overflow: "hidden" }}>
              {HOURS_LIST.map(h => (
                <div key={h} style={{
                  position: "absolute" as const, top: 0, bottom: 0,
                  left: (h / 24 * 100) + "%", width: (1 / 24 * 100) + "%",
                  borderRight: "1px solid rgba(255,255,255,0.04)",
                }}>
                  {h % 6 === 0 && <span style={{ position: "absolute" as const, top: 2, left: 2, fontSize: 7, color: "rgba(255,255,255,0.3)" }}>{fmtHourLocal(h)}</span>}
                </div>
              ))}
              {/* Target hour highlight */}
              <div style={{
                position: "absolute" as const, top: 0, bottom: 0,
                left: (hour / 24 * 100) + "%", width: (1 / 24 * 100) + "%",
                background: "rgba(167,139,250,0.4)",
              }} />
              {modalShows.map(s => {
                const end = s.end_hour <= s.start_hour ? s.end_hour + 24 : s.end_hour;
                const w = ((end - s.start_hour) / 24) * 100;
                const l = (s.start_hour / 24) * 100;
                return (
                  <div key={s.id} style={{
                    position: "absolute" as const, top: 0, bottom: 0,
                    left: Math.min(l, 100) + "%", width: Math.min(w, 100 - l) + "%",
                    background: (s.color || "#444") + "cc",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 8, fontWeight: 700, color: "#fff", overflow: "hidden",
                  }}>
                    {s.name}
                  </div>
                );
              })}
            </div>
          </div>

          {/* New show button */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>Shows & Dayparts</div>
            <button onClick={() => setEditing({ name: "", start_hour: 0, end_hour: 6, color: "#3b82f6" })}
              style={{ padding: "5px 12px", borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer", background: "rgba(56,189,248,0.12)", color: "#38bdf8", border: "1px solid rgba(56,189,248,0.3)" }}>
              + New Show
            </button>
          </div>

          {/* Edit form */}
          {editing && (
            <div style={{ padding: "12px", background: "var(--bg-tertiary)", borderRadius: 9, border: "1px solid var(--border-primary)", marginBottom: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 100px 100px", gap: 6, marginBottom: 6 }}>
                <input placeholder="Show name" value={editing.name||""} onChange={e => setEditing({...editing, name: e.target.value})}
                  style={{ padding: "6px 10px", borderRadius: 7, fontSize: 11, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
                <input placeholder="Description" value={editing.description||""} onChange={e => setEditing({...editing, description: e.target.value})}
                  style={{ padding: "6px 10px", borderRadius: 7, fontSize: 11, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
                <select value={editing.start_hour||0} onChange={e => setEditing({...editing, start_hour: +e.target.value})}
                  style={{ padding: "6px 8px", borderRadius: 7, fontSize: 11, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}>
                  {HOURS_LIST.map(h => <option key={h} value={h}>{fmtHourLocal(h)}</option>)}
                </select>
                <select value={editing.end_hour||0} onChange={e => setEditing({...editing, end_hour: +e.target.value})}
                  style={{ padding: "6px 8px", borderRadius: 7, fontSize: 11, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}>
                  {HOURS_LIST.map(h => <option key={h} value={h}>{fmtHourLocal(h)}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="color" value={editing.color||"#3b82f6"} onChange={e => setEditing({...editing, color: e.target.value})}
                  style={{ width: 32, height: 28, borderRadius: 6, border: "1px solid var(--border-primary)", cursor: "pointer", background: "none" }} />
                <button onClick={save} style={{ padding: "5px 14px", borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer", background: "rgba(56,189,248,0.12)", color: "#38bdf8", border: "1px solid rgba(56,189,248,0.3)" }}>Save</button>
                <button onClick={() => setEditing(null)} style={{ padding: "5px 12px", borderRadius: 7, fontSize: 11, cursor: "pointer", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)" }}>Cancel</button>
              </div>
            </div>
          )}

          {/* Show list */}
          {modalShows.length === 0 && (
            <div style={{ textAlign: "center" as const, padding: "24px", color: "var(--text-tertiary)", fontSize: 12, fontStyle: "italic" }}>
              No shows yet — click + New Show to create dayparts
            </div>
          )}
          {modalShows.map(s => {
            const isTarget = s.start_hour <= hour && s.end_hour > hour;
            return (
              <div key={s.id} style={{
                padding: "12px 14px", borderRadius: 9, marginBottom: 6,
                background: isTarget ? "rgba(167,139,250,0.06)" : "var(--bg-tertiary)",
                border: `1px solid ${isTarget ? "rgba(167,139,250,0.25)" : "var(--border-primary)"}`,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: s.color || "#94a3b8", flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: isTarget ? "#a78bfa" : "var(--text-primary)" }}>
                      {s.name} {isTarget && <span style={{ fontSize: 9, background: "rgba(167,139,250,0.2)", color: "#a78bfa", padding: "1px 5px", borderRadius: 3, marginLeft: 4 }}>TARGET HOUR</span>}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
                      {fmtHourLocal(s.start_hour)} – {fmtHourLocal(s.end_hour)}{s.description ? " · " + s.description : ""}
                    </div>
                  </div>
                  <button onClick={() => setEditing(s)} style={{ padding: "3px 10px", borderRadius: 6, fontSize: 10, cursor: "pointer", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)" }}>Edit</button>
                  <button onClick={() => removeShow(s.id)} style={{ padding: "3px 8px", borderRadius: 6, fontSize: 10, cursor: "pointer", background: "transparent", border: "none", color: "var(--text-tertiary)" }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
                  >✕</button>
                </div>

                {/* Clock assignment */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 10, color: "var(--text-tertiary)", flexShrink: 0 }}>Format Clock:</span>
                  <select value={s.clock_id||""} onChange={e => assignClock(s.id, e.target.value ? +e.target.value : null)}
                    style={{
                      flex: 1, padding: "5px 10px", borderRadius: 7, fontSize: 11,
                      background: "var(--bg-secondary)", border: `1px solid ${s.clock_id ? "rgba(52,211,153,0.3)" : "var(--border-primary)"}`,
                      color: "var(--text-primary)", outline: "none", cursor: "pointer",
                    }}>
                    <option value="">-- No clock assigned --</option>
                    {modalClocks.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  {s.clock_id && <span style={{ fontSize: 10, color: "#34d399", fontWeight: 700, flexShrink: 0 }}>✓ Active</span>}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{
          padding: "12px 18px", borderTop: "1px solid var(--border-primary)",
          display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
          background: "var(--bg-tertiary)",
        }}>
          <span style={{ fontSize: 10, color: "var(--text-tertiary)", flex: 1 }}>
            {!hasTargetHour
              ? "Changes save automatically"
              : canGenerate
              ? `Ready — ${fmtHourLocal(hour)} will use "${targetShow?.clock_name}"`
              : `Assign a clock to the show covering ${fmtHourLocal(hour)}`}
          </span>
          <button onClick={onClose} style={{ padding: "7px 14px", borderRadius: 7, fontSize: 11, cursor: "pointer", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)" }}>
            {hasTargetHour ? "Close" : "Done"}
          </button>
          {hasTargetHour && (
            <button
              onClick={onDone}
              disabled={!canGenerate}
              style={{
                padding: "7px 20px", borderRadius: 7, fontSize: 11, fontWeight: 700,
                cursor: canGenerate ? "pointer" : "default",
                background: canGenerate ? "rgba(52,211,153,0.15)" : "rgba(255,255,255,0.04)",
                color: canGenerate ? "#34d399" : "var(--text-tertiary)",
                border: `1px solid ${canGenerate ? "rgba(52,211,153,0.35)" : "var(--border-primary)"}`,
              }}
            >
              ▶ Generate {fmtHourLocal(hour)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

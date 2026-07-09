/**
 * ListenerAnalytics.tsx
 * Ether Technologies — Listener & Airplay Analytics (Pro feature)
 *
 * Data sources:
 *   play_log        — every on-air play (title, artist, deck, played_at)
 *   songs           — BPM, energy, LUFS, category, last_played_at
 *   scheduled_log   — what was scheduled vs what actually aired
 *
 * The component creates play_log if it doesn't exist yet.
 */

import { useState, useEffect, useCallback } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";

// ─── Types ────────────────────────────────────────────────────

interface PlayEntry {
  id: number;
  title: string;
  artist: string | null;
  deck_id: string | null;
  played_at: number; // unix seconds
}

interface TopSong {
  title: string;
  artist: string | null;
  play_count: number;
  last_played: number;
  category_code: string | null;
  category_color: string | null;
  bpm: number | null;
  energy: number | null;
  lufs_measured: number | null;
}

interface TopArtist {
  artist: string;
  play_count: number;
  unique_songs: number;
  last_played: number;
}

interface HourlyData {
  hour: number;
  play_count: number;
  unique_artists: number;
}

interface CategoryBreakdown {
  category_code: string | null;
  category_color: string | null;
  play_count: number;
  total_ms: number;
}

interface DailyTrend {
  date: string;
  play_count: number;
}

// ─── Helpers ──────────────────────────────────────────────────

function fmtHour(h: number) {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function fmtDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDateFull(epoch: number) {
  return new Date(epoch * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function timeAgo(epoch: number) {
  const diff = Date.now() / 1000 - epoch;
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return fmtDate(epoch);
}

// ─── Mini bar chart ───────────────────────────────────────────

function BarChart({ data, height = 80, color = "var(--accent-cyan)" }: {
  data: { label: string; value: number }[];
  height?: number;
  color?: string;
}) {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, height: "100%", justifyContent: "flex-end" }}>
          <div style={{
            width: "100%", borderRadius: "3px 3px 0 0",
            height: `${(d.value / max) * 100}%`,
            background: d.value === 0 ? "var(--bg-tertiary)" : color,
            opacity: d.value === 0 ? 0.3 : 0.85,
            minHeight: d.value > 0 ? 3 : 0,
            transition: "height 0.4s ease",
          }} />
          <div style={{ fontSize: 7, color: "var(--text-tertiary)", textAlign: "center", lineHeight: 1, whiteSpace: "nowrap" }}>{d.label}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────

function StatCard({ label, value, sub, color = "var(--accent-cyan)" }: {
  label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <div style={{
      padding: "14px 16px", borderRadius: 0,
      background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.14em", color: "var(--text-tertiary)", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color, fontFamily: "'DM Mono', monospace", letterSpacing: "-0.03em", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{sub}</div>}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────

interface Props { onClose?: () => void; }

type Tab = "overview" | "songs" | "artists" | "schedule";
type Range = "7d" | "30d" | "90d" | "all";

export default function ListenerAnalytics({ onClose }: Props) {
  const { stationId } = useActiveStation();
  const [tab, setTab]             = useState<Tab>("overview");
  const [range, setRange]         = useState<Range>("30d");
  const [loading, setLoading]     = useState(true);

  // Data
  const [totalPlays, setTotalPlays]         = useState(0);
  const [uniqueSongs, setUniqueSongs]       = useState(0);
  const [uniqueArtists, setUniqueArtists]   = useState(0);
  const [avgPlaysPerDay, setAvgPlaysPerDay] = useState(0);
  const [topSongs, setTopSongs]             = useState<TopSong[]>([]);
  const [topArtists, setTopArtists]         = useState<TopArtist[]>([]);
  const [hourly, setHourly]                 = useState<HourlyData[]>([]);
  const [categories, setCategories]         = useState<CategoryBreakdown[]>([]);
  const [dailyTrend, setDailyTrend]         = useState<DailyTrend[]>([]);
  const [recentPlays, setRecentPlays]       = useState<PlayEntry[]>([]);

  const rangeDays: Record<Range, number | null> = { "7d": 7, "30d": 30, "90d": 90, "all": null };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const days = rangeDays[range];
      const since = days ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
      // station_id scoping: Strategy C — station_id is the base condition in all dynamic builders
      const whereClause = since > 0 ? `WHERE pl.station_id = ${stationId} AND pl.played_at >= ${since}` : `WHERE pl.station_id = ${stationId}`;
      const sinceClause = since > 0 ? `AND played_at >= ${since}` : "";

      // Overview stats — station_id scoping: Strategy C dynamic builders
      const [playsRow, songsRow, artistsRow] = await Promise.all([
        queryScoped<{ c: number }>(`SELECT COUNT(*) as c FROM play_log WHERE station_id = ? AND (content_class IS NULL OR content_class = 'MUSIC') ${since > 0 ? `AND played_at >= ${since}` : ""}`, [stationId], stationId, { skipScoping: true }),
        queryScoped<{ c: number }>(`SELECT COUNT(DISTINCT title) as c FROM play_log WHERE station_id = ? AND (content_class IS NULL OR content_class = 'MUSIC') ${since > 0 ? `AND played_at >= ${since}` : ""}`, [stationId], stationId, { skipScoping: true }),
        queryScoped<{ c: number }>(`SELECT COUNT(DISTINCT artist) as c FROM play_log WHERE station_id = ? AND artist IS NOT NULL AND (content_class IS NULL OR content_class = 'MUSIC') ${since > 0 ? `AND played_at >= ${since}` : ""}`, [stationId], stationId, { skipScoping: true }),
      ]);

      const plays = playsRow[0]?.c ?? 0;
      setTotalPlays(plays);
      setUniqueSongs(songsRow[0]?.c ?? 0);
      setUniqueArtists(artistsRow[0]?.c ?? 0);
      setAvgPlaysPerDay(days ? Math.round(plays / days * 10) / 10 : 0);

      // Top songs — station_id scoping: manual JOIN with explicit scoping on all tables
      const songs = await queryScoped<TopSong>(`
        SELECT pl.title, pl.artist, COUNT(*) as play_count,
               MAX(pl.played_at) as last_played,
               s.category_code, s.category_color, s.bpm, s.energy, s.lufs_measured
        FROM play_log pl
        LEFT JOIN (
          SELECT s2.title, s2.artist_id, s2.bpm, s2.energy, s2.lufs_measured,
                 c.code as category_code, c.color as category_color,
                 a.name as artist_name
          FROM songs s2
          LEFT JOIN categories c ON c.id = s2.category_id AND c.station_id = ${stationId}
          LEFT JOIN artists a ON a.id = s2.artist_id AND a.station_id = ${stationId}
          WHERE s2.station_id = ${stationId}
        ) s ON s.title = pl.title
        ${whereClause}
        GROUP BY pl.title
        ORDER BY play_count DESC
        LIMIT 50
      `, [], stationId, { skipScoping: true });
      setTopSongs(songs);

      // Top artists — station_id scoping: Strategy C dynamic builder
      const artists = await queryScoped<TopArtist>(`
        SELECT artist, COUNT(*) as play_count,
               COUNT(DISTINCT title) as unique_songs,
               MAX(played_at) as last_played
        FROM play_log
        WHERE station_id = ? AND artist IS NOT NULL AND (content_class IS NULL OR content_class = 'MUSIC') ${sinceClause}
        GROUP BY artist
        ORDER BY play_count DESC
        LIMIT 50
      `, [stationId], stationId, { skipScoping: true });
      setTopArtists(artists);

      // Hourly distribution — station_id scoping: Strategy C dynamic builder
      const hourlyRaw = await queryScoped<{ hour: number; play_count: number; unique_artists: number }>(`
        SELECT CAST(strftime('%H', datetime(played_at, 'unixepoch', 'localtime')) AS INTEGER) as hour,
               COUNT(*) as play_count,
               COUNT(DISTINCT artist) as unique_artists
        FROM play_log
        WHERE station_id = ? ${sinceClause}
        GROUP BY hour ORDER BY hour
      `, [stationId], stationId, { skipScoping: true });
      const hourlyMap: Record<number, HourlyData> = {};
      hourlyRaw.forEach(r => { hourlyMap[r.hour] = r; });
      setHourly(Array.from({ length: 24 }, (_, h) => hourlyMap[h] ?? { hour: h, play_count: 0, unique_artists: 0 }));

      // Category breakdown — station_id scoping: Strategy C dynamic builder
      const cats = await queryScoped<CategoryBreakdown>(`
        SELECT category_code, category_color,
               COUNT(*) as play_count,
               SUM(duration_ms) as total_ms
        FROM scheduled_log
        WHERE station_id = ? AND (status = 'played' OR status = 'scheduled')
        ${since > 0 ? `AND created_at >= ${since}` : ""}
        GROUP BY category_code
        ORDER BY play_count DESC
      `, [stationId], stationId, { skipScoping: true });
      setCategories(cats.filter(c => c.category_code));

      // Daily trend — station_id scoping: Strategy C dynamic builder
      const trendDays = days ?? 30;
      const trend = await queryScoped<DailyTrend>(`
        SELECT date(datetime(played_at, 'unixepoch', 'localtime')) as date,
               COUNT(*) as play_count
        FROM play_log
        WHERE station_id = ? AND played_at >= ${Math.floor(Date.now() / 1000) - trendDays * 86400}
        GROUP BY date ORDER BY date
      `, [stationId], stationId, { skipScoping: true });
      // Fill in missing days
      const trendMap: Record<string, number> = {};
      trend.forEach(r => { trendMap[r.date] = r.play_count; });
      const trendFilled: DailyTrend[] = [];
      for (let i = trendDays - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        const key = d.toISOString().slice(0, 10);
        trendFilled.push({ date: key, play_count: trendMap[key] ?? 0 });
      }
      setDailyTrend(trendFilled);

      // Recent plays — station_id scoping: Strategy B (single table, queryScoped injects)
      const recent = await queryScoped<PlayEntry>(`
        SELECT * FROM play_log ORDER BY played_at DESC LIMIT 20
      `, [], stationId);
      setRecentPlays(recent);

    } catch (e) {
      console.error("[Analytics] load failed:", e);
    }
    setLoading(false);
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // ─── Render ─────────────────────────────────────────────────

  const TABS: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "songs",    label: "Top Songs" },
    { id: "artists",  label: "Top Artists" },
    { id: "schedule", label: "Scheduling" },
  ];

  const RANGES: { id: Range; label: string }[] = [
    { id: "7d",  label: "7 days" },
    { id: "30d", label: "30 days" },
    { id: "90d", label: "90 days" },
    { id: "all", label: "All time" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--bg-primary)" }}>

      {/* ── Header ── */}
      <div style={{
        padding: "14px 24px", borderBottom: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)", display: "flex", alignItems: "center", gap: 14, flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "var(--accent-cyan)", textTransform: "uppercase", marginBottom: 2 }}>Pro Feature</div>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)", fontFamily: "'Newsreader', Georgia, serif" }}>Listener Analytics</div>
        </div>

        {/* Range selector */}
        <div style={{ display: "flex", gap: 3, background: "var(--bg-tertiary)", borderRadius: 0, padding: 3, border: "1px solid var(--border-primary)", marginLeft: 16 }}>
          {RANGES.map(r => (
            <button key={r.id} onClick={() => setRange(r.id)} style={{
              padding: "5px 12px", borderRadius: 0, fontSize: 11, fontWeight: 700,
              border: "none", cursor: "pointer", transition: "all 0.12s",
              background: range === r.id ? "var(--accent-cyan)" : "transparent",
              color: range === r.id ? "#000" : "var(--text-tertiary)",
            }}>{r.label}</button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {loading && (
          <div style={{ width: 18, height: 18, borderRadius: "50%", border: "2px solid var(--border-primary)", borderTopColor: "var(--accent-cyan)", animation: "spin 0.7s linear infinite" }} />
        )}
        {onClose && (
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 0, border: "1px solid var(--border-primary)", background: "transparent", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.1)"; (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
          >✕</button>
        )}
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: "flex", gap: 2, padding: "8px 16px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-secondary)", flexShrink: 0 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "6px 16px", borderRadius: 0, fontSize: 11, fontWeight: 700,
            border: "none", cursor: "pointer", transition: "all 0.12s",
            background: tab === t.id ? "rgb(from var(--accent-cyan) r g b / 0.12)" : "transparent",
            color: tab === t.id ? "var(--accent-cyan)" : "var(--text-tertiary)",
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>

        {/* ══ OVERVIEW ══ */}
        {tab === "overview" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* Stat cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              <StatCard label="Total Plays" value={totalPlays.toLocaleString()} sub={`${avgPlaysPerDay}/day avg`} color="var(--accent-cyan)" />
              <StatCard label="Unique Songs" value={uniqueSongs.toLocaleString()} sub="distinct titles" color="#34d399" />
              <StatCard label="Unique Artists" value={uniqueArtists.toLocaleString()} sub="distinct artists" color="#a78bfa" />
              <StatCard label="Avg/Day" value={avgPlaysPerDay.toLocaleString()} sub={`over ${rangeDays[range] ?? "all"} days`} color="#fb923c" />
            </div>

            {/* Daily trend */}
            <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "16px 18px" }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 14 }}>Daily Play Volume</div>
              <BarChart
                data={dailyTrend.map((d, i) => ({
                  label: i % Math.ceil(dailyTrend.length / 8) === 0 ? new Date(d.date).toLocaleDateString("en-US", { month: "numeric", day: "numeric" }) : "",
                  value: d.play_count,
                }))}
                height={100}
                color="var(--accent-cyan)"
              />
            </div>

            {/* Hourly heatmap */}
            <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "16px 18px" }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 14 }}>Plays by Hour of Day</div>
              <BarChart
                data={hourly.map(h => ({ label: h.hour % 6 === 0 ? fmtHour(h.hour) : "", value: h.play_count }))}
                height={80}
                color="#a78bfa"
              />
            </div>

            {/* Category breakdown */}
            {categories.length > 0 && (
              <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "16px 18px" }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 14 }}>Category Breakdown</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {categories.map(cat => {
                    const total = categories.reduce((s, c) => s + c.play_count, 0);
                    const pct = Math.round((cat.play_count / total) * 100);
                    const color = cat.category_color || "#64748b";
                    const totalHrs = Math.round((cat.total_ms || 0) / 3600000 * 10) / 10;
                    return (
                      <div key={cat.category_code} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 36, flexShrink: 0 }}>
                          <span style={{ fontSize: 10, fontWeight: 800, color, background: color + "20", borderRadius: 0, padding: "2px 6px" }}>{cat.category_code}</span>
                        </div>
                        <div style={{ flex: 1, height: 8, background: "var(--bg-tertiary)", borderRadius: 0, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: pct + "%", background: color, borderRadius: 0, transition: "width 0.5s ease" }} />
                        </div>
                        <div style={{ width: 32, fontSize: 10, fontWeight: 700, color: "var(--text-secondary)", textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{pct}%</div>
                        <div style={{ width: 60, fontSize: 9, color: "var(--text-tertiary)", textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{cat.play_count} plays</div>
                        <div style={{ width: 48, fontSize: 9, color: "var(--text-tertiary)", textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{totalHrs}h</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Recent plays */}
            <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" }}>Recent Plays</div>
              {recentPlays.length === 0 ? (
                <div style={{ padding: "32px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 12 }}>No play history yet — plays are logged when tracks air on any deck.</div>
              ) : (
                recentPlays.map((p, i) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: i < recentPlays.length - 1 ? "1px solid var(--border-primary)" : "none", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)" }}>
                    <div style={{ width: 22, height: 22, borderRadius: 0, background: "var(--bg-tertiary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>{i + 1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</div>
                      <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{p.artist || "Unknown Artist"}</div>
                    </div>
                    <div style={{ fontSize: 9, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>{p.deck_id && `Deck ${p.deck_id}`}</div>
                    <div style={{ fontSize: 9, color: "var(--text-tertiary)", flexShrink: 0 }}>{timeAgo(p.played_at)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* ══ TOP SONGS ══ */}
        {tab === "songs" && (
          <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "32px 1fr 120px 60px 60px 60px 80px", padding: "8px 16px", background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)", fontSize: 8, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" }}>
              <span>#</span><span>Song</span><span>Category</span><span>Plays</span><span>BPM</span><span>LUFS</span><span>Last Played</span>
            </div>
            {topSongs.length === 0 ? (
              <div style={{ padding: "40px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 12 }}>No play data yet for this period.</div>
            ) : topSongs.map((s, i) => {
              const color = s.category_color || "#64748b";
              return (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "32px 1fr 120px 60px 60px 60px 80px", padding: "10px 16px", borderBottom: i < topSongs.length - 1 ? "1px solid var(--border-primary)" : "none", alignItems: "center", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: i < 3 ? "var(--accent-cyan)" : "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>{i + 1}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                    <div style={{ fontSize: 10, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.artist || "Unknown"}</div>
                  </div>
                  <span>
                    {s.category_code && <span style={{ fontSize: 9, fontWeight: 800, color, background: color + "20", borderRadius: 0, padding: "2px 6px" }}>{s.category_code}</span>}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 800, color: "var(--text-primary)", fontFamily: "'DM Mono', monospace" }}>{s.play_count}</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "'DM Mono', monospace" }}>{s.bpm ? Math.round(s.bpm) : "—"}</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "'DM Mono', monospace" }}>{s.lufs_measured ? s.lufs_measured.toFixed(1) : "—"}</span>
                  <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{timeAgo(s.last_played)}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* ══ TOP ARTISTS ══ */}
        {tab === "artists" && (
          <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "32px 1fr 80px 100px 100px", padding: "8px 16px", background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)", fontSize: 8, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" }}>
              <span>#</span><span>Artist</span><span>Plays</span><span>Unique Songs</span><span>Last Played</span>
            </div>
            {topArtists.length === 0 ? (
              <div style={{ padding: "40px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 12 }}>No artist data yet.</div>
            ) : topArtists.map((a, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "32px 1fr 80px 100px 100px", padding: "10px 16px", borderBottom: i < topArtists.length - 1 ? "1px solid var(--border-primary)" : "none", alignItems: "center", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: i < 3 ? "var(--accent-cyan)" : "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>{i + 1}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: "var(--accent-cyan)", flexShrink: 0 }}>
                    {a.artist.charAt(0).toUpperCase()}
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.artist}</span>
                </div>
                <span style={{ fontSize: 13, fontWeight: 800, color: "var(--text-primary)", fontFamily: "'DM Mono', monospace" }}>{a.play_count}</span>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "'DM Mono', monospace" }}>{a.unique_songs} songs</span>
                <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{timeAgo(a.last_played)}</span>
              </div>
            ))}
          </div>
        )}

        {/* ══ SCHEDULING ══ */}
        {tab === "schedule" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Hourly play distribution */}
            <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "16px 18px" }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 6 }}>Peak Broadcast Hours</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 16 }}>Which hours of day have the most music activity</div>
              <BarChart
                data={hourly.map(h => ({ label: h.hour % 3 === 0 ? fmtHour(h.hour) : "", value: h.play_count }))}
                height={120}
                color="#34d399"
              />
              <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
                {hourly
                  .filter(h => h.play_count > 0)
                  .sort((a, b) => b.play_count - a.play_count)
                  .slice(0, 5)
                  .map(h => (
                    <div key={h.hour} style={{ padding: "4px 10px", borderRadius: 0, background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.25)", fontSize: 10, fontWeight: 700, color: "#34d399" }}>
                      {fmtHour(h.hour)} · {h.play_count} plays
                    </div>
                  ))}
              </div>
            </div>

            {/* Category time-on-air */}
            {categories.length > 0 && (
              <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "16px 18px" }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 14 }}>Time on Air by Category</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {categories.map(cat => {
                    const color = cat.category_color || "#64748b";
                    const hrs = (cat.total_ms || 0) / 3600000;
                    const maxHrs = Math.max(...categories.map(c => (c.total_ms || 0) / 3600000));
                    const pct = maxHrs > 0 ? (hrs / maxHrs) * 100 : 0;
                    return (
                      <div key={cat.category_code} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 10, fontWeight: 800, color, background: color + "20", borderRadius: 0, padding: "2px 6px", width: 36, textAlign: "center", flexShrink: 0 }}>{cat.category_code}</span>
                        <div style={{ flex: 1, height: 10, background: "var(--bg-tertiary)", borderRadius: 0, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: pct + "%", background: color, borderRadius: 0, transition: "width 0.5s ease" }} />
                        </div>
                        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "'DM Mono', monospace", width: 52, textAlign: "right", flexShrink: 0 }}>
                          {hrs.toFixed(1)}h
                        </span>
                        <span style={{ fontSize: 9, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", width: 56, textAlign: "right", flexShrink: 0 }}>
                          {cat.play_count} plays
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// Jukebox Mode — Slice 1, "the room".
//
// Design of record: docs/jukebox-mode-design-2026-08-04.md (APPROVED 2026-08-04).
//
// A fullscreen takeover of THIS renderer — not a second window. The engine, active station and daemon
// connection are already resolved here; a second window would need the whole station-context handshake
// again, which is a bug class this codebase has already paid for twice.
//
// The public browses and picks. A pick becomes PLAY NEXT on the operator's running station via the two
// EXISTING id-addressed queue intents — queue:enqueue then queue:move(top) (engine-rodio.ts:610,613).
// The daemon is the single source of truth: the up-next list renders the daemon's queue, never an
// optimistic local list. If the daemon didn't take the pick, the public sees that it didn't.
//
// ELIGIBILITY — "clock as playlist". A clock is a category-SEQUENCE template (clock_slots carries
// clock_id/position/slot_type/category_id), so the pickable set is the UNION of songs in the DISTINCT
// categories that clock's music slots reference. Order is discarded — sequence is a scheduling concern.
// Non-music slots carry spot_category_id, not category_id, so spots and talk breaks are never pickable.
//
// v1 is RESTRICTED to the ACTIVE station's clocks (Jeff, §7a.1): a foreign station's category resolves
// to that station's songs, whose file_path may not exist on this machine, and a public pick that
// produces dead air is the worst failure this feature can have.
//
// NOT in this slice: the PIN-gated settings overlay and the MANUAL-precondition banner (Slice 2), and
// real artwork (library artwork Slice A). Tiles render a neutral art-forward treatment — deliberately,
// not as a stub: firing a music-store lookup per tile across hundreds of songs would be both slow and
// exactly the guessing the spot fix removed.

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
import { useAudioEngine } from "../audio/AudioEngineContext";

// ── Payment layer (design §4) ──────────────────────────────────────────────────────────────────────
// Phase 1 is cash/free — the reality is a bucket. The pick path calls authorize() and enqueues ONLY on
// ok:true; nothing else in the jukebox knows anything about money, so Clover / QR drop in behind this
// same interface as a config value rather than a change at the call site.
export interface JukeboxPaymentProvider {
  readonly id: "free" | "clover" | "qr";
  readonly label: string;                       // the confirm button's verb
  authorize(sel: { songId: number; title: string; artist: string }):
    Promise<{ ok: boolean; reference?: string; declineReason?: string }>;
}

const FreeProvider: JukeboxPaymentProvider = {
  id: "free",
  label: "PLAY NEXT",
  async authorize() { return { ok: true }; },
};

// ── Tunables, read from station_config_kv with the design's defaults (§7a) ─────────────────────────
const DEFAULT_REPEAT_MINUTES = 60;
const DEFAULT_MAX_PENDING = 12;
const PAGE_SIZE = 60;

interface JukeSong {
  id: number;
  title: string;
  artist: string | null;
  file_path: string;
  duration_ms: number | null;
}

const fmtDur = (ms: number | null) => {
  if (!ms || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Deterministic tile tint from the title, so the neutral grid still reads as a wall of distinct
 *  covers rather than 200 identical grey squares. Replaced by real art in library artwork Slice A. */
function tintFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h} 42% 22%)`;
}

export default function Jukebox({ onExit }: { onExit: () => void }) {
  const { stationId, isReady } = useActiveStation();
  const engine = useAudioEngine();

  const [clockId, setClockId] = useState<number | null>(null);
  const [clockName, setClockName] = useState<string | null>(null);
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [categoryNames, setCategoryNames] = useState<string[]>([]);
  const [configLoaded, setConfigLoaded] = useState(false);

  const [repeatMinutes, setRepeatMinutes] = useState(DEFAULT_REPEAT_MINUTES);
  const [maxPending, setMaxPending] = useState(DEFAULT_MAX_PENDING);

  const [search, setSearch] = useState("");
  const [songs, setSongs] = useState<JukeSong[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);

  const [confirming, setConfirming] = useState<JukeSong | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [queue, setQueue] = useState<any[]>([]);
  /** file_paths this session has queued — the basis for the pending cap. Honest about its own limit:
   *  a reload forgets them, which only ever makes the cap more permissive, never less safe. */
  const myPicks = useRef<Set<string>>(new Set());

  const provider: JukeboxPaymentProvider = FreeProvider;

  // ── Config: which clock, and the tunables ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isReady || stationId == null) return;
    let stop = false;
    (async () => {
      try {
        const r: any = await (window as any).ether.stationConfigKv.list(stationId);
        const rows: any[] = (r && r.rows) || [];
        const get = (k: string) => rows.find(x => x.key === k)?.value;
        const cid = parseInt(get("jukebox_source_clock_id") ?? "", 10);
        const rm = parseInt(get("jukebox_repeat_minutes") ?? "", 10);
        const mp = parseInt(get("jukebox_max_pending") ?? "", 10);
        if (stop) return;
        setClockId(Number.isFinite(cid) ? cid : null);
        if (Number.isFinite(rm)) setRepeatMinutes(rm);
        if (Number.isFinite(mp)) setMaxPending(mp);
      } catch { /* defaults */ }
      finally { if (!stop) setConfigLoaded(true); }
    })();
    return () => { stop = true; };
  }, [isReady, stationId]);

  // ── Clock → its DISTINCT music categories. This is the whole eligibility rule. ───────────────────
  useEffect(() => {
    if (!isReady || stationId == null || clockId == null) { setCategoryIds([]); setCategoryNames([]); return; }
    let stop = false;
    (async () => {
      try {
        const nameRows = await queryScoped<{ name: string }>(
          "SELECT name FROM clocks WHERE id = ? AND deleted_at IS NULL LIMIT 1", [clockId], stationId);
        const slots = await queryScoped<{ category_id: number }>(
          `SELECT DISTINCT category_id FROM clock_slots
            WHERE clock_id = ? AND category_id IS NOT NULL AND deleted_at IS NULL`, [clockId], stationId);
        if (stop) return;
        setClockName(nameRows[0]?.name ?? null);
        const ids = slots.map(s => s.category_id).filter(n => Number.isFinite(n));
        setCategoryIds(ids);
        if (ids.length) {
          const cats = await queryScoped<{ name: string }>(
            `SELECT name FROM categories WHERE id IN (${ids.map(() => "?").join(",")}) AND deleted_at IS NULL ORDER BY name`,
            ids, stationId);
          if (!stop) setCategoryNames(cats.map(c => c.name));
        } else setCategoryNames([]);
      } catch { if (!stop) { setCategoryIds([]); setCategoryNames([]); } }
    })();
    return () => { stop = true; };
  }, [isReady, stationId, clockId]);

  // ── LIVE search. Filters in SQL, paged — never loads the whole set into an array. Debounced by one
  //    frame-ish tick so a fast typist doesn't queue a query per keystroke, while still feeling instant.
  const runQuery = useCallback(async (term: string, pageIdx: number, append: boolean) => {
    if (stationId == null || !categoryIds.length) { setSongs([]); setTotal(0); return; }
    setLoading(true);
    try {
      const inList = categoryIds.map(() => "?").join(",");
      const like = `%${term.trim()}%`;
      const hasTerm = term.trim().length > 0;
      const where =
        `s.deleted_at IS NULL AND s.file_path IS NOT NULL AND TRIM(s.file_path) <> ''
         AND (s.content_class IS NULL OR s.content_class = 'MUSIC')
         AND s.category_id IN (${inList})` +
        (hasTerm ? ` AND (s.title LIKE ? OR a.name LIKE ?)` : "");
      const params = hasTerm ? [...categoryIds, like, like] : [...categoryIds];

      const countRows = await queryScoped<{ c: number }>(
        `SELECT COUNT(*) c FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE ${where}`,
        params, stationId);
      const rows = await queryScoped<JukeSong>(
        `SELECT s.id, s.title, a.name AS artist, s.file_path, s.duration_ms
           FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
          WHERE ${where}
          ORDER BY s.title
          LIMIT ? OFFSET ?`,
        [...params, PAGE_SIZE, pageIdx * PAGE_SIZE], stationId);
      setTotal(countRows[0]?.c ?? 0);
      setSongs(prev => (append ? [...prev, ...rows] : rows));
    } catch { if (!append) { setSongs([]); setTotal(0); } }
    finally { setLoading(false); }
  }, [stationId, categoryIds]);

  useEffect(() => {
    setPage(0);
    const t = setTimeout(() => { void runQuery(search, 0, false); }, 90);
    return () => clearTimeout(t);
  }, [search, runQuery]);

  // ── Up-next: the DAEMON's queue, never a local optimistic list. ─────────────────────────────────
  useEffect(() => {
    const pull = () => { try { setQueue(engine.getQueue() || []); } catch { setQueue([]); } };
    pull();
    const onChange = () => pull();
    window.addEventListener("ether:queue-changed", onChange);
    const tick = setInterval(pull, 2000);
    return () => { window.removeEventListener("ether:queue-changed", onChange); clearInterval(tick); };
  }, [engine]);

  const pendingMine = useMemo(
    () => queue.filter(q => myPicks.current.has(q.filePath)).length, [queue]);

  // ── The pick path ───────────────────────────────────────────────────────────────────────────────
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3600); };

  /** Wait for the daemon's next queue emit so the qid we need actually exists. Resolves either way —
   *  a timeout falls through to the lookup, which simply won't find it and we say so. */
  const waitForQueue = (ms = 2000) => new Promise<void>(resolve => {
    let done = false;
    const fin = () => { if (done) return; done = true; window.removeEventListener("ether:queue-changed", fin); resolve(); };
    window.addEventListener("ether:queue-changed", fin);
    setTimeout(fin, ms);
  });

  const pick = async (song: JukeSong) => {
    if (busy) return;
    setBusy(true);
    try {
      // Queue-depth cap (§7a.3) — told, not silently refused.
      if (pendingMine >= maxPending) {
        say(`The queue is full right now — ${maxPending} songs are already waiting. Try again shortly.`);
        return;
      }
      // Repeat protection (§7a.2) — already waiting, or played too recently.
      if (queue.some(q => q.filePath === song.file_path)) {
        say(`"${song.title}" is already coming up.`);
        return;
      }
      try {
        const since = Math.floor(Date.now() / 1000) - repeatMinutes * 60;
        const recent = await queryScoped<{ c: number }>(
          `SELECT COUNT(*) c FROM play_log
            WHERE file_path = ? AND played_at >= ? AND deleted_at IS NULL`,
          [song.file_path, since], stationId!);
        if ((recent[0]?.c ?? 0) > 0) {
          say(`"${song.title}" played in the last ${repeatMinutes} minutes — pick another for now.`);
          return;
        }
      } catch { /* play_log unreadable → don't block the pick on a diagnostic */ }

      // Payment layer. Phase 1 approves instantly; the shape is what lets Clover/QR slot in.
      const auth = await provider.authorize({ songId: song.id, title: song.title, artist: song.artist || "" });
      if (!auth.ok) { say(auth.declineReason || "Payment was not completed."); return; }

      // PLAY NEXT = the two existing intents. The playing song is never touched.
      await engine.queueEnqueue([{
        filePath: song.file_path,
        title: song.title,
        artist: song.artist || "",
        durationMs: song.duration_ms ?? undefined,
      }]);
      myPicks.current.add(song.file_path);
      await waitForQueue();

      const q = engine.getQueue() || [];
      const mine = [...q].reverse().find((it: any) => it.filePath === song.file_path);
      if (mine?.qid) {
        await engine.queueMove(mine.qid, "top");
        say(`"${song.title}" is up next.`);
      } else {
        // Honest: it went in, we could not confirm the move. Never claim "up next" without the receipt.
        say(`"${song.title}" was added to the queue.`);
      }
      setQueue(engine.getQueue() || []);
    } catch {
      say("That didn't go through. Please ask a member of staff.");
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  // ── Staff exit chord (§7a.5): Ctrl+Shift+J. The corner button is the other way out. ─────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "J" || e.key === "j")) { e.preventDefault(); onExit(); }
      if (e.key === "Escape" && confirming) setConfirming(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onExit, confirming]);

  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { searchRef.current?.focus(); }, []);

  // ── Render ──────────────────────────────────────────────────────────────────────────────────────
  const notConfigured = configLoaded && (clockId == null || categoryIds.length === 0);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9000,
      background: "#07070b", color: "#f2f2f7",
      display: "flex", flexDirection: "column",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      {/* ── Header: search is the primary control, nothing competes with it ── */}
      <div style={{ flexShrink: 0, padding: "20px 28px 14px", display: "flex", alignItems: "center", gap: 18, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <div style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 30, fontWeight: 800, letterSpacing: "-0.03em", flexShrink: 0 }}>
          Pick a song
        </div>
        <input
          ref={searchRef}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by song or artist…"
          style={{
            flex: 1, minWidth: 0, height: 60, padding: "0 22px",
            fontSize: 21, fontWeight: 600,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.14)",
            color: "#fff", outline: "none", borderRadius: 8,
          }}
        />
        {/* ✕, not ⚙. This control EXITS — the PIN-gated settings overlay is Slice 2 and does not
            exist yet, so a gear here promised settings and delivered an exit. A glyph that lies about
            what a control does is a defect, not a placeholder. */}
        <button onClick={onExit} title="Staff — exit jukebox (Ctrl+Shift+J)"
          style={{
            flexShrink: 0, width: 46, height: 46, borderRadius: 8, cursor: "pointer",
            background: "transparent", border: "1px solid rgba(255,255,255,0.14)",
            color: "rgba(255,255,255,0.35)", fontSize: 18, lineHeight: 1,
          }}>✕</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* ── Browse grid ── */}
        <div style={{
          flex: 1, minWidth: 0, overflowY: "auto", padding: "22px 28px 40px",
          scrollBehavior: "smooth", WebkitOverflowScrolling: "touch" as any,
        }}>
          {notConfigured ? (
            <div style={{ maxWidth: 560, margin: "14vh auto 0", textAlign: "center", color: "rgba(255,255,255,0.6)" }}>
              <div style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 28, color: "#fff", marginBottom: 12 }}>
                The jukebox isn't set up yet
              </div>
              <div style={{ fontSize: 16, lineHeight: 1.6 }}>
                A member of staff needs to choose which clock the jukebox plays from,
                using the settings button in the top corner.
              </div>
            </div>
          ) : songs.length === 0 && !loading ? (
            <div style={{ maxWidth: 560, margin: "14vh auto 0", textAlign: "center", color: "rgba(255,255,255,0.6)" }}>
              <div style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 26, color: "#fff", marginBottom: 10 }}>
                {search.trim() ? "Nothing matched that" : "No songs available"}
              </div>
              <div style={{ fontSize: 16 }}>
                {search.trim() ? "Try a different song or artist." : "Ask a member of staff."}
              </div>
            </div>
          ) : (
            <>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
                gap: 18,
              }}>
                {songs.map(s => (
                  <button key={s.id} onClick={() => setConfirming(s)}
                    style={{
                      display: "block", textAlign: "left", padding: 0, cursor: "pointer",
                      background: "transparent", border: "none", color: "inherit",
                    }}>
                    <div style={{
                      width: "100%", aspectRatio: "1", borderRadius: 10, overflow: "hidden",
                      background: tintFor(s.title + (s.artist || "")),
                      border: "1px solid rgba(255,255,255,0.10)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      padding: 16, boxSizing: "border-box",
                    }}>
                      <span style={{
                        fontFamily: "'Newsreader', Georgia, serif", fontSize: 22, lineHeight: 1.2,
                        fontWeight: 700, color: "rgba(255,255,255,0.92)", textAlign: "center",
                        display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical",
                        overflow: "hidden", wordBreak: "break-word",
                      }}>{s.title}</span>
                    </div>
                    <div style={{ marginTop: 10, fontSize: 15, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.artist || "Unknown artist"}{s.duration_ms ? ` · ${fmtDur(s.duration_ms)}` : ""}
                    </div>
                  </button>
                ))}
              </div>

              {songs.length < total && (
                <div style={{ textAlign: "center", marginTop: 30 }}>
                  <button
                    onClick={() => { const n = page + 1; setPage(n); void runQuery(search, n, true); }}
                    disabled={loading}
                    style={{
                      height: 56, padding: "0 34px", fontSize: 17, fontWeight: 800, cursor: "pointer",
                      background: "rgba(255,255,255,0.07)", color: "#fff",
                      border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8,
                    }}>
                    {loading ? "Loading…" : `Show more (${songs.length} of ${total})`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Up next — the daemon's queue ── */}
        <div style={{
          width: 300, flexShrink: 0, borderLeft: "1px solid rgba(255,255,255,0.08)",
          display: "flex", flexDirection: "column", background: "rgba(255,255,255,0.02)",
        }}>
          <div style={{ padding: "18px 20px 10px", fontSize: 12, fontWeight: 800, letterSpacing: "0.16em", color: "rgba(255,255,255,0.45)" }}>
            UP NEXT
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 20px 20px" }}>
            {queue.length === 0 ? (
              <div style={{ fontSize: 14, color: "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>
                Nothing waiting yet. Your song will show up here.
              </div>
            ) : queue.slice(0, 24).map((q: any, i: number) => (
              <div key={q.qid || `${q.filePath}-${i}`} style={{
                padding: "11px 0", borderBottom: "1px solid rgba(255,255,255,0.06)",
                display: "flex", gap: 12, alignItems: "baseline",
              }}>
                <span style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: "rgba(255,255,255,0.3)", width: 18, flexShrink: 0 }}>{i + 1}</span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 700, color: myPicks.current.has(q.filePath) ? "var(--accent-cyan, #22d3ee)" : "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.title}</span>
                  <span style={{ display: "block", fontSize: 12, color: "rgba(255,255,255,0.45)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.artist || ""}</span>
                </span>
              </div>
            ))}
          </div>
          {clockName && (
            <div style={{ padding: "10px 20px 16px", fontSize: 11, color: "rgba(255,255,255,0.28)", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              {total} songs · {clockName}
              {categoryNames.length ? ` · ${categoryNames.join(", ")}` : ""}
            </div>
          )}
        </div>
      </div>

      {/* ── Confirm card — large, not a small dialog ── */}
      {confirming && (
        <div
          onClick={() => !busy && setConfirming(null)}
          style={{ position: "fixed", inset: 0, zIndex: 9100, background: "rgba(0,0,0,0.78)", display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
          <div onClick={e => e.stopPropagation()}
            style={{
              width: "min(560px, 100%)", background: "#101018", borderRadius: 16,
              border: "1px solid rgba(255,255,255,0.12)", padding: 34, textAlign: "center",
              boxShadow: "0 30px 90px rgba(0,0,0,0.6)",
            }}>
            <div style={{
              width: 260, height: 260, margin: "0 auto 24px", borderRadius: 12,
              background: tintFor(confirming.title + (confirming.artist || "")),
              border: "1px solid rgba(255,255,255,0.10)",
              display: "flex", alignItems: "center", justifyContent: "center", padding: 22, boxSizing: "border-box",
            }}>
              <span style={{
                fontFamily: "'Newsreader', Georgia, serif", fontSize: 27, lineHeight: 1.2, fontWeight: 700,
                color: "rgba(255,255,255,0.92)", display: "-webkit-box", WebkitLineClamp: 5,
                WebkitBoxOrient: "vertical", overflow: "hidden", wordBreak: "break-word",
              }}>{confirming.title}</span>
            </div>
            <div style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 30, fontWeight: 800, lineHeight: 1.15, marginBottom: 6 }}>{confirming.title}</div>
            <div style={{ fontSize: 17, color: "rgba(255,255,255,0.55)", marginBottom: 28 }}>
              {confirming.artist || "Unknown artist"}{confirming.duration_ms ? ` · ${fmtDur(confirming.duration_ms)}` : ""}
            </div>
            <button onClick={() => void pick(confirming)} disabled={busy}
              style={{
                width: "100%", height: 78, fontSize: 22, fontWeight: 900, letterSpacing: "0.06em",
                cursor: busy ? "default" : "pointer", borderRadius: 10, border: "none",
                background: busy ? "rgba(255,255,255,0.14)" : "var(--accent-blue, #6040C0)", color: "#fff",
              }}>
              {busy ? "…" : provider.label}
            </button>
            <button onClick={() => setConfirming(null)} disabled={busy}
              style={{
                marginTop: 14, height: 52, width: "100%", fontSize: 15, fontWeight: 700, cursor: "pointer",
                background: "transparent", color: "rgba(255,255,255,0.5)",
                border: "1px solid rgba(255,255,255,0.14)", borderRadius: 10,
              }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 34, left: "50%", transform: "translateX(-50%)", zIndex: 9200,
          background: "rgba(20,20,28,0.97)", border: "1px solid rgba(255,255,255,0.16)",
          borderRadius: 10, padding: "18px 30px", fontSize: 17, fontWeight: 700,
          maxWidth: "80vw", textAlign: "center", boxShadow: "0 18px 50px rgba(0,0,0,0.5)",
        }}>{toast}</div>
      )}
    </div>
  );
}

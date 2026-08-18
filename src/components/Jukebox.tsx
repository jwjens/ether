// Jukebox — the public request kiosk. TouchTunes-style wall of artwork, named request queue, QR.
//
// Design of record: docs/jukebox-rebuild-design-2026-08-17.md, which supersedes parts of
// docs/jukebox-mode-design-2026-08-04.md. Read §0 of the rebuild doc before changing anything here —
// it records which of the 08-04 decisions Jeff reversed and what each reversal costs.
//
// WHAT THIS IS NOW (the rebuild):
//   • a POP-OUT kiosk window (#popout/jukebox), opened from the hamburger → Windows. It is no longer
//     a bottom-tab fullscreen takeover of the main renderer.
//   • its pool is the CATEGORIES an operator checked in Preferences → Jukebox — NOT a clock. The
//     clock-as-playlist setup from 08-04 §2.4 is dead; jukebox_source_clock_id is ignored.
//   • every request carries the REQUESTER'S NAME, kept in the local-only jukebox_requests table
//     (migration v38) because the daemon's queue has no field for it.
//
// STATION IDENTITY — the reason this file is careful:
//   08-04 §2.1 refused to make this a second window precisely because a popout has to redo the
//   station handshake, and cited the popout `?? 1` fallback as a bug this codebase already paid for
//   twice. PopoutRenderer.tsx:72,81 still carry that fallback. This component does NOT: with no
//   resolved active station it renders an honest "no station" panel and picks nothing. A kiosk that
//   guesses station 1 would show a stranger a different station's library and queue onto air nobody
//   asked for.
//
// WHAT PLAYS, AND WHO DECIDES — the deck-source model (Jeff, 2026-08-17;
// docs/jukebox-deck-source-design-2026-08-17.md):
//   The jukebox is an AUDIO SOURCE patched into a deck, like a microphone — not a station mode. The
//   operator picks "Jukebox" as the source of deck D/E/F on the dashboard, and the fader decides
//   whether it is on air. THE BOARD IS THE TRUTH.
//
//   • Requests are NEVER enqueued onto the station's queue. The old play-next-into-rotation path was
//     removed with this ruling: a request in the station queue would air through the station's decks,
//     outside the jukebox fader, on the operator's rotation.
//   • This window drives its own deck: strict FIFO, oldest request first, and it NEVER cuts a playing
//     song. No priority and no paid-skip — that is a future design with donations.
//   • Its AUTO is its own. Engaged, it shuffles the checked categories when no request is waiting;
//     disengaged, it plays only requests and is silent otherwise. Station AUTO/MANUAL is untouched:
//     station automation enumerates ["A","B","C"] and never looks at D/E/F.
//   • It is an EVENT TOOL, not playout — no traffic, no spots, ever.

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
import { getLocalArt } from "../lib/albumArt";

// ── Payment layer (08-04 §4) — kept as the seam, still free ────────────────────────────────────────
// The pick path calls authorize() and enqueues ONLY on ok:true, so a donation/card step drops in here
// without touching the call site. Phase 1 is free; jukebox_requests.donation_cents exists and is
// written by nothing. No payments code.
export interface JukeboxPaymentProvider {
  readonly id: "free" | "clover" | "qr";
  readonly label: string;
  authorize(sel: { songId: number; title: string; artist: string }):
    Promise<{ ok: boolean; reference?: string; declineReason?: string }>;
}

const FreeProvider: JukeboxPaymentProvider = {
  id: "free",
  label: "PLAY NEXT",
  async authorize() { return { ok: true }; },
};

const DEFAULT_REPEAT_MINUTES = 60;
const DEFAULT_MAX_PENDING = 12;
const PAGE_SIZE = 60;
const NAME_MAX = 40;

interface JukeSong {
  id: number;
  title: string;
  artist: string | null;
  file_path: string;
  duration_ms: number | null;
}

interface JukeRequest {
  id: number;
  requester_name: string;
  title: string;
  artist: string | null;
  file_path: string;
  qid: string | null;
  status: string;
  source: string;
  created_at: number;
}

/** Deterministic tint from the title so a tile whose art hasn't resolved still reads as a distinct
 *  cover rather than one of 200 identical grey squares. Never an empty square (08-04 §3). */
function tintFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h} 45% 20%)`;
}

// ── One tile. Art resolves lazily, once, per visible tile. ─────────────────────────────────────────
function Tile({ song, onPick }: { song: JukeSong; onPick: (s: JukeSong) => void }) {
  const [art, setArt] = useState<string | null>(null);
  const ref = useRef<HTMLButtonElement | null>(null);
  const asked = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only resolve art for tiles that actually come into view, and only ONCE per tile.
    //
    // getLocalArt, NOT resolveArtwork: resolveArtwork falls back to fetchMusicStoreArt, which is an
    // iTunes lookup per (title, artist). Across a wall of thousands of songs that is a network
    // request storm, and 08-04 §3 ruled it out explicitly ("firing a music-store lookup per tile
    // across hundreds of songs would be both slow and exactly the guessing the spot fix removed").
    // getLocalArt reads the embedded cover out of the file itself, is per-file cached, and never
    // touches the network — so scrolling back is free.
    const io = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting) || asked.current) return;
      asked.current = true;
      getLocalArt(song.file_path)
        .then(src => { if (src) setArt(src); })
        .catch(() => { /* neutral tile stands */ });
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [song.file_path, song.title, song.artist]);

  return (
    <button
      ref={ref}
      onClick={() => onPick(song)}
      style={{
        position: "relative", aspectRatio: "1 / 1", width: "100%",
        border: "none", borderRadius: 10, cursor: "pointer", padding: 0, overflow: "hidden",
        background: art ? `#000 center/cover no-repeat url("${art}")` : tintFor(song.title),
        boxShadow: "0 8px 24px rgba(0,0,0,0.55)",
        transition: "transform 0.12s ease, box-shadow 0.12s ease",
        outline: "1px solid rgba(255,255,255,0.06)",
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1.035)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
    >
      {/* Title/artist always legible over art — a gradient scrim, not a flat bar. */}
      <div style={{
        position: "absolute", left: 0, right: 0, bottom: 0, padding: "34px 12px 11px",
        textAlign: "left",
        background: "linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.72) 45%, transparent 100%)",
      }}>
        <div style={{
          fontSize: art ? 15 : 19, fontWeight: 800, color: "#fff", lineHeight: 1.15,
          overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box",
          WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const,
        }}>{song.title}</div>
        <div style={{
          fontSize: 12.5, fontWeight: 600, color: "rgba(255,255,255,0.72)", marginTop: 3,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{song.artist || "—"}</div>
      </div>
    </button>
  );
}

export default function Jukebox({ onExit }: { onExit?: () => void }) {
  const { stationId, isReady } = useActiveStation();

  // NO renderer-side engine handle here, deliberately. AudioEngineContext defaults to 1
  // (AudioEngineContext.tsx:6) and a pop-out has no AudioEngineProvider above it, so useAudioEngine()
  // would silently bind this kiosk to STATION 1 — the `?? 1` popout bug wearing a convenience hook.
  // Playback goes through the jukebox IPC, which resolves the station explicitly and refuses D/E/F
  // violations in the main process.

  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [categoryNames, setCategoryNames] = useState<string[]>([]);
  const [requestUrl, setRequestUrl] = useState<string>("");
  const [configLoaded, setConfigLoaded] = useState(false);

  const [repeatMinutes, setRepeatMinutes] = useState(DEFAULT_REPEAT_MINUTES);
  const [maxPending, setMaxPending] = useState(DEFAULT_MAX_PENDING);

  const [search, setSearch] = useState("");
  const [songs, setSongs] = useState<JukeSong[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);

  const [confirming, setConfirming] = useState<JukeSong | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [requests, setRequests] = useState<JukeRequest[]>([]);
  const [tableMissing, setTableMissing] = useState(false);
  /** Set when the pool query itself FAILED. Distinct from "the pool is empty" — never conflate them. */
  const [poolError, setPoolError] = useState<string | null>(null);

  // ── Deck source state ───────────────────────────────────────────────────────────────────────────
  // The jukebox airs through a real deck (D/E/F) the operator patched it into, and the DECK is the
  // truth about whether anything is reaching air. None of this is inferred from intent.
  const [routedDeck, setRoutedDeck] = useState<string | null>(null);
  const [deckStatus, setDeckStatus] = useState<string | null>(null);
  const [deckVolume, setDeckVolume] = useState<number | null>(null);
  const [autoOn, setAutoOn] = useState(false);
  const starting = useRef(false);          // one start in flight at a time — never two loads racing

  const deckIsBusy = deckStatus === "playing";

  const provider: JukeboxPaymentProvider = FreeProvider;

  // ── Config: the CHECKED CATEGORIES (not a clock), the request URL, the tunables ─────────────────
  //
  // POLLED, not read once (2026-08-18). The deps used to be [isReady, stationId], so an operator could
  // tick categories in Settings and the open kiosk would keep showing the old pool until the window was
  // reopened — a stale-until-reopen bug on a screen that faces the public. The re-read only touches
  // state when the stored value actually CHANGES, so a steady state costs one KV list every few seconds
  // and causes no re-render.
  useEffect(() => {
    if (!isReady || stationId == null) return;
    let stop = false;
    const load = async () => {
      try {
        const r: any = await (window as any).ether.stationConfigKv.list(stationId);
        const rows: any[] = (r && r.rows) || [];
        const get = (k: string) => rows.find(x => x.key === k)?.value;

        let ids: number[] = [];
        try {
          const raw = get("jukebox_categories");
          const parsed = raw ? JSON.parse(raw) : [];
          if (Array.isArray(parsed)) ids = parsed.map((n: any) => parseInt(n, 10)).filter(Number.isFinite);
        } catch { ids = []; }

        const rm = parseInt(get("jukebox_repeat_minutes") ?? "", 10);
        const mp = parseInt(get("jukebox_max_pending") ?? "", 10);
        if (stop) return;
        // Identity-stable update: same ids in the same order -> keep the existing array so the
        // dependent query effects do not re-run every 4 seconds.
        setCategoryIds(prev => (prev.length === ids.length && prev.every((v, i) => v === ids[i]) ? prev : ids));
        setRequestUrl(String(get("jukebox_request_url") ?? "").trim());
        if (Number.isFinite(rm)) setRepeatMinutes(rm);
        if (Number.isFinite(mp)) setMaxPending(mp);
      } catch { if (!stop) setCategoryIds([]); }
      finally { if (!stop) setConfigLoaded(true); }
    };
    void load();
    const tick = setInterval(() => { void load(); }, 4000);
    return () => { stop = true; clearInterval(tick); };
  }, [isReady, stationId]);

  // Resolved category NAMES — so staff can see at a glance that the pool is what they checked.
  useEffect(() => {
    if (stationId == null || !categoryIds.length) { setCategoryNames([]); return; }
    let stop = false;
    (async () => {
      try {
        const rows = await queryScoped<{ name: string }>(
          `SELECT name FROM categories
            WHERE id IN (${categoryIds.map(() => "?").join(",")}) AND deleted_at IS NULL
            ORDER BY name`, categoryIds, stationId);
        if (!stop) setCategoryNames(rows.map(r => r.name));
      } catch { if (!stop) setCategoryNames([]); }
    })();
    return () => { stop = true; };
  }, [stationId, categoryIds]);

  // ── LIVE search over the pool. Filters in SQL, paged — never loads the whole set into an array. ──
  const runQuery = useCallback(async (term: string, pageIdx: number, append: boolean) => {
    if (stationId == null || !categoryIds.length) { setSongs([]); setTotal(0); return; }
    setLoading(true);
    setPoolError(null);
    try {
      const inList = categoryIds.map(() => "?").join(",");
      const like = `%${term.trim()}%`;
      const hasTerm = term.trim().length > 0;
      // file_path present is not optional here: a public pick that resolves to a missing file is
      // dead air in front of an audience (08-04 §2.5.1).
      const where =
        `s.deleted_at IS NULL AND s.file_path IS NOT NULL AND TRIM(s.file_path) <> ''
         AND (s.content_class IS NULL OR s.content_class = 'MUSIC')
         AND s.category_id IN (${inList})` +
        (hasTerm ? ` AND (s.title LIKE ? OR a.name LIKE ?)` : "");
      const params = hasTerm ? [...categoryIds, like, like] : [...categoryIds];

      // skipScoping IS THE FIX (2026-08-18). queryScoped injects `station_id = ?` unless the SQL
      // already mentions it (db/stationScoped.ts) — but `songs` HAS NO station_id column: the library
      // is account-scoped, not per-station. With the LEFT JOIN present the injected predicate does not
      // even error; it silently binds to artists.station_id, turns the outer join inner, and returns
      // ZERO rows. That is why Settings showed "156 songs across 6 categories" while this wall showed
      // "0 songs" from the same ticks. Proven on the live db: same SQL unscoped = 156, scoped = 0, and
      // without the join the injection throws "no such column: station_id".
      // The pool is filtered by category, and the categories are already this station's.
      const countRows = await queryScoped<{ c: number }>(
        `SELECT COUNT(*) c FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE ${where}`,
        params, stationId, { skipScoping: true });
      const rows = await queryScoped<JukeSong>(
        `SELECT s.id, s.title, a.name AS artist, s.file_path, s.duration_ms
           FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
          WHERE ${where}
          ORDER BY s.title
          LIMIT ? OFFSET ?`,
        [...params, PAGE_SIZE, pageIdx * PAGE_SIZE], stationId, { skipScoping: true });
      setTotal(countRows[0]?.c ?? 0);
      setSongs(prev => (append ? [...prev, ...rows] : rows));
    } catch (e: any) {
      // A failed query must never read as an empty pool. That is exactly how this bug hid: the wall
      // said "No songs available to pick" — a sentence about the library — when the truth was that the
      // query never ran. Say which it is.
      console.error("[jukebox] pool query failed:", e?.message || e);
      if (!append) { setSongs([]); setTotal(0); }
      setPoolError(e?.message || String(e));
    }
    finally { setLoading(false); }
  }, [stationId, categoryIds]);

  useEffect(() => {
    setPage(0);
    const t = setTimeout(() => { void runQuery(search, 0, false); }, 90);
    return () => clearTimeout(t);
  }, [search, runQuery]);

  /** One random playable song from the checked categories — the AUTO filler.
   *  Chosen in SQL (ORDER BY RANDOM() LIMIT 1) rather than by loading the pool into memory: the pool
   *  can be thousands of rows and this runs at every song boundary. */
  const pickShuffleSong = useCallback(async (): Promise<JukeSong | null> => {
    if (stationId == null || !categoryIds.length) return null;
    try {
      const rows = await queryScoped<JukeSong>(
        `SELECT s.id, s.title, a.name AS artist, s.file_path, s.duration_ms
           FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
          WHERE s.deleted_at IS NULL AND s.file_path IS NOT NULL AND TRIM(s.file_path) <> ''
            AND (s.content_class IS NULL OR s.content_class = 'MUSIC')
            AND s.category_id IN (${categoryIds.map(() => "?").join(",")})
          ORDER BY RANDOM() LIMIT 1`, categoryIds, stationId, { skipScoping: true });   // see runQuery
      return rows[0] ?? null;
    } catch { return null; }
  }, [stationId, categoryIds]);

  // ── Which deck is the jukebox patched into? ─────────────────────────────────────────────────────
  // Read from deck_configs, the same table the dashboard's deck source dropdown writes. Not a
  // jukebox-private setting: the operator patches the source on the board, and this follows.
  useEffect(() => {
    if (stationId == null) return;
    let stop = false;
    const pull = async () => {
      try {
        const rows = await queryScoped<{ slot: string }>(
          "SELECT slot FROM deck_configs WHERE type = 'jukebox' AND enabled = 1 ORDER BY slot LIMIT 1",
          [], stationId);
        if (!stop) setRoutedDeck(rows[0]?.slot ?? null);
      } catch { if (!stop) setRoutedDeck(null); }
    };
    void pull();
    const tick = setInterval(pull, 5000);   // the operator can re-patch while the kiosk is open
    return () => { stop = true; clearInterval(tick); };
  }, [stationId]);

  // ── What the deck is ACTUALLY doing — status and fader, straight off the engine. ────────────────
  useEffect(() => {
    if (stationId == null || !routedDeck) { setDeckStatus(null); setDeckVolume(null); return; }
    let stop = false;
    const pull = async () => {
      try {
        const r: any = await (window as any).ether.jukebox?.deckState({ stationId, deck: routedDeck });
        if (stop) return;
        if (r?.ok) { setDeckStatus(r.status ?? null); setDeckVolume(typeof r.volume === "number" ? r.volume : null); }
        else { setDeckStatus(null); setDeckVolume(null); }
      } catch { if (!stop) { setDeckStatus(null); setDeckVolume(null); } }
    };
    void pull();
    const tick = setInterval(pull, 1000);
    return () => { stop = true; clearInterval(tick); };
  }, [stationId, routedDeck]);

  // ── THE DRIVE — strict FIFO, and it never cuts a playing song. ──────────────────────────────────
  //
  // Runs only when the deck is free. Requests first, oldest first (no priority, no paid-skip — that
  // is a future design with donations). With no requests it shuffles the checked categories ONLY if
  // the jukebox's own AUTO is engaged; otherwise it stays silent, deliberately, and says so.
  //
  // This AUTO is the jukebox's alone. It has nothing to do with the station's AUTO/MANUAL: the deck
  // it drives is D/E/F, which station automation never enumerates.
  useEffect(() => {
    if (stationId == null || !routedDeck) return;
    if (deckStatus === null) return;              // no reading yet — never act on an unknown deck
    if (deckIsBusy || starting.current) return;   // a playing song is NEVER cut

    let cancelled = false;
    (async () => {
      starting.current = true;
      try {
        const next = requests.find(r => r.status === "queued" || r.status === "pending");
        let toPlay: { filePath: string; title: string; artist: string | null; durationMs: number | null } | null = null;
        let reqId: number | null = null;

        if (next) {
          toPlay = { filePath: next.file_path, title: next.title, artist: next.artist, durationMs: null };
          reqId = next.id;
        } else if (autoOn) {
          const pick = await pickShuffleSong();
          if (pick) toPlay = { filePath: pick.file_path, title: pick.title, artist: pick.artist, durationMs: pick.duration_ms };
        }
        if (!toPlay || cancelled) return;

        const r: any = await (window as any).ether.jukebox?.play({
          stationId, deck: routedDeck, filePath: toPlay.filePath, title: toPlay.title,
          artist: toPlay.artist || "", durationMs: toPlay.durationMs, contentClass: "MUSIC",
        });
        if (r?.ok) {
          if (reqId != null) await (window as any).ether.jukebox?.closeRequest(reqId, "played");
          setDeckStatus("playing");   // optimistic ONLY until the next 1s poll corrects it
          await loadRequests();
        } else if (reqId != null) {
          // The engine refused it (missing file, bad deck). Close it rather than retrying forever in
          // front of an audience, and say so instead of silently dropping a stranger's request.
          await (window as any).ether.jukebox?.closeRequest(reqId, "cancelled");
          await loadRequests();
          say(`Couldn't play "${toPlay.title}" — skipping to the next request.`);
        }
      } finally {
        starting.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, [stationId, routedDeck, deckStatus, deckIsBusy, requests, autoOn]);

  // ── The request rail — names + placement, from the local-only jukebox_requests table. ───────────
  const loadRequests = useCallback(async () => {
    if (stationId == null) return;
    try {
      const r: any = await (window as any).ether.jukebox?.listRequests(stationId);
      setTableMissing(!!r?.tableMissing);
      setRequests((r?.rows as JukeRequest[]) || []);
    } catch { setRequests([]); }
  }, [stationId]);

  useEffect(() => {
    void loadRequests();
    const tick = setInterval(() => { void loadRequests(); }, 3000);
    return () => clearInterval(tick);
  }, [loadRequests]);

  const pendingCount = requests.filter(r => r.status === "queued" || r.status === "pending").length;

  // ── The pick path ───────────────────────────────────────────────────────────────────────────────
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 4200); };

  const submit = async () => {
    const song = confirming;
    const who = nameInput.trim().slice(0, NAME_MAX);
    if (!song || busy) return;
    if (stationId == null) { say("No station is active — nothing can be queued."); return; }
    if (!who) { say("Please enter your name first."); return; }
    setBusy(true);
    try {
      if (pendingCount >= maxPending) {
        say(`The queue is full right now — ${maxPending} songs are already waiting. Try again shortly.`);
        return;
      }
      if (requests.some(r => r.file_path === song.file_path && r.status === "queued")) {
        say(`"${song.title}" is already on the list.`);
        return;
      }

      const auth = await provider.authorize({ songId: song.id, title: song.title, artist: song.artist || "" });
      if (!auth.ok) { say(auth.declineReason || "That didn't go through."); return; }

      // A request is a row in the jukebox's OWN queue. It is never enqueued onto the station's queue:
      // the jukebox is a source patched into a deck, and a request that entered the station queue
      // would air through the station's decks, outside the jukebox fader, on the operator's rotation.
      // (The old play-next-into-rotation path was removed with the deck-source ruling, 2026-08-17.)
      const created: any = await (window as any).ether.jukebox?.createRequest({
        stationId, requesterName: who, songId: song.id, filePath: song.file_path,
        title: song.title, artist: song.artist, source: "kiosk",
      });
      if (!created?.ok) { say(created?.error || "Couldn't record that request."); return; }

      await loadRequests();
      setConfirming(null);
      setNameInput("");
      // STRICT FIFO, and never cut a playing song (Jeff, 2026-08-17): a request takes its place at the
      // back of the queue and plays when the deck is free. No priority, no paid-skip — that is a
      // future design with donations, deliberately not built.
      say(deckIsBusy
        ? `Thanks ${who} — "${song.title}" is in the queue.`
        : `Thanks ${who} — "${song.title}" is up next.`);
    } catch (e: any) {
      say(e?.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  // ── Honest states before the room ───────────────────────────────────────────────────────────────
  const shell = (body: React.ReactNode) => (
    <div style={{
      position: "fixed", inset: 0, background: "#07070b", color: "#e8e8f0",
      fontFamily: "'Inter', system-ui, sans-serif", display: "flex",
      alignItems: "center", justifyContent: "center", padding: 48, textAlign: "center",
    }}>{body}</div>
  );

  if (!isReady) return shell(<div style={{ color: "#606078", fontSize: 15 }}>Resolving station…</div>);

  // NO `?? 1`. A kiosk that guesses a station shows strangers the wrong library (rebuild doc §0.1).
  if (stationId == null) return shell(
    <div style={{ maxWidth: 560 }}>
      <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: "-0.02em" }}>No station selected</div>
      <div style={{ marginTop: 14, fontSize: 15, color: "#8a8aa0", lineHeight: 1.6 }}>
        The jukebox plays to one station and none is active on this install yet. Sign in and choose a
        station in the main window, then open this display again.
      </div>
    </div>
  );

  if (configLoaded && !categoryIds.length) return shell(
    <div style={{ maxWidth: 620 }}>
      <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: "-0.02em" }}>The jukebox isn't set up yet</div>
      <div style={{ marginTop: 14, fontSize: 15, color: "#8a8aa0", lineHeight: 1.6 }}>
        Nobody has chosen which music the public can pick from. In the main window open
        <strong style={{ color: "#c8c8e0" }}> Settings → Jukebox</strong> and tick the categories that
        should be available, then reopen this display.
      </div>
    </div>
  );

  const upNextIndex = 1;   // #2 in the rail — see the rebuild doc §1 on placement semantics.

  // ── Routing truth ───────────────────────────────────────────────────────────────────────────────
  // Observed, never inferred. The queue is kept in every case — routing is about audibility, not about
  // whether people can request. The fader is the operator's decision and this only reports it.
  const faderDown = deckVolume != null && deckVolume <= 0.001;
  const onAir = deckIsBusy && !faderDown;
  const routingOk = !!routedDeck && !faderDown;
  const routingNote = !routedDeck
    ? "Not routed to a deck. On the dashboard, set a deck's source to Jukebox (deck D, E or F) — requests are still being collected in the meantime."
    : faderDown
      ? `Routed to Deck ${routedDeck} — the fader is down, so nothing is reaching air. The queue keeps filling.`
      : autoOn
        ? `Routed to Deck ${routedDeck} · AUTO on — music keeps playing from the chosen categories between requests.`
        : `Routed to Deck ${routedDeck} · AUTO off — only requested songs play, and it is silent in between.`;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#07070b", color: "#e8e8f0",
      fontFamily: "'Inter', system-ui, sans-serif", display: "flex", overflow: "hidden",
    }}>
      <style>{`
        @keyframes juke-flash { 0%,100% { opacity: 1; } 50% { opacity: 0.28; } }
        @keyframes juke-rise  { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
        .juke-scroll::-webkit-scrollbar { width: 10px; }
        .juke-scroll::-webkit-scrollbar-thumb { background: #23233a; border-radius: 6px; }
      `}</style>

      {/* ── LEFT: the wall ───────────────────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ padding: "22px 30px 16px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: "-0.02em" }}>Pick a song</div>
            <div style={{ fontSize: 13, color: "#6a6a85", flex: 1 }}>
              {total.toLocaleString()} song{total === 1 ? "" : "s"}
              {categoryNames.length ? ` · ${categoryNames.join(" · ")}` : ""}
            </div>

            {/* ON AIR — driven by the DECK's observed status, never by whether AUTO is engaged.
                AUTO on with the fader down must not blink "on air"; that would be a claimed state. */}
            {onAir && (
              <div style={{
                display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", borderRadius: 999,
                background: "rgba(220,60,60,0.14)", border: "1px solid #dc3c3c",
                animation: "juke-flash 1.2s ease-in-out infinite",
              }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#dc3c3c" }} />
                <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: "0.16em", color: "#ff8080" }}>ON AIR</span>
              </div>
            )}

            {/* The JUKEBOX's own AUTO. Nothing to do with the station's AUTO/MANUAL. */}
            <button
              onClick={() => setAutoOn(v => !v)}
              title={autoOn
                ? "AUTO is on — the jukebox keeps music going from the chosen categories when nobody has requested anything."
                : "AUTO is off — the jukebox plays only what people request, and is silent in between."}
              style={{
                padding: "9px 18px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                fontSize: 12, fontWeight: 900, letterSpacing: "0.14em",
                background: autoOn ? "#6040c0" : "transparent",
                border: `1px solid ${autoOn ? "#8868D8" : "#2a2a44"}`,
                color: autoOn ? "#fff" : "#6a6a85",
              }}>
              AUTO {autoOn ? "ON" : "OFF"}
            </button>
          </div>

          {/* ROUTING — what the operator needs to know, read off the deck itself. */}
          {routingNote && (
            <div style={{
              marginTop: 12, padding: "10px 14px", borderRadius: 10, fontSize: 12.5, lineHeight: 1.5,
              background: routingOk ? "rgba(96,64,192,0.10)" : "rgba(200,120,50,0.12)",
              border: `1px solid ${routingOk ? "#33335a" : "#a06030"}`,
              color: routingOk ? "#8a8aa8" : "#e0a060",
            }}>{routingNote}</div>
          )}
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by song or artist…"
            style={{
              marginTop: 14, width: "100%", padding: "16px 20px", fontSize: 19,
              background: "#101018", border: "1px solid #23233a", borderRadius: 12,
              color: "#e8e8f0", outline: "none", fontFamily: "inherit",
            }}
          />
        </div>

        <div className="juke-scroll" style={{ flex: 1, overflowY: "auto", padding: "4px 30px 30px" }}
             onScroll={e => {
               const el = e.currentTarget;
               if (loading || songs.length >= total) return;
               if (el.scrollTop + el.clientHeight > el.scrollHeight - 500) {
                 const next = page + 1;
                 setPage(next);
                 void runQuery(search, next, true);
               }
             }}>
          {poolError ? (
            /* A FAILED query is not an empty pool. Saying "no songs available" when the query never ran
               is what let the 2026-08-18 scoping bug sit behind a plausible sentence. */
            <div style={{ padding: "50px 20px", textAlign: "center", color: "#e0a060" }}>
              <div style={{ fontSize: 19, fontWeight: 800 }}>The song list couldn't be loaded</div>
              <div style={{ marginTop: 10, fontSize: 13, color: "#8a8aa0", lineHeight: 1.6 }}>
                This is a fault, not an empty library — staff should check the log.
              </div>
              <div style={{ marginTop: 12, fontSize: 11.5, color: "#6a6a85", fontFamily: "monospace" }}>{poolError}</div>
            </div>
          ) : songs.length === 0 && !loading ? (
            <div style={{ color: "#5a5a70", fontSize: 15, padding: "60px 0", textAlign: "center" }}>
              {search ? `Nothing matches "${search}".` : "No songs available to pick."}
            </div>
          ) : (
            <div style={{
              display: "grid", gap: 18,
              gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
            }}>
              {songs.map(s => <Tile key={s.id} song={s} onPick={sel => { setConfirming(sel); setNameInput(""); }} />)}
            </div>
          )}
          {loading && <div style={{ color: "#5a5a70", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>}
        </div>
      </div>

      {/* ── RIGHT RAIL: the named queue + the QR ─────────────────────────────────────────────────── */}
      <div style={{
        width: 400, flexShrink: 0, background: "#0b0b12", borderLeft: "1px solid #1a1a2a",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "24px 22px 14px", flexShrink: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.16em", color: "#6040c0" }}>UP NEXT</div>
          <div style={{ fontSize: 12, color: "#5a5a70", marginTop: 5 }}>
            {pendingCount} request{pendingCount === 1 ? "" : "s"} waiting
          </div>
        </div>

        <div className="juke-scroll" style={{ flex: 1, overflowY: "auto", padding: "0 16px 16px" }}>
          {tableMissing && (
            <div style={{ color: "#c08040", fontSize: 12.5, padding: 12, lineHeight: 1.5 }}>
              The request store hasn't been created on this install yet. Close and reopen Ether to run
              the pending database migration.
            </div>
          )}
          {!tableMissing && requests.length === 0 && (
            <div style={{ color: "#4a4a60", fontSize: 13.5, padding: "26px 8px", lineHeight: 1.6 }}>
              No requests yet. Scan the code below, or pick something from the wall.
            </div>
          )}
          {requests.map((r, i) => {
            const isUpNext = i === upNextIndex;
            return (
              <div key={r.id} style={{
                display: "flex", gap: 13, alignItems: "center",
                padding: isUpNext ? "18px 16px" : "12px 14px",
                marginBottom: 9, borderRadius: 12,
                background: isUpNext ? "rgba(96,64,192,0.16)" : "#101018",
                border: `1px solid ${isUpNext ? "#6040c0" : "#1c1c2c"}`,
                animation: "juke-rise 0.22s ease",
              }}>
                <div style={{
                  flexShrink: 0, width: isUpNext ? 44 : 32, height: isUpNext ? 44 : 32,
                  borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                  background: isUpNext ? "#6040c0" : "#1a1a2a",
                  color: isUpNext ? "#fff" : "#7a7a95",
                  fontSize: isUpNext ? 17 : 13, fontWeight: 900,
                }}>{i + 1}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontSize: isUpNext ? 17 : 14, fontWeight: 800, color: "#fff",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{r.requester_name}</div>
                  <div style={{
                    fontSize: isUpNext ? 14 : 12.5, color: isUpNext ? "#c0b0f0" : "#7a7a95", marginTop: 2,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{r.title}{r.artist ? ` — ${r.artist}` : ""}</div>
                  {isUpNext && (
                    <div style={{
                      marginTop: 7, fontSize: 10.5, fontWeight: 900, letterSpacing: "0.16em",
                      color: "#8868D8", animation: "juke-flash 1.1s ease-in-out infinite",
                    }}>● UP NEXT</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* QR — rendered every time this window opens (spec item 5). Big enough to scan across a room. */}
        <div style={{ padding: "18px 22px 24px", borderTop: "1px solid #1a1a2a", flexShrink: 0, textAlign: "center" }}>
          {requestUrl ? (
            <>
              <div style={{ background: "#fff", padding: 12, borderRadius: 12, display: "inline-block" }}>
                <QRCodeSVG value={requestUrl} size={188} level="M" />
              </div>
              <div style={{ marginTop: 11, fontSize: 13.5, fontWeight: 700, color: "#c8c8e0" }}>
                Request from your phone
              </div>
              <div style={{ marginTop: 3, fontSize: 11, color: "#4a4a60", wordBreak: "break-all" }}>{requestUrl}</div>
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: "#5a5a70", lineHeight: 1.55 }}>
              No request link set yet — add one in <strong style={{ color: "#8a8aa0" }}>Settings → Jukebox</strong> and
              it will show here as a scannable code.
            </div>
          )}
        </div>
      </div>

      {/* ── CONFIRM CARD — big cover, name, one huge button ──────────────────────────────────────── */}
      {confirming && (
        <div
          onClick={() => { if (!busy) { setConfirming(null); setNameInput(""); } }}
          style={{
            position: "fixed", inset: 0, background: "rgba(4,4,8,0.88)", backdropFilter: "blur(6px)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 32,
          }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: "min(560px, 94vw)", background: "#0e0e16", border: "1px solid #23233a",
            borderRadius: 20, padding: 34, textAlign: "center", animation: "juke-rise 0.2s ease",
          }}>
            <div style={{ fontSize: 27, fontWeight: 900, color: "#fff", lineHeight: 1.2 }}>{confirming.title}</div>
            <div style={{ fontSize: 16, color: "#8a8aa0", marginTop: 7 }}>{confirming.artist || "—"}</div>

            <input
              autoFocus
              value={nameInput}
              onChange={e => setNameInput(e.target.value.slice(0, NAME_MAX))}
              onKeyDown={e => { if (e.key === "Enter") void submit(); }}
              placeholder="Your name"
              style={{
                marginTop: 26, width: "100%", padding: "17px 20px", fontSize: 20, textAlign: "center",
                background: "#08080e", border: "1px solid #2a2a44", borderRadius: 12,
                color: "#fff", outline: "none", fontFamily: "inherit", fontWeight: 700,
              }}
            />

            <button
              onClick={() => void submit()}
              disabled={busy}
              style={{
                marginTop: 18, width: "100%", padding: "20px 0", fontSize: 19, fontWeight: 900,
                letterSpacing: "0.06em", border: "none", borderRadius: 13,
                background: busy ? "#2a2a44" : "#6040c0", color: "#fff",
                cursor: busy ? "default" : "pointer", fontFamily: "inherit",
              }}>
              {busy ? "SENDING…" : provider.label}
            </button>
            <button
              onClick={() => { setConfirming(null); setNameInput(""); }}
              disabled={busy}
              style={{
                marginTop: 12, background: "transparent", border: "none", color: "#5a5a70",
                fontSize: 13.5, cursor: "pointer", fontFamily: "inherit", padding: 8,
              }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div style={{
          position: "fixed", bottom: 34, left: "50%", transform: "translateX(-50%)",
          background: "#151522", border: "1px solid #2a2a44", borderRadius: 12,
          padding: "16px 28px", fontSize: 16, fontWeight: 600, color: "#e8e8f0",
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)", zIndex: 60, animation: "juke-rise 0.2s ease",
        }}>{toast}</div>
      )}

      {/* Staff exit — deliberately small and quiet. Only rendered when the host gave us a way out
          (the in-window takeover did; the pop-out is closed with the window / F11). */}
      {onExit && (
        <button
          onClick={onExit}
          style={{
            position: "fixed", top: 12, right: 14, background: "transparent", border: "none",
            color: "#2e2e40", fontSize: 11, letterSpacing: "0.1em", cursor: "pointer", zIndex: 40,
          }}>EXIT</button>
      )}
    </div>
  );
}

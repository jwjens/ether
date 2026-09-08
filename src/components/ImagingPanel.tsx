// src/components/ImagingPanel.tsx — IMAGING, a top-level destination.
//
// Imaging had one door: a push-up at the bottom bar. That is a room, not a home, and by the
// doors-before-rooms rule a feature its owner cannot find is a defect. This is slice 1 of
// docs/imaging-model-redesign-2026-09-06.md §1 — the surface.
//
// WHAT IS EDITABLE HERE, AND WHY (revised 2026-09-07 after the first build).
//
// ASSIGNMENTS and POOLS are EDITABLE. They render the existing SweepersPanel — one component, one set
// of write handlers, reached through two doors. The duplication worth fearing is two IMPLEMENTATIONS
// that can disagree; two doors onto one component is not that, and §1.2 of the redesign always had the
// push-up becoming "a shortcut INTO it rather than the thing itself".
//
// The first build shipped them with `readOnly`, which DISABLED every control rather than not drawing
// it — a surface full of dead controls, which is the exact defect this work exists to remove. Jeff:
// "every control renders and none of them work". Fixed by letting them work, not by greying them out.
//
// RACK, ON DECK and RULES are read-only and draw NO CONTROLS AT ALL — not disabled ones. Their writes
// belong to later slices (marks, overrides, bans); until then there is nothing to click, which is the
// honest render of a thing that cannot yet be done.
//
// NOTHING RENDERS UNLESS IT IS WIRED.
//
// RACK shows NAME · TYPE · LENGTH · POOL and no more, because the
// other two columns in the design do not exist yet: no imaging asset carries run dates anywhere
// (asset_sweeper_meta is asset_uuid + sweeper_category_id, nothing else), and the hour mask is a
// property of the ASSIGNMENT (categories.overlay_active_hours), not of a cut — so it is shown in
// ASSIGNMENTS, where it lives. Drawing an empty column would be a control that lies.
import { useEffect, useState, useCallback } from "react";
import { query } from "../db/client";
import { useActiveStation } from "../hooks/useActiveStation";
import SweepersPanel from "./SweepersPanel";
import MarkEditor from "./MarkEditor";
import { SWP_INDIGO } from "../lib/classColors";

type View = "rack" | "pools" | "assignments" | "ondeck" | "rules";

const VIEWS: { key: View; label: string; blurb: string }[] = [
  { key: "rack",        label: "RACK",        blurb: "Every imaging cut in the library." },
  { key: "pools",       label: "POOLS",       blurb: "Groups a category can draw from in rotation." },
  { key: "assignments", label: "ASSIGNMENTS", blurb: "Which category gets which imaging, and when." },
  { key: "ondeck",      label: "ON DECK",     blurb: "What fires ahead of you, in log order." },
  { key: "rules",       label: "RULES",       blurb: "Where a produced cut may not go." },
];

interface RackRow {
  id: number; uuid: string; type: string; title: string | null; duration_ms: number | null;
  pools: string | null; file_path: string | null; intro_end: number | null;
  // v56 marks. dry_ms for a cut, post_ms for a song — see MarkEditor for what each one means.
  post_ms: number | null; post_source: string | null; post_confirmed_at: string | null;
  dry_ms: number | null; dry_source: string | null; dry_confirmed_at: string | null;
  /** SONGS mode only: how many times this song is placed in the log ahead. Marks are worth an evening
   *  on the thirty songs that carry the station and can wait forever on the tail, so the list is
   *  ordered by what actually airs rather than alphabetically. */
  scheduled?: number;
}
interface DeckRow { scheduled_at: number; content_class: string; title: string | null; lead_in_sec: number | null; }

const secs = (ms: number | null) => {
  if (ms == null || ms <= 0) return null;               // absent, not zero — say so with a dash
  const t = Math.round(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const LABEL: React.CSSProperties = { fontSize: "var(--t-micro)", color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em" };
const NO_POOL = "— not in one of this station" + String.fromCharCode(39) + "s pools —";
const EMPTY: React.CSSProperties = { fontSize: "var(--t-body)", color: "var(--text-tertiary)", fontStyle: "italic", lineHeight: 1.6, maxWidth: 620 };

export default function ImagingPanel() {
  const { stationId, isReady } = useActiveStation();
  const [view, setView] = useState<View>("rack");

  // ── RACK ──────────────────────────────────────────────────────────────────
  // RACK shows one of two lists. IMAGING marks DRY on a cut; SONGS marks POST on a song. Same editor,
  // same gesture — they are the same question asked of two kinds of audio (design §2.2, §3.2).
  const [rackMode, setRackMode] = useState<"imaging" | "songs">("imaging");
  const [rack, setRack] = useState<RackRow[] | null>(null);
  const [editing, setEditing] = useState<RackRow | null>(null);
  // ── ON DECK ───────────────────────────────────────────────────────────────
  const [deck, setDeck] = useState<DeckRow[] | null>(null);
  const [why, setWhy] = useState<{ assigned: number; cats: number; fallback: boolean } | null>(null);

  const load = useCallback(async () => {
    if (stationId == null) return;
    try {
      // The same join SweepersPanel already runs — a proven path, not a new one. Announcements are
      // included: type is metadata, and an imaging surface that shows only sweepers is not one.
      // THE CUT LIST IS GLOBAL, THE POOLS ARE NOT. Every sweeper is available to every station — one
      // shared set, like the song library — so there is deliberately no station filter on the assets.
      // The pools are per station and, since v55, a cut can be in SEVERAL of them, so this is a
      // group_concat and the column is POOLS, plural. Scoped by jc.station_id: without it halloVeen
      // printed other stations' pool names on 52 of 64 rows.
      const MARKS = " s.post_ms, s.post_source, s.post_confirmed_at, s.dry_ms, s.dry_source, s.dry_confirmed_at,";
      setRack(rackMode === "imaging"
        ? await query<RackRow>(
            "SELECT s.id, la.uuid, la.type, la.title, la.duration_ms, s.file_path, s.intro_end," + MARKS +
            "       (SELECT group_concat(jc.name, ', ') FROM sweeper_pool_member m" +
            "          JOIN jingle_categories jc ON jc.id = m.pool_id AND jc.station_id = ? AND jc.deleted_at IS NULL" +
            "         WHERE m.asset_uuid = la.uuid AND m.deleted_at IS NULL) AS pools" +
            "  FROM library_asset la" +
            "  JOIN songs s ON s.uuid = la.uuid" +
            " WHERE la.type IN ('SWEEPER','ANNOUNCEMENT') AND la.deleted_at IS NULL AND s.deleted_at IS NULL" +
            " ORDER BY la.type, la.title", [stationId])
        // MOST-SCHEDULED FIRST, and unmarked before marked: the order in which marking is worth doing.
        : await query<RackRow>(
            "SELECT s.id, s.uuid, 'SONG' AS type, s.title, s.duration_ms, s.file_path, s.intro_end," + MARKS +
            "       NULL AS pools," +
            "       (SELECT COUNT(*) FROM generated_schedule g" +
            "         WHERE g.song_id = s.id AND g.station_id = ? AND g.scheduled_at >= strftime('%s','now')) AS scheduled" +
            "  FROM songs s" +
            " WHERE s.content_class = 'MUSIC' AND s.deleted_at IS NULL AND s.file_path IS NOT NULL" +
            " ORDER BY (s.post_ms IS NOT NULL), scheduled DESC, s.title LIMIT 400", [stationId]));
    } catch { setRack([]); }
    try {
      // What WILL fire, from the generated log. A placed sweeper carries the same scheduled_at as the
      // song it precedes (electron/main.js placement), which is what lets a cut be named against its song.
      setDeck(await query<DeckRow>(
        "SELECT scheduled_at, content_class, title, lead_in_sec FROM generated_schedule" +
        " WHERE station_id = ? AND scheduled_at >= strftime('%s','now')" +
        " ORDER BY scheduled_at, (content_class='SWP') DESC LIMIT 60", [stationId]));
    } catch { setDeck([]); }
    try {
      // WHY nothing is placed, when nothing is placed. Read from the same tables the generator reads.
      const a = await query<{ n: number }>(
        "SELECT COUNT(*) n FROM categories WHERE station_id = ? AND deleted_at IS NULL AND overlay_kind IS NOT NULL", [stationId]);
      const c = await query<{ n: number }>(
        "SELECT COUNT(*) n FROM categories WHERE station_id = ? AND deleted_at IS NULL", [stationId]);
      const f = await query<{ value: string }>(
        "SELECT value FROM station_config_kv WHERE station_id = ? AND key = 'overlay_fallback_category_id' AND deleted_at IS NULL", [stationId]);
      setWhy({ assigned: a?.[0]?.n ?? 0, cats: c?.[0]?.n ?? 0, fallback: !!(f?.[0]?.value) });
    } catch { setWhy(null); }
  }, [stationId, rackMode]);

  useEffect(() => { load(); }, [load]);

  /** Write a mark to BOTH tables. A sweeper is a `songs` row joined by uuid to a `library_asset` row,
   *  and the two are read by different code — _placeJingles reads songs, RACK reads library_asset — so
   *  a mark on one and not the other would be a mark that half the app cannot see. Both writes go
   *  through the logged sync writers, so the mark travels with the account. */
  const writeMark = useCallback(async (row: RackRow, kind: "post" | "dry", ms: number | null) => {
    const now = new Date().toISOString();
    const patch: any = ms == null
      ? { [`${kind}_ms`]: null, [`${kind}_source`]: null, [`${kind}_confirmed_at`]: null }
      // SET BY EAR stamps the operator as the author. That is what makes it a fact rather than a
      // candidate, and what a later slice checks before letting imaging talk over a vocal.
      : { [`${kind}_ms`]: ms, [`${kind}_source`]: "operator", [`${kind}_confirmed_at`]: now };
    try { await (window as any).ether?.songs?.updateById(row.id, patch); } catch {}
    try { await (window as any).ether?.libraryAsset?.update(row.uuid, patch); } catch { /* a song has no asset row on a pre-v50 profile */ }
    await load();
    setEditing(prev => prev && prev.id === row.id ? { ...prev, ...patch } : prev);
  }, [load]);

  // Refuses to guess a station: every number here is per-station, and showing one station's imaging
  // under another station's name is worse than showing nothing.
  if (!isReady || stationId == null) {
    return <div style={{ padding: 24, ...EMPTY }}>Resolving the active station…</div>;
  }

  const sweepers = deck?.filter(d => d.content_class === "SWP") ?? [];
  const musicAhead = deck?.filter(d => d.content_class === "MUSIC") ?? [];
  // Pair each sweeper with the song it precedes — identical scheduled_at, by construction at Generate.
  const pairs = sweepers.map(s => ({ s, song: musicAhead.find(m => m.scheduled_at === s.scheduled_at) || null }));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", color: "var(--text-primary)", minHeight: 0 }}>
      <div style={{ padding: "14px 20px 0" }}>
        <div style={{ fontSize: "var(--t-h2)", fontWeight: 800, letterSpacing: "0.04em" }}>IMAGING</div>
        <div style={{ ...EMPTY, fontStyle: "normal", marginTop: 4 }}>
          Sweepers, IDs and announcements — the cuts, the pools they sit in, and where they fire.
        </div>
      </div>

      <div style={{ display: "flex", gap: 4, padding: "12px 20px 0", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        {VIEWS.map(v => (
          <button key={v.key} onClick={() => setView(v.key)} title={v.blurb} style={{
            padding: "6px 14px", background: "transparent", border: "none",
            borderBottom: `2px solid ${view === v.key ? SWP_INDIGO : "transparent"}`,
            color: view === v.key ? SWP_INDIGO : "var(--text-tertiary)",
            fontWeight: 800, fontSize: "var(--t-body)", letterSpacing: "0.04em", cursor: "pointer",
          }}>{v.label}</button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {/* ── RACK ─────────────────────────────────────────────────────────── */}
        {view === "rack" && (
          <div style={{ padding: 20, maxWidth: 900 }}>
            {/* WHICH LIST. Cuts carry a DRY length; songs carry a POST. One editor, two subjects. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              {([["imaging", "Imaging cuts"], ["songs", "Songs"]] as const).map(([k, lbl]) => (
                <button key={k} onClick={() => { setRackMode(k); setEditing(null); }} style={{
                  padding: "4px 12px", fontSize: 11, fontWeight: 800, letterSpacing: "0.08em",
                  textTransform: "uppercase" as const,
                  background: rackMode === k ? "rgba(136,104,216,0.2)" : "transparent",
                  border: `1px solid ${rackMode === k ? "#8868D8" : "var(--border-primary)"}`,
                  color: rackMode === k ? "#8868D8" : "var(--text-tertiary)", cursor: "pointer",
                }}>{lbl}</button>
              ))}
              <span style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)", marginLeft: 4 }}>
                {rackMode === "imaging"
                  ? "mark DRY — how much of a cut has no music under it"
                  : "mark POST — where the vocal begins · most-scheduled first"}
              </span>
            </div>

            {rack === null ? <div style={EMPTY}>Reading the library…</div>
            : rack.length === 0 ? (
              <div style={EMPTY}>
                No imaging in the library.<br />
                Import cuts from the SWEEPERS push-up at the bottom bar → ADD IMAGING — CUT A REEL, or mark
                an existing item as a sweeper in the Library.
              </div>
            ) : (
              <>
                <div style={{ ...LABEL, marginBottom: 10 }}>
                  {rack.length} {rackMode === "imaging" ? "cuts" : "songs"} ·{" "}
                  {rack.filter(r => (rackMode === "imaging" ? r.dry_ms : r.post_ms) != null).length} marked
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 92px 70px 150px 1fr", gap: "6px 14px", alignItems: "center" }}>
                  <div style={LABEL}>Name</div><div style={LABEL}>Type</div>
                  <div style={LABEL}>Length</div>
                  <div style={LABEL}>{rackMode === "imaging" ? "Dry" : "Post"}</div>
                  <div style={LABEL}>{rackMode === "imaging" ? "Pools" : "Placed ahead"}</div>
                  {rack.map((r, i) => {
                    const len = secs(r.duration_ms);
                    const kind = rackMode === "imaging" ? "dry" : "post";
                    const ms = kind === "dry" ? r.dry_ms : r.post_ms;
                    const src = kind === "dry" ? r.dry_source : r.post_source;
                    const open = editing?.id === r.id;
                    return (
                      <Row key={i}>
                        <span style={{ fontSize: "var(--t-lead)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: open ? "#8868D8" : undefined }}>{r.title || "(untitled)"}</span>
                        <span style={{ fontSize: "var(--t-small)", color: "var(--text-secondary)" }}>{r.type}</span>
                        {/* A dash is the honest render of an absent length; it also marks the row as
                            incomplete, which is information rather than a gap. */}
                        <span style={{ fontSize: "var(--t-small)", color: len ? "var(--text-secondary)" : "var(--text-tertiary)" }}>{len ?? "—"}</span>
                        {/* THE MARK, and whose it is. An auto value is a candidate and says so. */}
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <button
                            disabled={!r.file_path}
                            onClick={() => setEditing(open ? null : r)}
                            title={r.file_path ? "Set this mark by ear" : "No file on disk for this row — nothing to audition."}
                            style={{ padding: "2px 9px", fontSize: 11, fontWeight: 700,
                              background: open ? "rgba(136,104,216,0.2)" : "transparent",
                              border: `1px solid ${open ? "#8868D8" : "var(--border-primary)"}`,
                              color: ms != null ? "var(--text-primary)" : "var(--text-tertiary)",
                              cursor: r.file_path ? "pointer" : "default", opacity: r.file_path ? 1 : 0.4 }}>
                            {ms != null ? `${(ms / 1000).toFixed(2)}s` : "mark…"}
                          </button>
                          {src === "auto" && (
                            <span title="A detector proposed this. Nobody has agreed with it yet." style={{ fontSize: 10, fontWeight: 800, color: "#f59e0b" }}>AUTO</span>
                          )}
                        </span>
                        {rackMode === "imaging"
                          ? <span style={{ fontSize: "var(--t-small)", color: r.pools ? "var(--text-secondary)" : "var(--text-tertiary)" }}>{r.pools ?? NO_POOL}</span>
                          : <span style={{ fontSize: "var(--t-small)", color: r.scheduled ? "var(--text-secondary)" : "var(--text-tertiary)" }}>{r.scheduled ? `${r.scheduled}x ahead` : "not in the log ahead"}</span>}
                      </Row>
                    );
                  })}
                </div>

                {editing && editing.file_path && (
                  <MarkEditor
                    filePath={editing.file_path}
                    title={editing.title || "(untitled)"}
                    kind={rackMode === "imaging" ? "dry" : "post"}
                    valueMs={rackMode === "imaging" ? editing.dry_ms : editing.post_ms}
                    source={rackMode === "imaging" ? editing.dry_source : editing.post_source}
                    confirmedAt={rackMode === "imaging" ? editing.dry_confirmed_at : editing.post_confirmed_at}
                    introEndMs={editing.intro_end != null ? Math.round(editing.intro_end * 1000) : null}
                    onSave={(ms) => writeMark(editing, rackMode === "imaging" ? "dry" : "post", ms)}
                    onClear={() => writeMark(editing, rackMode === "imaging" ? "dry" : "post", null)}
                    onClose={() => setEditing(null)}
                  />
                )}
                <div style={{ ...EMPTY, marginTop: 16 }}>
                  {rackMode === "imaging"
                    ? <>Every cut in the shared library — all of them are available to every station. POOLS shows this station&rsquo;s pools only, and a cut can be in more than one of them. Pool membership is set in POOLS.</>
                    : <>The 400 songs most likely to need a post, unmarked first. Marking the thirty that carry the station is an evening; the tail can wait.</>}
                  <br />
                  <b>Nothing reads these marks yet.</b> They are recorded for chain types, a later slice —
                  setting one changes no seam and no sound.
                </div>
              </>
            )}
          </div>
        )}

        {/* ── POOLS and ASSIGNMENTS — the existing editor, lifted and LIVE ── */}
        {view === "pools" && (
          <SweepersPanel stationId={stationId} section="pools" />
        )}
        {view === "assignments" && (
          <SweepersPanel stationId={stationId} section="assignments" />
        )}

        {/* ── ON DECK ──────────────────────────────────────────────────────── */}
        {view === "ondeck" && (
          <div style={{ padding: 20, maxWidth: 900 }}>
            {deck === null ? <div style={EMPTY}>Reading the log…</div>
            : deck.length === 0 ? (
              // STATE 1 — nothing generated at all.
              <div style={EMPTY}>
                Nothing is scheduled ahead of now.<br />
                Generate a day in the Calendar, then come back — this view reads the generated log.
              </div>
            ) : pairs.length === 0 ? (
              // STATE 2 — a log exists and carries no imaging. The useful case: say WHY.
              <div style={EMPTY}>
                {musicAhead.length} element{musicAhead.length === 1 ? "" : "s"} scheduled through{" "}
                {clock(deck[deck.length - 1].scheduled_at)}, <b>no imaging placed</b>.
                {why && why.assigned === 0 && !why.fallback && (
                  <><br /><br />
                    None of this station&rsquo;s {why.cats} music categor{why.cats === 1 ? "y has" : "ies have"} an
                    overlay assigned, and there is no fallback pool. Assign one in ASSIGNMENTS, or set a
                    fallback so unassigned categories still get imaging.
                  </>
                )}
                {why && (why.assigned > 0 || why.fallback) && (
                  <><br /><br />
                    {why.assigned} categor{why.assigned === 1 ? "y is" : "ies are"} assigned
                    {why.fallback ? " and a fallback pool is set" : ""}, so the placements ahead may simply fall
                    outside their active hours. Check ACTIVE HOURS in ASSIGNMENTS.
                  </>
                )}
              </div>
            ) : (
              // STATE 3 — the list. The specific cut, named, against the song it introduces.
              <>
                <div style={{ ...LABEL, marginBottom: 10 }}>next {pairs.length} placements</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {pairs.map((p, i) => (
                    <div key={i} style={{ display: "flex", gap: 12, alignItems: "baseline", padding: "6px 10px", background: "var(--bg-secondary)", borderRadius: "var(--r-0)" }}>
                      <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: "var(--t-small)", color: "var(--text-tertiary)" }}>{clock(p.s.scheduled_at)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "var(--t-lead)", color: SWP_INDIGO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {p.s.title || "(untitled cut)"}
                        </div>
                        <div style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          → {p.song?.title ?? "(the next element)"}
                        </div>
                      </div>
                      {p.s.lead_in_sec != null && (
                        <span style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)" }}>lead {p.s.lead_in_sec}s</span>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ ...EMPTY, marginTop: 16 }}>
                  What the generated log says will fire. Swapping or killing a single placement is a later
                  slice; nothing here changes the log.
                </div>
              </>
            )}
          </div>
        )}

        {/* ── RULES — a placeholder that says what it will hold, and that it holds nothing ── */}
        {view === "rules" && (
          <div style={{ padding: 20, maxWidth: 620 }}>
            <div style={EMPTY}>
              <b style={{ color: "var(--text-secondary)" }}>Nothing is configured, and bans are not built yet.</b>
              <br /><br />
              This is where segue bans will live: a short, readable list of places a produced cut may not
              go — a sweeper that names a song must not land against a different one, a cut that ends dry
              must not run into a cold open.
              <br /><br />
              It is deliberately empty rather than showing controls that do nothing. Nothing on this
              surface writes in this release.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One grid row; keeps the RACK markup flat and readable. */
function Row({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

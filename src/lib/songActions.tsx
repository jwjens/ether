// songActions — the actions a SONG has, defined once, rendered wherever a song appears.
//
// A song shows up in the queue, on a deck, in the library, in the log and on the calendar. Its own
// actions — edit it, send it to Show+, find it in the library, change what it IS — belong to the
// SONG, not to the surface it happens to be sitting on. Defined per surface they drift: within a
// month you have a dozen menus that disagree about what you can do to a track.
//
// So: one action set here, one `useSongMenu()` any surface drops in, and SURFACE-SPECIFIC actions
// (queue ordering, deck transport) are passed in as extras. The song's actions travel with the song.
//
// HOW THE ACTIONS REACH THE APP. Editing a track and pushing to Show+ are already one-liners at App
// level — `setEditSong(s); setPanel("trackedit")` and the `studio:push-track` invoke, both wired for
// LibraryPanel's onEdit/onSendToStudio. Rather than reimplement either (two implementations of "edit
// this song" is the same disease), the menu dispatches `ether:song-action` and App performs it with
// the handlers it already has.
//
// HONEST ABOUT WHAT IT CANNOT DO. A queue item and a deck carry filePath/title/artist but no song id,
// so the row is resolved from `songs` by file_path. Something not in the library — a cart file, an
// imported one-off — has no row, and the song actions are then shown DISABLED with the reason,
// never rendered as though they would work.

import React, { useCallback, useEffect, useState } from "react";
import { query } from "../db/client";
import { checkFilePresence, fileLocationItem, changeFileLocationItem, type FilePresence } from "./fileLocation";

/** What a surface knows about a song it is displaying. */
export interface SongRef {
  title?: string | null;
  artist?: string | null;
  filePath?: string | null;
}

/** The library row behind it, once resolved. */
export interface ResolvedSong {
  id: number;
  title: string;
  artist_name: string | null;
  file_path: string | null;
  duration_ms: number | null;
  content_class: string | null;
}

export type SongActionName = "edit" | "showplus" | "library";

/** Fired at the window; App holds the single listener that performs these. */
export function dispatchSongAction(action: SongActionName, song: ResolvedSong) {
  window.dispatchEvent(new CustomEvent("ether:song-action", { detail: { action, song } }));
}

export async function resolveSongByPath(filePath?: string | null): Promise<ResolvedSong | null> {
  if (!filePath) return null;
  try {
    const rows = await query<ResolvedSong>(
      "SELECT id, title, artist_name, file_path, duration_ms, content_class FROM songs WHERE file_path = ? LIMIT 1",
      [filePath]);
    return rows[0] ?? null;
  } catch { return null; }
}

/** An entry on the menu. `disabled` carries WHY, so a greyed row explains itself. */
export interface SongMenuItem {
  label: string;
  run?: () => void | Promise<void>;
  danger?: boolean;
  disabled?: string;
  divider?: boolean;
}

const ITEM_BTN: React.CSSProperties = {
  width: "100%", textAlign: "left", padding: "6px 12px", fontSize: 11, fontWeight: 600,
  background: "none", border: "1px solid transparent", cursor: "pointer",
  letterSpacing: "0.03em", whiteSpace: "nowrap",
};

/**
 * Right-click support for any surface showing a song.
 *
 *   const songMenu = useSongMenu();
 *   <div onContextMenu={e => songMenu.open(e, { title, artist, filePath }, extraItems)} />
 *   {songMenu.node}
 */
export function useSongMenu() {
  const [menu, setMenu] = useState<
    { x: number; y: number; ref: SongRef; extras: SongMenuItem[]; resolved: ResolvedSong | null;
      resolving: boolean; presence: FilePresence } | null
  >(null);

  const close = useCallback(() => setMenu(null), []);

  const open = useCallback((e: React.MouseEvent, ref: SongRef, extras: SongMenuItem[] = []) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, ref, extras, resolved: null, resolving: true, presence: "checking" });
    void resolveSongByPath(ref.filePath).then(r =>
      setMenu(m => (m ? { ...m, resolved: r, resolving: false } : m)));
    // Independent of the library lookup on purpose: "is this file on disk" is a different question
    // from "is this track in the library", and an item can be either without being the other — a
    // cart file is on disk with no library row, and an R2-only track has a row with no local file.
    void checkFilePresence(ref.filePath).then(p =>
      setMenu(m => (m ? { ...m, presence: p } : m)));
  }, []);

  // Dismiss on Escape or a click anywhere outside.
  useEffect(() => {
    if (!menu) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") close(); };
    const onDown = () => close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [menu, close]);

  let node: React.ReactNode = null;
  if (menu) {
    const song = menu.resolved;
    // One reason, written once: every song action needs the library row.
    const why = menu.resolving ? "finding this track…" : "this file is not in the library";
    const cls = song?.content_class ?? null;

    const setClass = async (next: string) => {
      if (!song) return;
      try { await (window as any).ether.songs.updateById(song.id, { content_class: next }); }
      catch (err) { console.error("[songActions] content_class change failed:", err); }
      window.dispatchEvent(new CustomEvent("ether:songs-changed"));
    };

    const songItems: SongMenuItem[] = [
      { label: "Edit Track…",      run: () => { if (song) dispatchSongAction("edit", song); },     disabled: song ? undefined : why },
      { label: "Send to Show+",    run: () => { if (song) dispatchSongAction("showplus", song); }, disabled: song ? undefined : why },
      { label: "Show in Library",  run: () => { if (song) dispatchSongAction("library", song); },  disabled: song ? undefined : why },
      { divider: true, label: "" },
      { label: cls === "SWP" ? "Unmark Sweeper (→ Music)" : "Mark as Sweeper",
        run: () => setClass(cls === "SWP" ? "MUSIC" : "SWP"), disabled: song ? undefined : why },
      { label: cls === "SPOT" ? "Unmark Spot (→ Music)" : "Mark as Spot",
        run: () => setClass(cls === "SPOT" ? "MUSIC" : "SPOT"), disabled: song ? undefined : why },
      { divider: true, label: "" },
      // Deliberately NOT gated on the library row. This one needs only a file path, so it works for
      // the cart file and the one-off import that every action above is correctly disabled for.
      fileLocationItem(menu.ref.filePath, menu.presence),
      // Needs the library row for its id — a queue/deck item with no `songs` row cannot be repointed,
      // and says so rather than opening a picker that would write nowhere.
      song ? changeFileLocationItem({ table: "songs", id: song.id }, menu.ref.filePath)
           : { label: "Change File Location…", disabled: why },
    ];

    const items = menu.extras.length
      ? [...menu.extras, { divider: true, label: "" } as SongMenuItem, ...songItems]
      : songItems;

    node = (
      <div
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        onContextMenu={e => e.preventDefault()}
        style={{
          position: "fixed", left: menu.x, top: menu.y, zIndex: 9999, minWidth: 190,
          background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.45)", padding: "4px 0",
        }}
      >
        <div style={{
          padding: "4px 12px 6px", fontSize: 9, color: "var(--text-tertiary)",
          borderBottom: "1px solid var(--border-primary)", marginBottom: 4,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260,
          fontFamily: "'DM Mono', monospace",
        }}>{menu.ref.title || "(untitled)"}</div>

        {items.map((it, i) => it.divider ? (
          <div key={`d${i}`} style={{ height: 1, background: "var(--border-primary)", margin: "4px 0" }} />
        ) : (
          <button
            key={it.label + i}
            title={it.disabled || undefined}
            disabled={!!it.disabled}
            // Closing is the MENU's job, not each item's — an ordering item that left it open was
            // the tell that half the entries were closing themselves and half were not.
            onClick={() => { if (it.disabled) return; close(); void it.run?.(); }}
            style={{
              ...ITEM_BTN,
              color: it.disabled ? "var(--text-tertiary)" : it.danger ? "#ef4444" : "var(--text-secondary)",
              cursor: it.disabled ? "default" : "pointer",
              opacity: it.disabled ? 0.45 : 1,
            }}
            onMouseEnter={e => { if (!it.disabled) (e.currentTarget as HTMLButtonElement).style.background = it.danger ? "#ef444414" : "var(--bg-tertiary)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
          >{it.label}</button>
        ))}
      </div>
    );
  }

  return { open, close, node };
}

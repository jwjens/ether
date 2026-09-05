// fileLocation — "Open File Location", defined once for anything backed by a real audio file.
//
// A song, a spot, a sweeper, an announcement, a cart: different tables, different panels, one thing
// in common — a row that points at a file on disk. Revealing that file belongs to the ITEM, not to
// the surface it happens to be sitting on, so it lives here and travels with the item wherever it
// appears. Written per-surface it would drift into five menus that disagree about what "open" means.
//
// WHY IT IS DISABLED RATHER THAN OPTIMISTIC. A file_path in the database is a CLAIM, not a fact:
// half a station's library once had paths pointing at files that existed only in R2 (see the
// library-materialisation work), and `shell.showItemInFolder` on a missing file opens the containing
// folder with nothing selected — or the user's home directory — which reads as "the app is broken"
// rather than "this track needs re-importing". So presence is checked BEFORE the menu is drawn, and
// a missing file greys the row and says why.

import React, { useCallback, useEffect, useState } from "react";
import type { SongMenuItem } from "./songActions";

/** What we know about the file behind an item, at the moment the menu was opened. */
export type FilePresence = "checking" | "present" | "missing" | "none";

/**
 * Ask the main process whether the file is actually on this machine.
 * Never throws — an IPC failure is reported as "missing", which disables the row rather than
 * offering an action that would then do nothing.
 */
export async function checkFilePresence(filePath?: string | null): Promise<FilePresence> {
  if (!filePath) return "none";
  try {
    const ok = await (window as any).ether?.fs?.exists(filePath);
    return ok ? "present" : "missing";
  } catch {
    return "missing";
  }
}

/**
 * The reason a row is greyed, in the operator's language rather than the file system's.
 *
 * Exported because not every menu in the app is built from SongMenuItem — the cart wall renders its
 * own buttons — and the ONE thing that must not vary between them is what the operator is told about
 * a missing file. Same words everywhere, from here.
 */
export function fileLocationReason(presence: FilePresence): string | undefined {
  switch (presence) {
    case "present":  return undefined;
    case "checking": return "checking for the file…";
    case "none":     return "this item has no file";
    case "missing":  return "the audio isn't on this machine — this item needs re-importing";
  }
}

/**
 * The menu entry. Drop it into any action list:
 *
 *   const [presence, setPresence] = useState<FilePresence>("checking");
 *   // on menu open: void checkFilePresence(filePath).then(setPresence);
 *   const items = [...otherItems, fileLocationItem(filePath, presence)];
 */
/**
 * COPY-ON-IMPORT — put a chosen file into the audio library and return the path to store.
 *
 * THE RULE: every audio file that enters Ether is copied into the audio library. That is the first
 * and only place audio files live, and a basename plus the local library is the only thing that
 * survives a trip between machines.
 *
 * EVERY PICKER IN THE APP MUST GO THROUGH HERE, and must store the path this returns — never the
 * one the operator browsed to. Before this existed, nothing copied: the library was a folder the
 * uploader consolidated into and the importer never wrote to, which is how 1,113 files ended up in
 * the library with no row, ten carts ended up in Downloads, and OV received 382 rows naming a
 * directory it cannot open.
 *
 * IT FAILS AT THE DOOR, LOUDLY. On refusal it tells the operator which file and why, and returns
 * null so the caller writes NO ROW. A row written for a file that is not in the library yet is a
 * promise the disk has not kept, and it is discovered mid-show.
 *
 * @returns the path to store, or null if the import was refused (the caller must then do nothing).
 */
export async function importIntoAudioLibrary(srcPath: string | null | undefined): Promise<string | null> {
  if (!srcPath) return null;
  try {
    const r = await (window as any).ether?.audioLibrary?.import(srcPath);
    if (!r) return srcPath;                       // older main without the IPC — do not block the operator
    if (r.ok) return r.path as string;
    window.alert(
      `That file was not added.\n\n${String(srcPath).split(/[\\/]/).pop()}\n\n${r.error}`);
    return null;
  } catch (err: any) {
    window.alert(`That file was not added.\n\n${err?.message || String(err)}`);
    return null;
  }
}

/** What a surface knows about the ROW behind a file, so it can be repointed. */
export interface FileRowRef {
  table: string;          // 'songs' | 'announcements' | 'spots' | 'cart_slots' | …
  id: number | string;
}

/**
 * CHANGE FILE LOCATION — repoint one row's file_path at a file the operator chooses.
 *
 * THE SUGGESTION IS THE POINT. The overwhelmingly common case is not "find me a file" — it is "I
 * already moved these into the audio library, the rows just haven't caught up." Measured on the dev
 * machine (2026-09-04): 8 of 10 carts pointed at Downloads while the identical basename already sat
 * in the library. Making the operator navigate to a file the app could have named is friction the
 * app created.
 *
 * So: ask main for the candidate FIRST, offer it as one click, and only open a picker if there
 * isn't one — or if the operator declines it.
 *
 * THE WRITE IS LOCAL-ONLY. `file_path` is a blob-ref column, and in sync-protocol v0 a blob-ref
 * ships the literal absolute path — so a repoint routed through the normal save would push this
 * machine's path to every peer, which is the OV incident in reverse. `audio-library:repoint` writes
 * the column directly and logs a `manual-repoint` health event so a hand repair stays findable.
 */
export function changeFileLocationItem(
  row: FileRowRef | null | undefined,
  filePath: string | null | undefined,
  onDone?: () => void,
): SongMenuItem {
  return {
    label: "Change File Location…",
    // NOTE THE INVERSION vs Open File Location: a MISSING file is exactly when this is wanted, so it
    // stays enabled. It is disabled only when there is no row to repoint.
    disabled: row && row.table ? undefined : "this item's row can't be identified",
    run: async () => {
      if (!row) return;
      const api = (window as any).ether;
      try {
        const s = await api?.audioLibrary?.suggest(filePath);
        const suggestion: string | null = s?.suggestion || null;

        let chosen: string | null = null;
        if (suggestion) {
          const name = suggestion.split(/[\\/]/).pop();
          // Plain confirm: one click for the case that is right ~80% of the time.
          const useIt = window.confirm(
            `Found this file already in your catalogue:\n\n${name}\n\n` +
            `Point this item at it?\n\n(Cancel to choose a different file.)`);
          if (useIt) chosen = suggestion;
        }
        if (!chosen) {
          const picked = await api?.dialog?.openFile({
            multiple: false, title: "Choose the audio file for this item",
            filters: [{ name: "Audio", extensions: ["mp3", "flac", "ogg", "wav", "m4a", "aac"] }],
          });
          chosen = Array.isArray(picked) ? picked[0] : picked;
        }
        if (!chosen) return;

        const r = await api?.audioLibrary?.repoint(row.table, row.id, chosen);
        if (r && r.ok === false) {
          window.alert(`Could not repoint this item:\n\n${r.error}`);
          return;
        }
        window.dispatchEvent(new CustomEvent("ether:songs-changed"));
        onDone?.();
      } catch (err) {
        console.error("[fileLocation] repoint failed:", err);
      }
    },
  };
}

export function fileLocationItem(filePath: string | null | undefined, presence: FilePresence): SongMenuItem {
  return {
    label: "Open File Location",
    disabled: fileLocationReason(presence),
    run: async () => {
      if (!filePath) return;
      try {
        const r = await (window as any).ether?.system?.revealFile(filePath);
        // The file can vanish between the check and the click. Say so rather than failing silently —
        // a menu item that does nothing is indistinguishable from a broken app.
        if (r && r.ok === false) {
          console.warn("[fileLocation] reveal failed:", r.error, filePath);
        }
      } catch (err) {
        console.error("[fileLocation] reveal threw:", err);
      }
    },
  };
}

// ── useFileMenu — right-click for ANY file-backed item that is not a song ───────────────────────
//
// The second shared action set (Jeff, 2026-09-04). `useSongMenu` carries a song's own actions —
// edit, Show+, mark as sweeper — and needs a `songs` row to do any of them. Spots, announcements,
// sweepers and library assets have none of that, but they all have the two actions that belong to
// the FILE rather than to the kind of thing it is:
//
//   OPEN FILE LOCATION    show me where this actually is
//   CHANGE FILE LOCATION  point this row at a different file
//
// Defined once here so all four panels agree on the wording, the disabled reasons and the
// suggestion behaviour. Written per panel they would drift within a month, which is the whole
// reason the song set exists in this shape.
//
// Usage:
//   const menu = useFileMenu();
//   <div onContextMenu={e => menu.open(e, { table: "spots", id: s.id, filePath: s.file_path, title: s.title }, onChanged)} />
//   {menu.node}

export interface FileMenuTarget {
  table: string;
  id: number | string;
  filePath?: string | null;
  title?: string | null;
}

const FILE_ITEM_BTN: React.CSSProperties = {
  width: "100%", textAlign: "left", padding: "6px 12px", fontSize: 11, fontWeight: 600,
  background: "none", border: "1px solid transparent", cursor: "pointer",
  letterSpacing: "0.03em", whiteSpace: "nowrap",
};

export function useFileMenu() {
  const [menu, setMenu] = useState<
    { x: number; y: number; target: FileMenuTarget; presence: FilePresence; onChanged?: () => void } | null
  >(null);

  const close = useCallback(() => setMenu(null), []);

  const open = useCallback((e: React.MouseEvent, target: FileMenuTarget, onChanged?: () => void) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target, presence: "checking", onChanged });
    // Presence decides whether OPEN is offered, and it is re-read on every open rather than cached:
    // the file may have been moved or repointed since this row was last drawn.
    void checkFilePresence(target.filePath).then(p =>
      setMenu(m => (m ? { ...m, presence: p } : m)));
  }, []);

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
    const items: SongMenuItem[] = [
      fileLocationItem(menu.target.filePath, menu.presence),
      changeFileLocationItem(
        { table: menu.target.table, id: menu.target.id },
        menu.target.filePath,
        menu.onChanged),
    ];
    node = (
      <div
        onMouseDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        onContextMenu={e => e.preventDefault()}
        style={{
          position: "fixed", left: menu.x, top: menu.y, zIndex: 9999, minWidth: 200,
          background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.45)", padding: "4px 0",
        }}
      >
        <div style={{
          padding: "4px 12px 6px", fontSize: 9, color: "var(--text-tertiary)",
          borderBottom: "1px solid var(--border-primary)", marginBottom: 4,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260,
          fontFamily: "'DM Mono', monospace",
        }}>{menu.target.title || "(untitled)"}</div>
        {items.map((it, i) => (
          <button
            key={it.label + i}
            title={it.disabled || undefined}
            disabled={!!it.disabled}
            onClick={() => { if (it.disabled) return; close(); void it.run?.(); }}
            style={{
              ...FILE_ITEM_BTN,
              color: it.disabled ? "var(--text-tertiary)" : "var(--text-secondary)",
              cursor: it.disabled ? "default" : "pointer",
              opacity: it.disabled ? 0.45 : 1,
            }}
            onMouseEnter={e => { if (!it.disabled) (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-tertiary)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
          >{it.label}</button>
        ))}
      </div>
    );
  }

  return { open, close, node };
}

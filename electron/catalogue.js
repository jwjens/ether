// electron/catalogue.js — WHERE A ROW'S AUDIO PLAYS FROM, with nothing decided by Ether (Jeff, 2026-10-26: "The catalogue
// is the default, not a lock. Nothing is baked in. Change File Location must stay fully available … What item 5 removes is
// Ether deciding on its own: no automatic path guessing, no title matching, no silent fallback to another folder.").
//
//   · A row plays from the location it stores — the catalogue (the default every import and download uses) or any file the
//     user chose with Change File Location. That stored location is the only one opened.
//   · When the file is not there, nothing else is tried: no same-named file in the catalogue or anywhere else, no
//     case-blind or "tolerant" name, no title. It is MISSING, and said so.
//   · A DOWNLOAD (the row's own cloud copy, by its file_key) goes INTO THE CATALOGUE folder under the row's own file name,
//     and the row is then pointed at it — on this computer only — so where it plays from is again simply what it stores.
// Names that differ only in capitalisation are different files (electron/audio-library-index.js libraryNameFor).
//
// Used by main (playback, announcements, the jukebox, the cue editor, downloads), the audio engine (audiod/engine.js) and
// the library-health sense, so none of them can disagree about a file.
"use strict";
const path = require("path");
const { storedBasename, existsExactCase, libraryPathFor } = require("./audio-library-index");

/** The file a row plays: its stored path, exactly (a different-case spelling is another file). null = not there. */
function playableFile(storedPath) {
  if (!storedPath) return null;
  return existsExactCase(String(storedPath)) ? String(storedPath) : null;
}

/** A row's file name: the name its stored path ends in, else its cloud file_key's. null = it has none. */
function catalogueName(storedPath, fileKey) {
  const n = storedPath ? storedBasename(storedPath) : "";
  if (n) return n;
  const k = fileKey ? storedBasename(fileKey) : "";
  return k || null;
}

/** Where a download of this row goes: the catalogue folder `root`, under the row's own name (or its case-alt name). */
function downloadTarget(root, storedPath, fileKey) {
  if (!root) return null;
  const name = catalogueName(storedPath, fileKey);
  if (!name) return null;
  const t = libraryPathFor(root, name);
  return { path: t.path, name: path.basename(t.path), present: t.present };
}

module.exports = { playableFile, catalogueName, downloadTarget };

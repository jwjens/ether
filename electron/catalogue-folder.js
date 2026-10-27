// electron/catalogue-folder.js — WHERE THE CATALOGUE FOLDER IS (Jeff, 2026-10-27: "Catalogue folder: there is always a
// default. Ether creates the catalogue folder at its default location so there is always a starting point. The user can
// always choose a different location, both in first-run setup and in Preferences.").
//
//   · The default is <the user's Music folder>\ether music library (per-user, so it is the same relative place on every
//     machine without a hard-coded user name); `fallbackDir` only when the OS has no Music folder.
//   · The user's choice (first-run setup or Preferences → music:set-dir) is kept in `settingFile` — a FILE, not the DB, so it
//     survives the install-from-cloud DB swap and never syncs to another machine — and wins over the default.
//   · ensureAtLaunch() creates whichever of the two is in force when Ether starts, so the folder is there before anything
//     needs it. A folder that cannot be created is reported, never swapped for another one (electron/catalogue.js).
"use strict";
const fs = require("fs");
const path = require("path");

function createCatalogueFolder({ musicPath, settingFile, fallbackDir, log = () => {} }) {
  let saidCannot = false;

  function defaultDir() {
    let m = null;
    try { m = typeof musicPath === "function" ? musicPath() : musicPath; } catch { m = null; }
    return m ? path.join(m, "ether music library") : fallbackDir;
  }

  function chosenDir() {
    try { const p = fs.readFileSync(settingFile, "utf8").trim(); return p || null; } catch { return null; }
  }

  /** The folder in force (the user's choice, else the default), created if it is not there. Always returns a path. */
  function current() {
    const dir = chosenDir() || defaultDir();
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { if (!saidCannot) { saidCannot = true; log(`[catalogue] the catalogue folder ${dir} cannot be created (${e.message}) — downloads into it will fail until it can`); } }
    return dir;
  }

  /** The user's choice. Creates the folder, then saves the choice. */
  function set(dir) {
    const d = String(dir || "").trim();
    if (!d) return { ok: false, error: "empty path" };
    try { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(settingFile, d); return { ok: true, dir: d }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  /** At launch: make sure the folder in force exists, and say which one it is. */
  function ensureAtLaunch() {
    const chosen = chosenDir();
    const dir = chosen || defaultDir();
    const existed = fs.existsSync(dir);
    current();
    const there = fs.existsSync(dir);
    log(`[catalogue] folder: ${dir} (${chosen ? "chosen by the user" : "the default"}) — ${there ? (existed ? "present" : "created") : "NOT there"}`);
    return { dir, isDefault: !chosen, created: !existed && there, present: there };
  }

  return { defaultDir, chosenDir, current, set, ensureAtLaunch };
}

module.exports = { createCatalogueFolder };

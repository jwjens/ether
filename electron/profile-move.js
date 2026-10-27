// electron/profile-move.js — MOVE A PROFILE FOLDER ONLY AFTER EVERY PART OF ETHER HAS LET GO OF IT.
//
// Jeff, 2026-10-26 (new computer, 4.6.64): signing in fails with "Ether could not finish opening your account's folder
// because a file was still in use", and closing and reopening does not help. Sign-in renames profiles\_pending to the
// account's folder (profile:adopt), and on Windows a folder cannot be renamed while any file inside it is open. adopt sent
// the audio engine "shutdown" and closed main's database, but:
//   • the engine CLIENT reconnected at once and spawned a new engine on the OLD path (process.env.ETHER_DB_PATH still
//     named _pending), which reopened _pending\openair.db;
//   • no restore gate was set, so the next renderer call reopened main's connection (getDb self-heal);
//   • the show-log and library-health workers keep their own read-only connection for the life of the app.
// A fresh computer always boots on _pending, so the rename failed on every sign-in. Same shape as the 4.6.63 station-join
// fix (db-holders.js), one layer up: a folder, not a file.
//
// This module is the order and the message; main.js supplies the parts (release/reacquire), so it is tested on real
// files with real holders (electron/profile-move.test.js).
"use strict";

const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every file under `dir` (the paths Windows is asked about when the move fails). */
function filesUnder(dir) {
  const out = [];
  (function walk(d) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); }
  })(dir);
  return out;
}

/** The sentence for a folder that would not move. Names the real holder: a part of Ether, another program, or neither. */
function profileInUseMessage({ heldBy = [], holders = [], selfPid = process.pid, daemonPid = null,
                               lead = "Ether could not finish opening your account's folder", again = "sign in again" } = {}) {
  const failed = heldBy.filter((r) => !r.ok).map((r) => r.name);
  const partOf = (h) => (h.pid === selfPid ? "Ether's main program" : (daemonPid && h.pid === daemonPid) ? "Ether's audio engine" : null);
  const isOurs = (h) => !!partOf(h) || /^(ether|electron)(\.exe)?$/i.test(String(h.process || ""));
  const ours = holders.filter(isOurs), others = holders.filter((h) => !isOurs(h));
  const who = (hs) => hs.map((h) => `${h.app || h.process || "a program"} (${h.process ? h.process.replace(/\.exe$/i, "") + ".exe, " : ""}process ${h.pid})`).join(", ");
  if (others.length) {
    return `${lead}: ${who(others)} ${others.length === 1 ? "has" : "have"} a file in it open${ours.length ? ", and so does Ether" : ""}. Close ${others.length === 1 ? "that program" : "those programs"} (or let ${others.length === 1 ? "it" : "them"} finish) and ${again}.`;
  }
  if (ours.length || failed.length) {
    const parts = [...new Set([...ours.map((h) => partOf(h) || `Ether (process ${h.pid})`), ...failed])];
    return `${lead}: ${parts.join(" and ")} still had a file in it open after Ether closed everything it holds. Close Ether completely, including from the tray, open it again and ${again}.`;
  }
  return `${lead}: a file in it was still in use after Ether closed everything it holds, and Windows did not say which program has it (antivirus or backup software is the usual cause). Wait a minute and ${again}.`;
}

/**
 * Release → move → (on failure) find the holder → reacquire. Never throws.
 * @param o.from, o.to        folders
 * @param o.release()         closes every holder; resolves to [{ name, ok, error? }] (db-holders shape)
 * @param o.reacquire(moved)  reopens everything, on the new folder if moved, else on the old one
 * @param o.whoHolds(files)   → [{ pid, process, app }] (file-lockers-win)
 * @param o.daemonPid()       the audio engine's pid, to name it
 * @returns { ok: true, heldBy } | { ok: false, error: "profile_in_use", detail, code, holders, heldBy }
 */
async function moveProfileReleasing(o) {
  const log = (m) => { try { o.log && o.log(m); } catch {} };
  const rename = o.rename || fs.renameSync;
  const tries = o.tries ?? 15, waitMs = o.waitMs ?? 200;
  let heldBy = [], moved = false, lastErr = null;
  try {
    heldBy = (await o.release()) || [];
    for (const r of heldBy) log(`[profile-move] ${r.name}: ${r.ok ? (r.how || "closed") : "did NOT release: " + r.error}`);
    for (let i = 0; i < tries; i++) {
      try { rename(o.from, o.to); moved = true; break; }
      catch (e) {
        lastErr = e;
        if (!/^(EPERM|EBUSY|EACCES)$/.test(String(e.code))) break;     // not a lock: retrying will not help
        await sleep(waitMs);                                             // a scanner's momentary lock lets go
      }
    }
    if (moved) { log(`[profile-move] moved ${o.from} → ${o.to}`); return { ok: true, heldBy }; }
    let holders = [];
    try { holders = (await o.whoHolds(filesUnder(o.from))) || []; } catch (e) { log(`[profile-move] who holds: ${e.message}`); }
    const daemonPid = (() => { try { return o.daemonPid ? o.daemonPid() : null; } catch { return null; } })();
    log(`[profile-move] FAILED ${lastErr && lastErr.code} moving ${o.from}; Windows reports: ${holders.length ? holders.map((h) => `${h.process || "?"} (pid ${h.pid})`).join("; ") : "no holder named"}`);
    return { ok: false, error: "profile_in_use", code: lastErr && lastErr.code, holders, heldBy,
             detail: profileInUseMessage({ heldBy, holders, daemonPid }) };
  } finally {
    try { await o.reacquire(moved); } catch (e) { log(`[profile-move] reopen failed: ${e.message}`); }
  }
}

module.exports = { moveProfileReleasing, profileInUseMessage, filesUnder };

// audiod/catalogue-check.js — the engine's "is this file here?" through electron/catalogue.js, with the failure SAID.
//
// 4.6.66 (docs/engine-missing-catalogue-4.6.66-2026-10-27.md): engine.js did
//   try { here = require('../electron/catalogue').playableFile(fp); } catch { here = null; }
// The staged engine had no catalogue.js, the require threw on every call, and the catch turned it into "this file is not
// here" — every song unplayable, the queue never filled, and nothing in any log said why. Jeff: "Log the error at
// engine.js:1956." A failure here is now logged with its cause and the file it was checking: the first time, then again
// every 10 minutes while it keeps happening (a refill checks dozens of files in a burst — one line, not a flood).
"use strict";

const REPEAT_MS = 10 * 60 * 1000;
const said = new Map();            // cause → { at, count }

function loadCatalogue() { return require('../electron/catalogue'); }

/** The stored path when it plays here, else null. A failure of the check itself is logged through `log`, never hidden. */
function playableFile(fp, log, loader = loadCatalogue, now = Date.now) {
  try { return loader().playableFile(fp); }
  catch (e) {
    const cause = `${(e && e.code) || "error"}: ${(e && e.message || String(e)).split("\n")[0]}`;
    const s = said.get(cause) || { at: 0, count: 0 };
    s.count++;
    const t = now();
    if (!s.at || t - s.at >= REPEAT_MS) {
      s.at = t;
      try { log(`✗ catalogue check FAILED — ${cause} — every file reads as unplayable until this is fixed (${s.count} check(s) failed so far; this one: ${fp})`); } catch {}
    }
    said.set(cause, s);
    return null;
  }
}

module.exports = { playableFile, _said: said };

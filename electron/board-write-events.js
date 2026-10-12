// electron/board-write-events.js — "the saved board changed" as an EVENT (2026-10-12).
//
// docs/health-monitor-jump-and-freeze-2026-10-12.md. Jeff: "the mismatch check must be event-driven and cheap, with no
// polling DB reads." The board watch (electron/board-watch.js) keeps each station's saved board in memory and re-reads it
// only when a write to station_config_kv or deck_configs says it changed. Those writes go through the writer functions in
// electron/sync/handlers/{station_config_kv,deck_configs}.js (the IPC handlers and main both call them; raw db:execute
// is locked against these synced tables), and an inbound sync pull reports its tables (main.js onProgress). Each writer
// is wrapped here, so a new caller can't forget to say so.
"use strict";

const listeners = new Set();

/** Subscribe: fn({ table, stationId, key }) — stationId null = could be any station. Returns an unsubscribe. */
function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function notify(info) {
  for (const l of listeners) { try { l(info); } catch { /* a listener never breaks a write */ } }
}

/** A writer that announces itself after it returns (only when it did not throw). */
function wrap(table, fn, infoOf) {
  return function wrapped(...args) {
    const r = fn.apply(this, args);
    let info = { table, stationId: null, key: null };
    try { info = { table, ...(infoOf ? infoOf(...args) : {}) }; } catch { /* announce as "any station" */ }
    notify(info);
    return r;
  };
}

module.exports = { on, notify, wrap };

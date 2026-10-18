// audiod/show-start.js — the decision "a show has started: turn AUTO on here?" (Jeff, 2026-10-18: "when a show hour is
// scheduled auto turns on"). Pure; ether-audiod.js _showStartTick feeds it the database, the arms and the engines.
//
// AUTO turns on at the START of a show run (a different show, or the same show again after a gap), only on a machine
// where the operator's last press for that station was AUTO (armed; machine-local — one machine per station
// broadcasts), and never on the first look after start-up (that only records what is on).
"use strict";
const SW = require("./show-window");

/**
 * @param {Map<number,string>} seen   stationId → last seen run key ("" = no show), mutated
 * @param {{id:number, shows:object[], armed:boolean, started:boolean}[]} stations
 * @param {number} nowTs
 * @returns {{start: {id:number, show:string}[], notArmed: {id:number, show:string}[]}}
 */
function decideShowStarts(seen, stations, nowTs) {
  const start = [], notArmed = [];
  for (const st of stations) {
    const run = SW.showRunAt(st.shows || [], nowTs);
    const key = run ? run.show.id + "@" + run.startTs : "";
    const prev = seen.get(st.id);
    seen.set(st.id, key);
    if (prev === undefined || !key || key === prev) continue;
    if (!st.armed) { notArmed.push({ id: st.id, show: run.show.name }); continue; }
    if (st.started) continue;
    start.push({ id: st.id, show: run.show.name });
  }
  return { start, notArmed };
}
module.exports = { decideShowStarts };

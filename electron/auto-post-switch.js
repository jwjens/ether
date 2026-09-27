// auto-post-switch — THE switch for AUTO-POST (audit 11; Jeff's ruling 2026-09-27: "build it as a station setting
// in the Sweepers panel … A behaviour with no switch is a hidden number").
//
// AUTO-POST places a sweeper so it ENDS at the incoming song's post (docs/imaging-shortest-path-to-air-2026-09-08.md).
// It used to be asked for by categories.overlay_chain_type, which nothing in the app could write. The one switch is
// now this station key, written by the Sweepers panel through upsertByKey — synced with the station, because it is a
// decision about the station's sound. Unset, or anything but "1", is OFF: the LEAD path, exactly as before.
"use strict";
const AUTO_POST_KEY = "overlay_auto_post";

function readAutoPost(db, stationId) {
  try {
    const r = db.prepare("SELECT value FROM station_config_kv WHERE key = ? AND station_id = ? AND deleted_at IS NULL").get(AUTO_POST_KEY, stationId);
    return !!r && String(r.value) === "1";
  } catch { return false; }
}

module.exports = { AUTO_POST_KEY, readAutoPost };

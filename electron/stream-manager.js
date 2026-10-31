// TOOLS → STREAM MANAGER: THE REAL STREAM (Jeff, 2026-10-30: "Tools → Stream Manager (real start/stop and real status)").
//
// The screen used to drive three stubs (stream_start / stream_status / stream_health in main.js) that set a flag and
// invented an uptime, and it edited an old stream_settings row the real stream never reads. Now it is a view of the ONE
// real stream the ON AIR button runs (stream:go-live / stream:stop-live), for the active station:
//   - settings are the station's own icecast_* columns (the ones go-live reads, the same Station Manager edits);
//   - status is the encoder's own (the daemon's StreamSupervisor.status(), or the in-process stream state);
//   - listeners come from the Icecast server's own status page for that mount.
// Nothing here invents a value: what is not known is null and the screen says so.

const ICECAST_PORT = 8000;        // go-live pushes to :8000 (main.js stream:go-live; the port setting is item 39)
const LISTENERS_TIME_LIMIT_MS = 4000;

/** The encoder status → what the screen shows. `src` is the daemon's status() or the in-process stream state. */
function statusOf(src) {
  if (!src) return { state: "idle", errorMsg: null, uptimeSec: null, bitrateKbps: null };
  const state = src.state ?? src.statusState ?? "idle";
  const uptimeSec = src.uptimeSec != null ? src.uptimeSec
                  : src.startTime ? Math.floor((Date.now() - src.startTime) / 1000) : null;
  return {
    state: ["idle", "connecting", "live", "error"].includes(state) ? state : "idle",
    errorMsg: state === "idle" ? null : (src.errorMsg || null),   // a stopped stream has no error to show
    uptimeSec: state === "live" ? uptimeSec : null,
    bitrateKbps: src.bitrate != null ? src.bitrate : null,
  };
}

/** The station's real stream settings, as go-live resolves them. The password is never sent to the screen, only whether one is set. */
function settingsOf(station) {
  if (!station) return null;
  const SA = require("./stream-args");
  return {
    stationId: station.id,
    stationUuid: station.uuid || null,
    stationName: station.name || "",
    server: (station.icecast_server_url || "").trim(),
    mount: (station.icecast_mount || "").trim(),
    bitrateKbps: SA.icecastBitrateOf(station),
    hasPassword: !!(station.icecast_password || "").trim(),
    port: ICECAST_PORT,
  };
}

/** Icecast status-json → that mount's listener count, or null when the mount is not on the server (not connected). */
function listenersFor(statusJson, mount) {
  const src = statusJson && statusJson.icestats && statusJson.icestats.source;
  const list = Array.isArray(src) ? src : src ? [src] : [];
  const want = String(mount || "").trim();
  if (!want) return null;
  for (const s of list) {
    let path = "";
    try { path = new URL(String(s.listenurl || "")).pathname; } catch { path = ""; }
    if (path === want) return Number.isFinite(Number(s.listeners)) ? Number(s.listeners) : null;
  }
  return null;
}

/** Ask the Icecast server. → { ok: true, listeners } (null = the mount is not on the server) | { ok: false, error } */
async function fetchListeners({ server, mount, fetchImpl = fetch, timeLimitMs = LISTENERS_TIME_LIMIT_MS }) {
  if (!server || !mount) return { ok: false, error: "no server or mount set" };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeLimitMs);
  try {
    const r = await fetchImpl(`http://${server}:${ICECAST_PORT}/status-json.xsl`, { signal: ctl.signal });
    if (!r.ok) return { ok: false, error: `the server answered ${r.status}` };
    return { ok: true, listeners: listenersFor(await r.json(), mount) };
  } catch (e) {
    return { ok: false, error: e && e.name === "AbortError" ? "the server did not answer in time" : `could not reach the server (${e && e.message || e})` };
  } finally { clearTimeout(t); }
}

/** A settings edit from the screen → the stations patch go-live will read. Only the four stream fields; blank password = keep. */
function patchFrom(edit) {
  const p = {};
  if (edit.server != null) p.icecast_server_url = String(edit.server).trim();
  if (edit.mount != null) { const m = String(edit.mount).trim(); p.icecast_mount = m && !m.startsWith("/") ? "/" + m : m; }
  if (edit.bitrateKbps != null && Number.isFinite(Number(edit.bitrateKbps))) p.icecast_bitrate = Number(edit.bitrateKbps);
  if (edit.password != null && String(edit.password) !== "") p.icecast_password = String(edit.password);
  return p;
}

module.exports = { statusOf, settingsOf, listenersFor, fetchListeners, patchFrom, ICECAST_PORT };

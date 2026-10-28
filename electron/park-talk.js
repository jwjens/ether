// electron/park-talk.js — PARK MIC / Hold to talk: the station's settings and state, pure (2026-10-16;
// docs/park-mic-build-2026-10-16.md). Main reads the database and the daemon; everything that DECIDES is here, tested.
//
// Jeff: "2 Park mic input sources (Park Mic 1, Park Mic 2), listed under Mic with the other inputs. The user puts each on
// any fader; that fader's existing settings (MAIN/AUX, ON, stream) decide where it's heard. … On the phone, HOLD TO TALK
// lets staff pick which Park mic to talk on, shown by the user's names. … logged-in only, one talker per mic, studio lock,
// follows MUTE where it reaches the park, STOP in Ether, who/when shown, limiter, longest talk 20 s, echo cancellation and
// noise suppression ON, auto gain OFF."
"use strict";

const PARK_MICS = [1, 2];
const parkDevice = (n) => `park:${n}`;
const parkMicOf = (device) => { const m = /^park:(\d+)$/.exec(String(device || "")); const n = m ? Number(m[1]) : NaN; return PARK_MICS.includes(n) ? n : null; };

/** The station's Hold-to-talk settings (station_config_kv, synced with the station). */
// NO TIME LIMIT (Jeff, 2026-10-16): "no automatic stop and no 'longest talk' setting. Turning the mic off is the user's
// job. Ether's STOP button and the studio lock already cover a forgotten mic."
const KEYS = {
  echo: "park_talk_echo_cancel",          // "1" / "0" — the phone's echo cancellation
  noise: "park_talk_noise_suppress",      // "1" / "0" — the phone's noise suppression
  agc: "park_talk_auto_gain",             // "1" / "0" — the phone's automatic gain
};
// NO PARK MIC LIMITER (Jeff, 2026-10-16): "The Park mic fader uses its own processor like every other fader, and nothing
// is applied automatically or baked in." No limiter settings, nothing written into a fader's rack.
const nameKey = (n) => `park_mic_${n}_name`;
const lastKey = (n) => `park_talk_last_${n}`;
/** Jeff's numbers (2026-10-15/16), written once — when a Park mic is first put on a fader — never over a set value. */
// Auto gain ON (Jeff, 2026-10-16: "Turn phone auto gain ON for the Park mic, so talking close doesn't clip and staff
// don't need an exact distance").
const START = { echo: "1", noise: "1", agc: "1" };
/** PARK MIC BUFFER (Jeff, 2026-10-16: a visible setting "starting at 120 ms"): how much voice the engine holds before
 *  playing, to ride out phone internet. Applied by the daemon (audiod/engine.js); not needed for "ready" (the engine
 *  starts at the same 120). */
const BUFFER_KEY = "park_mic_buffer_ms";
const BUFFER_START = "120";
const BUFFER_RANGE = [20, 1000];
const DEFAULT_NAME = (n) => `Park Mic ${n}`;
const ALL_KEYS = [...Object.values(KEYS), BUFFER_KEY, ...PARK_MICS.map(nameKey), ...PARK_MICS.map(lastKey)];

/** @param get (key) => stored value | undefined */
function readSettings(get) {
  const missing = [];
  const val = (k) => { const v = get(k); return v == null || String(v).trim() === "" ? null : String(v).trim(); };
  const flag = (k) => { const v = val(k); if (v !== "1" && v !== "0") { missing.push(k); return null; } return v === "1"; };
  const echo = flag(KEYS.echo), noise = flag(KEYS.noise), agc = flag(KEYS.agc);
  const names = {};
  for (const n of PARK_MICS) names[n] = (val(nameKey(n)) || DEFAULT_NAME(n)).slice(0, 40);
  const b = Number(val(BUFFER_KEY));
  const bufferMs = Number.isFinite(b) && b >= BUFFER_RANGE[0] && b <= BUFFER_RANGE[1] ? b : null;
  return { ready: missing.length === 0, missing, echo, noise, agc, bufferMs, names };
}

/** The writes that put Jeff's starting values in, for keys not set yet. [[key, value]] */
function seedWrites(get) {
  const out = [];
  for (const [k, key] of Object.entries(KEYS)) { const v = get(key); if (v == null || String(v).trim() === "") out.push([key, START[k]]); }
  { const v = get(BUFFER_KEY); if (v == null || String(v).trim() === "") out.push([BUFFER_KEY, BUFFER_START]); }
  return out;
}

/** Which fader each Park mic is on, from the machine's mic patches ({ slot: { device } }). The first fader wins, as the
 *  engine's: a second fader patched to the same Park mic takes it over, so the LAST patched is live — but patches carry
 *  no order, so a mic on two faders is reported as a conflict. */
function micFaders(patches) {
  const out = {}; const conflicts = {};
  for (const n of PARK_MICS) out[n] = null;
  for (const [slot, p] of Object.entries(patches || {})) {
    const n = parkMicOf(p && p.device);
    if (!n) continue;
    if (out[n]) (conflicts[n] = conflicts[n] || [out[n]]).push(slot); else out[n] = slot;
  }
  return { faders: out, conflicts };
}

/** park_talk_last_<n>: { by, at (ISO), sec, how } or null. */
function parseLast(raw) {
  if (!raw) return null;
  try { const v = JSON.parse(raw); return v && typeof v.at === "string" && Number.isFinite(Number(v.sec)) ? v : null; } catch { return null; }
}

const HOW = { released: "", limit: "cut at the limit", lease: "phone gone", locked: "locked by the studio", ether: "stopped in Ether",
              "no-audio": "no voice arrived", shutdown: "Ether closed" };
/** "Last: Ryan, 8:42 PM, 14 s" (+ ", stopped in Ether"). `fmtTime` is injected so the test does not depend on the locale. */
function lastLine(last, fmtTime) {
  if (!last) return null;
  const t = new Date(last.at); if (isNaN(t.getTime())) return null;
  const how = HOW[last.how] || "";
  return `Last: ${last.by || "someone"}, ${fmtTime(t)}, ${Math.round(Number(last.sec))} s${how ? `, ${how}` : ""}`;
}

/** Why a start is refused, or null. Every reason is a sentence the Park page shows. */
function refusal({ locked, settings, fader, daemon }) {
  if (!daemon) return "Hold to talk needs the audio engine — it is not running on this computer.";
  if (locked) return "Controls locked by the studio";
  if (!settings.ready) return "Hold to talk isn't set up on this station yet (Ether → Settings → Park Page → Hold to talk).";
  if (!fader) return "That Park mic isn't on a fader in Ether.";
  return null;
}

module.exports = { PARK_MICS, parkDevice, parkMicOf, KEYS, BUFFER_KEY, BUFFER_START, BUFFER_RANGE, nameKey, lastKey, START, ALL_KEYS, DEFAULT_NAME,
  readSettings, seedWrites, micFaders, parseLast, lastLine, refusal, HOW };

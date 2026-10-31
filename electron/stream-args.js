// electron/stream-args.js — the Icecast encoder's settings, ONE place for both stream paths (2026-10-11).
//
// docs/audio-numbers-audit-2026-10-11.md: the daemon's stream used the station's `icecast_bitrate`; the in-process
// (fallback) path hard-coded `-b:a 128k`, so a station set to 192 kb/s streamed at 128 whenever the app fell back.
// Both paths now take the bitrate from here.
"use strict";

/** The station's Icecast bitrate in kb/s: the saved value, else the column's own default (128, stations table). */
function icecastBitrateOf(station) {
  const n = Number(station && station.icecast_bitrate);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 128;
}

const { streamFormatOf, formatArgs } = require("../audiod/stream-format");

/** ffmpeg arguments for the in-process programme-bus encoder. `format` = the station's Format (mp3 / aac / ogg). */
function programBusEncoderArgs({ port, sampleRate, bitrateKbps, url, format = "mp3" }) {
  const fa = formatArgs(format, bitrateKbps);
  if (!fa.ok) throw new Error(fa.error);
  return [
    "-f", "f32le", "-ar", String(sampleRate), "-ac", "2",
    "-i", `tcp://127.0.0.1:${port}`,
    ...fa.args,
    url,
  ];
}

module.exports = { icecastBitrateOf, programBusEncoderArgs, streamFormatOf, formatArgs };

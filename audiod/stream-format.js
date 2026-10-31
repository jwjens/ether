// audiod/stream-format.js — the Icecast stream FORMAT, one place for both stream paths (dead-controls item 13).
//
// Station Manager → Format offered MP3 / AAC / OGG and both encoders were hard-wired to MP3 (libmp3lame, audio/mpeg), so
// the choice did nothing. The chosen format now picks the encoder, the container and the content type. All three
// encoders are in the bundled ffmpeg-static (aac, libmp3lame, libvorbis — checked with `ffmpeg -encoders`). A value this
// does not know is refused with a reason, never quietly streamed as MP3.
"use strict";

const FORMATS = {
  mp3: { codec: "libmp3lame", container: "mp3",  contentType: "audio/mpeg", label: "MP3" },
  aac: { codec: "aac",        container: "adts", contentType: "audio/aac",  label: "AAC" },
  ogg: { codec: "libvorbis",  container: "ogg",  contentType: "audio/ogg",  label: "OGG (Vorbis)" },
};

/** The station's saved format, lower-cased; unset → 'mp3' (the column's own default, stations.icecast_format). */
function streamFormatOf(station) {
  const v = String((station && station.icecast_format) ?? "").trim().toLowerCase();
  return v || "mp3";
}

/** → { ok, args } the encoder/container/content-type arguments, or { ok:false, error } for a format we can't stream. */
function formatArgs(format, bitrateKbps) {
  const f = FORMATS[String(format || "mp3").toLowerCase()];
  if (!f) return { ok: false, error: `The stream format "${format}" isn't supported. Choose MP3, AAC or OGG in Station Manager.` };
  return { ok: true, format: String(format).toLowerCase(), args: ["-c:a", f.codec, "-b:a", `${bitrateKbps}k`, "-f", f.container, "-content_type", f.contentType] };
}

module.exports = { FORMATS, streamFormatOf, formatArgs };

// Station Manager → Format (dead-controls item 13): the stream was always MP3 whatever was chosen. The format now picks
// the encoder, container and content type on BOTH stream paths (daemon audiod/stream.js and in-process main.js).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const SF = require_("../audiod/stream-format.js");
const SA = require_("./stream-args.js");
const mainSrc = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const streamSrc = fs.readFileSync(path.join(__dirname, "..", "audiod", "stream.js"), "utf8");
const after = (a, flag) => a[a.indexOf(flag) + 1];

describe("stream format", () => {
  it("MP3 / AAC / OGG each get their own encoder, container and content type", () => {
    const mp3 = SF.formatArgs("mp3", 128).args, aac = SF.formatArgs("aac", 96).args, ogg = SF.formatArgs("ogg", 192).args;
    expect([after(mp3, "-c:a"), after(mp3, "-f"), after(mp3, "-content_type")]).toEqual(["libmp3lame", "mp3", "audio/mpeg"]);
    expect([after(aac, "-c:a"), after(aac, "-f"), after(aac, "-content_type"), after(aac, "-b:a")]).toEqual(["aac", "adts", "audio/aac", "96k"]);
    expect([after(ogg, "-c:a"), after(ogg, "-f"), after(ogg, "-content_type")]).toEqual(["libvorbis", "ogg", "audio/ogg"]);
  });
  it("the station's saved value; unset = the column default mp3; an unknown value is refused, not streamed as MP3", () => {
    expect(SF.streamFormatOf({ icecast_format: "AAC" })).toBe("aac");
    expect(SF.streamFormatOf({})).toBe("mp3");
    expect(SF.formatArgs("wma", 128).ok).toBe(false);
  });
  it("reaches the in-process encoder", () => {
    const a = SA.programBusEncoderArgs({ port: 5000, sampleRate: 44100, bitrateKbps: 128, url: "icecast://x", format: "ogg" });
    expect(after(a, "-c:a")).toBe("libvorbis");
    expect(a[a.length - 1]).toBe("icecast://x");
  });
  it("both paths take the format; neither hard-codes MP3", () => {
    expect(mainSrc).toMatch(/config: \{ server, password: pw, mount, bitrate, format,/);
    expect(mainSrc).toMatch(/url: state\.url, format \}/);
    expect(streamSrc).not.toMatch(/"libmp3lame"/);
    expect(streamSrc).toMatch(/formatArgs\(config\.format \|\| "mp3", this\._bitrate\)/);
  });
});

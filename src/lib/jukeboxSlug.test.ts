import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { jukeboxSlug } from "./jukeboxSlug";

const require_ = createRequire(import.meta.url);
const main = require_("../../electron/jukebox-slug.js");

const CASES: [string | null | undefined, string | null][] = [
  ["party", "party"], ["PARTY", "party"], ["/party/", "party"], ["  party ", "party"],
  ["https://listen.ether-technologies.com/jukebox/party", "party"],
  ["https://listen.ether-cast.com/jukebox/Party/lobby", "party"],
  ["http://listen.ether-technologies.com/jukebox/my-station?x=1#top", "my-station"],
  ["https://example.com/party", "party"],
  ["https://listen.ether-technologies.com/jukebox/", null],
  ["https://listen.ether-technologies.com/", null],
  ["bad name!", null], ["", null], [null, null], [undefined, null], ["https://", null],
];

describe("jukebox request name", () => {
  it("is read from a short name or a full https:// address", () => {
    for (const [raw, want] of CASES) expect(jukeboxSlug(raw), String(raw)).toBe(want);
  });
  it("the main process reads it exactly the same way", () => {
    for (const [raw] of CASES) expect(main.jukeboxSlug(raw), String(raw)).toBe(jukeboxSlug(raw));
  });
});

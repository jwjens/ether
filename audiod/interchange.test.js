// INTERCHANGE (2026-10-04) — the daemon and main-process half. "carts announcements jukebox sweepers link they all are
// just input sources and need to work interchangeably on all faders."
//
// ether-audiod.js and electron/main.js load the native addon, so vitest cannot import them. The rule lives in a small
// pure module (jukebox-decks.js) and the call sites are pinned by source contract, the cart-observe.js pattern.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const SOURCE = ["D", "E", "F", "S1", "S2", "S3", "S4", "S5"];
const read = (p) => fs.readFileSync(path.resolve(__dirname, p), "utf8");

describe("jukebox decks — every source fader", () => {
  it("JUKEBOX_DECKS is exactly the source slots", () => {
    const { JUKEBOX_DECKS } = require_("./jukebox-decks.js");
    expect([...JUKEBOX_DECKS]).toEqual(SOURCE);
  });
  it("jukeboxDeck() accepts every source slot (any case) and refuses rotation decks, CART and junk", () => {
    const { jukeboxDeck } = require_("./jukebox-decks.js");
    for (const s of SOURCE) { expect(jukeboxDeck(s)).toBe(s); expect(jukeboxDeck(s.toLowerCase())).toBe(s); }
    for (const s of ["A", "B", "C", "CART", "S6", "", null, undefined, "G"]) expect(jukeboxDeck(s)).toBe(null);
  });
  it("the daemon's jukebox:play / stop / state all gate on the shared module, not a D/E/F literal", () => {
    const src = read("./ether-audiod.js");
    expect(src).toMatch(/require\("\.\/jukebox-decks"\)/);
    expect(src).not.toMatch(/JUKEBOX_DECKS\s*=\s*\[\s*"D",\s*"E",\s*"F"\s*\]/);
    for (const h of ["jukebox:play", "jukebox:stop", "jukebox:state"]) {
      const body = src.slice(src.indexOf(`"${h}":`), src.indexOf(`"${h}":`) + 400);
      expect(body, h).toMatch(/jukeboxDeck\(m\.deck\)/);
    }
  });
  it("electron main's jukebox IPC gates on the same module", () => {
    const src = read("../electron/main.js");
    expect(src).toMatch(/require\("\.\.\/audiod\/jukebox-decks"\)/);
    expect(src).not.toMatch(/JUKEBOX_DECKS\s*=\s*\[\s*"D",\s*"E",\s*"F"\s*\]/);
    for (const h of ["jukebox:play", "jukebox:stop", "jukebox:deck-state"]) {
      const body = src.slice(src.indexOf(`ipcMain.handle("${h}"`), src.indexOf(`ipcMain.handle("${h}"`) + 300);
      expect(body, h).toMatch(/jukeboxDeck\(req\?\.deck\)/);
    }
  });
});

describe("room / aux path — every source fader", () => {
  it("a show Take carries a room level for S1..S5 exactly as for D/E/F, and never for A/B/C/CART", () => {
    const { engineDoc } = require_("./show-presets.js");
    const channels = {};
    for (const s of [...SOURCE, "A", "B", "C", "CART"]) channels[s] = { enabled: true, roomLevel: 0.5 };
    const doc = engineDoc({ board: { channels } }, [...SOURCE, "A", "B", "C", "CART"], false);
    for (const s of SOURCE) expect(doc.slots[s] && doc.slots[s].room, s).toBe(0.5);
    for (const s of ["A", "B", "C", "CART"]) expect(doc.slots[s] ? doc.slots[s].room : undefined, s).toBeUndefined();
  });
  it("the native aux-monitor setter is not D/E/F-only any more", () => {
    const audio = read("../native/src/audio.rs");
    const show = read("../native/src/show.rs");
    expect(audio).not.toMatch(/AUX DECKS ONLY/);
    expect(audio).not.toMatch(/Only indices 3\/4\/5 are ever non-zero/);
    expect(show).not.toMatch(/if !\(3\.\.=5\)\.contains\(&idx\) \{ return; \}/);
  });
  it("audio_get_state reports the S1..S5 decks (the jukebox's deck-state read and the renderer poll need them)", () => {
    // The behaviour is proven natively (lib.rs source_slot_meta::get_state_reports_every_source_slot_and_its_end); this
    // pins that audio_get_state still emits a `deck<S>` entry for each of S1..S5 from its own record and finished flag.
    const lib = read("../native/src/lib.rs");
    const body = lib.slice(lib.indexOf("pub fn audio_get_state"), lib.indexOf("pub fn audio_get_levels"));
    expect(body).toMatch(/\["S1", "S2", "S3", "S4", "S5"\]/);
    expect(body).toMatch(/st\[format!\("deck\{\}", S_IDS\[k\]\)\] = serde_json::json!\(audio\.deck_s\[k\]\.info\(S_IDS\[k\], fin_s\[k\]\)\)/);
  });
});

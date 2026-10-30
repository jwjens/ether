// SHOW+ DAW → DECK (Jeff, 2026-10-30: "fix "To Deck" so the audio actually reaches a deck").
//
// The DAW renders its mix in the window it runs in (usually its own pop-out). A deck only plays a FILE, so the mix is
// written into this account's folder (showplus-sends/) and handed to the same deck load every other door uses
// (main.js loadDeckFile → the daemon, or the in-process engine). Nothing here plays audio on its own; the deck the
// operator picked is loaded and the board decides what airs.
//
// Old sends are removed after a week, never the one just written.
const path = require("path");

const DECKS = ["A", "B", "C"];
const KEEP_MS = 7 * 24 * 3600 * 1000;
const NAME_RE = /^show-plus-mix-\d+\.wav$/;

/** The file name for a send made at `now`. */
const sendFileName = (now) => `show-plus-mix-${now}.wav`;

/**
 * @param req   { deck: "A"|"B"|"C", wav: Uint8Array|Buffer (a WAV file), stationId }
 * @param deps  { dir, fs (node fs), load(deck, filePath, title, artist, gainDb, stationId) → Promise<boolean>, now }
 * @returns { ok: true, deck, filePath } | { ok: false, reason }
 */
async function sendMixToDeck(req, { dir, fs, load, now = Date.now() }) {
  const deck = String(req?.deck || "").toUpperCase();
  if (!DECKS.includes(deck)) return { ok: false, reason: "deck-not-allowed" };
  const bytes = req?.wav;
  if (!bytes || !bytes.length) return { ok: false, reason: "nothing-to-send" };
  const buf = Buffer.from(bytes.buffer ? new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength ?? bytes.length) : bytes);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return { ok: false, reason: "not-a-wav" };

  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, sendFileName(now));
  fs.writeFileSync(filePath, buf);
  for (const name of fs.readdirSync(dir)) {
    const m = NAME_RE.test(name) && /(\d+)/.exec(name);
    if (m && now - Number(m[1]) > KEEP_MS) { try { fs.unlinkSync(path.join(dir, name)); } catch {} }
  }
  const loaded = await load(deck, filePath, "Show+ Mix", "", 0, req?.stationId ?? null);
  return loaded === false ? { ok: false, reason: "load-failed", filePath } : { ok: true, deck, filePath };
}

module.exports = { sendMixToDeck, sendFileName, DECKS, KEEP_MS };

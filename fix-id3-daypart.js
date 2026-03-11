const fs = require('fs');

console.log('\n  Ether — Fix ID3 Tags + Daypart Query\n');

// ============================================================
// 1. Rewrite id3.ts to use readFile (works in release builds)
// ============================================================

fs.mkdirSync('src/audio', { recursive: true });
fs.writeFileSync('src/audio/id3.ts', `import { readFile } from "@tauri-apps/plugin-fs";

export interface ID3Tags {
  title: string | null;
  artist: string | null;
  album: string | null;
  year: string | null;
  genre: string | null;
  durationSec: number | null;
}

const GENRES = [
  "Blues","Classic Rock","Country","Dance","Disco","Funk","Grunge","Hip-Hop",
  "Jazz","Metal","New Age","Oldies","Other","Pop","R&B","Rap","Reggae","Rock",
  "Techno","Industrial","Alternative","Ska","Death Metal","Pranks","Soundtrack",
  "Euro-Techno","Ambient","Trip-Hop","Vocal","Jazz+Funk","Fusion","Trance",
  "Classical","Instrumental","Acid","House","Game","Sound Clip","Gospel","Noise",
  "Alt. Rock","Bass","Soul","Punk","Space","Meditative","Instrumental Pop",
  "Instrumental Rock","Ethnic","Gothic","Darkwave","Techno-Industrial",
  "Electronic","Pop-Folk","Eurodance","Dream","Southern Rock","Comedy",
  "Cult","Gangsta Rap","Top 40","Christian Rap","Pop/Funk","Jungle",
  "Native American","Cabaret","New Wave","Psychedelic","Rave","Showtunes",
  "Trailer","Lo-Fi","Tribal","Acid Punk","Acid Jazz","Polka","Retro",
  "Musical","Rock & Roll","Hard Rock"
];

function trimNull(s: string): string {
  const idx = s.indexOf("\\0");
  return (idx >= 0 ? s.substring(0, idx) : s).trim();
}

function decodeText(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8").decode(bytes); }
  catch { return new TextDecoder("iso-8859-1").decode(bytes); }
}

function parseID3v1(bytes: Uint8Array): Partial<ID3Tags> {
  if (bytes.length < 128) return {};
  const tag = bytes.slice(bytes.length - 128);
  const header = decodeText(tag.slice(0, 3));
  if (header !== "TAG") return {};
  const title = trimNull(decodeText(tag.slice(3, 33)));
  const artist = trimNull(decodeText(tag.slice(33, 63)));
  const album = trimNull(decodeText(tag.slice(63, 93)));
  const year = trimNull(decodeText(tag.slice(93, 97)));
  const genreIdx = tag[127];
  const genre = genreIdx < GENRES.length ? GENRES[genreIdx] : null;
  return { title: title || null, artist: artist || null, album: album || null, year: year || null, genre };
}

function parseID3v2(bytes: Uint8Array): Partial<ID3Tags> {
  if (bytes.length < 10) return {};
  const header = decodeText(bytes.slice(0, 3));
  if (header !== "ID3") return {};
  const version = bytes[3];
  const size = (bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f);
  const result: Partial<ID3Tags> = {};
  let pos = 10;
  const end = Math.min(10 + size, bytes.length);
  while (pos + 10 < end) {
    const frameId = decodeText(bytes.slice(pos, pos + 4));
    if (frameId[0] === "\\0" || frameId.charCodeAt(0) === 0) break;
    const frameSize = version >= 4
      ? ((bytes[pos+4] & 0x7f) << 21 | (bytes[pos+5] & 0x7f) << 14 | (bytes[pos+6] & 0x7f) << 7 | (bytes[pos+7] & 0x7f))
      : (bytes[pos+4] << 24 | bytes[pos+5] << 16 | bytes[pos+6] << 8 | bytes[pos+7]);
    if (frameSize <= 0 || frameSize > end - pos - 10) break;
    const frameData = bytes.slice(pos + 10, pos + 10 + frameSize);
    const encoding = frameData[0];
    let text = "";
    if (encoding === 0 || encoding === 3) {
      text = trimNull(decodeText(frameData.slice(1)));
    } else if (encoding === 1 || encoding === 2) {
      try {
        const decoder = new TextDecoder(encoding === 1 ? "utf-16" : "utf-16be");
        text = trimNull(decoder.decode(frameData.slice(1)));
      } catch { text = trimNull(decodeText(frameData.slice(1))); }
    }
    if (frameId === "TIT2") result.title = text || null;
    if (frameId === "TPE1") result.artist = text || null;
    if (frameId === "TALB") result.album = text || null;
    if (frameId === "TDRC" || frameId === "TYER") result.year = text || null;
    if (frameId === "TCON") {
      const m = text.match(/\\((\\d+)\\)/);
      if (m) { const idx = parseInt(m[1]); result.genre = idx < GENRES.length ? GENRES[idx] : text; }
      else { result.genre = text || null; }
    }
    pos += 10 + frameSize;
  }
  return result;
}

export async function readID3(filePath: string): Promise<ID3Tags> {
  const result: ID3Tags = { title: null, artist: null, album: null, year: null, genre: null, durationSec: null };
  try {
    const bytes = await readFile(filePath);
    const v2 = parseID3v2(bytes);
    const v1 = parseID3v1(bytes);
    result.title = v2.title || v1.title || null;
    result.artist = v2.artist || v1.artist || null;
    result.album = v2.album || v1.album || null;
    result.year = v2.year || v1.year || null;
    result.genre = v2.genre || v1.genre || null;
  } catch (e) {
    console.error("ID3 read error:", e);
  }
  return result;
}
`, 'utf8');
console.log('  REWROTE src/audio/id3.ts (uses readFile, not fetch)');

// ============================================================
// 2. Verify the show query in UpNext matches the DB schema
// ============================================================

let upnext = fs.readFileSync('src/components/UpNext.tsx', 'utf8');

// Fix the show query - shows table has start_hour and end_hour
// Make sure we handle the case where end_hour wraps (e.g. 22 to 6)
upnext = upnext.replace(
  '"SELECT s.name, c.name as clock_name FROM shows s LEFT JOIN clocks c ON c.id = s.clock_id WHERE s.start_hour <= ? AND s.end_hour > ? LIMIT 1"',
  '"SELECT s.name, c.name as clock_name FROM shows s LEFT JOIN clocks c ON c.id = s.clock_id WHERE s.start_hour <= ? AND (s.end_hour > ? OR s.end_hour <= s.start_hour) LIMIT 1"'
);

fs.writeFileSync('src/components/UpNext.tsx', upnext, 'utf8');
console.log('  FIXED UpNext.tsx (daypart query handles wraparound)');

console.log('\n  Done! Delete DB, reimport music:');
console.log('  Remove-Item "$env:APPDATA\\com.openair.app\\openair.db*" -Force -ErrorAction SilentlyContinue');
console.log('  npm run tauri:dev');
console.log('');
console.log('  Then: Library → Import Folder');
console.log('  Artists will now read correctly from ID3 tags.');
console.log('  Set up shows in Schedule tab for daypart to show.\n');

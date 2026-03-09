const fs = require('fs');

console.log('\n  Ether — ID3 Tag Reading Update\n');

// ============================================================
// src/audio/id3.ts — Simple ID3 tag parser (no dependencies)
// Reads ID3v1 (last 128 bytes) and basic ID3v2 (header)
// ============================================================

fs.mkdirSync('src/audio', { recursive: true });
fs.writeFileSync('src/audio/id3.ts', [
'import { convertFileSrc } from "@tauri-apps/api/core";',
'',
'export interface ID3Tags {',
'  title: string | null;',
'  artist: string | null;',
'  album: string | null;',
'  year: string | null;',
'  genre: string | null;',
'  durationSec: number | null;',
'}',
'',
'// ID3v1 genre list (subset)',
'const GENRES = [',
'  "Blues","Classic Rock","Country","Dance","Disco","Funk","Grunge","Hip-Hop",',
'  "Jazz","Metal","New Age","Oldies","Other","Pop","R&B","Rap","Reggae","Rock",',
'  "Techno","Industrial","Alternative","Ska","Death Metal","Pranks","Soundtrack",',
'  "Euro-Techno","Ambient","Trip-Hop","Vocal","Jazz+Funk","Fusion","Trance",',
'  "Classical","Instrumental","Acid","House","Game","Sound Clip","Gospel","Noise",',
'  "Alt. Rock","Bass","Soul","Punk","Space","Meditative","Instrumental Pop",',
'  "Instrumental Rock","Ethnic","Gothic","Darkwave","Techno-Industrial",',
'  "Electronic","Pop-Folk","Eurodance","Dream","Southern Rock","Comedy",',
'  "Cult","Gangsta Rap","Top 40","Christian Rap","Pop/Funk","Jungle",',
'  "Native American","Cabaret","New Wave","Psychedelic","Rave","Showtunes",',
'  "Trailer","Lo-Fi","Tribal","Acid Punk","Acid Jazz","Polka","Retro",',
'  "Musical","Rock & Roll","Hard Rock"',
'];',
'',
'function trimNull(s: string): string {',
'  const idx = s.indexOf("\\0");',
'  return (idx >= 0 ? s.substring(0, idx) : s).trim();',
'}',
'',
'function decodeText(bytes: Uint8Array): string {',
'  try { return new TextDecoder("utf-8").decode(bytes); }',
'  catch { return new TextDecoder("iso-8859-1").decode(bytes); }',
'}',
'',
'// Parse ID3v1 tag from last 128 bytes',
'function parseID3v1(data: ArrayBuffer): Partial<ID3Tags> {',
'  const bytes = new Uint8Array(data);',
'  if (bytes.length < 128) return {};',
'  const tag = bytes.slice(bytes.length - 128);',
'  const header = decodeText(tag.slice(0, 3));',
'  if (header !== "TAG") return {};',
'',
'  const title = trimNull(decodeText(tag.slice(3, 33)));',
'  const artist = trimNull(decodeText(tag.slice(33, 63)));',
'  const album = trimNull(decodeText(tag.slice(63, 93)));',
'  const year = trimNull(decodeText(tag.slice(93, 97)));',
'  const genreIdx = tag[127];',
'  const genre = genreIdx < GENRES.length ? GENRES[genreIdx] : null;',
'',
'  return {',
'    title: title || null,',
'    artist: artist || null,',
'    album: album || null,',
'    year: year || null,',
'    genre: genre,',
'  };',
'}',
'',
'// Parse ID3v2 frames (basic - title, artist, album)',
'function parseID3v2(data: ArrayBuffer): Partial<ID3Tags> {',
'  const bytes = new Uint8Array(data);',
'  if (bytes.length < 10) return {};',
'  const header = decodeText(bytes.slice(0, 3));',
'  if (header !== "ID3") return {};',
'',
'  const version = bytes[3];',
'  const size = (bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f);',
'  const result: Partial<ID3Tags> = {};',
'',
'  let pos = 10;',
'  const end = Math.min(10 + size, bytes.length);',
'',
'  while (pos + 10 < end) {',
'    const frameId = decodeText(bytes.slice(pos, pos + 4));',
'    if (frameId[0] === "\\0") break;',
'',
'    const frameSize = version >= 4',
'      ? (bytes[pos+4] << 21 | bytes[pos+5] << 14 | bytes[pos+6] << 7 | bytes[pos+7])',
'      : (bytes[pos+4] << 24 | bytes[pos+5] << 16 | bytes[pos+6] << 8 | bytes[pos+7]);',
'',
'    if (frameSize <= 0 || frameSize > end - pos - 10) break;',
'',
'    const frameData = bytes.slice(pos + 10, pos + 10 + frameSize);',
'    const encoding = frameData[0];',
'    let text = "";',
'',
'    if (encoding === 0 || encoding === 3) {',
'      text = trimNull(decodeText(frameData.slice(1)));',
'    } else if (encoding === 1 || encoding === 2) {',
'      try {',
'        const decoder = new TextDecoder(encoding === 1 ? "utf-16" : "utf-16be");',
'        text = trimNull(decoder.decode(frameData.slice(1)));',
'      } catch { text = trimNull(decodeText(frameData.slice(1))); }',
'    }',
'',
'    if (frameId === "TIT2") result.title = text || null;',
'    if (frameId === "TPE1") result.artist = text || null;',
'    if (frameId === "TALB") result.album = text || null;',
'    if (frameId === "TDRC" || frameId === "TYER") result.year = text || null;',
'    if (frameId === "TCON") {',
'      const genreMatch = text.match(/\\((\\d+)\\)/);',
'      if (genreMatch) {',
'        const idx = parseInt(genreMatch[1]);',
'        result.genre = idx < GENRES.length ? GENRES[idx] : text;',
'      } else {',
'        result.genre = text || null;',
'      }',
'    }',
'',
'    pos += 10 + frameSize;',
'  }',
'',
'  return result;',
'}',
'',
'export async function readID3(filePath: string): Promise<ID3Tags> {',
'  const result: ID3Tags = { title: null, artist: null, album: null, year: null, genre: null, durationSec: null };',
'  try {',
'    const url = convertFileSrc(filePath);',
'    const resp = await fetch(url);',
'    if (!resp.ok) return result;',
'    const ab = await resp.arrayBuffer();',
'',
'    // Try ID3v2 first (more detailed), then fall back to ID3v1',
'    const v2 = parseID3v2(ab);',
'    const v1 = parseID3v1(ab);',
'',
'    result.title = v2.title || v1.title;',
'    result.artist = v2.artist || v1.artist;',
'    result.album = v2.album || v1.album;',
'    result.year = v2.year || v1.year;',
'    result.genre = v2.genre || v1.genre;',
'  } catch (e) {',
'    console.error("ID3 read error for " + filePath + ":", e);',
'  }',
'  return result;',
'}',
].join('\n'), 'utf8');
console.log('  CREATED src/audio/id3.ts');

// ============================================================
// Update the import section of App.tsx to use ID3 tags
// Read current App.tsx and patch the import function
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');

// Add the id3 import at the top
if (!app.includes('id3')) {
  app = app.replace(
    'import { engine, DeckState } from "./audio/engine";',
    'import { engine, DeckState } from "./audio/engine";\nimport { readID3 } from "./audio/id3";'
  );
}

// Replace the import handler to read ID3 tags
const oldImportBlock = `        if (!ex) {
          await execute("INSERT INTO songs (title, file_path, file_format, daypart_mask) VALUES (?, ?, ?, ?)", [titleFromFile(fp), fp, fmtExt(fp), 16777215]);
          n++;
        }
        setStatus("Importing... " + n);`;

const newImportBlock = `        if (!ex) {
          const tags = await readID3(fp);
          const title = tags.title || titleFromFile(fp);
          const artist = tags.artist || null;
          const album = tags.album || null;
          const genre = tags.genre || null;
          let artistId: number | null = null;
          if (artist) {
            const exArt = await queryOne<{ id: number }>("SELECT id FROM artists WHERE name = ?", [artist]);
            if (exArt) { artistId = exArt.id; }
            else { const r = await execute("INSERT INTO artists (name) VALUES (?)", [artist]); artistId = r.lastInsertId; }
          }
          let albumId: number | null = null;
          if (album) {
            const exAlb = await queryOne<{ id: number }>("SELECT id FROM albums WHERE title = ? AND (artist_id = ? OR artist_id IS NULL)", [album, artistId]);
            if (exAlb) { albumId = exAlb.id; }
            else { const r = await execute("INSERT INTO albums (title, artist_id) VALUES (?, ?)", [album, artistId]); albumId = r.lastInsertId; }
          }
          await execute("INSERT INTO songs (title, artist_id, album_id, file_path, file_format, genre, daypart_mask) VALUES (?, ?, ?, ?, ?, ?, ?)", [title, artistId, albumId, fp, fmtExt(fp), genre, 16777215]);
          n++;
        }
        setStatus("Importing... " + n);`;

if (app.includes(oldImportBlock)) {
  app = app.replace(oldImportBlock, newImportBlock);
  console.log('  UPDATED src/App.tsx (import now reads ID3 tags)');
} else {
  console.log('  NOTE: Could not find import block to patch. You may need to re-import your music.');
}

fs.writeFileSync('src/App.tsx', app, 'utf8');

console.log('\n  Done! Restart: npm run tauri:dev');
console.log('');
console.log('  To see real artist/album names, you need to re-import your music:');
console.log('    1. Go to Library');
console.log('    2. The existing songs still show Unknown (imported before ID3)');
console.log('    3. Delete the old database to start fresh:');
console.log('       Close app, run in PowerShell:');
console.log('       Remove-Item "$env:APPDATA\\com.openair.app\\openair.db*" -Force');
console.log('    4. Restart: npm run tauri:dev');
console.log('    5. Import your music folder again — now with real tags!');
console.log('');
console.log('  Push to GitHub:');
console.log('    git add -A');
console.log('    git commit -m "v0.2.1 ID3 tag reading on import"');
console.log('    git push\n');

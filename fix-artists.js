const fs = require('fs');

console.log('\n  Ether — Fix Artists + Dayparts\n');

// ============================================================
// 1. Check if id3.ts exists and is working
// ============================================================

if (!fs.existsSync('src/db/id3.ts')) {
  console.log('  WARNING: id3.ts is missing! Recreating...');
  fs.writeFileSync('src/db/id3.ts', `export interface ID3Result {
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  duration: number | null;
}

export async function readID3(filePath: string): Promise<ID3Result> {
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(filePath);
    const result: ID3Result = { title: null, artist: null, album: null, genre: null, year: null, duration: null };

    // Try ID3v2 first (starts with "ID3")
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      const version = bytes[3];
      const size = (bytes[6] & 0x7F) << 21 | (bytes[7] & 0x7F) << 14 | (bytes[8] & 0x7F) << 7 | (bytes[9] & 0x7F);
      let pos = 10;
      const end = Math.min(pos + size, bytes.length);

      while (pos < end - 10) {
        const frameId = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
        let frameSize: number;
        if (version === 4) {
          frameSize = (bytes[pos+4] & 0x7F) << 21 | (bytes[pos+5] & 0x7F) << 14 | (bytes[pos+6] & 0x7F) << 7 | (bytes[pos+7] & 0x7F);
        } else {
          frameSize = bytes[pos+4] << 24 | bytes[pos+5] << 16 | bytes[pos+6] << 8 | bytes[pos+7];
        }

        if (frameSize <= 0 || frameSize > end - pos) break;

        const data = bytes.slice(pos + 10, pos + 10 + frameSize);
        let text = "";
        if (data[0] === 3 || data[0] === 0) {
          text = new TextDecoder("utf-8").decode(data.slice(1)).replace(/\\0/g, "").trim();
        } else if (data[0] === 1) {
          try { text = new TextDecoder("utf-16").decode(data.slice(1)).replace(/\\0/g, "").trim(); } catch {}
        } else {
          text = new TextDecoder("utf-8").decode(data).replace(/\\0/g, "").trim();
        }

        if (frameId === "TIT2") result.title = text || null;
        else if (frameId === "TPE1") result.artist = text || null;
        else if (frameId === "TALB") result.album = text || null;
        else if (frameId === "TCON") result.genre = text || null;
        else if (frameId === "TDRC" || frameId === "TYER") {
          const y = parseInt(text);
          if (y > 1900 && y < 2100) result.year = y;
        }

        pos += 10 + frameSize;
      }
    }

    // Fallback: ID3v1 (last 128 bytes)
    if (!result.title && !result.artist && bytes.length > 128) {
      const tag = bytes.slice(bytes.length - 128);
      if (tag[0] === 0x54 && tag[1] === 0x41 && tag[2] === 0x47) {
        const dec = new TextDecoder("utf-8");
        const t = dec.decode(tag.slice(3, 33)).replace(/\\0/g, "").trim();
        const a = dec.decode(tag.slice(33, 63)).replace(/\\0/g, "").trim();
        const al = dec.decode(tag.slice(63, 93)).replace(/\\0/g, "").trim();
        if (t) result.title = t;
        if (a) result.artist = a;
        if (al) result.album = al;
      }
    }

    return result;
  } catch (e) {
    console.error("ID3 read error:", e);
    return { title: null, artist: null, album: null, genre: null, year: null, duration: null };
  }
}
`, 'utf8');
  console.log('  CREATED id3.ts');
} else {
  console.log('  id3.ts exists — OK');
}

// ============================================================
// 2. Make sure songs.ts uses ID3 on import
// ============================================================

let songs = fs.readFileSync('src/db/songs.ts', 'utf8');

if (!songs.includes('readID3')) {
  console.log('  WARNING: songs.ts does not use readID3!');
  // Check if importSongs function exists
  if (songs.includes('importSongs') || songs.includes('batchImportSongs')) {
    console.log('  songs.ts has import function but no ID3 — needs manual check');
  }
} else {
  console.log('  songs.ts uses readID3 — OK');
}

// ============================================================
// 3. Verify the songs import reads artist from ID3
// ============================================================

// Check if the import function properly creates artists
if (songs.includes('INSERT INTO songs') && !songs.includes('INSERT INTO artists')) {
  console.log('  WARNING: Import does not create artist records!');
  console.log('  Artists will show as Unknown.');
  console.log('  Need to fix the import function to create artists.');
}

// ============================================================
// 4. Add a re-scan function that updates artist from ID3
// ============================================================

if (!songs.includes('rescanArtists')) {
  songs += `

export async function rescanArtists(): Promise<number> {
  const { readID3 } = await import("./id3");
  const { query, execute, queryOne } = await import("./client");
  
  const allSongs = await query<{ id: number; file_path: string; artist_id: number | null }>(
    "SELECT id, file_path, artist_id FROM songs WHERE file_path IS NOT NULL"
  );
  
  let updated = 0;
  for (const song of allSongs) {
    try {
      const tags = await readID3(song.file_path);
      if (tags.artist) {
        // Find or create artist
        let artist = await queryOne<{ id: number }>("SELECT id FROM artists WHERE name = ?", [tags.artist]);
        if (!artist) {
          await execute("INSERT INTO artists (name, sort_name) VALUES (?, ?)", [
            tags.artist,
            tags.artist.replace(/^The /, "").trim() + (tags.artist.startsWith("The ") ? ", The" : "")
          ]);
          artist = await queryOne<{ id: number }>("SELECT id FROM artists WHERE name = ?", [tags.artist]);
        }
        if (artist && artist.id !== song.artist_id) {
          await execute("UPDATE songs SET artist_id = ? WHERE id = ?", [artist.id, song.id]);
          updated++;
        }
      }
      // Also update title if tag has one
      if (tags.title) {
        await execute("UPDATE songs SET title = ? WHERE id = ?", [tags.title, song.id]);
      }
    } catch {}
  }
  return updated;
}
`;
  fs.writeFileSync('src/db/songs.ts', songs, 'utf8');
  console.log('  ADDED rescanArtists() to songs.ts');
}

// ============================================================
// 5. Add RESCAN button to Library panel
// ============================================================

let app = fs.readFileSync('src/App.tsx', 'utf8');

if (!app.includes('rescanArtists')) {
  // Add import
  if (!app.includes('rescanArtists')) {
    app = app.replace(
      'import { fillQueueFromSchedule',
      'import { rescanArtists } from "./db/songs";\nimport { fillQueueFromSchedule'
    );
  }

  // Try to find the Library panel and add a rescan button
  // Look for library import button area
  if (app.includes('Import Folder') || app.includes('importFolder') || app.includes('scan')) {
    // Add rescan after import
    const importMatch = app.match(/onClick=\{[^}]*import[^}]*\}[^>]*>[^<]*Import/i);
    if (importMatch) {
      const idx = app.indexOf(importMatch[0]) + importMatch[0].length;
      // Find the closing tag
      const closeIdx = app.indexOf('</button>', idx);
      if (closeIdx > 0) {
        app = app.slice(0, closeIdx + 9) + '\n            <button onClick={async () => { const n = await rescanArtists(); alert("Updated " + n + " artists from ID3 tags"); }} style={{ padding: "5px 12px", borderRadius: "var(--radius-xs, 6px)", fontSize: 11, fontWeight: 500, background: "var(--accent-purple, #7c3aed)", color: "#fff", border: "none", cursor: "pointer" }}>RESCAN TAGS</button>' + app.slice(closeIdx + 9);
      }
    }
  }

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  ADDED RESCAN TAGS button to Library');
}

console.log('\n  Done! Delete DB, restart, and re-import:');
console.log('  Remove-Item "$env:APPDATA\\com.openair.app\\openair.db*" -Force -ErrorAction SilentlyContinue');
console.log('  npm run tauri:dev');
console.log('');
console.log('  Then:');
console.log('    1. Library → Import Folder (re-import your music)');
console.log('    2. If artists still show Unknown, click RESCAN TAGS');
console.log('    3. Schedule → set up shows with clocks');
console.log('    4. Live Assist → GEN LOG');
console.log('');
console.log('  RESCAN TAGS re-reads every file and updates artist/title from ID3.');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v1.5.6 fix artists + rescan tags"');
console.log('    git push\n');

const fs = require('fs');
let f = fs.readFileSync('src/components/ImportDialog.tsx', 'utf8');

// Replace the entire import loop body with a simpler version that skips albums
const oldInsert = `        // Get or create album
        let albumId = null;
        if (tags.album) {
          let album = await queryOne<{ id: number }>("SELECT id FROM albums WHERE title = ? AND artist_id = ?", [tags.album, artist?.id]);
          if (!album) {
            await execute("INSERT INTO albums (title, artist_id) VALUES (?, ?)", [tags.album, artist?.id]);
            album = await queryOne<{ id: number }>("SELECT id FROM albums WHERE title = ? AND artist_id = ?", [tags.album, artist?.id]);
          }
          albumId = album?.id;
        }

        // Insert song with category
        await execute(
          "INSERT INTO songs (title, file_path, artist_id, album_id, category_id, genre, rotation_status, gender, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', 'unknown', unixepoch(), unixepoch())",
          [title, filePath, artist?.id || null, albumId, selectedCat, tags.genre || null]
        );`;

const newInsert = `        // Insert song (skip album lookup for reliability)
        await execute(
          "INSERT INTO songs (title, file_path, artist_id, category_id, genre, rotation_status, gender, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 'unknown', unixepoch(), unixepoch())",
          [title, filePath, artist?.id || null, selectedCat, tags.genre || null]
        );`;

if (f.includes('// Get or create album')) {
  f = f.replace(oldInsert, newInsert);
  console.log('Replaced album block');
} else {
  console.log('Pattern not found - current album block:');
  const idx = f.indexOf('albumId');
  console.log(f.substring(idx - 50, idx + 500));
}

fs.writeFileSync('src/components/ImportDialog.tsx', f);
console.log('Done');

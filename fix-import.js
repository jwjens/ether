const fs = require('fs');
let f = fs.readFileSync('src/components/ImportDialog.tsx', 'utf8');

// Fix the songs INSERT - remove year column, fix rotation_status
f = f.replace(
  `"INSERT INTO songs (title, file_path, artist_id, album_id, category_id, genre, year, rotation, gender, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'unknown', unixepoch(), unixepoch())",\n          [title, filePath, artist?.id || null, albumId, selectedCat, tags.genre || null, tags.year || null]`,
  `"INSERT INTO songs (title, file_path, artist_id, album_id, category_id, genre, rotation_status, gender, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', 'unknown', unixepoch(), unixepoch())",\n          [title, filePath, artist?.id || null, albumId, selectedCat, tags.genre || null]`
);

fs.writeFileSync('src/components/ImportDialog.tsx', f);
console.log('Done');

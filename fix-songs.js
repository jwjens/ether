const fs = require('fs');

console.log('\n  Fixing songs table...\n');

let client = fs.readFileSync('src/db/client.ts', 'utf8');

// Replace the songs CREATE TABLE to include last_played_at and spins_total
client = client.replace(
  `await d.execute("CREATE TABLE IF NOT EXISTS songs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, artist_id INTEGER, album_id INTEGER, file_path TEXT, file_format TEXT, file_size_bytes INTEGER, duration_ms INTEGER NOT NULL DEFAULT 0, genre TEXT, era TEXT, category_id INTEGER, rotation_status TEXT NOT NULL DEFAULT 'active', daypart_mask INTEGER NOT NULL DEFAULT 16777215, gender TEXT NOT NULL DEFAULT 'unknown', tags TEXT NOT NULL DEFAULT '[]', notes TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()))");`,
  `await d.execute("CREATE TABLE IF NOT EXISTS songs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, artist_id INTEGER, album_id INTEGER, file_path TEXT, file_format TEXT, file_size_bytes INTEGER, duration_ms INTEGER NOT NULL DEFAULT 0, genre TEXT, era TEXT, category_id INTEGER, rotation_status TEXT NOT NULL DEFAULT 'active', daypart_mask INTEGER NOT NULL DEFAULT 16777215, gender TEXT NOT NULL DEFAULT 'unknown', tags TEXT NOT NULL DEFAULT '[]', notes TEXT, last_played_at INTEGER, spins_total INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()))");`
);

fs.writeFileSync('src/db/client.ts', client, 'utf8');
console.log('  FIXED songs table (last_played_at + spins_total in CREATE)');
console.log('  Close app, delete DB, restart:\n');
console.log('  Remove-Item "$env:APPDATA\\com.openair.app\\openair.db*" -Force -ErrorAction SilentlyContinue');
console.log('  npm run tauri:dev\n');

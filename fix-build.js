const fs = require('fs');
const path = require('path');

// 1. Fix src/audio/id3.ts
const id3Path = path.join('src', 'audio', 'id3.ts');
if (fs.existsSync(id3Path)) {
  let content = fs.readFileSync(id3Path, 'utf8');
  // Add || null to the end of the assignment lines to satisfy TS
  content = content.replace(/result\.title = v2\.title \|\| v1\.title;/g, 'result.title = v2.title || v1.title || null;');
  content = content.replace(/result\.artist = v2\.artist \|\| v1\.artist;/g, 'result.artist = v2.artist || v1.artist || null;');
  content = content.replace(/result\.album = v2\.album \|\| v1\.album;/g, 'result.album = v2.album || v1.album || null;');
  content = content.replace(/result\.year = v2\.year \|\| v1\.year;/g, 'result.year = v2.year || v1.year || null;');
  content = content.replace(/result\.genre = v2\.genre \|\| v1\.genre;/g, 'result.genre = v2.genre || v1.genre || null;');
  fs.writeFileSync(id3Path, content);
  console.log('✅ Fixed src/audio/id3.ts');
}

// 2. Fix src/db/client.ts
const dbPath = path.join('src', 'db', 'client.ts');
if (fs.existsSync(dbPath)) {
  // We'll replace the problematic execute function with a safer version
  const newExecute = `export async function execute(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number; lastInsertId: number }> {
  const d = await getDb();
  const r: any = await d.execute(sql, params);
  return {
    rowsAffected: r.rowsAffected ?? 0,
    lastInsertId: r.lastInsertId ?? 0
  };
}`;

  // This regex looks for the existing export async function execute... and replaces it
  let content = fs.readFileSync(dbPath, 'utf8');
  content = content.replace(/export async function execute[\s\S]*?return \{[\s\S]*?\}; \}/, newExecute);

  fs.writeFileSync(dbPath, content);
  console.log('✅ Fixed src/db/client.ts');
}

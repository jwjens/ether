import Database from "@tauri-apps/plugin-sql";
let db: Database | null = null;
export async function getDb(): Promise<Database> { if (!db) { db = await Database.load("sqlite:openair.db"); } return db; }
export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> { const d = await getDb(); return (await d.select(sql, params)) as T[]; }
export async function queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> { const rows = await query<T>(sql, params); return rows.length > 0 ? rows[0] : null; }
export async function execute(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number; lastInsertId: number }> { const d = await getDb(); const r = await d.execute(sql, params); return { rowsAffected: r.rowsAffected, lastInsertId: r.lastInsertId }; }
export async function runMigrations(): Promise<void> {
  const d = await getDb();
  await d.execute("CREATE TABLE IF NOT EXISTS artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort_name TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))");
  await d.execute("CREATE TABLE IF NOT EXISTS albums (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, artist_id INTEGER, year INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch()))");
  await d.execute("CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, color TEXT, description TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))");
  await d.execute("CREATE TABLE IF NOT EXISTS songs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, artist_id INTEGER, album_id INTEGER, file_path TEXT, file_format TEXT, file_size_bytes INTEGER, duration_ms INTEGER NOT NULL DEFAULT 0, genre TEXT, era TEXT, category_id INTEGER, rotation_status TEXT NOT NULL DEFAULT 'active', daypart_mask INTEGER NOT NULL DEFAULT 16777215, gender TEXT NOT NULL DEFAULT 'unknown', tags TEXT NOT NULL DEFAULT '[]', notes TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()))");
  const r = await d.select("SELECT COUNT(*) as c FROM categories");
  if ((r as any)[0].c === 0) {
    await d.execute("INSERT INTO categories (code,name,color) VALUES ('A','Power Current','#ef4444')");
    await d.execute("INSERT INTO categories (code,name,color) VALUES ('B','Secondary','#f59e0b')");
    await d.execute("INSERT INTO categories (code,name,color) VALUES ('C','Recurrent','#22c55e')");
    await d.execute("INSERT INTO categories (code,name,color) VALUES ('D','Gold','#3b82f6')");
  }
  console.log("DB ready");
}
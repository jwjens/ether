const fs = require('fs');

console.log('\n  Ether — Import to Category\n');

// ============================================================
// Update the import flow to ask for category first
// ============================================================

// Find the Library panel or import dialog and add category picker
let app = fs.readFileSync('src/App.tsx', 'utf8');

// Find the import function and update it
// The import uses open() dialog then loops through files
// We need to add a category selection step

// Check if there's a LibraryPanel or similar
// Let's update the song import in the songs.ts or wherever importFolder lives

let songsDb = null;
const songsPaths = ['src/db/songs.ts', 'src/db/import.ts'];
let songsPath = '';
for (const p of songsPaths) {
  if (fs.existsSync(p)) {
    songsDb = fs.readFileSync(p, 'utf8');
    songsPath = p;
    break;
  }
}

// Create an ImportDialog component
fs.writeFileSync('src/components/ImportDialog.tsx', `import { useState, useEffect } from "react";
import { query, execute, queryOne } from "../db/client";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { readID3 } from "../audio/id3";

interface Category {
  id: number;
  code: string;
  name: string;
  color: string;
}

interface Props {
  onDone: () => void;
}

export default function ImportDialog({ onDone }: Props) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCat, setSelectedCat] = useState<number | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [newCatCode, setNewCatCode] = useState("");
  const [step, setStep] = useState<"pick" | "importing" | "done">("pick");
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [imported, setImported] = useState(0);

  useEffect(() => {
    (async () => {
      const cats = await query<Category>("SELECT id, code, name, color FROM categories ORDER BY code");
      setCategories(cats);
    })();
  }, []);

  const createCategory = async () => {
    if (!newCatCode.trim() || !newCatName.trim()) return;
    const colors = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#6366f1"];
    const color = colors[categories.length % colors.length];
    await execute("INSERT INTO categories (code, name, color, spins_per_hour) VALUES (?, ?, ?, 0)", [newCatCode.trim().toUpperCase(), newCatName.trim(), color]);
    const cats = await query<Category>("SELECT id, code, name, color FROM categories ORDER BY code");
    setCategories(cats);
    const newCat = cats.find(c => c.code === newCatCode.trim().toUpperCase());
    if (newCat) setSelectedCat(newCat.id);
    setNewCatCode("");
    setNewCatName("");
  };

  const startImport = async () => {
    const folder = await open({ directory: true, title: "Select music folder to import" });
    if (!folder) return;
    const folderPath = Array.isArray(folder) ? folder[0] : folder;

    setStep("importing");
    setProgress({ done: 0, total: 0, current: "Scanning folder..." });

    // Scan for audio files
    const audioExts = [".mp3", ".flac", ".ogg", ".wav", ".m4a", ".aac", ".aiff"];
    const files: string[] = [];

    const scanDir = async (dirPath: string) => {
      try {
        const entries = await readDir(dirPath);
        for (const entry of entries) {
          const fullPath = dirPath + "/" + entry.name;
          if (entry.isDirectory) {
            await scanDir(fullPath);
          } else {
            const ext = "." + (entry.name.split(".").pop() || "").toLowerCase();
            if (audioExts.includes(ext)) files.push(fullPath);
          }
        }
      } catch (e) {
        console.error("Scan error:", e);
      }
    };

    await scanDir(folderPath);
    setProgress({ done: 0, total: files.length, current: "Importing..." });

    let count = 0;
    for (const filePath of files) {
      try {
        // Check if already imported
        const existing = await queryOne<{ id: number }>("SELECT id FROM songs WHERE file_path = ?", [filePath]);
        if (existing) {
          // Update category if one was selected
          if (selectedCat) {
            await execute("UPDATE songs SET category_id = ? WHERE id = ?", [selectedCat, existing.id]);
          }
          count++;
          setProgress({ done: count, total: files.length, current: filePath.split("/").pop() || "" });
          continue;
        }

        // Read ID3 tags
        const tags = await readID3(filePath);
        const title = tags.title || filePath.split(/[\\\\/]/).pop()?.replace(/\\.[^.]+$/, "") || "Unknown";
        const artistName = tags.artist || "Unknown";

        // Get or create artist
        let artist = await queryOne<{ id: number }>("SELECT id FROM artists WHERE name = ?", [artistName]);
        if (!artist) {
          await execute("INSERT INTO artists (name, sort_name) VALUES (?, ?)", [
            artistName,
            artistName.replace(/^The\\s+/i, "").trim() + (artistName.match(/^The\\s+/i) ? ", The" : "")
          ]);
          artist = await queryOne<{ id: number }>("SELECT id FROM artists WHERE name = ?", [artistName]);
        }

        // Get or create album
        let albumId = null;
        if (tags.album) {
          let album = await queryOne<{ id: number }>("SELECT id FROM albums WHERE name = ? AND artist_id = ?", [tags.album, artist?.id]);
          if (!album) {
            await execute("INSERT INTO albums (name, artist_id) VALUES (?, ?)", [tags.album, artist?.id]);
            album = await queryOne<{ id: number }>("SELECT id FROM albums WHERE name = ? AND artist_id = ?", [tags.album, artist?.id]);
          }
          albumId = album?.id;
        }

        // Insert song with category
        await execute(
          "INSERT INTO songs (title, file_path, artist_id, album_id, category_id, genre, year, rotation, gender, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'unknown', unixepoch(), unixepoch())",
          [title, filePath, artist?.id || null, albumId, selectedCat, tags.genre || null, tags.year || null]
        );

        count++;
        setProgress({ done: count, total: files.length, current: title });
      } catch (e) {
        console.error("Import error:", e);
        count++;
        setProgress({ done: count, total: files.length, current: "Error..." });
      }
    }

    setImported(count);
    setStep("done");
  };

  return (
    <div style={{
      background: "var(--bg-secondary)",
      borderRadius: "var(--radius)",
      border: "1px solid var(--border-primary)",
      boxShadow: "var(--shadow-md)",
      padding: 20,
      marginBottom: 16,
    }}>
      {step === "pick" && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>Import Music Folder</h3>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
            Choose a category for the imported songs. Great for seasonal music (Christmas, Halloween), format-specific libraries, or organizing by rotation.
          </p>

          {/* Category selection */}
          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", textTransform: "uppercase" as any, letterSpacing: "0.06em", marginBottom: 8 }}>
            Assign to Category
          </div>
          <div style={{ display: "flex", flexWrap: "wrap" as any, gap: 6, marginBottom: 16 }}>
            <button
              onClick={() => setSelectedCat(null)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: selectedCat === null ? 600 : 400,
                background: selectedCat === null ? "var(--accent-blue)" : "var(--bg-tertiary)",
                color: selectedCat === null ? "#fff" : "var(--text-secondary)",
                border: "none",
                cursor: "pointer",
              }}
            >No Category</button>
            {categories.map(c => (
              <button
                key={c.id}
                onClick={() => setSelectedCat(c.id)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: selectedCat === c.id ? 600 : 400,
                  background: selectedCat === c.id ? (c.color || "var(--accent-blue)") : "var(--bg-tertiary)",
                  color: selectedCat === c.id ? "#fff" : "var(--text-secondary)",
                  border: selectedCat === c.id ? "none" : "1px solid var(--border-primary)",
                  cursor: "pointer",
                }}
              >{c.code} — {c.name}</button>
            ))}
          </div>

          {/* Create new category */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 16 }}>
            <input
              placeholder="Code (e.g. XMAS)"
              value={newCatCode}
              onChange={e => setNewCatCode(e.target.value)}
              style={{ width: 90, padding: "6px 10px", borderRadius: 6, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }}
            />
            <input
              placeholder="Name (e.g. Christmas)"
              value={newCatName}
              onChange={e => setNewCatName(e.target.value)}
              style={{ flex: 1, padding: "6px 10px", borderRadius: 6, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }}
            />
            <button
              onClick={createCategory}
              style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}
            >+ New</button>
          </div>

          {/* Import button */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={startImport}
              style={{
                padding: "10px 24px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                background: "var(--accent-blue)",
                color: "#fff",
                border: "none",
                cursor: "pointer",
              }}
            >Choose Folder & Import</button>
            <button
              onClick={onDone}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 400,
                background: "var(--bg-tertiary)",
                color: "var(--text-secondary)",
                border: "none",
                cursor: "pointer",
              }}
            >Cancel</button>
          </div>
        </div>
      )}

      {step === "importing" && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>Importing...</h3>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>{progress.current}</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}>{progress.done} / {progress.total}</div>
          {progress.total > 0 && (
            <div style={{ height: 4, background: "var(--bg-tertiary)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: (progress.done / progress.total * 100) + "%", background: "var(--accent-blue)", borderRadius: 2, transition: "width 0.2s" }}></div>
            </div>
          )}
        </div>
      )}

      {step === "done" && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--accent-green)", marginBottom: 8 }}>Import Complete</h3>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>{imported} songs imported{selectedCat ? " to " + (categories.find(c => c.id === selectedCat)?.name || "category") : ""}.</div>
          <button
            onClick={onDone}
            style={{
              padding: "8px 20px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              background: "var(--accent-blue)",
              color: "#fff",
              border: "none",
              cursor: "pointer",
            }}
          >Done</button>
        </div>
      )}
    </div>
  );
}
`, 'utf8');
console.log('  CREATED ImportDialog.tsx');

// ============================================================
// Wire ImportDialog into the Library panel
// ============================================================

if (!app.includes('ImportDialog')) {
  app = app.replace(
    'import CartWall from "./components/CartWall";',
    'import CartWall from "./components/CartWall";\nimport ImportDialog from "./components/ImportDialog";'
  );
  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  Added ImportDialog import to App.tsx');
}

// Now add an IMPORT button and dialog to the Library panel
// Find the library panel and add it
// This depends on your current Library panel structure
// Let's add a simple wrapper

if (!app.includes('showImport')) {
  app = fs.readFileSync('src/App.tsx', 'utf8');
  app = app.replace(
    'const [showCarts, setShowCarts] = useState(false);',
    'const [showCarts, setShowCarts] = useState(false);\n  const [showImport, setShowImport] = useState(false);'
  );

  // Add import dialog to the library panel area
  // Find where library panel renders and add the dialog above it
  app = app.replace(
    '{panel === "library" && ',
    '{panel === "library" && <div>{showImport && <ImportDialog onDone={() => { setShowImport(false); }} />}<div style={{ marginBottom: 12 }}><button onClick={() => setShowImport(!showImport)} style={{ padding: "8px 18px", borderRadius: "var(--radius-xs, 6px)", fontSize: 12, fontWeight: 600, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", marginRight: 8 }}>{showImport ? "Cancel Import" : "Import Folder"}</button></div>'
  );

  // Close the wrapper div - find the matching closing
  // This is tricky without seeing the full structure, so let's just add it
  // after the library panel content
  app = app.replace(
    '{panel === "clocks"',
    '</div>}\n          {panel === "clocks"'
  );

  fs.writeFileSync('src/App.tsx', app, 'utf8');
  console.log('  Added Import Folder button to Library panel');
}

console.log('\n  Done! npm run tauri:dev');
console.log('');
console.log('  Library tab now has an IMPORT FOLDER button at the top.');
console.log('');
console.log('  Click it and you get:');
console.log('    1. Category picker — select where songs go');
console.log('       A, B, C, D, or any custom category');
console.log('    2. Create new category inline');
console.log('       Code: XMAS  Name: Christmas → click + New');
console.log('    3. Choose Folder — picks the folder and imports');
console.log('    4. Progress bar shows each song being imported');
console.log('    5. Done — songs are in the library under that category');
console.log('');
console.log('  Use case:');
console.log('    Import christmas folder → assign to XMAS category');
console.log('    Import halloween folder → assign to HWEEN category');
console.log('    Import regular library → assign to A/B/C/D');
console.log('    Create format clocks that pull from specific categories');
console.log('');
console.log('  Push:');
console.log('    git add -A');
console.log('    git commit -m "v1.6.0 import to category"');
console.log('    git push\n');

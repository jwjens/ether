import { useState } from "react";
import { execute, query, queryOne } from "../db/client";
import { queryScoped, executeScopedInsert } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

function parseNexGenCSV(text: string): any[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = line.match(/(".*?"|[^,]+)(?=,|$)/g) || [];
    const obj: any = {};
    headers.forEach((h, i) => {
      obj[h] = (vals[i] || '').replace(/^"|"$/g, '').trim();
    });
    return obj;
  });
}

function parseENCoLST(text: string): any[] {
  // ENCO .lst is tab-delimited
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = line.split('\t');
    const obj: any = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  });
}

function mapToEther(row: any, format: string) {
  if (format === 'nexgen') {
    return {
      title: row['title'] || row['song title'] || row['name'] || '',
      artist: row['artist'] || row['artist name'] || '',
      album: row['album'] || row['cd title'] || '',
      genre: row['genre'] || row['category'] || '',
      filePath: row['filename'] || row['file'] || row['path'] || '',
      year: row['year'] || '',
    };
  } else if (format === 'enco') {
    return {
      title: row['title'] || row['cart title'] || '',
      artist: row['artist'] || row['intro'] || '',
      album: row['album'] || '',
      genre: row['category'] || row['type'] || '',
      filePath: row['filename'] || row['file name'] || '',
      year: row['year'] || '',
    };
  } else {
    // Generic CSV - try common field names
    return {
      title: row['title'] || row['song'] || row['name'] || row['track'] || '',
      artist: row['artist'] || row['performer'] || row['band'] || '',
      album: row['album'] || row['record'] || '',
      genre: row['genre'] || row['category'] || row['format'] || '',
      filePath: row['filename'] || row['file'] || row['path'] || row['filepath'] || '',
      year: row['year'] || row['release year'] || '',
    };
  }
}

export default function NexGenImport({ onDone }: { onDone: () => void }) {
  const { stationId } = useActiveStation();
  const [format, setFormat] = useState<'nexgen' | 'enco' | 'csv'>('nexgen');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [preview, setPreview] = useState<any[]>([]);
  const [fileContent, setFileContent] = useState('');
  const [fileName, setFileName] = useState('');

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setFileContent(text);
      // Auto-detect format
      if (file.name.endsWith('.lst')) setFormat('enco');
      else if (file.name.endsWith('.xml')) setFormat('nexgen');
      // Show preview
      const rows = format === 'enco' ? parseENCoLST(text) : parseNexGenCSV(text);
      setPreview(rows.slice(0, 5).map(r => mapToEther(r, format)));
    };
    reader.readAsText(file);
  };

  const runImport = async () => {
    if (!fileContent) return;
    setImporting(true);
    const rows = format === 'enco' ? parseENCoLST(fileContent) : parseNexGenCSV(fileContent);
    const mapped = rows.map(r => mapToEther(r, format)).filter(r => r.title);

    let imported = 0; let skipped = 0; const errors: string[] = [];

    for (const song of mapped) {
      try {
        if (!song.title) { skipped++; continue; }

        // Get or create artist
        let artistId: number | null = null;
        if (song.artist) {
          let artist = await (queryScoped<{id:number}>("SELECT id FROM artists WHERE name=?", [song.artist], stationId).then(r => r[0] ?? null));
          if (!artist) {
            const r = await executeScopedInsert("INSERT INTO artists (name, sort_name) VALUES (?,?)", [song.artist, song.artist], stationId);
            artistId = r.lastInsertId;
          } else { artistId = artist.id; }
        }

        // Check duplicate by title+artist
        const existing = await (queryScoped<{id:number}>("SELECT id FROM songs WHERE title=? AND artist_id IS ?", [song.title, artistId], stationId).then(r => r[0] ?? null));
        if (existing) { skipped++; continue; }

        // Insert song (no file_path - they'll need to relocate library)
        await executeScopedInsert(
          "INSERT INTO songs (title, artist_id, genre, rotation_status, gender, created_at, updated_at) VALUES (?,?,?,'active','unknown',unixepoch(),unixepoch())",
          [song.title, artistId, song.genre || null], stationId
        );
        imported++;
      } catch (e) {
        errors.push(song.title + ": " + String(e));
      }
    }

    setResult({ imported, skipped, errors });
    setImporting(false);
  };

  return (
    <div style={{ maxWidth: 600 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 16 }}>Import from NexGen / ENCO / CSV</h2>

      <div style={{ background: "var(--bg-secondary)", borderRadius: 0, padding: 16, border: "1px solid var(--border-primary)", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 10 }}>Format</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {(['nexgen','enco','csv'] as const).map(f => (
            <button key={f} onClick={() => setFormat(f)} style={{ padding: "6px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: format === f ? "var(--accent-blue)" : "var(--bg-tertiary)", color: format === f ? "#fff" : "var(--text-secondary)", border: "none", cursor: "pointer" }}>
              {f === 'nexgen' ? 'NexGen' : f === 'enco' ? 'ENCO DAD' : 'Generic CSV'}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 12 }}>
          {format === 'nexgen' && "Export from NexGen: Tools → Export → Song Library → CSV format"}
          {format === 'enco' && "Export from ENCO DAD: Database → Export → All Carts → .lst or .csv"}
          {format === 'csv' && "Any CSV with columns: Title, Artist, Album, Genre, Filename"}
        </div>

        <input type="file" accept=".csv,.lst,.txt,.xml" onChange={handleFile}
          style={{ fontSize: 12, color: "var(--text-primary)" }} />
        {fileName && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 8 }}>Selected: {fileName}</div>}
      </div>

      {preview.length > 0 && (
        <div style={{ background: "var(--bg-secondary)", borderRadius: 0, padding: 16, border: "1px solid var(--border-primary)", marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>Preview (first 5 rows)</div>
          <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: "var(--text-tertiary)", textAlign: "left" as any }}>
                <th style={{ padding: "4px 8px" }}>Title</th>
                <th style={{ padding: "4px 8px" }}>Artist</th>
                <th style={{ padding: "4px 8px" }}>Genre</th>
                <th style={{ padding: "4px 8px" }}>File Path</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--border-primary)" }}>
                  <td style={{ padding: "4px 8px", color: "var(--text-primary)" }}>{r.title || "—"}</td>
                  <td style={{ padding: "4px 8px", color: "var(--text-secondary)" }}>{r.artist || "—"}</td>
                  <td style={{ padding: "4px 8px", color: "var(--text-tertiary)" }}>{r.genre || "—"}</td>
                  <td style={{ padding: "4px 8px", color: "var(--text-tertiary)", fontSize: 10, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{r.filePath || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result && (
        <div style={{ background: result.errors.length > 0 ? "rgba(239,68,68,0.1)" : "rgba(34,197,94,0.1)", borderRadius: 0, padding: 16, border: "1px solid " + (result.errors.length > 0 ? "#ef4444" : "#22c55e"), marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: result.errors.length > 0 ? "#ef4444" : "#22c55e", marginBottom: 8 }}>
            Import Complete
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            ✓ {result.imported} songs imported &nbsp;|&nbsp; {result.skipped} skipped (duplicates)
          </div>
          {result.errors.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: "#ef4444" }}>
              {result.errors.slice(0, 5).map((e, i) => <div key={i}>{e}</div>)}
              {result.errors.length > 5 && <div>...and {result.errors.length - 5} more errors</div>}
            </div>
          )}
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-tertiary)" }}>
            Note: Songs are imported without file paths. Use the Relocate button in the Library to link them to your audio files.
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={runImport} disabled={!fileContent || importing}
          style={{ padding: "10px 24px", borderRadius: 0, fontSize: 13, fontWeight: 600, background: fileContent ? "var(--accent-blue)" : "var(--bg-tertiary)", color: fileContent ? "#fff" : "var(--text-tertiary)", border: "none", cursor: fileContent ? "pointer" : "default" }}>
          {importing ? "Importing..." : "Import"}
        </button>
        <button onClick={onDone} style={{ padding: "10px 16px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "none", cursor: "pointer" }}>
          Done
        </button>
      </div>
    </div>
  );
}

// src/pages/LibraryPage.tsx
import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useLibraryStore } from '../store';
import { getSongs, getCategories, batchImportSongs } from '../db/songs';
import { getSongCount } from '../db/songs';
import type { SongView } from '../types/models';

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatLastPlayed(ts: number | null): string {
  if (!ts) return '—';
  const diff = Math.floor((Date.now() / 1000 - ts) / 3600);
  if (diff < 1) return 'Just now';
  if (diff < 24) return `${diff}h ago`;
  return `${Math.floor(diff / 24)}d ago`;
}

// ============================================================
// IMPORT DIALOG
// ============================================================
function ImportDialog({ onClose }: { onClose: () => void }) {
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<any>(null);
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState(false);
  const [recursive, setRecursive] = useState(true);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | undefined>();

  const categories = useLibraryStore(s => s.categories);
  const setImportProgress = useLibraryStore(s => s.setImportProgress);
  const setTotalCount = useLibraryStore(s => s.setTotalCount);

  const handlePickFolder = async () => {
    try {
      const folder = await invoke<string | null>('open_folder_dialog');
      if (!folder) return;

      setScanning(true);
      setScanResult(null);

      // Listen for progress events
      const unlisten = await listen<any>('scan_progress', (e) => {
        setImportProgress({
          current: e.payload.current,
          total: e.payload.total,
          file: e.payload.file,
        });
      });

      const result = await invoke<any>('scan_folder', {
        folderPath: folder,
        recursive,
      });

      unlisten();
      setScanning(false);
      setScanResult(result);
      setImportProgress(null);
    } catch (err) {
      setScanning(false);
      setImportProgress(null);
      console.error('Scan error:', err);
    }
  };

  const handleImport = async () => {
    if (!scanResult) return;
    setImporting(true);

    const payloads = scanResult.files
      .filter((f: any) => !f.error)
      .map((f: any) => ({
        file_path: f.file_path,
        file_format: f.file_format,
        file_size_bytes: f.file_size_bytes,
        title: f.title || f.file_name,
        artist: f.artist,
        album: f.album,
        year: f.year,
        genre: f.genre,
        duration_ms: f.duration_ms,
        category_id: selectedCategoryId,
      }));

    try {
      const result = await batchImportSongs(payloads);
      const count = await getSongCount();
      setTotalCount(count);
      setImporting(false);
      setDone(true);
      setScanResult({ ...scanResult, importResult: result });
    } catch (err) {
      setImporting(false);
      console.error('Import error:', err);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--r-lg)',
        width: 560, maxHeight: '80vh',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Import Music Library
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ marginLeft: 'auto' }}>✕</button>
        </div>

        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {/* Options */}
          {!scanResult && !scanning && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--font-display)' }}>
                  Default Category
                </label>
                <select
                  className="input"
                  value={selectedCategoryId ?? ''}
                  onChange={e => setSelectedCategoryId(e.target.value ? parseInt(e.target.value) : undefined)}
                >
                  <option value="">— No category (assign later) —</option>
                  {categories.map(c => (
                    <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                  ))}
                </select>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={recursive}
                  onChange={e => setRecursive(e.target.checked)}
                  style={{ accentColor: 'var(--amber)' }}
                />
                Scan subdirectories recursively
              </label>

              <button className="btn btn-primary" onClick={handlePickFolder} style={{ alignSelf: 'flex-start' }}>
                ♫ Choose Music Folder
              </button>

              <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Supported formats: MP3, FLAC, OGG, OPUS, WAV, AIFF, M4A, AAC, WMA.
                ID3/Vorbis tags will be read automatically.
              </p>
            </div>
          )}

          {/* Scanning progress */}
          {scanning && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', padding: '20px 0' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, color: 'var(--amber)' }}>Scanning...</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Reading audio files and metadata</div>
            </div>
          )}

          {/* Scan results */}
          {scanResult && !done && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                {[
                  { label: 'Found', value: scanResult.found, color: 'var(--green-air)' },
                  { label: 'Errors', value: scanResult.errors, color: 'var(--red-cue)' },
                  { label: 'Total Scanned', value: scanResult.scanned, color: 'var(--text-secondary)' },
                ].map(stat => (
                  <div key={stat.label} style={{ background: 'var(--bg-surface)', borderRadius: 'var(--r-md)', padding: '12px', textAlign: 'center' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, color: stat.color }}>{stat.value}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 4 }}>{stat.label}</div>
                  </div>
                ))}
              </div>

              {/* Preview first 5 */}
              <div style={{ background: 'var(--bg-surface)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
                <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--font-display)' }}>
                  Preview (first 5)
                </div>
                {scanResult.files.slice(0, 5).map((f: any, i: number) => (
                  <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: 12 }}>
                    <div style={{ color: 'var(--text-primary)' }}>{f.title || f.file_name}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>{f.artist || 'Unknown'} — {formatDuration(f.duration_ms)}</div>
                    {f.error && <div style={{ color: 'var(--red-cue)', fontSize: 11 }}>⚠ {f.error}</div>}
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-secondary" onClick={() => setScanResult(null)}>← Back</button>
                <button className="btn btn-primary" onClick={handleImport} disabled={importing}>
                  {importing ? 'Importing...' : `Import ${scanResult.found} Tracks`}
                </button>
              </div>
            </div>
          )}

          {/* Done */}
          {done && scanResult?.importResult && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', padding: '20px 0', textAlign: 'center' }}>
              <div style={{ fontSize: 40 }}>✓</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--green-air)' }}>Import Complete</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
                <div>{scanResult.importResult.inserted} tracks added</div>
                <div>{scanResult.importResult.skipped} already in library</div>
                {scanResult.importResult.errors.length > 0 && (
                  <div style={{ color: 'var(--red-cue)' }}>{scanResult.importResult.errors.length} errors</div>
                )}
              </div>
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// LIBRARY PAGE
// ============================================================
export default function LibraryPage() {
  const songs = useLibraryStore(s => s.songs);
  const categories = useLibraryStore(s => s.categories);
  const loading = useLibraryStore(s => s.loading);
  const searchQuery = useLibraryStore(s => s.searchQuery);
  const filterCategoryId = useLibraryStore(s => s.filterCategoryId);
  const selectedSongId = useLibraryStore(s => s.selectedSongId);
  const setSongs = useLibraryStore(s => s.setSongs);
  const setLoading = useLibraryStore(s => s.setLoading);
  const setSearch = useLibraryStore(s => s.setSearch);
  const setFilterCategory = useLibraryStore(s => s.setFilterCategory);
  const setSelectedSong = useLibraryStore(s => s.setSelectedSong);

  const [showImport, setShowImport] = useState(false);
  const [sortCol, setSortCol] = useState<'title' | 'artist' | 'duration' | 'last_played' | 'spins'>('artist');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const loadSongs = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await getSongs({
        search: searchQuery || undefined,
        category_id: filterCategoryId ?? undefined,
        limit: 1000,
      });
      setSongs(rows);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, filterCategoryId]);

  useEffect(() => { loadSongs(); }, [loadSongs]);

  // Re-load after import dialog closes
  const handleImportClose = () => {
    setShowImport(false);
    loadSongs();
  };

  // Sort
  const sorted = [...songs].sort((a, b) => {
    let va: string | number = '';
    let vb: string | number = '';
    if (sortCol === 'title')       { va = a.title; vb = b.title; }
    if (sortCol === 'artist')      { va = a.artist_sort_name || a.artist_name || ''; vb = b.artist_sort_name || b.artist_name || ''; }
    if (sortCol === 'duration')    { va = a.duration_ms; vb = b.duration_ms; }
    if (sortCol === 'last_played') { va = a.last_played_at ?? 0; vb = b.last_played_at ?? 0; }
    if (sortCol === 'spins')       { va = a.spins_total; vb = b.spins_total; }
    const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const toggleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const SortArrow = ({ col }: { col: typeof sortCol }) =>
    sortCol === col ? <span style={{ opacity: 0.7 }}>{sortDir === 'asc' ? ' ↑' : ' ↓'}</span> : null;

  return (
    <div className="page-panel">
      {showImport && <ImportDialog onClose={handleImportClose} />}

      {/* Header */}
      <div className="page-header">
        <span className="page-title">Library</span>
        <span className="page-subtitle" style={{ marginLeft: 8 }}>
          {songs.length.toLocaleString()} tracks
        </span>

        <div className="page-actions">
          <button className="btn btn-secondary btn-sm" onClick={loadSongs}>↺ Refresh</button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowImport(true)}>
            + Import Music
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{
        padding: '8px 16px',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex', gap: 10, alignItems: 'center',
        background: 'var(--bg-panel)',
        flexShrink: 0,
      }}>
        <input
          className="input"
          placeholder="Search title, artist, album..."
          value={searchQuery}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth: 300 }}
        />

        <select
          className="input"
          value={filterCategoryId ?? ''}
          onChange={e => setFilterCategory(e.target.value ? parseInt(e.target.value) : null)}
          style={{ maxWidth: 180 }}
        >
          <option value="">All Categories</option>
          {categories.map(c => (
            <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
          ))}
        </select>

        {(searchQuery || filterCategoryId) && (
          <button className="btn btn-ghost btn-sm" onClick={() => { setSearch(''); setFilterCategory(null); }}>
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
        ) : sorted.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.3 }}>♫</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, color: 'var(--text-muted)' }}>
              No tracks found
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8, marginBottom: 24 }}>
              Import a music folder to get started
            </div>
            <button className="btn btn-primary" onClick={() => setShowImport(true)}>
              + Import Music
            </button>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>Cat</th>
                <th onClick={() => toggleSort('title')} style={{ cursor: 'pointer' }}>
                  Title <SortArrow col="title" />
                </th>
                <th onClick={() => toggleSort('artist')} style={{ cursor: 'pointer' }}>
                  Artist <SortArrow col="artist" />
                </th>
                <th>Album</th>
                <th>Genre</th>
                <th onClick={() => toggleSort('duration')} style={{ cursor: 'pointer', width: 70 }}>
                  Time <SortArrow col="duration" />
                </th>
                <th onClick={() => toggleSort('last_played')} style={{ cursor: 'pointer', width: 90 }}>
                  Last Play <SortArrow col="last_played" />
                </th>
                <th onClick={() => toggleSort('spins')} style={{ cursor: 'pointer', width: 60 }}>
                  Spins <SortArrow col="spins" />
                </th>
                <th style={{ width: 80 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(song => (
                <tr
                  key={song.id}
                  className={selectedSongId === song.id ? 'selected' : ''}
                  onClick={() => setSelectedSong(selectedSongId === song.id ? null : song.id)}
                >
                  <td>
                    {song.category_color && (
                      <span
                        className="cat-badge"
                        style={{ background: song.category_color }}
                        title={song.category_name ?? ''}
                      >
                        {song.category_code}
                      </span>
                    )}
                  </td>
                  <td style={{ maxWidth: 220 }}>
                    <span title={song.title}>{song.title}</span>
                  </td>
                  <td style={{ maxWidth: 160 }}>
                    <span title={song.artist_name ?? ''}>{song.artist_name ?? '—'}</span>
                  </td>
                  <td style={{ maxWidth: 140 }}>
                    <span title={song.album_title ?? ''}>{song.album_title ?? '—'}</span>
                  </td>
                  <td>{song.genre ?? '—'}</td>
                  <td className="td-mono">{formatDuration(song.duration_ms)}</td>
                  <td className="td-mono">{formatLastPlayed(song.last_played_at)}</td>
                  <td className="td-mono">{song.spins_total}</td>
                  <td>
                    <span style={{
                      fontSize: 11,
                      color: song.rotation_status === 'active' ? 'var(--green-air)'
                           : song.rotation_status === 'inactive' ? 'var(--text-muted)'
                           : 'var(--amber)',
                    }}>
                      {song.rotation_status.toUpperCase()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

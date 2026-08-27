'use strict';
// Migration v50 — library_asset: ONE library, every asset typed.
//
// docs/library-asset-build-plan-2026-08-26.md · docs/unified-library-architecture-2026-08-26.md
//
// PURELY ADDITIVE. `songs` and `spots` are untouched and stay authoritative; nothing reads the new
// tables yet. This creates them, backfills them, and stops. Readers flip in a later step, and only
// then does anything change behaviour.
//
// THE RULE THIS MIGRATION IS SHAPED BY: a migration that reaches customers must leave the database
// openable by the PREVIOUS build. 4.4.151 broke that by turning `songs` into a VIEW, and an older
// build running `ALTER TABLE songs ADD COLUMN` against a view got "Cannot add a column to a view",
// an exception out of initDb(), and a fatal dialog with one button: Quit — a machine that could not
// launch. So `songs` stays a real table, is not renamed, is not reshaped, and keeps every column.
// docs/migration-safety-and-customer-recovery-2026-08-06.md
//
// ── THE THREE AXES, AND WHAT THIS TABLE IS NOT ──────────────────────────────────────────────────
//   TYPE      — library_asset.type. 8 codes, developer-defined, install-wide. In this table.
//   CATEGORY  — `categories`. UNLIMITED, operator-created, PER STATION. NOT in this table, and
//               deliberately: a category is how one station programmes an asset, not what it is.
//   METADATA  — `metadata_definitions` + `song_metadata_values`. UNLIMITED custom fields, per
//               station, overriding ANY value. NOT in this table.
// library_asset carries DEFAULTS, never truths. Title and Artist here are what a station sees UNTIL
// it overrides them. No field that is currently per-station overridable becomes a shared value.
//
// NO CHECK CONSTRAINT ON `type`, deliberately. The schema does not know the set of types, so adding a
// ninth is one object in shared/asset-types.json and needs no migration at all.
//
// Idempotent. Verify on a COPY first:
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-library-asset-phase-sync-50.js <copy.db>

const crypto = require('crypto');

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function hasCol(db, t, c) {
  try { return db.prepare(`PRAGMA table_info("${t}")`).all().some(x => x.name === c); } catch { return false; }
}
function isAlreadyMigrated(db) {
  return tableExists(db, 'library_asset');
}

/** content_class → asset type. The rename JIN→SWEEPER happens HERE, in the backfill, so there is no
 *  separate rename step and no window where two names for one thing are both live. */
function typeFromContentClass(cc) {
  const k = String(cc || '').trim().toUpperCase();
  if (k === 'JIN' || k === 'SWP') return 'SWEEPER';
  if (k === 'SPOT') return 'SPOT';
  if (k === 'ANN')  return 'ANNOUNCEMENT';
  return 'SONG';                      // MUSIC, '', NULL and anything unrecognised
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (50)').run(); } catch (e) { /* recorded */ }
    console.log('[migrate-v50] SKIP — library_asset already exists');
    return;
  }

  const migrate = db.transaction(() => {
    // ── THE ASSET ────────────────────────────────────────────────────────────────────────────────
    // INSTALL-SCOPED: no station_id, deliberately. An asset is a FILE, and all four stations draw
    // from one shared library. Adding station_id here would break that and is prohibited.
    db.prepare(`
      CREATE TABLE library_asset (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid           TEXT NOT NULL,
        type           TEXT NOT NULL DEFAULT 'SONG',   -- registry code. NO CHECK, deliberately.
        title          TEXT,                            -- DEFAULT. Per-station overridable.
        artist_id      INTEGER,
        album_id       INTEGER,
        genre          TEXT,
        file_path      TEXT,
        file_key       TEXT,
        duration_ms    INTEGER,
        bpm            REAL,
        energy         REAL,
        mood           TEXT,
        gender         TEXT,
        is_explicit    INTEGER,
        spotify_uri    TEXT,
        cart_id        TEXT,
        -- Cue/intro carried VERBATIM from songs, both the ms and the legacy columns. Reconciling the
        -- two is a units audit and a separate task; dropping either here would lose data on a row
        -- that only populated one of them.
        cue_in         INTEGER, cue_out        INTEGER,
        cue_in_ms      INTEGER, cue_out_ms     INTEGER,
        intro_end      INTEGER, outro_start    INTEGER,
        intro_end_ms   INTEGER, outro_start_ms INTEGER,
        has_intro      INTEGER, intro_version_path TEXT,
        lufs_measured  REAL, peak_db REAL, gain_db REAL, is_processed INTEGER DEFAULT 0,
        last_played_at INTEGER,
        play_count     INTEGER DEFAULT 0,
        raw_metadata   TEXT,
        r2_uploaded_at TIMESTAMP,
        created_at     TEXT, updated_at TEXT, deleted_at TEXT
      )`).run();
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_library_asset_uuid ON library_asset(uuid)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_library_asset_type ON library_asset(type) WHERE deleted_at IS NULL').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_library_asset_file ON library_asset(file_path) WHERE deleted_at IS NULL').run();

    // ── TRAFFIC DETAIL — STATION-SCOPED ──────────────────────────────────────────────────────────
    // The same audio file can be sold to two stations on different terms, so this is per station
    // while the asset is not. Identity unifies; type-specific detail sits beside it.
    db.prepare(`
      CREATE TABLE asset_spot_meta (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_uuid       TEXT NOT NULL,
        station_id       INTEGER NOT NULL,
        spot_type        TEXT, advertiser TEXT, agency TEXT,
        isci_code        TEXT, cart_number TEXT,
        spot_category_id INTEGER,
        start_date       TEXT, end_date TEXT,
        max_plays_day    INTEGER,
        play_count       INTEGER DEFAULT 0,
        last_played_at   INTEGER,
        length_sec       INTEGER,
        notes            TEXT,
        art_image        TEXT,
        is_active        INTEGER DEFAULT 1,
        uuid             TEXT,
        created_at       TEXT, updated_at TEXT, deleted_at TEXT
      )`).run();
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_spot_meta_key
                  ON asset_spot_meta(asset_uuid, station_id) WHERE deleted_at IS NULL`).run();

    // ── SWEEPER DETAIL ───────────────────────────────────────────────────────────────────────────
    db.prepare(`
      CREATE TABLE asset_sweeper_meta (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_uuid          TEXT NOT NULL,
        sweeper_category_id INTEGER,
        uuid                TEXT,
        created_at          TEXT, updated_at TEXT, deleted_at TEXT
      )`).run();
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_sweeper_meta_key
                  ON asset_sweeper_meta(asset_uuid) WHERE deleted_at IS NULL`).run();

    const now = new Date().toISOString();

    // ── BACKFILL 1: songs → library_asset ────────────────────────────────────────────────────────
    // A song's uuid is REUSED as the asset uuid. That is what lets the per-station overlays be
    // bridged below without inventing a mapping table nobody would maintain.
    let songsIn = 0, songsSkipped = 0;
    const byFile = new Map();   // file_path → asset uuid, for reconciling spots against songs
    if (tableExists(db, 'songs')) {
      const ins = db.prepare(`
        INSERT INTO library_asset
          (uuid, type, title, artist_id, album_id, genre, file_path, file_key, duration_ms, bpm,
           energy, mood, gender, is_explicit, spotify_uri, cart_id,
           cue_in, cue_out, cue_in_ms, cue_out_ms, intro_end, outro_start, intro_end_ms,
           outro_start_ms, has_intro, intro_version_path,
           lufs_measured, peak_db, gain_db, is_processed, last_played_at, play_count,
           raw_metadata, r2_uploaded_at, created_at, updated_at, deleted_at)
        VALUES (@uuid, @type, @title, @artist_id, @album_id, @genre, @file_path, @file_key,
                @duration_ms, @bpm, @energy, @mood, @gender, @is_explicit, @spotify_uri, @cart_id,
                @cue_in, @cue_out, @cue_in_ms, @cue_out_ms, @intro_end, @outro_start, @intro_end_ms,
                @outro_start_ms, @has_intro, @intro_version_path,
                @lufs_measured, @peak_db, @gain_db, @is_processed, @last_played_at, @play_count,
                @raw_metadata, @r2_uploaded_at, @created_at, @updated_at, @deleted_at)`);
      const sweep = db.prepare(
        'INSERT INTO asset_sweeper_meta (asset_uuid, sweeper_category_id, uuid, created_at, updated_at) VALUES (?,?,?,?,?)');

      for (const s of db.prepare('SELECT * FROM songs').all()) {
        // A row with no uuid cannot be referenced by an overlay and could never be bridged. Counted
        // and reported, never invented — the same treatment v47 gave uuid-less announcements.
        if (!s.uuid) { songsSkipped++; continue; }
        const type = typeFromContentClass(s.content_class);
        ins.run({
          uuid: s.uuid, type,
          title: s.title, artist_id: s.artist_id, album_id: s.album_id, genre: s.genre,
          file_path: s.file_path, file_key: s.file_key, duration_ms: s.duration_ms, bpm: s.bpm,
          energy: s.energy, mood: s.mood, gender: s.gender, is_explicit: s.is_explicit,
          spotify_uri: s.spotify_uri, cart_id: s.cart_id,
          cue_in: s.cue_in, cue_out: s.cue_out, cue_in_ms: s.cue_in_ms, cue_out_ms: s.cue_out_ms,
          intro_end: s.intro_end, outro_start: s.outro_start,
          intro_end_ms: s.intro_end_ms, outro_start_ms: s.outro_start_ms,
          has_intro: s.has_intro, intro_version_path: s.intro_version_path,
          lufs_measured: s.lufs_measured, peak_db: s.peak_db, gain_db: s.gain_db,
          is_processed: s.is_processed, last_played_at: s.last_played_at,
          play_count: s.play_count ?? 0, raw_metadata: s.raw_metadata,
          r2_uploaded_at: s.r2_uploaded_at,
          created_at: s.created_at != null ? String(s.created_at) : now,
          updated_at: s.updated_at != null ? String(s.updated_at) : now,
          deleted_at: s.deleted_at,
        });
        if (s.file_path && !s.deleted_at) byFile.set(s.file_path, s.uuid);
        if (type === 'SWEEPER' && s.jingle_category_id != null) {
          sweep.run(s.uuid, s.jingle_category_id, crypto.randomUUID(), now, now);
        }
        songsIn++;
      }
    }
    console.log(`[migrate-v50] songs → library_asset: ${songsIn} asset(s)` +
                (songsSkipped ? `, ${songsSkipped} skipped (no uuid — unreferenceable)` : ''));

    // ── BACKFILL 2: spots → library_asset + asset_spot_meta ──────────────────────────────────────
    // THE OVERLAP IS RECONCILED BY file_path AND REPORTED, NEVER SILENTLY MERGED. A spot whose file
    // is already an asset REUSES that asset and gains only its traffic row; one whose file is not
    // becomes a new asset. Both counts are printed, because a silent merge of two stores that are
    // already known to disagree is exactly how a spot would go missing.
    let spotsReused = 0, spotsNew = 0, retyped = 0;
    if (tableExists(db, 'spots')) {
      const insAsset = db.prepare(`
        INSERT INTO library_asset (uuid, type, title, file_path, duration_ms, created_at, updated_at, deleted_at)
        VALUES (?, 'SPOT', ?, ?, ?, ?, ?, ?)`);
      const insMeta = db.prepare(`
        INSERT INTO asset_spot_meta
          (asset_uuid, station_id, spot_type, advertiser, agency, isci_code, cart_number,
           spot_category_id, start_date, end_date, max_plays_day, play_count, last_played_at,
           length_sec, notes, art_image, is_active, uuid, created_at, updated_at, deleted_at)
        VALUES (@asset_uuid, @station_id, @spot_type, @advertiser, @agency, @isci_code, @cart_number,
                @spot_category_id, @start_date, @end_date, @max_plays_day, @play_count,
                @last_played_at, @length_sec, @notes, @art_image, @is_active, @uuid,
                @created_at, @updated_at, @deleted_at)`);
      const retype = db.prepare("UPDATE library_asset SET type='SPOT' WHERE uuid=? AND type<>'SPOT'");

      for (const sp of db.prepare('SELECT * FROM spots').all()) {
        let assetUuid = sp.file_path ? byFile.get(sp.file_path) : null;
        if (assetUuid) {
          // The file is already an asset. It is a spot on at least one station, so the ASSET is a
          // SPOT — retyped, and counted so the reconciliation is visible rather than assumed.
          if (retype.run(assetUuid).changes > 0) retyped++;
          spotsReused++;
        } else {
          assetUuid = sp.uuid || crypto.randomUUID();
          insAsset.run(assetUuid, sp.title, sp.file_path,
                       sp.length_sec != null ? sp.length_sec * 1000 : null,
                       sp.created_at != null ? String(sp.created_at) : now,
                       sp.updated_at != null ? String(sp.updated_at) : now, sp.deleted_at);
          if (sp.file_path && !sp.deleted_at) byFile.set(sp.file_path, assetUuid);
          spotsNew++;
        }
        insMeta.run({
          asset_uuid: assetUuid, station_id: sp.station_id,
          spot_type: sp.spot_type, advertiser: sp.advertiser, agency: sp.agency,
          isci_code: sp.isci_code, cart_number: sp.cart_number,
          spot_category_id: sp.spot_category_id,
          start_date: sp.start_date, end_date: sp.end_date, max_plays_day: sp.max_plays_day,
          play_count: sp.play_count ?? 0, last_played_at: sp.last_played_at,
          length_sec: sp.length_sec, notes: sp.notes, art_image: sp.art_image,
          is_active: sp.is_active ?? 1, uuid: crypto.randomUUID(),
          created_at: sp.created_at != null ? String(sp.created_at) : now,
          updated_at: sp.updated_at != null ? String(sp.updated_at) : now,
          deleted_at: sp.deleted_at,
        });
      }
    }
    console.log(`[migrate-v50] spots → library_asset: ${spotsNew} new asset(s), ${spotsReused} reused an existing asset` +
                (retyped ? `, ${retyped} retyped to SPOT` : ''));

    // ── BRIDGE: the two EXISTING per-station overlays gain asset_uuid ─────────────────────────────
    // NOT rebuilt, NOT replaced — widened. station_programming (how a station programmes an asset)
    // and song_metadata_values (per-station override of ANY field, including Title and Artist) both
    // key on song_id today. Adding asset_uuid lets them key on any asset type without changing one
    // thing that reads them now. Both keep song_id; nothing is dropped.
    let bridged = 0;
    for (const t of ['station_programming', 'song_metadata_values']) {
      if (!tableExists(db, t)) continue;
      if (!hasCol(db, t, 'asset_uuid')) db.prepare(`ALTER TABLE ${t} ADD COLUMN asset_uuid TEXT`).run();
      const n = db.prepare(
        `UPDATE ${t} SET asset_uuid = (SELECT s.uuid FROM songs s WHERE s.id = ${t}.song_id)
          WHERE asset_uuid IS NULL`).run().changes;
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_${t}_asset ON ${t}(asset_uuid)`).run();
      console.log(`[migrate-v50] ${t}: +asset_uuid, ${n} row(s) bridged`);
      bridged += n;
    }

    const total = db.prepare('SELECT COUNT(*) n FROM library_asset').get().n;
    const byType = db.prepare("SELECT type, COUNT(*) n FROM library_asset WHERE deleted_at IS NULL GROUP BY type ORDER BY n DESC").all();
    console.log(`[migrate-v50] library_asset holds ${total} row(s): ` +
                byType.map(r => `${r.type} ${r.n}`).join(' · '));

    db.prepare('INSERT INTO schema_version (version) VALUES (50)').run();
  });
  migrate();
  console.log('[migrate-v50] Transaction committed — songs and spots are UNTOUCHED and still authoritative.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — library_asset and its meta tables are brand new, so there are no older payloads to
    // transform. The asset_uuid columns added to the two existing overlays are additive and nullable,
    // so an older peer's payload without them applies unchanged.
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os   = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);
  console.log('=== migrate-library-asset-phase-sync-50.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}

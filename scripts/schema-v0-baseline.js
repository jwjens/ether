'use strict';
// schema-v0-baseline.js — base schema for fresh installs (Option B).
// Called by runMigrations() BEFORE v1–v16 migrations.
// All statements are CREATE TABLE IF NOT EXISTS — fully idempotent on
// existing installs (every statement is a no-op if the table already exists).
// Do NOT add seeding, ALTER TABLE, or business logic here.

module.exports = function applyBaseline(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

    CREATE TABLE IF NOT EXISTS artists (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      sort_name  TEXT,
      gender     TEXT DEFAULT 'unknown',
      created_at INTEGER DEFAULT (unixepoch()),
      uuid       TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS albums (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      artist_id  INTEGER REFERENCES artists(id),
      year       INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      uuid       TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS categories (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      code           TEXT NOT NULL UNIQUE,
      name           TEXT NOT NULL,
      color          TEXT,
      spins_per_hour INTEGER DEFAULT 1,
      priority       INTEGER DEFAULT 0,
      station_id     INTEGER NOT NULL DEFAULT 1,
      uuid           TEXT,
      created_at     TEXT,
      updated_at     TEXT,
      deleted_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS songs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      title              TEXT NOT NULL,
      file_path          TEXT,
      artist_id          INTEGER REFERENCES artists(id),
      album_id           INTEGER REFERENCES albums(id),
      category_id        INTEGER REFERENCES categories(id),
      genre              TEXT,
      duration_ms        INTEGER,
      bpm                REAL,
      energy             REAL,
      mood               TEXT,
      gender             TEXT DEFAULT 'unknown',
      rotation_status    TEXT DEFAULT 'active',
      daypart_mask       INTEGER DEFAULT 127,
      no_repeat_hours    INTEGER DEFAULT 2,
      lufs_measured      REAL,
      peak_db            REAL,
      gain_db            REAL DEFAULT 0,
      is_processed       INTEGER DEFAULT 0,
      cue_in             INTEGER,
      cue_out            INTEGER,
      cue_in_ms          INTEGER,
      cue_out_ms         INTEGER,
      intro_end          INTEGER,
      outro_start        INTEGER,
      intro_end_ms       INTEGER,
      outro_start_ms     INTEGER,
      intro_version_path TEXT,
      has_intro          INTEGER DEFAULT 0,
      last_played_at     INTEGER,
      play_count         INTEGER DEFAULT 0,
      is_explicit        INTEGER DEFAULT 0,
      created_at         INTEGER DEFAULT (unixepoch()),
      updated_at         INTEGER DEFAULT (unixepoch()),
      raw_metadata       TEXT,
      spotify_uri        TEXT DEFAULT NULL,
      uuid               TEXT,
      deleted_at         TEXT
    );

    CREATE TABLE IF NOT EXISTS pinned_songs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id       INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      slot_hour     INTEGER NOT NULL,
      slot_position INTEGER DEFAULT 0,
      recur_dow     INTEGER DEFAULT 0,
      play_at_unix  INTEGER DEFAULT 0,
      start_unix    INTEGER DEFAULT 0,
      end_unix      INTEGER DEFAULT 0,
      force_play    INTEGER DEFAULT 0,
      pinned_by     TEXT DEFAULT '',
      reason        TEXT DEFAULT '',
      consumed_at   INTEGER DEFAULT 0,
      created_at    INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS separation_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type   TEXT NOT NULL,
      scope       TEXT DEFAULT 'global',
      value       INTEGER NOT NULL DEFAULT 0,
      is_hard     INTEGER DEFAULT 0,
      is_active   INTEGER DEFAULT 1,
      description TEXT,
      station_id  INTEGER NOT NULL DEFAULT 1,
      uuid        TEXT,
      created_at  TEXT,
      updated_at  TEXT,
      deleted_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS clocks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      show_id     INTEGER,
      description TEXT,
      color       TEXT,
      station_id  INTEGER NOT NULL DEFAULT 1,
      uuid        TEXT,
      created_at  TEXT,
      updated_at  TEXT,
      deleted_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS clock_slots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      clock_id     INTEGER NOT NULL REFERENCES clocks(id),
      position     INTEGER NOT NULL DEFAULT 0,
      slot_type    TEXT NOT NULL DEFAULT 'music',
      category_id  INTEGER REFERENCES categories(id),
      label        TEXT,
      duration_min INTEGER DEFAULT 4,
      station_id   INTEGER NOT NULL DEFAULT 1,
      uuid         TEXT,
      created_at   TEXT,
      updated_at   TEXT,
      deleted_at   TEXT,
      chain_type   TEXT DEFAULT 'segue'
    );

    CREATE TABLE IF NOT EXISTS shows (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      start_hour  INTEGER DEFAULT 0,
      end_hour    INTEGER DEFAULT 1,
      days        TEXT DEFAULT '0123456',
      color       TEXT,
      description TEXT,
      is_active   INTEGER DEFAULT 1,
      clock_id    INTEGER REFERENCES clocks(id),
      station_id  INTEGER NOT NULL DEFAULT 1,
      uuid        TEXT,
      created_at  TEXT,
      updated_at  TEXT,
      deleted_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS play_log (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      title              TEXT NOT NULL,
      artist             TEXT,
      deck               TEXT,
      deck_id            TEXT,
      duration_ms        INTEGER,
      session_id         TEXT,
      played_at          INTEGER DEFAULT (unixepoch()),
      scheduled_log_id   INTEGER,
      show_name          TEXT,
      category_code      TEXT,
      station_id         INTEGER NOT NULL DEFAULT 1,
      uuid               TEXT,
      created_at         TEXT,
      updated_at         TEXT,
      deleted_at         TEXT,
      programming_row_id INTEGER REFERENCES station_programming(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      log_date         TEXT,
      hour             INTEGER,
      position         INTEGER,
      song_id          INTEGER REFERENCES songs(id),
      title            TEXT,
      artist           TEXT,
      category_id      INTEGER,
      duration_ms      INTEGER,
      clock_id         INTEGER,
      created_at       INTEGER DEFAULT (unixepoch()),
      overflow         INTEGER DEFAULT 0,
      fade_out_at_ms   INTEGER DEFAULT 0,
      fade_duration_ms INTEGER DEFAULT 8000,
      chain_type       TEXT DEFAULT 'segue',
      station_id       INTEGER NOT NULL DEFAULT 1,
      uuid             TEXT,
      updated_at       TEXT,
      deleted_at       TEXT,
      -- renderer display optimization columns (denormalized for fast UI rendering, not synced)
      category_code    TEXT,
      slot_type        TEXT,
      song_title       TEXT,
      song_artist      TEXT,
      category_color   TEXT,
      label            TEXT,
      status           TEXT
    );

    CREATE TABLE IF NOT EXISTS spots (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      title          TEXT NOT NULL,
      file_path      TEXT,
      spot_type      TEXT DEFAULT 'promo',
      advertiser     TEXT,
      start_date     TEXT,
      end_date       TEXT,
      max_plays_day  INTEGER,
      play_count     INTEGER DEFAULT 0,
      last_played_at INTEGER,
      is_active      INTEGER DEFAULT 1,
      notes          TEXT,
      created_at     INTEGER DEFAULT (unixepoch()),
      isci_code      TEXT,
      cart_number    TEXT,
      agency         TEXT,
      length_sec     INTEGER,
      station_id     INTEGER NOT NULL DEFAULT 1,
      uuid           TEXT,
      updated_at     TEXT,
      deleted_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS cart_slots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_number INTEGER UNIQUE,
      title       TEXT,
      file_path   TEXT,
      color       TEXT DEFAULT '#3b82f6',
      hotkey      TEXT,
      station_id  INTEGER NOT NULL DEFAULT 1,
      uuid        TEXT,
      created_at  TEXT,
      updated_at  TEXT,
      deleted_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      title          TEXT NOT NULL,
      file_path      TEXT,
      trigger_time   TEXT,
      days           TEXT DEFAULT '0123456',
      duck_music     INTEGER DEFAULT 1,
      resume_music   INTEGER DEFAULT 1,
      duck_level     REAL DEFAULT 0.2,
      is_active      INTEGER DEFAULT 1,
      last_played_at INTEGER,
      created_at     INTEGER DEFAULT (unixepoch()),
      station_id     INTEGER NOT NULL DEFAULT 1,
      uuid           TEXT,
      updated_at     TEXT,
      deleted_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS voice_tracks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT,
      file_path     TEXT,
      show_id       INTEGER REFERENCES shows(id),
      clock_slot_id INTEGER REFERENCES clock_slots(id),
      duration_ms   INTEGER,
      recorded_by   TEXT,
      recorded_at   INTEGER DEFAULT (unixepoch()),
      station_id    INTEGER NOT NULL DEFAULT 1,
      uuid          TEXT,
      created_at    TEXT,
      updated_at    TEXT,
      deleted_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS station_config_kv (
      station_id INTEGER NOT NULL,
      key        TEXT    NOT NULL,
      value      TEXT,
      uuid       TEXT    NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      deleted_at INTEGER,
      PRIMARY KEY (station_id, key)
    );

    CREATE TABLE IF NOT EXISTS install_config_kv (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      uuid       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS install_secrets_kv (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      uuid       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS smart_schedule_rules (
      id           TEXT PRIMARY KEY,
      description  TEXT,
      days         TEXT,
      start_hour   INTEGER,
      end_hour     INTEGER,
      energy_level TEXT,
      bpm_min      INTEGER,
      bpm_max      INTEGER,
      genre        TEXT,
      is_active    INTEGER DEFAULT 1,
      station_id   INTEGER NOT NULL DEFAULT 1,
      uuid         TEXT,
      created_at   TEXT,
      updated_at   TEXT,
      deleted_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS stream_settings (
      id        INTEGER PRIMARY KEY DEFAULT 1,
      host      TEXT,
      port      INTEGER,
      mount     TEXT,
      username  TEXT,
      password  TEXT,
      format    TEXT DEFAULT 'mp3',
      bitrate   INTEGER DEFAULT 128,
      is_active INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS stations (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      name                    TEXT NOT NULL,
      callsign                TEXT,
      frequency               TEXT,
      city                    TEXT,
      state                   TEXT,
      country                 TEXT DEFAULT 'US',
      website                 TEXT,
      is_active               INTEGER DEFAULT 1,
      created_at              INTEGER DEFAULT (unixepoch()),
      icecast_server_url      TEXT DEFAULT NULL,
      icecast_mount           TEXT DEFAULT '/live',
      icecast_password        TEXT DEFAULT 'hackme',
      icecast_bitrate         INTEGER DEFAULT 128,
      icecast_format          TEXT DEFAULT 'mp3',
      uuid                    TEXT,
      updated_at              TEXT,
      deleted_at              TEXT,
      icecast_port            INTEGER DEFAULT 8000,
      audio_device_output     TEXT,
      mic_device              TEXT,
      mount_pending_provision INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS monitor_routing (
      output_device_id TEXT PRIMARY KEY,
      station_id       INTEGER,
      uuid             TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      deleted_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS liner_cards (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      category   TEXT DEFAULT 'Custom',
      color      TEXT DEFAULT '#94a3b8',
      pinned     INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      station_id INTEGER NOT NULL DEFAULT 1,
      uuid       TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS prep_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      body       TEXT DEFAULT '',
      show_date  TEXT DEFAULT '',
      category   TEXT DEFAULT 'Script',
      created_at INTEGER DEFAULT (unixepoch()),
      station_id INTEGER NOT NULL DEFAULT 1,
      uuid       TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS published_episodes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT,
      file_path    TEXT,
      show_id      INTEGER,
      published_at INTEGER DEFAULT (unixepoch()),
      station_id   INTEGER NOT NULL DEFAULT 1,
      uuid         TEXT,
      created_at   TEXT,
      updated_at   TEXT,
      deleted_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS format_clocks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      slots      TEXT DEFAULT '[]',
      created_at INTEGER DEFAULT (unixepoch()),
      daypart    TEXT NOT NULL DEFAULT 'Morning Drive',
      slots_json TEXT NOT NULL DEFAULT '[]',
      station_id INTEGER NOT NULL DEFAULT 1,
      uuid       TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS crash_recovery (
      id              INTEGER PRIMARY KEY DEFAULT 1,
      data            TEXT,
      saved_at        INTEGER DEFAULT (unixepoch()),
      queue_json      TEXT DEFAULT '[]',
      deck_a_path     TEXT,
      deck_a_title    TEXT,
      deck_a_artist   TEXT,
      deck_a_position INTEGER DEFAULT 0,
      was_playing     INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS users (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT NOT NULL,
      role     TEXT NOT NULL DEFAULT 'jock',
      pin_hash TEXT,
      color    TEXT NOT NULL DEFAULT '#22d3ee'
    );

    CREATE TABLE IF NOT EXISTS rtmp_destinations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      url        TEXT NOT NULL,
      stream_key TEXT DEFAULT '',
      is_active  INTEGER DEFAULT 1,
      station_id INTEGER NOT NULL DEFAULT 1,
      uuid       TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deck_configs (
      slot       TEXT PRIMARY KEY,
      type       TEXT NOT NULL DEFAULT 'music',
      label      TEXT NOT NULL,
      color      TEXT NOT NULL DEFAULT '#34d399',
      enabled    INTEGER NOT NULL DEFAULT 0,
      purpose    TEXT DEFAULT '',
      station_id INTEGER NOT NULL DEFAULT 1,
      uuid       TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS macros (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      description   TEXT,
      trigger_type  TEXT NOT NULL DEFAULT 'manual',
      trigger_value TEXT,
      actions       TEXT NOT NULL DEFAULT '[]',
      hotkey        TEXT,
      is_active     INTEGER DEFAULT 1,
      color         TEXT DEFAULT '#38bdf8',
      created_at    INTEGER DEFAULT (unixepoch()),
      station_id    INTEGER NOT NULL DEFAULT 1,
      uuid          TEXT,
      updated_at    TEXT,
      deleted_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_macros_station_trigger ON macros(station_id, trigger_type, is_active);
    CREATE INDEX IF NOT EXISTS idx_macros_station_hotkey ON macros(station_id, hotkey, is_active) WHERE hotkey IS NOT NULL;

    CREATE TABLE IF NOT EXISTS scheduling_rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL,
      name       TEXT NOT NULL,
      rule_type  TEXT NOT NULL,
      rule_data  TEXT,
      is_active  INTEGER NOT NULL DEFAULT 1,
      uuid       TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS generated_schedule (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduled_at INTEGER NOT NULL,
      song_id      INTEGER REFERENCES songs(id),
      title        TEXT NOT NULL,
      artist       TEXT,
      file_key     TEXT,
      duration_s   INTEGER DEFAULT 0,
      category_id  INTEGER,
      clock_id     INTEGER,
      generated_at INTEGER DEFAULT (unixepoch()),
      station_id   INTEGER NOT NULL DEFAULT 1,
      uuid         TEXT,
      created_at   TEXT,
      updated_at   TEXT,
      deleted_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS midi_mappings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_name TEXT,
      channel     INTEGER DEFAULT 0,
      type        TEXT DEFAULT 'cc',
      number      INTEGER DEFAULT 0,
      action      TEXT NOT NULL,
      label       TEXT,
      is_fader    INTEGER DEFAULT 0,
      station_id  INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS studio_sessions (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS studio_session_versions (
      id             TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      label          TEXT,
      snapshot       TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES studio_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS studio_notes (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      position_ms INTEGER NOT NULL,
      track_id    TEXT,
      author      TEXT NOT NULL,
      text        TEXT NOT NULL,
      color       TEXT DEFAULT '#f59e0b',
      resolved    INTEGER DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eas_tests (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at       INTEGER NOT NULL,
      alert_code        TEXT NOT NULL,
      direction         TEXT NOT NULL DEFAULT 'received',
      originator        TEXT DEFAULT '',
      sender_id         TEXT DEFAULT '',
      received_from     TEXT DEFAULT '',
      retransmitted     INTEGER DEFAULT 0,
      retransmitted_at  INTEGER DEFAULT 0,
      operator_initials TEXT DEFAULT '',
      notes             TEXT DEFAULT '',
      created_at        INTEGER DEFAULT (unixepoch()),
      station_id        INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS ai_voice_templates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      kind            TEXT DEFAULT 'evergreen',
      prompt_template TEXT NOT NULL,
      voice_id        TEXT DEFAULT '',
      provider        TEXT DEFAULT '',
      created_at      INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS ai_voice_segments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id  INTEGER,
      title        TEXT NOT NULL,
      script       TEXT NOT NULL,
      provider     TEXT NOT NULL,
      voice_id     TEXT NOT NULL,
      file_path    TEXT DEFAULT '',
      duration_ms  INTEGER DEFAULT 0,
      size_bytes   INTEGER DEFAULT 0,
      status       TEXT DEFAULT 'pending',
      error_msg    TEXT DEFAULT '',
      generated_at INTEGER DEFAULT 0,
      played_at    INTEGER DEFAULT 0,
      created_at   INTEGER DEFAULT (unixepoch()),
      station_id   INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS operators (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      initials   TEXT NOT NULL DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch()),
      theme      TEXT DEFAULT NULL,
      station_id INTEGER NOT NULL DEFAULT 1,
      uuid       TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS operator_notes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_id INTEGER NOT NULL REFERENCES operators(id),
      note        TEXT NOT NULL DEFAULT '',
      updated_at  INTEGER DEFAULT (unixepoch()),
      station_id  INTEGER NOT NULL DEFAULT 1,
      uuid        TEXT,
      created_at  TEXT,
      deleted_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS scheduler_reasons (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      picked_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      song_id       INTEGER NOT NULL,
      source        TEXT NOT NULL,
      source_detail TEXT DEFAULT '',
      category_id   INTEGER,
      hour          INTEGER,
      filters_json  TEXT DEFAULT '',
      pool_size     INTEGER DEFAULT 0,
      notes         TEXT DEFAULT ''
    );
  `);
};

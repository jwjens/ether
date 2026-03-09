-- OpenAir: Free Broadcast Automation
-- Migration 001: Initial Schema
-- SQLite via tauri-plugin-sql

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- SONG LIBRARY
-- ============================================================

CREATE TABLE IF NOT EXISTS artists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  sort_name   TEXT,                        -- "Beatles, The" for sorting
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS albums (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  artist_id   INTEGER REFERENCES artists(id) ON DELETE SET NULL,
  year        INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS songs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT NOT NULL,
  artist_id         INTEGER REFERENCES artists(id) ON DELETE SET NULL,
  album_id          INTEGER REFERENCES albums(id) ON DELETE SET NULL,

  -- File
  file_path         TEXT UNIQUE,            -- absolute path on disk
  file_format       TEXT,                   -- mp3, flac, ogg, wav
  file_size_bytes   INTEGER,

  -- Timing (all in milliseconds)
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  intro_ms          INTEGER NOT NULL DEFAULT 0,   -- post-intro cue (where vocals start)
  outro_ms          INTEGER NOT NULL DEFAULT 0,   -- segue point from end
  hook_start_ms     INTEGER,                      -- hook/sample start
  hook_end_ms       INTEGER,

  -- Audio analysis
  bpm               REAL,
  key_signature     TEXT,
  loudness_lufs     REAL,                   -- integrated loudness (EBU R128)
  peak_db           REAL,

  -- Classification
  genre             TEXT,
  subgenre          TEXT,
  mood              TEXT,
  energy            INTEGER CHECK(energy BETWEEN 1 AND 10),
  era               TEXT,                   -- e.g. "80s", "90s", "current"
  language          TEXT DEFAULT 'en',
  is_explicit       INTEGER NOT NULL DEFAULT 0,  -- bool
  is_instrumental   INTEGER NOT NULL DEFAULT 0,  -- bool

  -- Rotation metadata
  category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  rotation_status   TEXT NOT NULL DEFAULT 'active'
                    CHECK(rotation_status IN ('active','recurrent','library','inactive','gold')),
  spins_total       INTEGER NOT NULL DEFAULT 0,
  spins_this_week   INTEGER NOT NULL DEFAULT 0,
  last_played_at    INTEGER,                -- unix timestamp
  last_played_hour  INTEGER,               -- 0-23, for daypart separation rules

  -- Scheduling rules (inline flags for quick filtering)
  no_repeat_hours   INTEGER NOT NULL DEFAULT 2,  -- min hours before same song replays
  no_artist_hours   INTEGER NOT NULL DEFAULT 1,  -- min hours before same artist replays
  daypart_mask      INTEGER NOT NULL DEFAULT 16777215,  -- bitmask 24 bits = 24 hours; all 1s = unrestricted
  gender            TEXT CHECK(gender IN ('male','female','group','unknown')) DEFAULT 'unknown',

  -- Tags / searchability
  tags              TEXT,                   -- JSON array of freeform tags

  -- Admin
  notes             TEXT,
  added_by          TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_songs_artist    ON songs(artist_id);
CREATE INDEX IF NOT EXISTS idx_songs_category  ON songs(category_id);
CREATE INDEX IF NOT EXISTS idx_songs_last_play ON songs(last_played_at);
CREATE INDEX IF NOT EXISTS idx_songs_status    ON songs(rotation_status);

-- ============================================================
-- CATEGORIES (Music beds / rotation bins)
-- ============================================================

CREATE TABLE IF NOT EXISTS categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,    -- e.g. "A", "B", "GOLD", "CHR"
  name          TEXT NOT NULL,           -- e.g. "Current Recurrents"
  color         TEXT,                    -- hex color for UI
  description   TEXT,
  target_spins_per_week  INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================================
-- SCHEDULING RULES (applied per category or globally)
-- ============================================================

CREATE TABLE IF NOT EXISTS scheduling_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  scope           TEXT NOT NULL CHECK(scope IN ('global','category','song')),
  scope_id        INTEGER,               -- category_id or song_id when scope != global
  rule_type       TEXT NOT NULL,
  -- rule_type options:
  --   'artist_separation'  : min minutes between same artist
  --   'song_separation'    : min minutes before same song replays
  --   'title_separation'   : no two songs with same title keyword
  --   'gender_balance'     : max consecutive same gender
  --   'energy_flow'        : restrict energy level sequences
  --   'era_spread'         : max consecutive from same era
  --   'tempo_flow'         : BPM step limit between adjacent songs
  --   'daypart_restriction': restrict to specific hours
  --   'max_consecutive'    : max songs from same category in a row
  value_int       INTEGER,
  value_text      TEXT,
  value_json      TEXT,                  -- for complex rule parameters
  is_hard_rule    INTEGER NOT NULL DEFAULT 1,  -- 0 = soft/warn, 1 = hard/block
  priority        INTEGER NOT NULL DEFAULT 100,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================================
-- CLOCK / FORMAT WHEELS
-- ============================================================

CREATE TABLE IF NOT EXISTS clocks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  code          TEXT NOT NULL UNIQUE,   -- short ref e.g. "AM_DRIVE"
  description   TEXT,
  total_minutes INTEGER NOT NULL DEFAULT 60,
  is_default    INTEGER NOT NULL DEFAULT 0,
  color         TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS clock_slots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  clock_id        INTEGER NOT NULL REFERENCES clocks(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,       -- slot order within the hour (0-based)
  slot_type       TEXT NOT NULL CHECK(slot_type IN (
                    'music',              -- pull from category rotation
                    'spot_break',         -- commercial/spot block
                    'liner',              -- station ID / imaging
                    'sweeper',            -- bed/sweeper
                    'jingle',             -- jingle
                    'news',               -- news break
                    'weather',            -- weather break
                    'traffic',            -- traffic break
                    'talkset',            -- DJ talk
                    'fixed',              -- a specific, pinned song/cart
                    'filler'              -- flexible fill
                  )),

  -- For music slots
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,

  -- For fixed/specific item slots
  song_id         INTEGER REFERENCES songs(id) ON DELETE SET NULL,
  spot_id         INTEGER REFERENCES spots(id) ON DELETE SET NULL,

  -- Timing within the clock (minutes from top of hour)
  scheduled_minute  INTEGER,             -- approx minute this slot falls at
  duration_ms       INTEGER,             -- override expected duration (null = auto)

  -- UI / wheel visualization
  color           TEXT,                  -- override slot color
  label           TEXT,                  -- override display label
  notes           TEXT,

  UNIQUE(clock_id, position)
);

-- ============================================================
-- HOURLY LOGS (the actual generated playout schedule)
-- ============================================================

CREATE TABLE IF NOT EXISTS log_hours (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  log_date      TEXT NOT NULL,           -- ISO date "2024-03-15"
  hour          INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
  clock_id      INTEGER REFERENCES clocks(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK(status IN ('draft','locked','aired','partial')),
  generated_at  INTEGER,
  locked_at     INTEGER,
  notes         TEXT,
  UNIQUE(log_date, hour)
);

CREATE TABLE IF NOT EXISTS log_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  log_hour_id     INTEGER NOT NULL REFERENCES log_hours(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,       -- play order within the hour
  slot_type       TEXT NOT NULL,          -- mirrors clock_slots.slot_type
  
  -- What's scheduled
  song_id         INTEGER REFERENCES songs(id) ON DELETE SET NULL,
  spot_id         INTEGER REFERENCES spots(id) ON DELETE SET NULL,
  
  -- Timing
  scheduled_time  TEXT,                   -- "HH:MM:SS" wall-clock time
  actual_time     TEXT,                   -- filled in during playout
  duration_ms     INTEGER,

  -- Playout state
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','playing','played','skipped','error')),
  played_at       INTEGER,                -- unix timestamp of actual play
  
  -- Override / notes
  override_reason TEXT,
  notes           TEXT,

  UNIQUE(log_hour_id, position)
);

CREATE INDEX IF NOT EXISTS idx_log_entries_hour   ON log_entries(log_hour_id);
CREATE INDEX IF NOT EXISTS idx_log_entries_song   ON log_entries(song_id);
CREATE INDEX IF NOT EXISTS idx_log_hours_date     ON log_hours(log_date, hour);

-- ============================================================
-- SPOT / COMMERCIAL INVENTORY
-- ============================================================

CREATE TABLE IF NOT EXISTS advertisers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  contact     TEXT,
  notes       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS spots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  advertiser_id   INTEGER REFERENCES advertisers(id) ON DELETE SET NULL,
  
  -- File
  file_path       TEXT UNIQUE,
  file_format     TEXT,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  
  -- Campaign / scheduling
  spot_type       TEXT NOT NULL DEFAULT 'commercial'
                  CHECK(spot_type IN ('commercial','psa','promo','liner','sweeper','jingle','imaging')),
  start_date      TEXT,                   -- ISO date, null = always eligible
  end_date        TEXT,                   -- ISO date, null = no expiry
  max_plays_per_day    INTEGER,
  max_plays_per_hour   INTEGER DEFAULT 1,
  
  -- Daypart targeting (same bitmask approach as songs)
  daypart_mask    INTEGER NOT NULL DEFAULT 16777215,
  
  -- Rotation
  priority        INTEGER NOT NULL DEFAULT 50,  -- higher = more likely to fill break
  spins_total     INTEGER NOT NULL DEFAULT 0,
  spins_today     INTEGER NOT NULL DEFAULT 0,
  last_played_at  INTEGER,
  
  is_active       INTEGER NOT NULL DEFAULT 1,
  notes           TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS spot_breaks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,          -- e.g. "Standard 2-min break"
  total_duration_ms INTEGER NOT NULL DEFAULT 120000,
  spot_count      INTEGER NOT NULL DEFAULT 2,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS spot_break_slots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_break_id   INTEGER NOT NULL REFERENCES spot_breaks(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  spot_type_filter TEXT,                  -- optional: only fill with this spot_type
  duration_ms     INTEGER,               -- target duration for this slot
  UNIQUE(spot_break_id, position)
);

-- ============================================================
-- LIVE ASSIST / CART WALL
-- ============================================================

CREATE TABLE IF NOT EXISTS cart_walls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  rows        INTEGER NOT NULL DEFAULT 4,
  cols        INTEGER NOT NULL DEFAULT 8,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS cart_buttons (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_wall_id  INTEGER NOT NULL REFERENCES cart_walls(id) ON DELETE CASCADE,
  row_index     INTEGER NOT NULL,
  col_index     INTEGER NOT NULL,
  label         TEXT,
  color         TEXT DEFAULT '#2d6a4f',
  
  -- What it triggers
  target_type   TEXT NOT NULL CHECK(target_type IN ('song','spot','silence','command')),
  song_id       INTEGER REFERENCES songs(id) ON DELETE SET NULL,
  spot_id       INTEGER REFERENCES spots(id) ON DELETE SET NULL,
  command       TEXT,                     -- e.g. "STOP_ALL", "FADE_OUT"
  
  -- Playback behavior
  play_mode     TEXT NOT NULL DEFAULT 'instant'
                CHECK(play_mode IN (
                  'instant',              -- plays immediately, interrupts nothing
                  'next',                 -- queues as next item
                  'loop',                 -- loops until stopped
                  'toggle'               -- play/stop toggle
                )),
  hotkey        TEXT,                     -- keyboard shortcut e.g. "F1"
  
  UNIQUE(cart_wall_id, row_index, col_index)
);

-- ============================================================
-- FORMAT SCHEDULE (which clock runs at which time)
-- ============================================================

CREATE TABLE IF NOT EXISTS format_schedule (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week INTEGER CHECK(day_of_week BETWEEN 0 AND 6),  -- 0=Sun, null=all days
  hour        INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
  clock_id    INTEGER NOT NULL REFERENCES clocks(id) ON DELETE CASCADE,
  priority    INTEGER NOT NULL DEFAULT 100,
  UNIQUE(day_of_week, hour)
);

-- ============================================================
-- APP SETTINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('station_name', 'My Station'),
  ('station_slogan', ''),
  ('default_cart_wall_id', NULL),
  ('audio_output_device', 'default'),
  ('crossfade_ms', '0'),
  ('log_auto_generate_hours_ahead', '24'),
  ('library_scan_path', ''),
  ('lufs_target', '-14.0'),
  ('theme', 'dark');

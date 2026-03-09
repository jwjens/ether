// OpenAir — TypeScript Data Models
// Mirrors the SQLite schema exactly; used throughout the React app.

// ============================================================
// PRIMITIVES
// ============================================================

export type RotationStatus = 'active' | 'recurrent' | 'library' | 'inactive' | 'gold';
export type SlotType =
  | 'music' | 'spot_break' | 'liner' | 'sweeper' | 'jingle'
  | 'news' | 'weather' | 'traffic' | 'talkset' | 'fixed' | 'filler';
export type SpotType = 'commercial' | 'psa' | 'promo' | 'liner' | 'sweeper' | 'jingle' | 'imaging';
export type PlayMode = 'instant' | 'next' | 'loop' | 'toggle';
export type CartTargetType = 'song' | 'spot' | 'silence' | 'command';
export type LogStatus = 'draft' | 'locked' | 'aired' | 'partial';
export type EntryStatus = 'pending' | 'playing' | 'played' | 'skipped' | 'error';
export type RuleScope = 'global' | 'category' | 'song';
export type RuleType =
  | 'artist_separation' | 'song_separation' | 'title_separation'
  | 'gender_balance' | 'energy_flow' | 'era_spread' | 'tempo_flow'
  | 'daypart_restriction' | 'max_consecutive';

// ============================================================
// SONG LIBRARY
// ============================================================

export interface Artist {
  id: number;
  name: string;
  sort_name: string | null;
  created_at: number;
}

export interface Album {
  id: number;
  title: string;
  artist_id: number | null;
  year: number | null;
  created_at: number;
}

/** Core song record — maps 1:1 to the songs table */
export interface Song {
  id: number;
  title: string;
  artist_id: number | null;
  album_id: number | null;

  // File
  file_path: string | null;
  file_format: string | null;
  file_size_bytes: number | null;

  // Timing (ms)
  duration_ms: number;
  intro_ms: number;
  outro_ms: number;
  hook_start_ms: number | null;
  hook_end_ms: number | null;

  // Audio analysis
  bpm: number | null;
  key_signature: string | null;
  loudness_lufs: number | null;
  peak_db: number | null;

  // Classification
  genre: string | null;
  subgenre: string | null;
  mood: string | null;
  energy: number | null;    // 1–10
  era: string | null;
  language: string;
  is_explicit: boolean;
  is_instrumental: boolean;

  // Rotation
  category_id: number | null;
  rotation_status: RotationStatus;
  spins_total: number;
  spins_this_week: number;
  last_played_at: number | null;
  last_played_hour: number | null;

  // Scheduling rules (per-song overrides)
  no_repeat_hours: number;
  no_artist_hours: number;
  daypart_mask: number;     // 24-bit bitmask, bit N = hour N is allowed
  gender: 'male' | 'female' | 'group' | 'unknown';

  tags: string[];           // parsed from JSON
  notes: string | null;
  added_by: string | null;
  created_at: number;
  updated_at: number;
}

/** Song + joined artist/album/category for display */
export interface SongView extends Song {
  artist_name: string | null;
  artist_sort_name: string | null;
  album_title: string | null;
  category_code: string | null;
  category_name: string | null;
  category_color: string | null;
}

// ============================================================
// CATEGORIES
// ============================================================

export interface Category {
  id: number;
  code: string;
  name: string;
  color: string | null;
  description: string | null;
  target_spins_per_week: number | null;
  created_at: number;
}

// ============================================================
// SCHEDULING RULES
// ============================================================

export interface SchedulingRule {
  id: number;
  name: string;
  scope: RuleScope;
  scope_id: number | null;
  rule_type: RuleType;
  value_int: number | null;
  value_text: string | null;
  value_json: string | null;   // parse as needed
  is_hard_rule: boolean;
  priority: number;
  is_active: boolean;
  created_at: number;
}

// Typed variants for specific rule payloads
export interface ArtistSeparationRule extends SchedulingRule {
  rule_type: 'artist_separation';
  value_int: number;  // minutes
}

export interface MaxConsecutiveRule extends SchedulingRule {
  rule_type: 'max_consecutive';
  value_int: number;  // max count
  value_json: string; // JSON: { category_ids: number[] }
}

// ============================================================
// CLOCK / FORMAT WHEEL
// ============================================================

export interface Clock {
  id: number;
  name: string;
  code: string;
  description: string | null;
  total_minutes: number;
  is_default: boolean;
  color: string | null;
  created_at: number;
  updated_at: number;
}

export interface ClockSlot {
  id: number;
  clock_id: number;
  position: number;
  slot_type: SlotType;

  // Content references
  category_id: number | null;
  song_id: number | null;
  spot_id: number | null;

  // Timing
  scheduled_minute: number | null;
  duration_ms: number | null;

  // UI
  color: string | null;
  label: string | null;
  notes: string | null;
}

/** Clock with all slots + denormalized labels for the wheel editor */
export interface ClockWithSlots extends Clock {
  slots: ClockSlotView[];
}

export interface ClockSlotView extends ClockSlot {
  category_code: string | null;
  category_name: string | null;
  category_color: string | null;
  song_title: string | null;
  song_artist: string | null;
  spot_title: string | null;
  effective_label: string;     // computed: label ?? category_code ?? slot_type
  effective_color: string;     // computed: color ?? category_color ?? default
  effective_duration_ms: number; // computed from content or slot default
}

// ============================================================
// FORMAT SCHEDULE
// ============================================================

export interface FormatScheduleEntry {
  id: number;
  day_of_week: number | null;  // 0-6, null = applies all days
  hour: number;                // 0-23
  clock_id: number;
  priority: number;
}

/** Full 7×24 grid, keyed by [day][hour] */
export type FormatGrid = Record<number, Record<number, FormatScheduleEntry | null>>;

// ============================================================
// HOURLY LOGS
// ============================================================

export interface LogHour {
  id: number;
  log_date: string;    // "YYYY-MM-DD"
  hour: number;        // 0-23
  clock_id: number | null;
  status: LogStatus;
  generated_at: number | null;
  locked_at: number | null;
  notes: string | null;
}

export interface LogEntry {
  id: number;
  log_hour_id: number;
  position: number;
  slot_type: SlotType;

  song_id: number | null;
  spot_id: number | null;

  scheduled_time: string | null;  // "HH:MM:SS"
  actual_time: string | null;
  duration_ms: number | null;

  status: EntryStatus;
  played_at: number | null;

  override_reason: string | null;
  notes: string | null;
}

/** Log entry with all content joined for display */
export interface LogEntryView extends LogEntry {
  song_title: string | null;
  song_artist: string | null;
  song_duration_ms: number | null;
  spot_title: string | null;
  spot_advertiser: string | null;
  spot_duration_ms: number | null;
  display_title: string;      // computed: song_title ?? spot_title ?? slot_type
  display_artist: string;
  display_duration_ms: number;
}

// ============================================================
// SPOT / COMMERCIAL INVENTORY
// ============================================================

export interface Advertiser {
  id: number;
  name: string;
  contact: string | null;
  notes: string | null;
  created_at: number;
}

export interface Spot {
  id: number;
  title: string;
  advertiser_id: number | null;

  file_path: string | null;
  file_format: string | null;
  duration_ms: number;

  spot_type: SpotType;
  start_date: string | null;
  end_date: string | null;
  max_plays_per_day: number | null;
  max_plays_per_hour: number;

  daypart_mask: number;
  priority: number;
  spins_total: number;
  spins_today: number;
  last_played_at: number | null;

  is_active: boolean;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface SpotBreak {
  id: number;
  name: string;
  total_duration_ms: number;
  spot_count: number;
  notes: string | null;
}

export interface SpotBreakSlot {
  id: number;
  spot_break_id: number;
  position: number;
  spot_type_filter: SpotType | null;
  duration_ms: number | null;
}

// ============================================================
// LIVE ASSIST / CART WALL
// ============================================================

export interface CartWall {
  id: number;
  name: string;
  rows: number;
  cols: number;
  is_default: boolean;
  created_at: number;
}

export interface CartButton {
  id: number;
  cart_wall_id: number;
  row_index: number;
  col_index: number;
  label: string | null;
  color: string;

  target_type: CartTargetType;
  song_id: number | null;
  spot_id: number | null;
  command: string | null;

  play_mode: PlayMode;
  hotkey: string | null;
}

/** CartWall + all buttons populated */
export interface CartWallLayout extends CartWall {
  buttons: CartButtonView[][];  // [row][col], undefined = empty
}

export interface CartButtonView extends CartButton {
  song_title: string | null;
  song_artist: string | null;
  spot_title: string | null;
  display_label: string;        // label ?? song_title ?? spot_title ?? command ?? '—'
  is_playing: boolean;          // runtime state, not persisted
  progress_ms: number;          // runtime state
}

// ============================================================
// AUDIO ENGINE (runtime, not persisted)
// ============================================================

export type PlayerChannel = 'A' | 'B' | 'cart';

export interface AudioTrack {
  id: string;           // uuid, runtime only
  song_id?: number;
  spot_id?: number;
  file_path: string;
  title: string;
  artist: string;
  duration_ms: number;
  intro_ms: number;
  outro_ms: number;
}

export interface PlayerState {
  channel: PlayerChannel;
  track: AudioTrack | null;
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';
  position_ms: number;
  volume: number;       // 0–1
  is_cued: boolean;
  error: string | null;
}

export interface EngineState {
  on_air: boolean;
  player_a: PlayerState;
  player_b: PlayerState;
  cart_players: Record<string, PlayerState>;  // keyed by cart button id
  queue: AudioTrack[];
  current_log_entry_id: number | null;
}

// ============================================================
// SCHEDULER ENGINE (runtime, not persisted)
// ============================================================

export interface SchedulerCandidate {
  song: SongView;
  score: number;
  violations: RuleViolation[];
  warnings: RuleViolation[];
}

export interface RuleViolation {
  rule_id: number | null;
  rule_type: RuleType;
  message: string;
  is_hard: boolean;
}

export interface GenerateLogOptions {
  log_date: string;
  hour: number;
  clock_id?: number;       // overrides format schedule lookup
  dry_run?: boolean;       // don't persist, just return preview
}

// ============================================================
// APP SETTINGS
// ============================================================

export interface AppSettings {
  station_name: string;
  station_slogan: string;
  default_cart_wall_id: number | null;
  audio_output_device: string;
  crossfade_ms: number;
  log_auto_generate_hours_ahead: number;
  library_scan_path: string;
  lufs_target: number;
  theme: 'dark' | 'light';
}

// ============================================================
// UTILITY TYPES
// ============================================================

/** For any new/draft record that hasn't been saved yet */
export type NewRecord<T extends { id: number; created_at: number }> =
  Omit<T, 'id' | 'created_at'>;

/** Partial update payload */
export type UpdateRecord<T extends { id: number }> =
  Pick<T, 'id'> & Partial<Omit<T, 'id' | 'created_at'>>;

/** Daypart bitmask helpers */
export const DaypartMask = {
  ALL: 0b111111111111111111111111,  // all 24 hours
  fromHours: (hours: number[]): number =>
    hours.reduce((mask, h) => mask | (1 << h), 0),
  toHours: (mask: number): number[] =>
    Array.from({ length: 24 }, (_, i) => i).filter(h => (mask >> h) & 1),
  includesHour: (mask: number, hour: number): boolean => Boolean((mask >> hour) & 1),
} as const;

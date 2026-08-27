// Generated from dump-schema.js output at commit <HEAD>.
// Categorizations per docs/sync-protocol-v0.md §4.5 and Jeff's Session A2.1 review.
// Every column from the live DB at time of authoring appears here.
// To add a new synced table or column: update this file, run scripts/verify-synced-tables.js, bump schema_version per §8.
// Do NOT edit category values without consulting the protocol doc.
//
// PHASE 4 (Apr 2026): adds `scope: 'install' | 'station'` to every entry per
// docs/phase-4-library-architecture.md commitment #7. Reclassifies songs/artists/albums
// to install-scoped (Direction C). Adds 4 new entries: station_programming, mood_tags,
// station_programming_moods, pinned_songs.

'use strict';

const SYNCED_TABLES = [
  'albums',
  'announcement_schedule',
  'asset_spot_meta',
  'asset_sweeper_meta',
  'announcements',
  'artists',
  'cart_slots',
  'categories',
  'clock_breaks',
  'clock_slots',
  'clocks',
  'deck_configs',
  'format_clocks',
  'generated_schedule',
  'install_config_kv',
  'install_secrets_kv',
  'jingle_categories',
  'library_asset',
  'liner_cards',
  'macros',
  'metadata_definitions',
  'metadata_vocabulary',
  'monitor_routing',
  'mood_tags',
  'operator_notes',
  'operators',
  'pinned_songs',
  'play_log',
  'prep_notes',
  'published_episodes',
  'rtmp_destinations',
  'scheduled_log',
  'separation_rules',
  'shows',
  'smart_schedule_rules',
  'song_metadata_values',
  'songs',
  'spots',
  'station_config_kv',
  'station_programming',
  'station_programming_moods',
  'stations',
  'voice_tracks',
];

const REGISTRY = {

  albums: {
    tableName: 'albums',
    primaryKey: ['id'],
    scope: 'install',
    columns: {
      id:         'scalar',
      title:      'scalar',
      artist_id:  'scalar',
      year:       'scalar',
      created_at: 'scalar',
      uuid:       'scalar',
      updated_at: 'scalar',
      deleted_at: 'scalar',
    },
  },

  // THE ANNOUNCEMENT SCHEDULE (v47) — one row per (announcement, time) attached to weekdays or to a
  // single date. The schedule came OFF announcements so one asset can play at many times on many
  // days; `announcements` is now the ASSET and this is the ENTRY.
  //
  // announcement_uuid is a cross-row reference, so it is declared in `refs`: causal ordering must not
  // apply an entry on a peer before the announcement it points at exists there.
  announcement_schedule: {
    tableName: 'announcement_schedule',
    primaryKey: ['id'],
    scope: 'station',
    // NO REF FOR announcement_uuid, deliberately. `refs` is UUID-IDENTITY REMAPPING: it maps a
    // column holding a LOCAL INTEGER ID to the table it points at, so the sender attaches the
    // parent's uuid (_enrichWire → SELECT ... WHERE id = ?) and the receiver resolves it back to ITS
    // OWN local id (_remapRefs → row[col] = localId). A UUID column needs none of that — a uuid is
    // globally stable, which is exactly why it was chosen. Listing one here made every row look
    // dangling to rebaselineScan (SELECT 1 FROM announcements WHERE id = '<uuid>' never matches).
    refs: { station_id: 'stations' },
    columns: {
      id:                'scalar',
      station_id:        'scalar',
      uuid:              'scalar',
      announcement_uuid: 'scalar',
      scope:             'scalar',
      days:              'scalar',
      date:              'scalar',
      trigger_type:      'scalar',
      trigger_time:      'scalar',
      close_offset_min:  'scalar',
      sort_order:        'scalar',
      last_played_at:    'scalar',
      created_at:        'scalar',
      updated_at:        'scalar',
      deleted_at:        'scalar',
    },
  },

  // ── THE UNIFIED LIBRARY (v50) ────────────────────────────────────────────────────────────────
  // docs/library-asset-build-plan-2026-08-26.md
  //
  // INSTALL-SCOPED, like `songs`: an asset is a FILE, and every station draws from one shared
  // library. NO station_id — adding one would break that and is prohibited by the design.
  //
  // `type` is a registry code with NO CHECK constraint in the schema, so a type this build has never
  // seen still syncs, still stores and still displays (normalizeType degrades it rather than dropping
  // the row). A newer peer's asset must never vanish here.
  //
  // No `refs`: install-scoped tables are skipped by _enrichWire and _remapRefs entirely, and the
  // columns that would want remapping (artist_id, album_id) point at install-scoped tables whose ids
  // are already the same on every install of this account.
  library_asset: {
    tableName: 'library_asset',
    primaryKey: ['id'],
    scope: 'install',
    columns: {
      id: 'scalar', uuid: 'scalar', type: 'scalar',
      title: 'scalar', artist_id: 'scalar', album_id: 'scalar', genre: 'scalar',
      file_path: 'blob-ref', file_key: 'scalar', duration_ms: 'scalar',
      bpm: 'scalar', energy: 'scalar', mood: 'scalar', gender: 'scalar',
      is_explicit: 'scalar', spotify_uri: 'scalar', cart_id: 'scalar',
      cue_in: 'scalar', cue_out: 'scalar', cue_in_ms: 'scalar', cue_out_ms: 'scalar',
      intro_end: 'scalar', outro_start: 'scalar', intro_end_ms: 'scalar', outro_start_ms: 'scalar',
      has_intro: 'scalar', intro_version_path: 'scalar',
      lufs_measured: 'scalar', peak_db: 'scalar', gain_db: 'scalar', is_processed: 'scalar',
      last_played_at: 'scalar', play_count: 'scalar',
      raw_metadata: 'scalar', r2_uploaded_at: 'scalar',
      created_at: 'scalar', updated_at: 'scalar', deleted_at: 'scalar',
    },
  },

  // TRAFFIC DETAIL — STATION-SCOPED, because the same audio file can be sold to two stations on
  // different terms. asset_uuid is a UUID and therefore carries NO ref (see the note on
  // announcement_schedule above); spot_category_id IS a local integer id and does.
  asset_spot_meta: {
    tableName: 'asset_spot_meta',
    primaryKey: ['id'],
    scope: 'station',
    refs: { station_id: 'stations', spot_category_id: 'spot_categories' },
    columns: {
      id: 'scalar', asset_uuid: 'scalar', station_id: 'scalar',
      spot_type: 'scalar', advertiser: 'scalar', agency: 'scalar',
      isci_code: 'scalar', cart_number: 'scalar', spot_category_id: 'scalar',
      start_date: 'scalar', end_date: 'scalar', max_plays_day: 'scalar',
      play_count: 'scalar', last_played_at: 'scalar', length_sec: 'scalar',
      notes: 'scalar', art_image: 'scalar', is_active: 'scalar',
      uuid: 'scalar', created_at: 'scalar', updated_at: 'scalar', deleted_at: 'scalar',
    },
  },

  // SWEEPER DETAIL — install-scoped, keyed by the asset alone.
  asset_sweeper_meta: {
    tableName: 'asset_sweeper_meta',
    primaryKey: ['id'],
    scope: 'install',
    columns: {
      id: 'scalar', asset_uuid: 'scalar', sweeper_category_id: 'scalar',
      uuid: 'scalar', created_at: 'scalar', updated_at: 'scalar', deleted_at: 'scalar',
    },
  },

  announcements: {
    tableName: 'announcements',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:             'scalar',
      title:          'scalar',
      file_path:      'blob-ref',
      trigger_time:   'scalar',
      days:           'scalar',
      // SLICE 5 — what KIND of trigger this is, and how far before closing it fires.
      trigger_type:     'scalar',
      close_offset_min: 'scalar',
      duck_music:     'scalar',
      resume_music:   'scalar',
      duck_level:     'scalar',
      is_active:      'scalar',
      last_played_at: 'scalar',
      created_at:     'scalar',
      station_id:     'scalar',
      uuid:           'scalar',
      updated_at:     'scalar',
      deleted_at:     'scalar',
    },
  },

  artists: {
    tableName: 'artists',
    primaryKey: ['id'],
    scope: 'install',
    columns: {
      id:         'scalar',
      name:       'scalar',
      sort_name:  'scalar',
      gender:     'scalar',
      created_at: 'scalar',
      uuid:       'scalar',
      updated_at: 'scalar',
      deleted_at: 'scalar',
    },
  },

  cart_slots: {
    tableName: 'cart_slots',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:          'scalar',
      slot_number: 'scalar',
      title:       'scalar',
      file_path:   'blob-ref',
      color:       'scalar',
      hotkey:      'scalar',
      station_id:  'scalar',
      uuid:        'scalar',
      created_at:  'scalar',
      updated_at:  'scalar',
      deleted_at:  'scalar',
    },
  },

  categories: {
    tableName: 'categories',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:             'scalar',
      code:           'scalar',
      name:           'scalar',
      color:          'scalar',
      spins_per_hour: 'scalar',
      priority:       'scalar',
      // JINGLES/SWEEPERS v2 (v32) — per-music-category overlay assignment (item OR pool + timing + hours).
      overlay_kind:        'scalar',   // NULL | 'item' | 'pool'
      overlay_song_id:     'scalar',   // specific JIN/SWP song (kind='item')
      overlay_category_id: 'scalar',   // overlay pool (kind='pool') → jingle_categories.id
      overlay_lead_in_sec:  'scalar',
      overlay_underlap_sec: 'scalar',
      overlay_active_hours: 'scalar',  // 24-bit daypart mask (16777215 = always)
      station_id:     'scalar',
      uuid:           'scalar',
      created_at:     'scalar',
      updated_at:     'scalar',
      deleted_at:     'scalar',
    },
  },

  spot_categories: {
    tableName: 'spot_categories',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:         'scalar',
      name:       'scalar',
      color:      'scalar',
      sort_order: 'scalar',
      station_id: 'scalar',
      uuid:       'scalar',
      created_at: 'scalar',
      updated_at: 'scalar',
      deleted_at: 'scalar',
    },
  },

  jingle_categories: {
    tableName: 'jingle_categories',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:              'scalar',
      name:            'scalar',
      color:           'scalar',
      type:            'scalar',   // v2 (v32): 'JIN' | 'SWP' — types the overlay pool
      lead_in_sec:     'scalar',
      underlap_sec:    'scalar',
      cadence_every_n: 'scalar',   // RETIRED in v2 (dead column, kept for back-compat)
      sort_order:      'scalar',
      station_id:      'scalar',
      uuid:            'scalar',
      created_at:      'scalar',
      updated_at:      'scalar',
      deleted_at:      'scalar',
    },
  },

  clock_breaks: {
    tableName: 'clock_breaks',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:               'scalar',
      clock_id:         'scalar',
      minute:           'scalar',
      spot_category_id: 'scalar',
      count:            'scalar',
      sort_order:       'scalar',
      station_id:       'scalar',
      uuid:             'scalar',
      created_at:       'scalar',
      updated_at:       'scalar',
      deleted_at:       'scalar',
    },
    // UUID-identity refs: local-integer FKs resolved to/from stable uuids on push/apply.
    refs: { station_id: 'stations', clock_id: 'clocks', spot_category_id: 'spot_categories' },
  },

  clock_slots: {
    tableName: 'clock_slots',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:           'scalar',
      clock_id:     'scalar',
      position:     'scalar',
      slot_type:    'scalar',
      category_id:  'scalar',
      label:        'scalar',
      duration_min: 'scalar',
      spot_type:    'scalar',
      spot_category_id: 'scalar',
      station_id:   'scalar',
      uuid:         'scalar',
      created_at:   'scalar',
      updated_at:   'scalar',
      deleted_at:   'scalar',
    },
    // UUID-identity (Tier-2): local-integer reference columns → the table they point at. On push the
    // sender resolves each to the parent's stable uuid (ref_uuids); on apply the receiver resolves
    // back to its OWN local id. station_id is the universal default for all scope:'station' tables;
    // declared here in full for the columns that also carry parent FKs.
    refs: { station_id: 'stations', clock_id: 'clocks', category_id: 'categories', spot_category_id: 'spot_categories' },
  },

  clocks: {
    tableName: 'clocks',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:          'scalar',
      name:        'scalar',
      show_id:     'scalar',
      description: 'scalar',
      color:       'scalar',
      station_id:  'scalar',
      uuid:        'scalar',
      created_at:  'scalar',
      updated_at:  'scalar',
      deleted_at:  'scalar',
    },
    refs: { station_id: 'stations', show_id: 'shows' },
  },

  deck_configs: {
    tableName: 'deck_configs',
    primaryKey: ['slot'],
    scope: 'station',
    columns: {
      slot:       'scalar',
      type:       'scalar',
      label:      'scalar',
      color:      'scalar',
      enabled:    'scalar',
      purpose:    'scalar',
      // SLICE 2 (2026-08-22) — the SOURCE channel's patch point. serializePayload() walks this map,
      // so a column missing here is silently dropped from the mutation: the local board would show
      // the source while a second machine's board showed an empty dropdown.
      kind:       'scalar',
      address:    'scalar',
      // SLICE 3 — the per-channel ducker toggle. A preference, not the rule: only SOURCE slots can
      // duck and that is enforced in Rust by the slot's kind.
      duck:       'scalar',
      // SLICE 3 receiver side — does this deck step back when a source ducks? Default 1 (it does).
      duckable:   'scalar',
      station_id: 'scalar',
      uuid:       'scalar',
      created_at: 'scalar',
      updated_at: 'scalar',
      deleted_at: 'scalar',
    },
  },

  format_clocks: {
    tableName: 'format_clocks',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:         'scalar',
      name:       'scalar',
      slots:      'local-only',   // legacy column, superseded by slots_json
      created_at: 'scalar',
      daypart:    'scalar',
      slots_json: 'json-text',
      station_id: 'scalar',
      uuid:       'scalar',
      updated_at: 'scalar',
      deleted_at: 'scalar',
    },
  },

  generated_schedule: {
    tableName: 'generated_schedule',
    primaryKey: ['id'],
    scope: 'station',
    // RULING A. The backend has REFUSED this table since 2026-06-16 (ether-backend ed9b790,
    // "exclude generated_schedule from peer-sync — runaway table growth"), and its BACKEND_EXCLUDED
    // list is checked per row. Because the client never excluded it, every Generate journalled
    // thousands of rows that were pushed, refused, left 'pending', and re-pushed forever — OV's logs
    // show 26 consecutive batches of accepted=0 rejected=500. The backend holds ZERO rows of this
    // table and always has, so nothing is lost by not sending it.
    //
    // It is also derived data: every install regenerates its own log from clocks, which DO sync.
    // The row that plays is a local playout artifact, not shared state.
    syncExcluded: true,
    columns: {
      id:           'scalar',
      scheduled_at: 'scalar',
      song_id:      'scalar',
      title:        'scalar',
      artist:       'scalar',
      file_key:     'scalar',
      duration_s:   'scalar',
      category_id:  'scalar',
      clock_id:     'scalar',
      generated_at: 'scalar',
      content_class:      'scalar',   // jingles overlay v1 (v31) — 'JIN' marks a transition-attached jingle placement
      channel:            'scalar',   // 'CART' for a JIN overlay row; NULL for music/spot
      lead_in_sec:        'scalar',
      underlap_sec:       'scalar',
      jingle_category_id: 'scalar',
      // Log-Reader Flip v33 (Phase 0) — playout lifecycle / playhead. LOCAL-ONLY: the always-on local
      // engine owns these per-machine; excluded from sync payloads BOTH directions so a playhead flip
      // never CRDT-merges (avoids the peer-sync last-write-wins fight — see project_peer_sync_station_uuid).
      // Pushed for display via now-playing, never pulled back as truth. Design §5.
      state:        'local-only',   // 'pending' | 'playing' | 'played' | 'skipped' — playhead = the 'playing' row
      played_at:    'local-only',   // unix seconds the row actually aired (engine-stamped, Phase 1)
      seq:          'local-only',   // local play-order (decoupled from scheduled_at); sync treatment revisited at Phase 4 reorder
      source:       'local-only',   // v34: provenance — NULL/'machine' | 'operator' (jock deck-load) | 'autofit'. Local-authoritative playout state (§2.5)
      station_id:   'scalar',
      uuid:         'scalar',
      created_at:   'scalar',
      updated_at:   'scalar',
      deleted_at:   'scalar',
    },
  },

  install_config_kv: {
    tableName: 'install_config_kv',
    primaryKey: ['key'],
    scope: 'install',
    isKv: true,
    kvKeyCol: 'key',
    kvValueCol: 'value',
    columns: {
      key:        'scalar',
      value:      'scalar',
      uuid:       'scalar',
      created_at: 'scalar',
      updated_at: 'scalar',
      deleted_at: 'scalar',
    },
  },

  install_secrets_kv: {
    tableName: 'install_secrets_kv',
    primaryKey: ['key'],
    scope: 'install',
    isKv: true,
    syncExcluded: true,   // never leave the device in any sync payload per [Q-13]
    kvKeyCol: 'key',
    kvValueCol: 'value',
    columns: {
      key:        'scalar',
      value:      'scalar',
      uuid:       'scalar',
      created_at: 'scalar',
      updated_at: 'scalar',
      deleted_at: 'scalar',
    },
  },

  liner_cards: {
    tableName: 'liner_cards',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:         'scalar',
      title:      'scalar',
      body:       'scalar',
      category:   'scalar',
      color:      'scalar',
      pinned:     'scalar',
      created_at: 'scalar',
      station_id: 'scalar',
      uuid:       'scalar',
      updated_at: 'scalar',
      deleted_at: 'scalar',
    },
  },

  macros: {
    tableName: 'macros',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:            'scalar',
      name:          'scalar',
      description:   'scalar',
      trigger_type:  'scalar',
      trigger_value: 'scalar',
      actions:       'json-text',
      hotkey:        'scalar',
      is_active:     'scalar',
      color:         'scalar',
      created_at:    'scalar',
      station_id:    'scalar',
      uuid:          'scalar',
      updated_at:    'scalar',
      deleted_at:    'scalar',
    },
  },

  metadata_definitions: {
    tableName: 'metadata_definitions',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:            'scalar',
      uuid:          'scalar',
      station_id:    'scalar',
      name:          'scalar',
      data_type:     'scalar',
      description:   'scalar',
      is_built_in:   'scalar',
      is_required:   'scalar',
      display_order: 'scalar',
      created_at:    'scalar',
      updated_at:    'scalar',
      deleted_at:    'scalar',
    },
  },

  metadata_vocabulary: {
    tableName: 'metadata_vocabulary',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:            'scalar',
      uuid:          'scalar',
      station_id:    'scalar',
      definition_id: 'scalar',
      value:         'scalar',
      display_order: 'scalar',
      color:         'scalar',
      created_at:    'scalar',
      updated_at:    'scalar',
      deleted_at:    'scalar',
    },
    refs: { station_id: 'stations', definition_id: 'metadata_definitions' },
  },

  monitor_routing: {
    tableName: 'monitor_routing',
    primaryKey: ['output_device_id'],
    scope: 'local-only',  // routing is per-physical-machine per AD-10 — each PC has different output devices
    columns: {
      output_device_id: 'scalar',
      station_id:       'scalar',
      uuid:             'scalar',
      created_at:       'scalar',
      updated_at:       'scalar',
      deleted_at:       'scalar',
    },
  },

  mood_tags: {
    tableName: 'mood_tags',
    primaryKey: ['id'],
    scope: 'install',
    columns: {
      id:          'scalar',
      uuid:        'scalar',
      name:        'scalar',
      description: 'scalar',
      color:       'scalar',
      created_at:  'scalar',
      updated_at:  'scalar',
      deleted_at:  'scalar',
    },
  },

  operator_notes: {
    tableName: 'operator_notes',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:          'scalar',
      operator_id: 'scalar',
      note:        'scalar',
      updated_at:  'scalar',
      station_id:  'scalar',
      uuid:        'scalar',
      created_at:  'scalar',
      deleted_at:  'scalar',
    },
  },

  operators: {
    tableName: 'operators',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:         'scalar',
      name:       'scalar',
      initials:   'scalar',
      created_at: 'scalar',
      theme:      'scalar',
      station_id: 'scalar',
      uuid:       'scalar',
      updated_at: 'scalar',
      deleted_at: 'scalar',
    },
  },

  pinned_songs: {
    tableName: 'pinned_songs',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:            'scalar',
      song_id:       'scalar',
      slot_hour:     'scalar',
      slot_position: 'scalar',
      recur_dow:     'scalar',
      play_at_unix:  'scalar',
      start_unix:    'scalar',
      end_unix:      'scalar',
      force_play:    'scalar',
      pinned_by:     'scalar',
      reason:        'scalar',
      consumed_at:   'scalar',
      created_at:    'scalar',
      station_id:    'scalar',
      uuid:          'scalar',
      updated_at:    'scalar',
      deleted_at:    'scalar',
    },
    // pinned_by is TEXT (who pinned) — a value, NOT remapped. song_id → install-scope songs (depends
    // on the borrowed-library/grant path carrying stable song UUIDs).
    refs: { station_id: 'stations', song_id: 'songs' },
  },

  play_log: {
    tableName: 'play_log',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:                  'scalar',
      title:               'scalar',
      artist:              'scalar',
      deck:                'scalar',
      deck_id:             'scalar',
      duration_ms:         'scalar',
      session_id:          'scalar',
      played_at:           'scalar',
      scheduled_log_id:    'scalar',
      show_name:           'scalar',
      category_code:       'scalar',
      station_id:          'scalar',
      uuid:                'scalar',
      created_at:          'scalar',
      updated_at:          'scalar',
      deleted_at:          'scalar',
      programming_row_id:  'scalar',
      file_path:           'blob-ref',   // v19: the audio that aired — affidavit join key
      content_class:       'scalar',     // jingles design 1b — MUSIC/JIN/SPOT (v29)
      // v39: which SOURCE aired it. NULL = ordinary playout; 'jukebox' = the event-tool deck source.
      // SYNCED on purpose (unlike generated_schedule.source, which is local-authoritative playout
      // state): play_log is history that already travels, and a mark that stayed home would make the
      // history honest on one machine and misleading everywhere else.
      source:              'scalar',
    },
  },

  prep_notes: {
    tableName: 'prep_notes',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:         'scalar',
      title:      'scalar',
      body:       'scalar',
      show_date:  'scalar',
      category:   'scalar',
      created_at: 'scalar',
      station_id: 'scalar',
      uuid:       'scalar',
      updated_at: 'scalar',
      deleted_at: 'scalar',
    },
  },

  published_episodes: {
    tableName: 'published_episodes',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:           'scalar',
      title:        'scalar',
      file_path:    'blob-ref',
      show_id:      'scalar',
      published_at: 'scalar',
      station_id:   'scalar',
      uuid:         'scalar',
      created_at:   'scalar',
      updated_at:   'scalar',
      deleted_at:   'scalar',
    },
  },

  rtmp_destinations: {
    tableName: 'rtmp_destinations',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:         'scalar',
      name:       'scalar',
      url:        'scalar',
      stream_key: 'local-only',  // sensitive credential — excluded from payloads per [Q-13]
      is_active:  'scalar',
      station_id: 'scalar',
      uuid:       'scalar',
      created_at: 'scalar',
      updated_at: 'scalar',
      deleted_at: 'scalar',
    },
  },

  scheduled_log: {
    tableName: 'scheduled_log',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:               'scalar',
      log_date:         'scalar',
      hour:             'scalar',
      position:         'scalar',
      song_id:          'scalar',
      title:            'scalar',
      artist:           'scalar',
      category_id:      'scalar',
      duration_ms:      'scalar',
      clock_id:         'scalar',
      created_at:       'scalar',
      overflow:         'scalar',
      fade_out_at_ms:   'scalar',
      fade_duration_ms: 'scalar',
      chain_type:       'scalar',
      station_id:       'scalar',
      uuid:             'scalar',
      updated_at:       'scalar',
      deleted_at:       'scalar',
    },
  },

  separation_rules: {
    tableName: 'separation_rules',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:          'scalar',
      rule_type:   'scalar',
      scope:       'scalar',
      value:       'scalar',
      is_hard:     'scalar',
      is_active:   'scalar',
      description: 'scalar',
      station_id:  'scalar',
      uuid:        'scalar',
      created_at:  'scalar',
      updated_at:  'scalar',
      deleted_at:  'scalar',
    },
  },

  shows: {
    tableName: 'shows',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:          'scalar',
      name:        'scalar',
      start_hour:  'scalar',
      end_hour:    'scalar',
      days:        'scalar',
      color:       'scalar',
      description: 'scalar',
      is_active:   'scalar',
      clock_id:    'scalar',
      station_id:  'scalar',
      uuid:        'scalar',
      created_at:  'scalar',
      updated_at:  'scalar',
      deleted_at:  'scalar',
    },
    // UUID-identity (Tier-2): the show→clock link, the reverse of clocks.show_id. Only the core
    // rotation gap. Machine-generated logs (scheduled_log, play_log, …) intentionally get NO refs —
    // they are not hand-edited and must not enter the edit-sync path; sacred value columns
    // (play_log.deck_id, play_log.session_id) are NEVER remapped.
    refs: { station_id: 'stations', clock_id: 'clocks' },
  },

  smart_schedule_rules: {
    tableName: 'smart_schedule_rules',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:           'scalar',
      description:  'scalar',
      days:         'scalar',
      start_hour:   'scalar',
      end_hour:     'scalar',
      energy_level: 'scalar',
      bpm_min:      'scalar',
      bpm_max:      'scalar',
      genre:        'scalar',
      is_active:    'scalar',
      station_id:   'scalar',
      uuid:         'scalar',
      created_at:   'scalar',
      updated_at:   'scalar',
      deleted_at:   'scalar',
    },
  },

  song_metadata_values: {
    tableName: 'song_metadata_values',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:                  'scalar',
      uuid:                'scalar',
      station_id:          'scalar',
      song_id:             'scalar',
      // v50: the same overlay, widened to any asset type. A UUID, so no ref.
      asset_uuid:          'scalar',
      definition_id:       'scalar',
      value_text:          'scalar',
      value_vocabulary_id: 'scalar',
      created_at:          'scalar',
      updated_at:          'scalar',
      deleted_at:          'scalar',
    },
    // value_text is the free-text value (left alone); value_vocabulary_id is the FK used instead when
    // the value comes from a vocabulary (null for free-text rows → skipped). song_id → install-scope songs.
    refs: { station_id: 'stations', song_id: 'songs', definition_id: 'metadata_definitions', value_vocabulary_id: 'metadata_vocabulary' },
  },

  songs: {
    // `songs` is BOTH the wire name and the physical table, and it stays a real TABLE forever — the
    // 4.4.151 rename-to-a-view stranded a customer whose older build ran ALTER against it. Deleted
    // songs are unreachable because they MOVE to songs_deleted, not because the name points elsewhere.
    // docs/migration-safety-and-customer-recovery-2026-08-06.md
    tableName: 'songs',
    primaryKey: ['id'],
    scope: 'install',
    columns: {
      id:                  'scalar',
      title:               'scalar',
      file_path:           'blob-ref',
      file_key:            'scalar',         // v17: R2 object basename
      r2_uploaded_at:      'local-only',     // v17: local upload marker
      artist_id:           'scalar',
      album_id:            'scalar',
      category_id:         'scalar',
      genre:               'scalar',
      duration_ms:         'scalar',
      bpm:                 'scalar',
      energy:              'scalar',
      mood:                'scalar',
      gender:              'scalar',
      rotation_status:     'scalar',
      content_class:       'scalar',   // jingles design 1b — MUSIC/JIN/SPOT (v29)
      jingle_category_id:  'scalar',   // jingles overlay v1 — which jingle pool a JIN song belongs to (v30); plain scalar like category_id
      daypart_mask:        'scalar',
      no_repeat_hours:     'scalar',
      lufs_measured:       'scalar',
      peak_db:             'scalar',
      gain_db:             'scalar',
      is_processed:        'scalar',
      cue_in:              'local-only',   // legacy marker, superseded by cue_in_ms
      cue_out:             'local-only',   // legacy marker, superseded by cue_out_ms
      cue_in_ms:           'scalar',
      cue_out_ms:          'scalar',
      intro_end:           'local-only',   // legacy marker, superseded by intro_end_ms
      outro_start:         'local-only',   // legacy marker, superseded by outro_start_ms
      intro_end_ms:        'scalar',
      outro_start_ms:      'scalar',
      intro_version_path:  'blob-ref',
      has_intro:           'scalar',
      last_played_at:      'scalar',
      play_count:          'scalar',
      is_explicit:         'scalar',
      created_at:          'scalar',
      updated_at:          'scalar',
      raw_metadata:        'json-text',
      spotify_uri:         'scalar',
      uuid:                'scalar',
      deleted_at:          'scalar',
    },
  },

  spots: {
    tableName: 'spots',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:             'scalar',
      title:          'scalar',
      file_path:      'blob-ref',
      spot_type:      'scalar',
      advertiser:     'scalar',
      start_date:     'scalar',
      end_date:       'scalar',
      max_plays_day:  'scalar',
      play_count:     'scalar',
      last_played_at: 'scalar',
      is_active:      'scalar',
      notes:          'scalar',
      created_at:     'scalar',
      isci_code:      'scalar',
      cart_number:    'scalar',
      agency:         'scalar',
      length_sec:       'scalar',
      spot_category_id: 'scalar',
      // v36 — operator-chosen artwork for this spot, stored as a base64 data URL in the row
      // (the station-logo pattern, main.js:5586 / SettingsPanel.tsx:245). Scalar: it is the
      // value itself, not a reference to a file or a blob the sync engine must fetch.
      art_image:        'scalar',
      station_id:       'scalar',
      uuid:             'scalar',
      updated_at:       'scalar',
      deleted_at:       'scalar',
    },
    // UUID-identity (Tier-2): spot_category_id is a LOCAL integer FK into spot_categories — on push
    // the sender resolves it to that category's stable uuid, on apply the receiver resolves back to
    // its own local id, so a spot lands in the right category on every machine (station_id likewise).
    refs: { station_id: 'stations', spot_category_id: 'spot_categories' },
  },

  station_config_kv: {
    tableName: 'station_config_kv',
    primaryKey: ['station_id', 'key'],
    scope: 'station',
    isKv: true,
    kvKeyCol: 'key',
    kvValueCol: 'value',
    columns: {
      station_id: 'scalar',
      key:        'scalar',
      value:      'scalar',
      uuid:       'scalar',
      created_at: 'scalar',
      updated_at: 'scalar',
      deleted_at: 'scalar',
    },
  },

  station_programming: {
    tableName: 'station_programming',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:              'scalar',
      uuid:            'scalar',
      song_id:         'scalar',
      // v50: the same overlay, widened to any asset type. A UUID, so no ref.
      asset_uuid:      'scalar',
      station_id:      'scalar',
      category_id:     'scalar',
      energy:          'scalar',
      daypart_mask:    'scalar',
      rotation_status: 'scalar',
      no_repeat_hours: 'scalar',
      last_played_at:  'scalar',
      play_count:      'scalar',
      notes:           'scalar',
      added_at:        'scalar',
      created_at:      'scalar',
      updated_at:      'scalar',
      deleted_at:      'scalar',
    },
    // song_id → install-scope songs (borrowed-library/grant dependency).
    refs: { station_id: 'stations', song_id: 'songs', category_id: 'categories' },
  },

  station_programming_moods: {
    tableName: 'station_programming_moods',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:                    'scalar',
      uuid:                  'scalar',
      station_programming_id:'scalar',
      mood_tag_id:           'scalar',
      created_at:            'scalar',
      updated_at:            'scalar',
      deleted_at:            'scalar',
    },
    // Moods scoping decision: this join table has NO station_id (the handler stamps the mutation
    // station_id null), so it is install-scoped today and STAYS install-scoped — refs carry no
    // station_id, so station_uuid stays null and delivery is unchanged. The only fix is remapping its
    // two parent FKs to the receiver's local ids. station_programming_id → station-scoped parent;
    // mood_tag_id → install-scope mood_tags (must sync with stable UUIDs). Caveat: in a multi-station
    // account an install may receive a moods row whose station_programming parent it doesn't hold →
    // the parent uuid won't resolve (logged, left unmapped, not corrupting). A deeper fix would scope
    // moods by its parent's station; not needed for single-station-per-account use.
    refs: { station_programming_id: 'station_programming', mood_tag_id: 'mood_tags' },
  },

  stations: {
    tableName: 'stations',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:                  'scalar',
      name:                'scalar',
      callsign:            'scalar',
      frequency:           'scalar',
      city:                'scalar',
      state:               'scalar',
      country:             'scalar',
      website:             'scalar',
      is_active:           'local-only',  // which station THIS machine operates is per-install local state — syncing it clobbers each machine's manual switch (the "switching doesn't stick" bug). Excluded from payloads BOTH directions per [N-24], so a local switch never propagates and a remote mutation (incl. legacy ones already carrying is_active) never overwrites it.
      created_at:          'scalar',
      icecast_server_url:  'scalar',
      icecast_mount:       'scalar',
      icecast_password:    'local-only',  // sensitive credential — excluded from payloads per [Q-13]
      icecast_bitrate:     'scalar',
      icecast_format:      'scalar',
      icecast_port:        'scalar',
      audio_device_output: 'scalar',
      mic_device:          'scalar',
      mount_pending_provision: 'local-only',  // each PC verifies its own Icecast Admin API connection independently; confirmation is per-machine, not facility-wide
      uuid:                'scalar',
      updated_at:          'scalar',
      deleted_at:          'scalar',
    },
  },

  voice_tracks: {
    tableName: 'voice_tracks',
    primaryKey: ['id'],
    scope: 'station',
    columns: {
      id:             'scalar',
      title:          'scalar',
      file_path:      'blob-ref',
      show_id:        'scalar',
      clock_slot_id:  'scalar',
      duration_ms:    'scalar',
      recorded_by:    'scalar',
      recorded_at:    'scalar',
      station_id:     'scalar',
      uuid:           'scalar',
      created_at:     'scalar',
      updated_at:     'scalar',
      deleted_at:     'scalar',
    },
    // recorded_by is TEXT (who recorded) — a value, NOT remapped. file_path is a blob-ref: the row
    // syncs but the actual audio travels separately (R2), so a voice track is only usable on the
    // receiver once its audio is present too.
    refs: { station_id: 'stations', show_id: 'shows', clock_slot_id: 'clock_slots' },
  },

};

module.exports = { SYNCED_TABLES, REGISTRY };

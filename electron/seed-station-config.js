'use strict';
// §8 — per-station config seeding at STATION CREATION (v2 station-provisioning).
// Replaces migration-time / fresh-install seeding: every station (onboarding-created OR reconcile-
// materialized) gets its own separation rules + metadata definitions/vocabulary the moment it exists.
// ONE transaction. Idempotent per station (guarded by per-station existence checks) so it's safe to
// call on every stations:create. Definitions/vocabulary are copied verbatim from
// migrate-metadata-tables-phase-sync-6.js (47 defs + 35 vocab) so a new station matches a migrated one.
const crypto = require('crypto');

// 5 default separation rules (matches the old fresh-install seed): [rule_type, scope, value, is_hard, is_active, description]
const SEPARATION_RULES = [
  ['artist_separation_min', 'global', 60,  1, 1, 'Minimum minutes between songs by the same artist'],
  ['song_separation_min',   'global', 180, 1, 1, 'Minimum minutes before a song can repeat'],
  ['title_separation_min',  'global', 120, 1, 1, 'Minimum minutes between songs with the same title'],
  ['max_same_gender',       'global', 3,   0, 1, 'Max consecutive songs of the same gender'],
  ['max_same_category',     'global', 3,   0, 1, 'Max consecutive songs from the same category'],
];

const DEFINITIONS = [
  { name: 'Title',             data_type: 'text',          description: 'Song title',                            display_order:  1 },
  { name: 'Artist',            data_type: 'text',          description: 'Primary artist name',                   display_order:  2 },
  { name: 'Album',             data_type: 'text',          description: 'Album name',                            display_order:  3 },
  { name: 'Album Artist',      data_type: 'text',          description: 'Album artist name',                     display_order:  4 },
  { name: 'Composer',          data_type: 'text',          description: 'Composer name',                         display_order:  5 },
  { name: 'Year',              data_type: 'number',        description: 'Release year',                          display_order:  6 },
  { name: 'Genre',             data_type: 'single_choice', description: 'Music genre',                           display_order:  7 },
  { name: 'BPM',               data_type: 'number',        description: 'Beats per minute',                      display_order:  8 },
  { name: 'Energy',            data_type: 'number',        description: 'Energy level (0-10)',                   display_order:  9 },
  { name: 'Mood',              data_type: 'single_choice', description: 'Song mood',                             display_order: 10 },
  { name: 'Comments',          data_type: 'text',          description: 'General comments',                      display_order: 11 },
  { name: 'Description',       data_type: 'text',          description: 'Song description',                      display_order: 12 },
  { name: 'Grouping',          data_type: 'text',          description: 'Content grouping',                      display_order: 13 },
  { name: 'Movement Name',     data_type: 'text',          description: 'Classical movement name',               display_order: 14 },
  { name: 'Movement Number',   data_type: 'number',        description: 'Classical movement number',             display_order: 15 },
  { name: 'Work',              data_type: 'text',          description: 'Musical work name',                     display_order: 16 },
  { name: 'Track Number',      data_type: 'number',        description: 'Track number on album',                 display_order: 17 },
  { name: 'Disc Number',       data_type: 'number',        description: 'Disc number',                           display_order: 18 },
  { name: 'Release Date',      data_type: 'date',          description: 'Official release date',                 display_order: 19 },
  { name: 'Purchase Date',     data_type: 'date',          description: 'Purchase date',                         display_order: 20 },
  { name: 'Rating',            data_type: 'number',        description: 'Song rating (0-5)',                     display_order: 21 },
  { name: 'Album Rating',      data_type: 'number',        description: 'Album rating (0-5)',                    display_order: 22 },
  { name: 'Favorite',          data_type: 'boolean',       description: 'Marked as favorite',                    display_order: 23 },
  { name: 'Era',               data_type: 'single_choice', description: 'Musical era or decade',                 display_order: 24 },
  { name: 'Tempo Feel',        data_type: 'single_choice', description: 'Subjective tempo feel',                 display_order: 25 },
  { name: 'Vocal Type',        data_type: 'single_choice', description: 'Vocal type or arrangement',             display_order: 26 },
  { name: 'ISRC',              data_type: 'text',          description: 'International Standard Recording Code', display_order: 27 },
  { name: 'Intro Time',        data_type: 'number',        description: 'Intro duration in seconds',             display_order: 28 },
  { name: 'Outro Time',        data_type: 'number',        description: 'Outro duration in seconds',             display_order: 29 },
  { name: 'Sort Title',        data_type: 'text',          description: 'Sort key for title',                    display_order: 30 },
  { name: 'Sort Artist',       data_type: 'text',          description: 'Sort key for artist',                   display_order: 31 },
  { name: 'Sort Album',        data_type: 'text',          description: 'Sort key for album',                    display_order: 32 },
  { name: 'Sort Album Artist', data_type: 'text',          description: 'Sort key for album artist',             display_order: 33 },
  { name: 'Sort Composer',     data_type: 'text',          description: 'Sort key for composer',                 display_order: 34 },
  { name: 'Length',            data_type: 'number',        description: 'Track length in seconds (auto)',        display_order: 35 },
  { name: 'Date Added',        data_type: 'date',          description: 'Date added to library (auto)',          display_order: 36 },
  { name: 'Date Modified',     data_type: 'date',          description: 'Date file was last modified (auto)',    display_order: 37 },
  { name: 'Last Played',       data_type: 'date',          description: 'Date last played (auto)',               display_order: 38 },
  { name: 'Last Skipped',      data_type: 'date',          description: 'Date last skipped (auto)',              display_order: 39 },
  { name: 'Plays',             data_type: 'number',        description: 'Total play count (auto)',               display_order: 40 },
  { name: 'Skips',             data_type: 'number',        description: 'Total skip count (auto)',               display_order: 41 },
  { name: 'Bit Rate',          data_type: 'number',        description: 'Audio bit rate in kbps (auto)',         display_order: 42 },
  { name: 'Sample Rate',       data_type: 'number',        description: 'Audio sample rate in Hz (auto)',        display_order: 43 },
  { name: 'Size',              data_type: 'number',        description: 'File size in bytes (auto)',             display_order: 44 },
  { name: 'Kind',              data_type: 'single_choice', description: 'Audio file format (auto)',              display_order: 45 },
  { name: 'Cloud Download',    data_type: 'boolean',       description: 'Cloud download status (auto)',          display_order: 46 },
  { name: 'Cloud Status',      data_type: 'text',          description: 'Cloud sync status (auto)',              display_order: 47 },
];

const VOCABULARY = {
  'Genre':      ['Rock', 'Pop', 'Country', 'Jazz', 'R&B', 'Hip-Hop', 'Electronic', 'Classical', 'Folk', 'World'],
  'Era':        ['60s', '70s', '80s', '90s', '2000s', '2010s', '2020s'],
  'Tempo Feel': ['Slow', 'Medium', 'Fast', 'Variable'],
  'Vocal Type': ['Male', 'Female', 'Group', 'Instrumental'],
  'Mood':       ['Upbeat', 'Mellow', 'Aggressive', 'Sad', 'Neutral'],
  'Kind':       ['MP3', 'WAV', 'AAC', 'FLAC', 'AIFF'],
};

// Seed a station's config. Idempotent per station: skips separation_rules / metadata if this station
// already has them, so calling it repeatedly (or on a re-materialized station) never duplicates.
function seedStationConfig(db, stationId) {
  if (stationId == null) return { ok: false, error: 'no stationId' };
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    let rules = 0, defs = 0, vocab = 0;

    const rc = db.prepare('SELECT COUNT(*) c FROM separation_rules WHERE station_id=?').get(stationId).c;
    if (rc === 0) {
      const ins = db.prepare('INSERT INTO separation_rules (station_id, rule_type, scope, value, is_hard, is_active, description) VALUES (?,?,?,?,?,?,?)');
      for (const [rt, sc, v, hard, act, desc] of SEPARATION_RULES) { ins.run(stationId, rt, sc, v, hard, act, desc); rules++; }
    }

    const dc = db.prepare('SELECT COUNT(*) c FROM metadata_definitions WHERE station_id=?').get(stationId).c;
    if (dc === 0) {
      const insDef = db.prepare('INSERT INTO metadata_definitions (uuid, station_id, name, data_type, description, is_built_in, is_required, display_order, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,1,0,?,?,?,NULL)');
      const insVocab = db.prepare('INSERT INTO metadata_vocabulary (uuid, station_id, definition_id, value, display_order, color, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,NULL,?,?,NULL)');
      const defIdByName = {};
      for (const d of DEFINITIONS) {
        const r = insDef.run(crypto.randomUUID(), stationId, d.name, d.data_type, d.description, d.display_order, now, now);
        defIdByName[d.name] = r.lastInsertRowid;
        defs++;
      }
      for (const [defName, values] of Object.entries(VOCABULARY)) {
        const defId = defIdByName[defName];
        values.forEach((val, i) => { insVocab.run(crypto.randomUUID(), stationId, defId, val, i + 1, now, now); vocab++; });
      }
    }
    return { rules, defs, vocab };
  });
  return { ok: true, ...tx() };
}

module.exports = { seedStationConfig, DEFINITIONS, VOCABULARY, SEPARATION_RULES };

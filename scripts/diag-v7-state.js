'use strict';

const path = require('path');
const os   = require('os');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath  = path.join(appData, 'com.ether.radio', 'openair.db');
const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const db = new Database(dbPath, { readonly: true });

let ok = true;
function pass(msg) { console.log('  PASS  ' + msg); }
function fail(msg) { console.error('  FAIL  ' + msg); ok = false; }

// schema_version
console.log('=== schema_version ===');
const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
console.log(JSON.stringify(versions));
if (JSON.stringify(versions) === '[1,2,3,4,5,6,7]') pass('schema_version = [1,2,3,4,5,6,7]');
else fail('schema_version mismatch: got ' + JSON.stringify(versions));

// artists columns
console.log('\n=== PRAGMA table_info(artists) ===');
const artistsCols = db.prepare('PRAGMA table_info(artists)').all();
artistsCols.forEach(r => console.log(' ', r.cid, r.name, r.type, r.notnull ? 'NOT NULL' : ''));
if (!artistsCols.find(r => r.name === 'station_id')) pass('artists: station_id absent');
else fail('artists: station_id STILL PRESENT');

// albums columns
console.log('\n=== PRAGMA table_info(albums) ===');
const albumsCols = db.prepare('PRAGMA table_info(albums)').all();
albumsCols.forEach(r => console.log(' ', r.cid, r.name, r.type, r.notnull ? 'NOT NULL' : ''));
if (!albumsCols.find(r => r.name === 'station_id')) pass('albums: station_id absent');
else fail('albums: station_id STILL PRESENT');

// songs columns
console.log('\n=== PRAGMA table_info(songs) [station_id must still be present] ===');
const songsCols = db.prepare('PRAGMA table_info(songs)').all();
const songsStationId = songsCols.find(r => r.name === 'station_id');
console.log('  station_id entry:', songsStationId ? JSON.stringify(songsStationId) : 'ABSENT');
if (songsStationId) pass('songs: station_id still present (deferred to v8)');
else fail('songs: station_id absent — should NOT have been dropped yet');

// row counts
console.log('\n=== row counts ===');
const nArtists = db.prepare('SELECT COUNT(*) AS n FROM artists').get().n;
const nAlbums  = db.prepare('SELECT COUNT(*) AS n FROM albums').get().n;
const nSongs   = db.prepare('SELECT COUNT(*) AS n FROM songs').get().n;
const nMuts    = db.prepare('SELECT COUNT(*) AS n FROM mutations').get().n;
console.log('  artists  :', nArtists);
console.log('  albums   :', nAlbums);
console.log('  songs    :', nSongs);
console.log('  mutations:', nMuts);

// mutations
const nMetaDefs = db.prepare('SELECT COUNT(*) AS n FROM metadata_definitions').get().n;
const nMetaVoc  = db.prepare('SELECT COUNT(*) AS n FROM metadata_vocabulary').get().n;
const nSMV      = db.prepare('SELECT COUNT(*) AS n FROM song_metadata_values').get().n;
console.log('  metadata_definitions  :', nMetaDefs);
console.log('  metadata_vocabulary   :', nMetaVoc);
console.log('  song_metadata_values  :', nSMV);

console.log('\n=== Result ===');
if (ok) console.log('ALL CHECKS PASSED — v7 state verified.');
else console.error('ONE OR MORE CHECKS FAILED.');

db.close();

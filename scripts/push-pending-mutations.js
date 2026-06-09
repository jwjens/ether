'use strict';
// scripts/push-pending-mutations.js
//
// Standalone push: sends all sync_status='pending' mutations from the real DB
// to the Railway backend and marks them synced. Does NOT pull or call syncCycle.
//
// Run with:
//   $env:ETHER_SYNC_URL="https://ether-backend-production.up.railway.app"
//   node_modules/.bin/electron --no-sandbox scripts/push-pending-mutations.js
//
// The license key is read automatically from station_config_kv (key='license_key').
// ETHER_SYNC_URL may also be stored in station_config_kv (key='sync_backend_url').

const path = require('path');
const os   = require('os');
const ROOT    = path.join(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DB_PATH = path.join(appData, 'com.ether.radio', 'openair.db');

const Database      = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const { HttpTransport } = require(path.join(ROOT, 'electron', 'sync', 'transport-http'));
const { SyncEngine }   = require(path.join(ROOT, 'electron', 'sync', 'sync-engine'));

(async () => {
  const db = new Database(DB_PATH);

  // Resolve base URL: DB row first, then env var
  const urlRow = db.prepare("SELECT value FROM station_config_kv WHERE key='sync_backend_url' LIMIT 1").get();
  const baseUrl = urlRow?.value || process.env.ETHER_SYNC_URL || '';
  if (!baseUrl) {
    console.error('[push] ERROR: no baseUrl — set ETHER_SYNC_URL or store sync_backend_url in station_config_kv');
    db.close(); process.exit(1);
  }
  console.log('[push] baseUrl:', baseUrl);

  // Count pending before push, broken down by table_name
  const beforeRows = db.prepare(
    "SELECT table_name, COUNT(*) as c FROM mutations WHERE sync_status='pending' GROUP BY table_name ORDER BY table_name"
  ).all();
  const beforeTotal = beforeRows.reduce((s, r) => s + r.c, 0);
  console.log('[push] pending before push: ' + beforeTotal);
  for (const r of beforeRows) console.log('  ' + r.table_name + ': ' + r.c);

  if (beforeTotal === 0) {
    console.log('[push] Nothing to push — exiting.');
    db.close(); process.exit(0);
  }

  const transport = new HttpTransport(db, { baseUrl });
  const engine    = new SyncEngine(db, transport);

  console.log('[push] Pushing...');
  let result;
  try {
    result = await engine.push();
  } catch (err) {
    console.error('[push] FATAL during push:', err.message);
    db.close(); process.exit(1);
  }

  console.log('[push] Push complete:');
  console.log('  sent    :', result.sent);
  console.log('  accepted:', result.accepted);
  console.log('  rejected:', result.rejected);

  // Count pending after push
  const afterRows = db.prepare(
    "SELECT table_name, COUNT(*) as c FROM mutations WHERE sync_status='pending' GROUP BY table_name ORDER BY table_name"
  ).all();
  const afterTotal = afterRows.reduce((s, r) => s + r.c, 0);
  console.log('[push] pending after push: ' + afterTotal);
  if (afterTotal > 0) {
    for (const r of afterRows) console.log('  ' + r.table_name + ': ' + r.c);
  }

  // Verify: clock_slots specifically
  const csRow = db.prepare(
    "SELECT sync_status, COUNT(*) as c FROM mutations WHERE table_name='clock_slots' GROUP BY sync_status"
  ).all();
  console.log('[push] clock_slots by sync_status after push:');
  for (const r of csRow) console.log('  ' + r.sync_status + ': ' + r.c);

  db.close();

  if (result.rejected > 0) {
    console.error('[push] WARN: ' + result.rejected + ' mutation(s) rejected by server.');
    process.exit(1);
  }
  if (afterTotal > 0) {
    console.error('[push] WARN: ' + afterTotal + ' mutation(s) still pending after push.');
    process.exit(1);
  }
  console.log('[push] OK — all pending mutations pushed and synced.');
  process.exit(0);
})();

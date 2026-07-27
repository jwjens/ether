'use strict';
// verify-push-license.js — READ-ONLY. Confirms the sync transport now resolves the ACCOUNT license
// (license 19, ETH-STN-1D73-7E88-C4E6) deterministically, instead of the old `… LIMIT 1` value.
//
// Opens the LIVE openair.db READ-ONLY (safe to run while Ether is on air — WAL allows concurrent
// readers; this never writes). Constructs HttpTransport exactly as main.js does (NO explicit
// licenseKey) and calls the real _getLicenseKey().
//
// Run:  ELECTRON_RUN_AS_NODE=1 /c/openair/node_modules/electron/dist/electron.exe \
//       "<this file>"

const path = require('path');
const OPENAIR = 'C:/openair';
const Database = require(path.join(OPENAIR, 'node_modules/better-sqlite3'));
const { HttpTransport } = require(path.join(OPENAIR, 'electron/sync/transport-http'));

const DB = path.join(process.env.LOCALAPPDATA, 'Ether', 'com.ether.radio', 'openair.db');
const EXPECTED = 'ETH-STN-1D73-7E88-C4E6';

const db = new Database(DB, { readonly: true, fileMustExist: true });

// What the OLD code returned (arbitrary LIMIT 1) — for contrast.
const legacy = db.prepare("SELECT value FROM station_config_kv WHERE key='license_key' LIMIT 1").get()?.value || '(none)';

// What each NEW branch sees.
const anchor = db.prepare("SELECT value FROM install_config_kv WHERE key='account_license_key' AND value IS NOT NULL AND value != '' AND deleted_at IS NULL LIMIT 1").get()?.value || '(unset)';
const owner  = db.prepare("SELECT owner_license_key AS value FROM stations WHERE owner_license_key IS NOT NULL AND owner_license_key != '' AND deleted_at IS NULL ORDER BY is_active DESC, id ASC LIMIT 1").get()?.value || '(none)';

// The REAL resolver (no explicit licenseKey → exercises the new branches).
const t = new HttpTransport(db, { baseUrl: 'http://verify.local' });
const resolved = t._getLicenseKey();

console.log('--- push-license resolution (READ-ONLY) ---');
console.log('OLD (station_config_kv LIMIT 1):', legacy);
console.log('NEW branch 1 account_license_key:', anchor);
console.log('NEW branch 2 owner_license_key  :', owner);
console.log('==> transport._getLicenseKey()  :', resolved);
console.log('');
console.log(resolved === EXPECTED
  ? `PASS ✅  push license pins to the OV account (${EXPECTED})`
  : `FAIL ❌  resolved ${resolved}, expected ${EXPECTED}`);
db.close();
process.exit(resolved === EXPECTED ? 0 : 1);

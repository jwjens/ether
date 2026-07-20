'use strict';
// backfill-missing-audio.js — IMMEDIATE RELIEF. Download every library song whose local file is
// ABSENT but which has an R2 file_key, to its EXACT file_path, so rotation + A/B/C deck-load
// (which check fs.existsSync(file_path)) find it. Replicates fetchR2Track's backend-signed flow.
// Writes AUDIO FILES ONLY — never the DB. Run:
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/backfill-missing-audio.js [--dry] [db]
const path = require('path'), os = require('os'), fs = require('fs');
const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const dbPath = args.find(a => a.endsWith('.db')) || path.join(lad, 'Ether', 'com.ether.radio', 'openair.db');
const BACKEND = 'https://ether-backend-production.up.railway.app';
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(dbPath, { readonly: true });
const exists = (fp) => { try { return !!fp && fs.existsSync(fp); } catch { return false; } };

// License key — same resolution as accountLicenseKey(): active/owned station owner license, else account KV.
let licenseKey = null;
try { licenseKey = db.prepare("SELECT owner_license_key k FROM stations WHERE is_active=1 AND deleted_at IS NULL AND owner_license_key IS NOT NULL LIMIT 1").get()?.k; } catch {}
if (!licenseKey) try { licenseKey = db.prepare("SELECT value FROM install_config_kv WHERE key='account_license_key' AND deleted_at IS NULL LIMIT 1").get()?.value; } catch {}
if (!licenseKey) try { licenseKey = db.prepare("SELECT owner_license_key k FROM stations WHERE owner_license_key IS NOT NULL AND owner_license_key!='' LIMIT 1").get()?.k; } catch {}
if (!licenseKey) { console.error('No license_key resolvable — abort.'); process.exit(1); }
console.log(`license …${String(licenseKey).slice(-4)}  backend ${BACKEND}  ${DRY ? '(DRY RUN)' : ''}`);

// The targets: file_path set, not deleted, file_key present, local file ABSENT.
const rows = db.prepare(
  `SELECT DISTINCT s.id, s.title, s.file_path, s.file_key
     FROM songs s WHERE s.deleted_at IS NULL AND s.file_path IS NOT NULL AND s.file_path!=''
       AND s.file_key IS NOT NULL AND s.file_key!=''`).all();
const missing = rows.filter(r => !exists(r.file_path));
console.log(`library songs with file_key: ${rows.length}; local-absent (to fetch): ${missing.length}\n`);
if (!missing.length) { console.log('Nothing to backfill.'); process.exit(0); }
if (DRY) { missing.slice(0, 10).forEach(m => console.log(`  would fetch: "${m.title}" → ${m.file_path}`)); console.log(`  … ${missing.length} total`); process.exit(0); }

async function fetchOne(m) {
  try {
    const u = await fetch(`${BACKEND}/audio/download-url`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey, file_key: m.file_key }),
    });
    const d = await u.json().catch(() => ({}));
    if (!u.ok || !d.signed_url) throw new Error(d.error || d.detail || `sign HTTP ${u.status}`);
    const g = await fetch(d.signed_url);
    if (!g.ok) throw new Error(`GET HTTP ${g.status}`);
    const buf = Buffer.from(await g.arrayBuffer());
    fs.mkdirSync(path.dirname(m.file_path), { recursive: true });
    const tmp = m.file_path + '.tmp';
    fs.writeFileSync(tmp, buf); fs.renameSync(tmp, m.file_path);
    return { ok: true, mb: buf.length / 1e6 };
  } catch (e) { try { fs.unlinkSync(m.file_path + '.tmp'); } catch {} return { ok: false, error: e.message }; }
}

(async () => {
  let done = 0, ok = 0, fail = 0, mb = 0; const errors = [];
  const CONC = 4; let idx = 0;
  async function worker() {
    while (idx < missing.length) {
      const m = missing[idx++];
      const r = await fetchOne(m);
      done++;
      if (r.ok) { ok++; mb += r.mb; } else { fail++; errors.push(`"${m.title}" (${m.file_key}): ${r.error}`); }
      if (done % 10 === 0 || done === missing.length) console.log(`  ${done}/${missing.length}  ok=${ok} fail=${fail}  ${mb.toFixed(0)}MB`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`\nDONE: ${ok} fetched (${mb.toFixed(0)} MB), ${fail} failed.`);
  if (errors.length) { console.log('First failures:'); errors.slice(0, 8).forEach(e => console.log('  ✗ ' + e)); }
  db.close();
})();

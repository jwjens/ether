'use strict';

// scripts/run-all-smokes.js
// Runs every scripts/smoke-*-handlers.js sequentially via Electron.
// Reports PASS/FAIL + assertion count per table. Exits 1 if any table fails.
//
// Uses temp-file capture per run because spawnSync cannot capture Electron
// stdout on Windows via the .cmd launcher.

const { spawnSync } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const ROOT     = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const smokeFiles = fs.readdirSync(path.join(ROOT, 'scripts'))
  .filter(f => f.startsWith('smoke-') && f.endsWith('-handlers.js'))
  .sort()
  .map(f => path.join('scripts', f));

if (smokeFiles.length === 0) {
  console.error('[run-all-smokes] No smoke files found matching scripts/smoke-*-handlers.js');
  process.exit(1);
}

console.log(`[run-all-smokes] Found ${smokeFiles.length} smoke scripts\n`);

const tmpDir  = os.tmpdir();
const results = [];
let anyFailed = false;

for (const file of smokeFiles) {
  const table   = file.replace('scripts/smoke-', '').replace('-handlers.js', '');
  const tmpFile = path.join(tmpDir, `smoke-${table}-${Date.now()}.log`);

  process.stdout.write(`  ${table}... `);

  const r = spawnSync(ELECTRON, ['--no-sandbox', path.join(ROOT, file)], {
    stdio: ['ignore', fs.openSync(tmpFile, 'w'), fs.openSync(tmpFile, 'a')],
    timeout: 30000,
  });

  let out = '';
  try { out = fs.readFileSync(tmpFile, 'utf8'); } catch (_) {}
  try { fs.unlinkSync(tmpFile); } catch (_) {}

  const m      = out.match(/RESULTS:\s*(\d+)\s*passed,\s*(\d+)\s*failed/);
  const nPass  = m ? parseInt(m[1], 10) : null;
  const nFail  = m ? parseInt(m[2], 10) : null;
  const ok     = r.status === 0 && nFail === 0;

  if (ok) {
    console.log(`PASS (${nPass})`);
    results.push({ table, ok: true, nPass, nFail: 0 });
  } else {
    console.log(`FAIL`);
    anyFailed = true;
    results.push({ table, ok: false, nPass, nFail, status: r.status, output: out });
  }
}

console.log('\n' + '═'.repeat(64));
console.log('SUMMARY');
console.log('═'.repeat(64));

for (const r of results) {
  const mark  = r.ok ? 'PASS' : 'FAIL';
  const count = r.nPass !== null ? ` (${r.nPass}/${(r.nPass || 0) + (r.nFail || 0)})` : '';
  console.log(`  ${mark}  ${r.table}${count}`);
}

console.log('');
const totalPass = results.filter(r => r.ok).length;
const totalFail = results.filter(r => !r.ok).length;
console.log(`Tables: ${totalPass} passed, ${totalFail} failed`);

if (anyFailed) {
  console.log('\nFAILED TABLES — output below:\n');
  for (const r of results.filter(r => !r.ok)) {
    console.log('─'.repeat(64));
    console.log(`FAIL: ${r.table}  (exit ${r.status})`);
    console.log(r.output || '(no output captured)');
  }
}

process.exit(anyFailed ? 1 : 0);

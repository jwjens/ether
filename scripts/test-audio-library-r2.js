#!/usr/bin/env node
/**
 * TEST: the folder-driven audio backup.
 *
 * THE PROMISE: "cloud backup of my library" must mean the LIBRARY — carts, spots, announcements,
 * sweepers, voice tracks, episodes, and the files with no row at all. It used to mean `songs`, which
 * on the dev machine was 765 of 1,878 files.
 *
 * The gates that matter:
 *   B-3  a file with NO database row is backed up (the old design's blind spot, 1,113 of them)
 *   B-6  a second run uploads nothing
 *   B-9  the download writes files only — never a row, which is what removed the path broadcast
 *   B-11 a short download is discarded, not left in the library
 *
 * Run: npm run test:audio-library-r2
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { uploadLibrary, downloadLibrary, MANIFEST_KEY } = require('../electron/audio-library-r2');

let pass = 0; const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push(`${name}\n      expected: ${e}\n      actual:   ${a}`);
};

// ── a fake R2 + backend, so the manifest round-trip is really exercised ────────────────────────
function makeCloud(opts = {}) {
  const objects = new Map();          // key -> Buffer
  let puts = 0, gets = 0;
  const fetchImpl = async (url, init) => {
    // Signing endpoints
    if (String(url).endsWith('/audio/upload-url') || String(url).endsWith('/audio/download-url')) {
      const body = JSON.parse(init.body);
      const kind = String(url).endsWith('/audio/upload-url') ? 'put' : 'get';
      if (kind === 'get' && !objects.has(body.file_key)) {
        return { ok: false, status: 404, json: async () => ({ error: 'not found' }), text: async () => 'not found' };
      }
      return { ok: true, status: 200, json: async () => ({ signed_url: `mem://${kind}/${encodeURIComponent(body.file_key)}` }) };
    }
    const m = /^mem:\/\/(put|get)\/(.+)$/.exec(String(url));
    if (!m) throw new Error('unexpected url ' + url);
    const key = decodeURIComponent(m[2]);
    if (m[1] === 'put') {
      puts++;
      if (opts.failKey && key === opts.failKey) return { ok: false, status: 500, text: async () => 'boom' };
      objects.set(key, Buffer.from(init.body));
      return { ok: true, status: 200 };
    }
    gets++;
    if (!objects.has(key)) return { ok: false, status: 404 };
    let buf = objects.get(key);
    if (opts.truncateKey && key === opts.truncateKey) buf = buf.slice(0, 1);   // a short download
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  return { objects, fetchImpl, stats: () => ({ puts, gets }) };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ether-r2-'));
const LIB_A = path.join(tmp, 'machineA', 'ether music library');   // the machine WITH the audio
const LIB_B = path.join(tmp, 'machineB', 'ether music library');   // the machine restoring
fs.mkdirSync(LIB_A, { recursive: true });
fs.mkdirSync(LIB_B, { recursive: true });

// The library as it actually is: a song, a cart, an announcement, and a file nothing references.
fs.writeFileSync(path.join(LIB_A, 'Wolves.mp3'), 'song-bytes');
fs.writeFileSync(path.join(LIB_A, 'growl.mp3'), 'cart-bytes');
fs.writeFileSync(path.join(LIB_A, 'Legal ID.mp3'), 'announcement-bytes');
fs.writeFileSync(path.join(LIB_A, 'orphan-nobody-references.mp3'), 'orphan-bytes');
fs.writeFileSync(path.join(LIB_A, 'notes.txt'), 'not audio');      // must be ignored

const base = { backendUrl: 'https://backend.test', licenseKey: 'LIC-1' };

(async () => {
  const cloud = makeCloud();

  console.log('\n── upload: the FOLDER, not one table ──');
  const up = await uploadLibrary({ ...base, libDir: LIB_A, fetchImpl: cloud.fetchImpl });
  check('  B-1 it succeeded', up.ok, true);
  check('  B-2 it saw the 4 audio files (and ignored notes.txt)', up.localFiles, 4);
  check('  B-3 a file with NO database row is backed up',
    cloud.objects.has('orphan-nobody-references.mp3'), true);
  check('  B-4 the cart is backed up', cloud.objects.has('growl.mp3'), true);
  check('  B-5 the announcement is backed up', cloud.objects.has('legal id.mp3') || cloud.objects.has('Legal ID.mp3'), true);
  check('  B-5b a manifest was written', cloud.objects.has(MANIFEST_KEY), true);
  check('  B-5c the non-audio file was NOT uploaded', cloud.objects.has('notes.txt'), false);

  console.log('\n── idempotent ──');
  const before = cloud.stats().puts;
  const up2 = await uploadLibrary({ ...base, libDir: LIB_A, fetchImpl: cloud.fetchImpl });
  check('  B-6 a second run uploads no audio', up2.uploaded, 0);
  check('  B-6b ...and reports everything already in the cloud', up2.skipped, 4);
  check('  B-6c only the manifest was re-written', cloud.stats().puts - before, 1);

  console.log('\n── restore onto a machine that has none of it ──');
  const dl = await downloadLibrary({ ...base, libDir: LIB_B, fetchImpl: cloud.fetchImpl });
  check('  B-7 it succeeded', dl.ok, true);
  check('  B-8 all four files landed', dl.downloaded, 4);
  check('  B-8b including the cart', fs.existsSync(path.join(LIB_B, 'growl.mp3')), true);
  check('  B-8c including the announcement', fs.existsSync(path.join(LIB_B, 'Legal ID.mp3')), true);
  check('  B-8d and the bytes match', fs.readFileSync(path.join(LIB_B, 'growl.mp3'), 'utf8'), 'cart-bytes');
  // The property that removed the path broadcast: this code path cannot write a row because it is
  // given no database at all.
  check('  B-9 downloadLibrary takes no db handle — it CANNOT write a row',
    /function downloadLibrary\(opts\)/.test(fs.readFileSync(path.join(__dirname, '..', 'electron', 'audio-library-r2.js'), 'utf8'))
      && !/db\./.test(fs.readFileSync(path.join(__dirname, '..', 'electron', 'audio-library-r2.js'), 'utf8')), true);

  const dl2 = await downloadLibrary({ ...base, libDir: LIB_B, fetchImpl: cloud.fetchImpl });
  check('  B-10 a second restore pulls nothing', dl2.downloaded, 0);

  console.log('\n── failure handling ──');
  const LIB_C = path.join(tmp, 'machineC', 'ether music library');
  fs.mkdirSync(LIB_C, { recursive: true });
  const cloud2 = makeCloud({ truncateKey: 'growl.mp3' });
  await uploadLibrary({ ...base, libDir: LIB_A, fetchImpl: cloud2.fetchImpl });
  const dl3 = await downloadLibrary({ ...base, libDir: LIB_C, fetchImpl: cloud2.fetchImpl });
  check('  B-11 a short download is DISCARDED, not left in the library',
    fs.existsSync(path.join(LIB_C, 'growl.mp3')), false);
  check('  B-11b ...no .part file left behind either',
    fs.existsSync(path.join(LIB_C, 'growl.mp3.part')), false);
  check('  B-11c ...and it is reported', dl3.failures.some(f => f.name === 'growl.mp3'), true);
  check('  B-11d the other files still landed', dl3.downloaded, 3);

  const cloud3 = makeCloud();
  const dlEmpty = await downloadLibrary({ ...base, libDir: LIB_C, fetchImpl: cloud3.fetchImpl });
  check('  B-12 no backup in the cloud yet is refused with an actionable reason',
    /No audio library backup found/.test(dlEmpty.error || ''), true);

  const cloud4 = makeCloud({ failKey: 'growl.mp3' });
  const upFail = await uploadLibrary({ ...base, libDir: LIB_A, fetchImpl: cloud4.fetchImpl });
  check('  B-13 an upload failure is reported, not swallowed',
    upFail.failures.some(f => f.name === 'growl.mp3'), true);
  check('  B-13b ...and the other files still went up', upFail.uploaded, 3);
  check('  B-13c ...and the manifest still describes reality (no phantom entry)',
    JSON.parse(cloud4.objects.get(MANIFEST_KEY).toString()).files['growl.mp3'], undefined);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log('\n' + '─'.repeat(70));
  if (failures.length) {
    console.log(`FAILED — ${failures.length} of ${pass + failures.length} checks\n`);
    for (const f of failures) console.log('  ✗ ' + f);
    console.log('');
    process.exit(1);
  }
  console.log(`PASS — all ${pass} checks\n`);
})().catch(e => { console.error('THREW:', e); process.exit(1); });

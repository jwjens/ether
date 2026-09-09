'use strict';
//
// electron/audio-library-r2.js — THE CLOUD BACKUP IS THE CATALOGUE FOLDER, NOT ONE TABLE.
//
// Jeff, 2026-09-09:
//   "R2 backs up songs only. That's wrong and it was always wrong — an mp3 is an mp3, the table name
//    is just a name. Carts, sweepers, announcements and spots are audio and they belong in the backup
//    like everything else."
//   "Upload everything in the catalogue, referenced or not. It's four cents a month and a file with
//    no row today may have one tomorrow. I'm not building a system that decides which of my audio is
//    worth keeping."
//
// WHAT WAS WRONG WITH ROW-DRIVEN. The old upload was `SELECT … FROM songs`, so the backup carried one
// table. Carts, spots, announcements, sweepers, voice tracks and published episodes — every one of
// them audio, every one of them a row that goes silent on another machine without its file — were not
// in it. Worse, a backup keyed on rows can never keep the promise its name makes: a file sitting in
// the catalogue that no row references is invisible to any widening of a row query, and no amount of
// adding tables fixes that. THE UNIT HAS TO BE THE FILE.
//
// The alternative considered and rejected (docs/one-sync-arc-2026-09-09.md §3.2) was a wider query
// across all seven audio tables. It is blocked on a five-table migration — `announcements`, `spots`,
// `cart_slots`, `voice_tracks` and `published_episodes` have neither `file_key` nor `r2_uploaded_at`
// — and it still misses the unreferenced files. Folder-driven needs NO migration at all, because
// neither the key nor the resume marker is a row property any more.
//
// THE MANIFEST IS THE RESUME MARKER. `songs.r2_uploaded_at` cannot serve: there is no such column on
// the other tables and no row at all behind an unreferenced file. So one JSON object in R2 lists what
// is up there, by basename and size. It is read at the start of a run, updated as files land, and
// written back — periodically, so an interrupted run resumes where it stopped rather than starting
// over on 2.9 GB.
//
// THE DOWNLOAD WRITES NO ROWS. Not "writes them carefully" — writes none. That is what makes the
// restore path structurally incapable of broadcasting this machine's paths to its peers: there is no
// row write left to route wrongly. Rows resolve afterwards by basename through the resolver tier,
// which is exactly the property [N-23a] and the one-catalogue rule were built to give.
//
// WHAT IT DOES NOT REPLACE: per-row MATERIALIZATION ("fetch the audio for this one row"), which needs
// a per-row key and is still `songs.file_key`. Upload keeps that column current for matching rows —
// `file_key` is a CONTENT identity, not a machine path, so it is safe and correct to sync. `file_path`
// is never written by anything in this file.

const fs = require('fs');
const path = require('path');

// One definition of "is this an audio file", shared with the index/health modules.
const { AUDIO: AUDIO_EXTS } = require('./audio-library-index');

const MANIFEST_KEY = '_ether-catalogue-manifest.json';
const MANIFEST_VERSION = 1;
const CHECKPOINT_EVERY = 25;     // files between manifest writes — bounds what an interrupted run loses

function contentTypeFor(name) {
  const ext = path.extname(name).toLowerCase();
  return ({
    '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
    '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  })[ext] || 'application/octet-stream';
}

/**
 * Every audio file directly in the catalogue.
 *
 * FLAT ON PURPOSE — depth 1, no recursion. The catalogue is flat by rule (a slug goes in a filename,
 * never a folder), and walking deeper would upload two files with the same basename to one key, where
 * the second silently overwrites the first. If a subfolder ever appears it is a defect upstream, and
 * quietly flattening it here would hide that.
 */
function walkCatalogue(root) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.isDirectory()) continue;
    if (!AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) continue;
    const full = path.join(root, e.name);
    let st; try { st = fs.statSync(full); } catch { continue; }
    out.push({ name: e.name, path: full, size: st.size, mtime: Math.floor(st.mtimeMs) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Does the local file differ from what the manifest says is in the cloud?
 *
 * SIZE, NOT mtime. An mtime differs after any copy, restore or filesystem round-trip, so comparing it
 * would re-upload the entire catalogue every time a machine restored one. Size is stable across all of
 * those and catches the case that actually matters — the file was replaced. (A same-size replacement
 * is missed; that is the documented cost of not hashing 2.9 GB on every run, and `force` exists for
 * when the operator wants certainty.)
 */
function needsUpload(local, manifestEntry) {
  if (!manifestEntry) return true;
  return Number(manifestEntry.size) !== Number(local.size);
}

function emptyManifest() {
  return { version: MANIFEST_VERSION, updated_at: null, files: {} };
}

/**
 * Read the manifest out of R2.
 *
 * A MISSING MANIFEST IS NOT AN ERROR — it is the first run, and the caller seeds it (see
 * seedManifestFromRows). Anything malformed is treated the same way: a manifest we cannot parse is
 * worth less than no manifest, because acting on it would skip files that are not up there.
 */
async function readRemoteManifest(io) {
  try {
    const body = await io.getObject(MANIFEST_KEY);
    if (!body) return { manifest: emptyManifest(), existed: false };
    const parsed = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.files !== 'object') {
      return { manifest: emptyManifest(), existed: false, malformed: true };
    }
    return { manifest: { ...emptyManifest(), ...parsed }, existed: true };
  } catch {
    return { manifest: emptyManifest(), existed: false };
  }
}

async function writeRemoteManifest(io, manifest) {
  manifest.updated_at = new Date().toISOString();
  const body = Buffer.from(JSON.stringify(manifest), 'utf8');
  await io.putObject(MANIFEST_KEY, body, 'application/json');
}

/**
 * FIRST-RUN SEED — what is already in R2, without a LIST endpoint.
 *
 * The backend exposes signed PUT and GET for a key; it cannot enumerate a prefix. So on the very
 * first folder-driven run there is no manifest and no way to ask what is up there — and re-uploading
 * 2.9 GB that is already in the bucket would be a pointless hour and a pointless bill.
 *
 * `songs.file_key` + `r2_uploaded_at` is the record of what the OLD row-driven upload sent, and the
 * old path keyed objects by basename too (`fileKey = path.basename(song.file_path)`), so those
 * objects are already in this exact keyspace. Seeding from them is not a guess about R2; it is this
 * machine's own record of what it uploaded.
 *
 * Sizes come from the LOCAL file when it is present. A seeded entry with no size can never satisfy
 * needsUpload(), so it re-uploads — which is the safe direction: the cost of being wrong is one
 * upload, not a missing backup.
 */
function seedManifestFromRows(db, catalogueRoot) {
  const manifest = emptyManifest();
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT file_key, file_path FROM songs
        WHERE deleted_at IS NULL AND r2_uploaded_at IS NOT NULL
          AND file_key IS NOT NULL AND file_key != ''`
    ).all();
  } catch { return { manifest, seeded: 0 }; }

  // KEYED ON THE LOCAL FILE'S ACTUAL NAME, NOT THE ROW'S file_key. Measured 2026-09-09: `songs` holds
  // TWO rows for the same audio whose file_keys differ only in case —
  //   id 699  "Deck The Halls_spotdown.org.mp3"
  //   id 1050 "Deck the Halls_spotdown.org.mp3"
  // R2 keys are case-SENSITIVE and NTFS is not, so the old row-driven upload sent that audio twice
  // under two keys, and seeding straight from file_key produced two manifest entries for one file.
  // On restore both downloaded to the same filename and one overwrote the other, leaving the
  // catalogue with a name whose case did not match the row.
  //
  // Building a case-folded index of what is actually on disk and seeding under the REAL filename
  // collapses the duplicates and makes the manifest describe the catalogue rather than the rows.
  const localByLower = new Map();
  try {
    for (const e of fs.readdirSync(catalogueRoot, { withFileTypes: true })) {
      if (e.isDirectory()) continue;
      localByLower.set(e.name.toLowerCase(), e.name);
    }
  } catch { return { manifest, seeded: 0 }; }

  let seeded = 0;
  for (const r of rows) {
    const claimed = path.basename(String(r.file_key));
    if (!claimed) continue;
    const realName = localByLower.get(claimed.toLowerCase());
    if (!realName) continue;                       // no local copy — let it upload
    if (manifest.files[realName]) continue;        // already seeded (the case-variant duplicate)
    let size = null;
    try { size = fs.statSync(path.join(catalogueRoot, realName)).size; } catch { size = null; }
    if (size === null) continue;
    // `seeded: true` means UNVERIFIED — this machine's own record says it uploaded the file, and that
    // record has been measured wrong. See the note on pruning in downloadCatalogue.
    manifest.files[realName] = { size, mtime: null, seeded: true };
    seeded++;
  }
  return { manifest, seeded };
}

/**
 * UPLOAD — the catalogue folder, every audio file in it.
 *
 * @param io   { putObject(key, buffer, contentType), getObject(key) -> Buffer|null }
 * @param opts { root, db, force, concurrency, onProgress(p), shouldAbort() -> bool, onFileKey(name) }
 */
async function uploadCatalogue(io, opts) {
  const {
    root, db, force = false, concurrency = 3,
    onProgress = () => {}, shouldAbort = () => false, onFileKey = null,
  } = opts;

  const local = walkCatalogue(root);
  const totalBytesLocal = local.reduce((a, f) => a + f.size, 0);

  let { manifest, existed } = await readRemoteManifest(io);
  let seeded = 0;
  if (!existed) {
    const s = seedManifestFromRows(db, root);
    manifest = s.manifest;
    seeded = s.seeded;
  }

  const pending = force ? local.slice() : local.filter(f => needsUpload(f, manifest.files[f.name]));
  const pendingBytes = pending.reduce((a, f) => a + f.size, 0);

  const result = {
    root,
    localFiles: local.length,
    localBytes: totalBytesLocal,
    manifestExisted: existed,
    seededFromRows: seeded,
    alreadyUp: local.length - pending.length,
    toUpload: pending.length,
    toUploadBytes: pendingBytes,
    uploaded: 0,
    uploadedBytes: 0,
    errors: 0,
    failures: [],
    aborted: false,
    startedAt: Date.now(),
  };

  let done = 0;
  let sinceCheckpoint = 0;

  async function one(file) {
    if (shouldAbort()) return;
    const MAX_TRIES = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      try {
        const body = fs.readFileSync(file.path);
        await io.putObject(file.name, body, contentTypeFor(file.name));
        manifest.files[file.name] = { size: file.size, mtime: file.mtime };
        result.uploaded++;
        result.uploadedBytes += file.size;
        // Keep per-row MATERIALIZATION working for song rows that name this file. `file_key` is a
        // CONTENT identity, not a machine path — safe and correct to sync, unlike file_path, which
        // nothing in this module ever writes.
        if (onFileKey) { try { onFileKey(file.name); } catch { /* never fail an upload over this */ } }
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_TRIES && !shouldAbort()) {
          await new Promise(r => setTimeout(r, 500 * attempt));
        }
      }
    }
    if (lastErr) {
      result.errors++;
      if (result.failures.length < 200) result.failures.push({ name: file.name, reason: lastErr.message });
    }
    done++;
    sinceCheckpoint++;
    onProgress({ phase: 'upload', done, total: pending.length, errors: result.errors, current: file.name });
  }

  for (let i = 0; i < pending.length; i += concurrency) {
    if (shouldAbort()) { result.aborted = true; break; }
    await Promise.all(pending.slice(i, i + concurrency).map(one));
    if (sinceCheckpoint >= CHECKPOINT_EVERY) {
      // Bounded loss on an interruption. Without this a run killed at file 400 of 483 would resume
      // from zero, on 2.9 GB.
      try { await writeRemoteManifest(io, manifest); sinceCheckpoint = 0; } catch { /* retried at the end */ }
    }
  }

  // Always write the manifest, even on abort — what did land is what the next run should skip.
  try { await writeRemoteManifest(io, manifest); result.manifestWritten = true; }
  catch (e) { result.manifestWritten = false; result.manifestError = e.message; }

  result.elapsedMs = Date.now() - result.startedAt;
  return result;
}

/**
 * DOWNLOAD — pull what the manifest has and this catalogue lacks.
 *
 * IT WRITES NO ROWS. Files land in the catalogue; every row that names one of those basenames
 * resolves through the resolver tier without anything being written to the database. That is the
 * whole reason a restore can no longer broadcast this machine's paths: there is no row write left.
 */
async function downloadCatalogue(io, opts) {
  const {
    root, concurrency = 3,
    onProgress = () => {}, shouldAbort = () => false,
    pruneMissing = true,
  } = opts;

  try { fs.mkdirSync(root, { recursive: true }); } catch { /* surfaced by the first write */ }

  const { manifest, existed } = await readRemoteManifest(io);
  const remote = Object.entries(manifest.files || {}).map(([name, meta]) => ({ name, size: Number(meta && meta.size) || null }));

  const localByName = new Map(walkCatalogue(root).map(f => [f.name, f]));
  const missing = remote.filter(r => {
    const l = localByName.get(r.name);
    if (!l) return true;
    return r.size !== null && Number(l.size) !== r.size;   // present but a different file
  });

  const result = {
    root,
    manifestExisted: existed,
    remoteFiles: remote.length,
    alreadyLocal: remote.length - missing.length,
    toDownload: missing.length,
    downloaded: 0,
    downloadedBytes: 0,
    errors: 0,
    failures: [],
    aborted: false,
    rowsWritten: 0,          // stated explicitly, and it is always 0 — see the header
    startedAt: Date.now(),
  };

  let done = 0;

  const notInCloud = [];

  async function one(entry) {
    if (shouldAbort()) return;
    try {
      const body = await io.getObject(entry.name);
      if (!body) { notInCloud.push(entry.name); throw new Error('not found in the cloud'); }
      // Write to a temp name and rename, so an interrupted download never leaves a truncated file
      // in the catalogue that looks like the real one to the resolver.
      const finalPath = path.join(root, entry.name);
      const tmpPath = finalPath + '.part';
      fs.writeFileSync(tmpPath, body);
      fs.renameSync(tmpPath, finalPath);
      result.downloaded++;
      result.downloadedBytes += body.length;
    } catch (e) {
      result.errors++;
      if (result.failures.length < 200) result.failures.push({ name: entry.name, reason: e.message });
    }
    done++;
    onProgress({ phase: 'download', done, total: missing.length, errors: result.errors, current: entry.name });
  }

  for (let i = 0; i < missing.length; i += concurrency) {
    if (shouldAbort()) { result.aborted = true; break; }
    await Promise.all(missing.slice(i, i + concurrency).map(one));
  }

  // ── SELF-HEALING: A MANIFEST THAT CLAIMS A FILE THE CLOUD DOES NOT HAVE IS WORSE THAN NO CLAIM ──
  //
  // Measured on this machine, 2026-09-09: FIVE songs carried `r2_uploaded_at` SET and a `file_key`,
  // and the objects were simply not in the bucket. The old row-driven upload had recorded a success
  // that never landed — the same success-shaped-guard class already on the backlog.
  //
  // The seed trusts that marker, so those five got manifest entries, were skipped by every
  // subsequent upload, and the ONLY way anyone would ever find out is the restore failing on the day
  // it is needed. A backup that says it has your audio and does not is worse than one that admits it
  // does not.
  //
  // So a restore that finds an entry missing PRUNES it. The next upload sees no entry, re-sends the
  // file, and the hole closes itself. This is the only moment the truth is observable without a LIST
  // endpoint, so it is the moment to act on it.
  result.notInCloud = notInCloud;
  if (pruneMissing && notInCloud.length) {
    for (const name of notInCloud) delete manifest.files[name];
    try {
      await writeRemoteManifest(io, manifest);
      result.prunedFromManifest = notInCloud.length;
    } catch (e) {
      result.prunedFromManifest = 0;
      result.pruneError = e.message;
    }
  } else {
    result.prunedFromManifest = 0;
  }

  result.elapsedMs = Date.now() - result.startedAt;
  return result;
}

module.exports = {
  MANIFEST_KEY,
  MANIFEST_VERSION,
  walkCatalogue,
  needsUpload,
  emptyManifest,
  seedManifestFromRows,
  readRemoteManifest,
  writeRemoteManifest,
  uploadCatalogue,
  downloadCatalogue,
  contentTypeFor,
};

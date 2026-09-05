'use strict';
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE AUDIO LIBRARY ↔ R2 — the backup carries the FOLDER, not one table's rows
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// Jeff, 2026-09-04:
//   "Cloud backup of my library" means "my songs" — which is a narrower promise than the name makes.
//   Under the one-library rule that assumption is wrong by definition. Every audio file lives in one
//   folder; the backup should carry that folder's audio, not one table's rows.
//
// WHY FOLDER-DRIVEN AND NOT A WIDER QUERY. A wider query is blocked and would still not keep the
// promise:
//   • `announcements`, `spots`, `cart_slots`, `voice_tracks` and `published_episodes` have NEITHER
//     `file_key` (to name the object) NOR `r2_uploaded_at` (to resume) — a five-table migration.
//   • Even after it, files in the library that no row references stay invisible. On the dev machine
//     that is 1,113 of 1,878 files. The operator put them there; a backup that drops them is not a
//     backup of their library.
// The folder IS the library, so backing up the folder IS backing up the library. No table is
// privileged, and carts, spots, announcements, sweepers, voice tracks and episodes are all carried
// without this module knowing or caring what any of them are — the same principle as "type is
// metadata on the row, never a reason to store the file somewhere else."
//
// KEYSPACE IS UNCHANGED. Objects have always been keyed by BASENAME (`fileKey =
// path.basename(song.file_path)`), so a folder-driven upload lands in exactly the same place and an
// existing library does not need re-uploading wholesale.
//
// THE DOWNLOAD WRITES NO ROWS. That is deliberate and it is what removes a whole class of defect by
// construction: the previous per-song download wrote `file_path` through the SYNC-LOGGED writer, so
// every restore broadcast this machine's absolute paths to every peer — a fresh install pulling 510
// songs emitted 510 of them. With the resolver tier in place peers do not need our paths at all:
// they resolve by basename against their own library. No row write left means none to route wrongly.
//
// MANIFEST. The backend exposes /audio/upload-url, /audio/download-url and /audio/delete — there is
// no LIST. So the set of objects is described by a manifest stored as an ordinary object under the
// reserved key below, written after every upload and read before every download.

const fs = require('fs');
const path = require('path');
const { buildIndex } = require('./audio-library-index');

// Reserved key. Leading underscore so it can never collide with an audio basename.
const MANIFEST_KEY = '_audio-library-manifest.json';

/** Signed-URL helpers, injected so this module never owns credentials or the backend URL. */
function makeClient({ backendUrl, licenseKey, fetchImpl }) {
  const f = fetchImpl || fetch;
  return {
    async uploadUrl(fileKey) {
      const r = await f(`${backendUrl}/audio/upload-url`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: licenseKey, file_key: fileKey }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.signed_url) throw new Error(d.error || `upload-url HTTP ${r.status}`);
      return d.signed_url;
    },
    async downloadUrl(fileKey) {
      const r = await f(`${backendUrl}/audio/download-url`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: licenseKey, file_key: fileKey }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.signed_url) throw new Error(d.error || `download-url HTTP ${r.status}`);
      return d.signed_url;
    },
    async put(url, body, contentType) {
      const r = await f(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`R2 PUT failed: HTTP ${r.status} — ${t.slice(0, 200)}`);
      }
    },
    async getBuffer(url) {
      const r = await f(url);
      if (!r.ok) throw new Error(`R2 GET failed: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
  };
}

/** Every audio file in the library, as {basename -> {path, size}}. One walk, shared definition. */
function libraryFiles(libDir) {
  const idx = buildIndex(libDir);
  const out = new Map();
  for (const [base, p] of idx.byBasename) {
    let size = -1;
    try { size = fs.statSync(p).size; } catch { /* vanished mid-walk */ }
    if (size >= 0) out.set(base, { path: p, size });
  }
  return out;
}

/**
 * Upload every audio file in the library that R2 does not already have.
 *
 * Resume is by MANIFEST + SIZE, not by a row column — because most of these files have no row.
 * A file whose basename and size already appear in the manifest is skipped, which makes a re-run
 * cheap and makes an interrupted run resumable without any per-row bookkeeping.
 */
async function uploadLibrary(opts) {
  const { libDir, backendUrl, licenseKey, onProgress, shouldAbort, fetchImpl } = opts;
  const client = makeClient({ backendUrl, licenseKey, fetchImpl });

  const local = libraryFiles(libDir);
  if (!local.size) return { ok: false, error: `No audio files in ${libDir}` };

  // What is already up there. A missing/corrupt manifest is not fatal — it just means we re-upload,
  // which is wasteful but correct. Never let a bad manifest block a backup.
  let remote = {};
  try {
    const buf = await client.getBuffer(await client.downloadUrl(MANIFEST_KEY));
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed && parsed.files) remote = parsed.files;
  } catch { /* first run, or unreadable — treat as empty */ }

  const todo = [];
  for (const [base, info] of local) {
    const r = remote[base];
    if (r && Number(r.size) === info.size) continue;     // same name, same bytes — already up
    todo.push({ base, ...info });
  }

  let done = 0, uploaded = 0;
  const failures = [];
  const CONCURRENCY = 3;

  async function one(item) {
    if (shouldAbort && shouldAbort()) return;
    const MAX_TRIES = 3;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      try {
        const url = await client.uploadUrl(item.base);
        await client.put(url, fs.readFileSync(item.path), 'audio/mpeg');
        remote[item.base] = { size: item.size, at: new Date().toISOString() };
        uploaded++;
        return;
      } catch (e) {
        if (attempt === MAX_TRIES || (shouldAbort && shouldAbort())) {
          failures.push({ name: item.base, reason: e.message });
          return;
        }
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
  }

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    if (shouldAbort && shouldAbort()) break;
    await Promise.all(todo.slice(i, i + CONCURRENCY).map(async (it) => {
      await one(it);
      done++;
      if (onProgress) onProgress({ phase: 'upload', done, total: todo.length, errors: failures.length, current: it.base });
    }));
  }

  // Write the manifest LAST, describing what is actually up there. Written even on a partial run so
  // the next one resumes from reality rather than from an optimistic record.
  let manifestOk = true;
  try {
    const body = Buffer.from(JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), files: remote }, null, 0), 'utf8');
    await client.put(await client.uploadUrl(MANIFEST_KEY), body, 'application/json');
  } catch (e) {
    manifestOk = false;
    failures.push({ name: MANIFEST_KEY, reason: `manifest not written: ${e.message}` });
  }

  return {
    ok: true, libDir, localFiles: local.size, considered: todo.length,
    uploaded, skipped: local.size - todo.length, manifestOk,
    errors: failures.length, failures: failures.slice(0, 200),
  };
}

/**
 * Pull every file the manifest names that this machine does not have, straight into the library.
 *
 * WRITES NO ROWS. Rows resolve afterwards by basename through the resolver tier — which is why a
 * restored machine airs its announcements and carts without a single mutation being generated.
 */
async function downloadLibrary(opts) {
  const { libDir, backendUrl, licenseKey, onProgress, shouldAbort, fetchImpl } = opts;
  const client = makeClient({ backendUrl, licenseKey, fetchImpl });

  let manifest;
  try {
    const buf = await client.getBuffer(await client.downloadUrl(MANIFEST_KEY));
    manifest = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    // Honest and actionable: this is what an install sees when the other machine has never backed up.
    return { ok: false, error: `No audio library backup found in the cloud yet (${e.message}). Run the upload on the machine that has the audio.` };
  }
  const files = (manifest && manifest.files) || {};
  const names = Object.keys(files);
  if (!names.length) return { ok: false, error: 'The cloud audio manifest is empty.' };

  try { fs.mkdirSync(libDir, { recursive: true }); }
  catch (e) { return { ok: false, error: `Cannot open the audio library folder: ${e.message}` }; }

  const local = libraryFiles(libDir);
  const todo = names.filter((base) => {
    const have = local.get(base.toLowerCase());
    return !(have && Number(files[base].size) === have.size);
  });

  let done = 0, fetched = 0;
  const failures = [];
  const CONCURRENCY = 3;

  async function one(base) {
    if (shouldAbort && shouldAbort()) return;
    try {
      const buf = await client.getBuffer(await client.downloadUrl(base));
      const dest = path.join(libDir, base);
      const tmp = dest + '.part';
      fs.writeFileSync(tmp, buf);
      // Verify before it becomes a real library file. A short download that is never checked plays
      // for four seconds and stops, on air.
      const want = Number(files[base].size);
      const got = fs.statSync(tmp).size;
      if (Number.isFinite(want) && want > 0 && got !== want) {
        try { fs.unlinkSync(tmp); } catch {}
        throw new Error(`incomplete (${got} of ${want} bytes)`);
      }
      fs.renameSync(tmp, dest);
      fetched++;
    } catch (e) {
      failures.push({ name: base, reason: e.message });
    }
  }

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    if (shouldAbort && shouldAbort()) break;
    await Promise.all(todo.slice(i, i + CONCURRENCY).map(async (base) => {
      await one(base);
      done++;
      if (onProgress) onProgress({ phase: 'download', done, total: todo.length, errors: failures.length, current: base });
    }));
  }

  return {
    ok: true, libDir, inCloud: names.length, considered: todo.length,
    downloaded: fetched, alreadyLocal: names.length - todo.length,
    errors: failures.length, failures: failures.slice(0, 200),
  };
}

module.exports = { uploadLibrary, downloadLibrary, libraryFiles, MANIFEST_KEY };

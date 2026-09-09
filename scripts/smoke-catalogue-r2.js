// scripts/smoke-catalogue-r2.js
//
// THE CONTRACT: the cloud backup carries the CATALOGUE FOLDER, and a restore writes no rows.
//
// Runs the real electron/audio-library-r2.js against an in-memory R2 and a temp catalogue, so every
// assertion is about the shipped code and none of it needs a network, a license or a bucket.
//
// The three properties that matter, and why:
//   1. TYPE-BLIND — a cart, a sweeper, an announcement and a file no row references are all just
//      files. The old backup was `SELECT ... FROM songs`, which is how carts and spots were absent
//      from every restore.
//   2. RESUME — the manifest is the marker. `songs.r2_uploaded_at` cannot serve: five of the seven
//      audio tables have no such column, and an unreferenced file has no row at all.
//   3. THE DOWNLOAD WRITES NO ROWS. Not carefully — none. That is what makes a restore structurally
//      incapable of broadcasting this machine's paths to its peers.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const R2 = require("../electron/audio-library-r2");

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const eq = (name, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(`${name} → ${JSON.stringify(actual)}`);
  else fail(`${name}\n          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`);
};

// ── an in-memory R2 ────────────────────────────────────────────────────────────────────────────
function makeIO(opts = {}) {
  const store = new Map();
  let puts = 0, gets = 0;
  return {
    store, stats: () => ({ puts, gets, keys: [...store.keys()] }),
    async putObject(key, body) {
      puts++;
      if (opts.failOn && opts.failOn(key, puts)) throw new Error("simulated R2 failure");
      store.set(key, Buffer.from(body));
    },
    async getObject(key) { gets++; return store.has(key) ? store.get(key) : null; },
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-r2-"));
const cat = path.join(tmp, "catalogue");
fs.mkdirSync(cat, { recursive: true });

// A catalogue holding one of everything — deliberately NOT all songs.
const FILES = {
  "song-one.mp3":        "aaaaaaaaaa",           // a library song
  "cart-growl.mp3":      "bbbb",                 // a cart — absent from every row-driven backup
  "sweeper-id.wav":      "cccccc",               // a sweeper
  "announce-park.mp3":   "dddddddd",             // an announcement
  "spot-promo.mp3":      "ee",                   // a spot
  "orphan-nobody.mp3":   "ffffffffffff",         // NO ROW REFERENCES THIS — ruling 2 says upload it
};
for (const [n, body] of Object.entries(FILES)) fs.writeFileSync(path.join(cat, n), body);
fs.writeFileSync(path.join(cat, "notes.txt"), "not audio");        // must be ignored
fs.mkdirSync(path.join(cat, "subfolder"), { recursive: true });
fs.writeFileSync(path.join(cat, "subfolder", "nested.mp3"), "xx"); // must NOT be walked

// A `db` stub — only seedManifestFromRows touches it.
const fakeDb = (rows) => ({ prepare: () => ({ all: () => rows }) });

(async () => {
  console.log("\n== 1. the walk is the catalogue, flat, audio only ==");
  {
    const files = R2.walkCatalogue(cat);
    eq("  file count", files.length, 6);
    const names = files.map(f => f.name).sort();
    if (names.includes("notes.txt")) fail("  a non-audio file was walked");
    else pass("  notes.txt ignored (not audio)");
    if (names.includes("nested.mp3")) fail("  a file in a SUBFOLDER was walked — two basenames would collide on one key");
    else pass("  subfolder/nested.mp3 not walked (the catalogue is flat by rule)");
  }

  console.log("\n== 2. upload is TYPE-BLIND — carts, sweepers, spots and orphans all go ==");
  {
    const io = makeIO();
    const r = await R2.uploadCatalogue(io, { root: cat, db: fakeDb([]) });
    eq("  uploaded", r.uploaded, 6);
    eq("  errors", r.errors, 0);
    const keys = io.stats().keys;
    for (const n of Object.keys(FILES)) {
      if (keys.includes(n)) pass(`  ${n} is in the cloud`);
      else fail(`  ${n} is NOT in the cloud — this is the songs-only defect`);
    }
    if (keys.includes(R2.MANIFEST_KEY)) pass("  the manifest was written");
    else fail("  no manifest — nothing can resume");
  }

  console.log("\n== 3. the manifest is the resume marker — a second run uploads nothing ==");
  {
    const io = makeIO();
    await R2.uploadCatalogue(io, { root: cat, db: fakeDb([]) });
    const before = io.stats().puts;
    const r2 = await R2.uploadCatalogue(io, { root: cat, db: fakeDb([]) });
    eq("  second run: toUpload", r2.toUpload, 0);
    eq("  second run: uploaded", r2.uploaded, 0);
    eq("  second run: alreadyUp", r2.alreadyUp, 6);
    // One PUT for the manifest itself; no audio re-sent.
    eq("  second run: extra PUTs (manifest only)", io.stats().puts - before, 1);
  }

  console.log("\n== 4. a CHANGED file is re-uploaded; an unchanged one is not ==");
  {
    const io = makeIO();
    await R2.uploadCatalogue(io, { root: cat, db: fakeDb([]) });
    fs.writeFileSync(path.join(cat, "cart-growl.mp3"), "bbbbbbbbbbbbbbbb");  // different SIZE
    const r = await R2.uploadCatalogue(io, { root: cat, db: fakeDb([]) });
    eq("  re-uploaded exactly the changed file", r.uploaded, 1);
    eq("  and nothing else", r.toUpload, 1);
    fs.writeFileSync(path.join(cat, "cart-growl.mp3"), FILES["cart-growl.mp3"]);  // restore
  }

  console.log("\n== 5. first run SEEDS from what the old row-driven upload already sent ==");
  {
    // Without this, the first folder-driven run re-uploads a catalogue that is already in the bucket.
    const io = makeIO();
    const rows = [{ file_key: "song-one.mp3", file_path: path.join(cat, "song-one.mp3") }];
    const r = await R2.uploadCatalogue(io, { root: cat, db: fakeDb(rows) });
    eq("  seeded from rows", r.seededFromRows, 1);
    eq("  so it uploads the other five only", r.uploaded, 5);
    if (!io.stats().keys.includes("song-one.mp3")) pass("  the already-uploaded song was not re-sent");
    else fail("  the already-uploaded song was re-sent");
  }

  console.log("\n== 6. RESTORE on a machine missing files — and it writes NO rows ==");
  {
    const io = makeIO();
    await R2.uploadCatalogue(io, { root: cat, db: fakeDb([]) });

    // A second machine: empty catalogue, same cloud.
    const cat2 = path.join(tmp, "catalogue-machine-2");
    const r = await R2.downloadCatalogue(io, { root: cat2 });
    eq("  toDownload", r.toDownload, 6);
    eq("  downloaded", r.downloaded, 6);
    eq("  errors", r.errors, 0);
    eq("  rowsWritten", r.rowsWritten, 0);

    const landed = R2.walkCatalogue(cat2).map(f => f.name).sort();
    eq("  every file landed, by basename", landed, Object.keys(FILES).sort());
    for (const [n, body] of Object.entries(FILES)) {
      const got = fs.readFileSync(path.join(cat2, n), "utf8");
      if (got !== body) { fail(`  ${n} content differs after restore`); break; }
    }
    pass("  contents match byte for byte");

    // No .part left behind — an interrupted write must never look like a real file to the resolver.
    if (fs.readdirSync(cat2).some(n => n.endsWith(".part"))) fail("  a .part temp file was left in the catalogue");
    else pass("  no .part files left behind");

    // Re-running is a no-op: the second machine now has everything.
    const again = await R2.downloadCatalogue(io, { root: cat2 });
    eq("  re-run downloads nothing", again.toDownload, 0);
  }

  console.log("\n== 7. a PARTIAL restore pulls only what is missing ==");
  {
    const io = makeIO();
    await R2.uploadCatalogue(io, { root: cat, db: fakeDb([]) });
    const cat3 = path.join(tmp, "catalogue-machine-3");
    fs.mkdirSync(cat3, { recursive: true });
    // This machine already has two of the six.
    fs.writeFileSync(path.join(cat3, "song-one.mp3"), FILES["song-one.mp3"]);
    fs.writeFileSync(path.join(cat3, "cart-growl.mp3"), FILES["cart-growl.mp3"]);
    const r = await R2.downloadCatalogue(io, { root: cat3 });
    eq("  alreadyLocal", r.alreadyLocal, 2);
    eq("  toDownload", r.toDownload, 4);
    eq("  downloaded", r.downloaded, 4);
  }

  console.log("\n== 8. an interrupted upload resumes instead of starting over ==");
  {
    // Fail every audio PUT after the third, then run again with a healthy connection.
    let audioPuts = 0;
    const io = makeIO({
      failOn: (key) => {
        if (key === R2.MANIFEST_KEY) return false;
        audioPuts++;
        return audioPuts > 3;
      },
    });
    const first = await R2.uploadCatalogue(io, { root: cat, db: fakeDb([]), concurrency: 1 });
    if (first.uploaded > 0 && first.errors > 0) pass(`  partial run: ${first.uploaded} up, ${first.errors} failed`);
    else fail(`  expected a partial run, got uploaded=${first.uploaded} errors=${first.errors}`);
    if (first.manifestWritten) pass("  the manifest was written despite the failures");
    else fail("  no manifest after a partial run — the next run would start from zero");

    const io2 = makeIO();
    io2.store.set(R2.MANIFEST_KEY, io.store.get(R2.MANIFEST_KEY));
    for (const k of io.store.keys()) if (k !== R2.MANIFEST_KEY) io2.store.set(k, io.store.get(k));
    const second = await R2.uploadCatalogue(io2, { root: cat, db: fakeDb([]) });
    eq("  the resumed run uploads only the remainder", second.uploaded, 6 - first.uploaded);
  }

  console.log("\n== 9. the SEED collapses case-variant duplicate file_keys ==");
  {
    // MEASURED ON THE REAL MACHINE, 2026-09-09: `songs` holds two rows for one file whose file_keys
    // differ only in case — "Deck The Halls…" (id 699) and "Deck the Halls…" (id 1050). R2 keys are
    // case-SENSITIVE and NTFS is not, so the old row-driven upload sent that audio twice, and seeding
    // straight from file_key made two manifest entries for one local file. On restore both landed on
    // the same filename and one overwrote the other, leaving a name whose case did not match the row.
    const rows = [
      { file_key: "song-one.mp3", file_path: path.join(cat, "song-one.mp3") },
      { file_key: "SONG-ONE.mp3", file_path: path.join(cat, "SONG-ONE.mp3") },   // the duplicate row
    ];
    const { manifest, seeded } = R2.seedManifestFromRows(fakeDb(rows), cat);
    eq("  seeded entries for one file", seeded, 1);
    eq("  manifest keys", Object.keys(manifest.files), ["song-one.mp3"]);
    if (Object.keys(manifest.files)[0] === "song-one.mp3") pass("  seeded under the REAL on-disk name, not the row's casing");
    else fail("  seeded under the row's casing — R2 keys are case-sensitive and this splits one file in two");
  }

  console.log("\n== 10. a restore PRUNES manifest entries the cloud does not actually have ==");
  {
    // MEASURED, 2026-09-09: five songs had `r2_uploaded_at` SET and a `file_key`, and the objects were
    // not in the bucket — the old upload recorded a success that never landed. The seed trusts that
    // marker, so those files were skipped by every later upload and the only way to find out was a
    // failed restore. A backup that claims a file it does not have is worse than one that admits it.
    const io = makeIO();
    await R2.uploadCatalogue(io, { root: cat, db: fakeDb([]) });

    // The cloud loses one object, but the manifest still claims it — exactly the measured state.
    io.store.delete("cart-growl.mp3");

    const cat5 = path.join(tmp, "catalogue-machine-5");
    const r = await R2.downloadCatalogue(io, { root: cat5 });
    eq("  reported as not in the cloud", r.notInCloud, ["cart-growl.mp3"]);
    eq("  pruned from the manifest", r.prunedFromManifest, 1);

    const after = await R2.readRemoteManifest(io);
    if (!after.manifest.files["cart-growl.mp3"]) pass("  the false claim is gone from the manifest");
    else fail("  the manifest still claims a file the cloud does not have");

    // THE HOLE CLOSES ITSELF: the next upload sees no entry and re-sends it.
    const r2 = await R2.uploadCatalogue(io, { root: cat, db: fakeDb([]) });
    eq("  the next upload re-sends exactly that file", r2.uploaded, 1);
    if (io.store.has("cart-growl.mp3")) pass("  it is back in the cloud");
    else fail("  it was not re-uploaded — the backup hole is permanent");
  }

  console.log("\n== 11. a missing manifest is a first run, not an error ==");
  {
    const io = makeIO();
    const r = await R2.downloadCatalogue(io, { root: path.join(tmp, "catalogue-machine-4") });
    eq("  manifestExisted", r.manifestExisted, false);
    eq("  toDownload", r.toDownload, 0);
    eq("  errors", r.errors, 0);
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }

  console.log(failures === 0
    ? "\nVERDICT: PASS — the backup is the catalogue folder, and a restore writes no rows.\n"
    : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
})();

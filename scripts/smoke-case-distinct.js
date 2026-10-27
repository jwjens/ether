// scripts/smoke-case-distinct.js
//
// THE CONTRACT: two cloud names that differ only in case are two files on every machine, and the catalogue pull settles.
//
// Jeff, 2026-10-23: "file names that differ only in capitalization ("Deck The Halls" / "Deck the Halls") must be treated as
// distinct files on Windows, so the pull settles." Measured that day: every 5 minutes a license-24 machine re-fetched three
// such pairs, because NTFS holds one spelling and the pull matched by exact name (docs/halloveen-join-61-file-errors-2026-10-23.md).
//
// Runs the real electron/audio-library-r2.js and electron/audio-library-index.js against an in-memory R2 and a temp
// folder. The two spellings carry DIFFERENT bytes here, so every check proves they stayed separate files. On a
// case-insensitive disk (NTFS, APFS) this is the real situation; on a case-sensitive one the same naming applies.
//
// Run: npm run test:case-distinct
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const R2 = require("../electron/audio-library-r2");
const IDX = require("../electron/audio-library-index");

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const eq = (name, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(`${name} → ${JSON.stringify(actual)}`);
  else fail(`${name}\n          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`);
};

function makeIO() {
  const store = new Map();
  let gets = 0;
  return {
    store, gets: () => gets,
    async putObject(key, body) { store.set(key, Buffer.from(body)); },
    async getObject(key) { gets++; return store.has(key) ? store.get(key) : null; },
  };
}

const UPPER = "Deck The Halls_spotdown.org.mp3";
const LOWER = "Deck the Halls_spotdown.org.mp3";
const BYTES = { [UPPER]: "upper-spelling-audio", [LOWER]: "lower-spelling-audio!" };   // different sizes too

async function cloudWithBoth() {
  const io = makeIO();
  for (const [k, v] of Object.entries(BYTES)) io.store.set(k, Buffer.from(v));
  io.store.set("Other Song.mp3", Buffer.from("other"));
  const files = {};
  for (const k of [UPPER, LOWER, "Other Song.mp3"]) files[k] = { size: io.store.get(k).length, mtime: null };
  await R2.writeRemoteManifest(io, { version: R2.MANIFEST_VERSION, updated_at: null, files });
  return io;
}

const readIn = (dir, cloudName) => {
  const hit = IDX.findInIndex(IDX.buildIndex(dir), path.join(dir, cloudName));
  return hit ? fs.readFileSync(hit, "utf8") : null;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-case-"));
const caseInsensitive = (() => {
  const p = path.join(tmp, "Probe.txt"); fs.writeFileSync(p, "x");
  const r = fs.existsSync(path.join(tmp, "probe.txt")); fs.unlinkSync(p); return r;
})();

(async () => {
  console.log(`\n(this disk is case-${caseInsensitive ? "INSENSITIVE — the real Windows case" : "sensitive"})`);

  console.log("\n== 1. the case-alt name is stable and only ever means the name it was made from ==");
  {
    const alt = IDX.caseAltName(LOWER);
    if (/^Deck the Halls_spotdown\.org~c[0-9a-f]{8}\.mp3$/.test(alt)) pass(`  ${LOWER} → ${alt}`);
    else fail(`  unexpected alt name ${alt}`);
    eq("  same name, same alt (every machine agrees)", IDX.caseAltName(LOWER), alt);
    if (IDX.caseAltName(UPPER) !== alt) pass("  the other spelling gets a different alt");
    else fail("  both spellings got the same alt name");
    eq("  caseKeyOf recovers the cloud name", IDX.caseKeyOf(alt), LOWER);
    eq("  a real title that merely looks like an alt is left alone", IDX.caseKeyOf("Mix~cdeadbeef.mp3"), "Mix~cdeadbeef.mp3");
    eq("  a plain name is its own cloud name", IDX.caseKeyOf(UPPER), UPPER);
  }

  console.log("\n== 2. a fresh machine: both spellings land as two files, and the pull settles ==");
  {
    const io = await cloudWithBoth();
    const dir = path.join(tmp, "fresh");
    const first = await R2.downloadCatalogue(io, { root: dir });
    eq("  first pull downloads all three", first.downloaded, 3);
    eq("  no errors", first.errors, 0);
    eq("  three files on disk", fs.readdirSync(dir).length, 3);
    eq(`  ${UPPER} plays its own bytes`, readIn(dir, UPPER), BYTES[UPPER]);
    eq(`  ${LOWER} plays its own bytes`, readIn(dir, LOWER), BYTES[LOWER]);
    for (let tick = 2; tick <= 3; tick++) {
      const again = await R2.downloadCatalogue(io, { root: dir, pruneMissing: false });
      eq(`  pull ${tick}: nothing to download (settled)`, again.toDownload, 0);
    }
    eq(`  ${UPPER} still has its own bytes`, readIn(dir, UPPER), BYTES[UPPER]);
    eq(`  ${LOWER} still has its own bytes`, readIn(dir, LOWER), BYTES[LOWER]);
  }

  console.log("\n== 3. a machine that already holds one spelling (today's catalogues): the other lands beside it ==");
  {
    const io = await cloudWithBoth();
    const dir = path.join(tmp, "existing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LOWER), BYTES[LOWER]);
    fs.writeFileSync(path.join(dir, "Other Song.mp3"), "other");
    const r = await R2.downloadCatalogue(io, { root: dir });
    eq("  only the missing spelling is downloaded", r.downloaded, 1);
    if (fs.existsSync(path.join(dir, IDX.caseAltName(UPPER)))) pass("  it went to its case-alt name");
    else fail("  it did not go to its case-alt name");
    eq("  the spelling already here is untouched", fs.readFileSync(path.join(dir, LOWER), "utf8"), BYTES[LOWER]);
    eq(`  ${UPPER} resolves to its own bytes`, readIn(dir, UPPER), BYTES[UPPER]);
    eq(`  ${LOWER} resolves to its own bytes`, readIn(dir, LOWER), BYTES[LOWER]);
    const again = await R2.downloadCatalogue(io, { root: dir, pruneMissing: false });
    eq("  next pull: settled", again.toDownload, 0);

    console.log("\n== 4. upload: the case-alt file is the cloud name it stands for, never a new key ==");
    const walked = R2.walkCatalogue(dir).map(f => f.name).sort();
    eq("  the walk reports cloud names", walked, [UPPER, LOWER, "Other Song.mp3"].sort());
    const keysBefore = [...io.store.keys()].sort();
    const up = await R2.uploadCatalogue(io, { root: dir, db: { prepare: () => ({ all: () => [] }) } });
    eq("  nothing to upload", up.toUpload, 0);
    eq("  no new key appeared in the cloud", [...io.store.keys()].sort(), keysBefore);
  }

  console.log("\n== 5. the resolvers: a different-case file is not this file ==");
  {
    const dir = path.join(tmp, "existing");
    const idx = IDX.buildIndex(dir);
    const plainHolder = fs.readdirSync(dir).find(n => n.toLowerCase() === LOWER.toLowerCase());
    const other = plainHolder === LOWER ? UPPER : LOWER;
    eq("  caseShadowed: the spelling NOT on disk under its own name", IDX.caseShadowed(idx, path.join(dir, other)), true);
    eq("  caseShadowed: the spelling that is", IDX.caseShadowed(idx, path.join(dir, plainHolder)), false);
    eq("  caseShadowed: an unrelated file", IDX.caseShadowed(idx, path.join(dir, "Other Song.mp3")), false);
    eq("  caseShadowed: a path outside the library", IDX.caseShadowed(idx, path.join(tmp, "elsewhere", other)), false);
    eq("  existsExactCase: own name", IDX.existsExactCase(path.join(dir, plainHolder)), true);
    eq("  existsExactCase: the other spelling", IDX.existsExactCase(path.join(dir, other)), false);
    // fetchR2Track and the prefetch ask libraryPathFor where a fetched file goes and whether it is already here.
    const lp = IDX.libraryPathFor(dir, other);
    eq("  libraryPathFor: the other spelling is present at its alt", [path.basename(lp.path), lp.present], [IDX.caseAltName(other), true]);
    const lp2 = IDX.libraryPathFor(path.join(tmp, "fresh-fetch"), other);
    eq("  libraryPathFor: in an empty folder, the plain name, to write", [path.basename(lp2.path), lp2.present], [other, false]);

    const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8");
    const engine = fs.readFileSync(path.join(__dirname, "..", "audiod", "engine.js"), "utf8");
    const health = fs.readFileSync(path.join(__dirname, "..", "electron", "library-health.js"), "utf8");
    // (2026-10-26, electron/catalogue.js) A row plays exactly its stored file, checked case-exact (existsExactCase).
    const cat = fs.readFileSync(path.join(__dirname, "..", "electron", "catalogue.js"), "utf8");
    if (/Cat\.playableFile\(filePath\)/.test(main) && /existsExactCase\(String\(storedPath\)\)/.test(cat)) pass("  main.js resolveLocalAudioPath: the stored file, case-exact (catalogue.js playableFile)");
    else fail("  main.js resolveLocalAudioPath fast path is case-blind");
    if (/libraryPathFor\(getMusicDir\(\), safeName\)/.test(main) && /if \(target\.present\) return/.test(main)) pass("  main.js fetchR2Track: case-exact cache hit and target");
    else fail("  main.js fetchR2Track is case-blind");
    if (/require\('\.\.\/electron\/catalogue'\)\.playableFile\(fp\)/.test(engine)) pass("  daemon engine._resolveLocal: the stored file, case-exact (catalogue.js playableFile)");
    else fail("  daemon engine._resolveLocal fast path is case-blind");
    if (/existsExactCase\(r\.gfp\) \|\| existsExactCase\(r\.sfp\)/.test(health) && /libraryPathFor\(path\.dirname\(t\.path\)/.test(health)) pass("  library-health prefetch: case-exact");
    else fail("  library-health prefetch is case-blind");
  }

  console.log("\n== 6. both spellings absent and fetched in the same batch: one plain, one alt, never the same file ==");
  {
    const io = makeIO();
    io.store.set(UPPER, Buffer.from(BYTES[UPPER])); io.store.set(LOWER, Buffer.from(BYTES[LOWER]));
    await R2.writeRemoteManifest(io, { version: 1, updated_at: null, files: {
      [LOWER]: { size: BYTES[LOWER].length }, [UPPER]: { size: BYTES[UPPER].length } } });
    const dir = path.join(tmp, "race");
    const r = await R2.downloadCatalogue(io, { root: dir, concurrency: 3 });
    eq("  both downloaded", r.downloaded, 2);
    eq("  two files on disk", fs.readdirSync(dir).length, 2);
    // Code-point order: "Deck The" < "Deck the", so the upper spelling takes the plain name.
    eq("  the plain name went to the first in code-point order", fs.existsSync(path.join(dir, UPPER)) && fs.readFileSync(path.join(dir, UPPER), "utf8"), BYTES[UPPER]);
    eq("  the other is at its alt", fs.readFileSync(path.join(dir, IDX.caseAltName(LOWER)), "utf8"), BYTES[LOWER]);
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  console.log(failures === 0
    ? "\nVERDICT: PASS — names that differ only in case are separate files, and the pull settles.\n"
    : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
})();

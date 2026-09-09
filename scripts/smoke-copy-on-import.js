// scripts/smoke-copy-on-import.js
//
// THE CONTRACT: every door that puts an operator-chosen file into a row goes through
// copy-on-import. No exceptions, no surface that quietly points at wherever the file happened to be.
//
// WHY THIS EXISTS. The audio-library rule is "every audio file that enters Ether is copied into the
// catalogue on import; that is the first and only place audio files live." Copy-on-import was added
// to the file-PICKER paths on 2026-09-04 — and the DRAG-AND-DROP paths were missed. Dropping a file
// onto a cart tile wrote whatever path the drag carried straight into `cart_slots`, which is a
// SYNCED table: the path travelled to every peer, and a peer without that exact directory got a cart
// that could not open its own audio. That is the OV incident's shape, reproduced by a door nobody
// had checked.
//
// A door that writes a browsed path is not a small bug. It is the SUPPLY of foreign paths, and every
// downstream repair — the resolver tier, the basename fallback, the health classifier's `foreign`
// count, the cart carve-out — exists to cope with rows this class of door produced.
//
// Static, deliberately: it runs in CI on a tree with no Electron, no engine and no audio.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

// Every file that both receives dropped/browsed paths AND writes rows. Adding a new import surface
// means adding it here — that is the point.
const DOORS = [
  "src/components/DeckConfigurator.tsx",
  "src/App.tsx",
  "src/components/Announcements.tsx",
  "src/components/Spots.tsx",
  "src/components/ImportDialog.tsx",
  "src/components/TrackEditor.tsx",
  "src/components/GSelectorImport.tsx",
  "src/components/PublishEpisode.tsx",
];

console.log("\n== 1. every drop handler that stores a path routes it through copy-on-import ==");
{
  // A drop handler reads the path out of dataTransfer. If the same handler then stores it, the
  // import call has to appear between the two — otherwise the browsed path IS the stored path.
  for (const f of DOORS) {
    let src;
    try { src = read(f); } catch { fail(`${f} is missing — this test is stale`); continue; }
    if (!/dataTransfer\.getData/.test(src)) continue;

    // Each onDrop / handleDrop body, roughly: from the getData call to the end of that handler.
    const bodies = src.split(/onDrop\s*=|const handleDrop\s*=/).slice(1);
    let idx = 0;
    for (const body of bodies) {
      idx++;
      const chunk = body.slice(0, 1400);
      if (!/dataTransfer\.getData/.test(chunk)) continue;

      // Does this handler STORE a path at all? Some drops reorder or carry non-file payloads.
      const stores = /filePath:\s*(?!undefined)/.test(chunk) || /file_path:\s*(?!null)/.test(chunk);
      if (!stores) { pass(`${f} drop #${idx} carries no stored path (nothing to import)`); continue; }

      if (/importIntoAudioLibrary\s*\(/.test(chunk)) {
        pass(`${f} drop #${idx} copies into the catalogue before storing`);
      } else {
        fail(`${f} drop #${idx} STORES A DROPPED PATH WITHOUT COPY-ON-IMPORT — this is the cart-in-Downloads defect`);
      }
    }
  }
}

console.log("\n== 2. the cart assign paths specifically ==");
{
  // Both cart walls, both gestures. cart_slots is synced, so this table is the one that punishes a
  // foreign path hardest.
  const dc  = read("src/components/DeckConfigurator.tsx");
  const app = read("src/App.tsx");

  const assign = dc.split("const assignCart")[1] || "";
  if (/importIntoAudioLibrary/.test(assign.slice(0, 900))) pass("BoutiqueCartWall assignCart (picker) copies on import");
  else fail("BoutiqueCartWall assignCart does not copy on import");

  const drop = dc.split("const handleDrop")[1] || "";
  if (/importIntoAudioLibrary/.test(drop.slice(0, 1400))) pass("BoutiqueCartWall handleDrop (drag) copies on import");
  else fail("BoutiqueCartWall handleDrop does not copy on import");

  const appAssign = app.split("const assignCart")[1] || "";
  if (/importIntoAudioLibrary/.test(appAssign.slice(0, 900))) pass("CartWallPanel assignCart (picker) copies on import");
  else fail("CartWallPanel assignCart does not copy on import");
}

console.log("\n== 3. generated audio is written INTO the catalogue, not beside it ==");
{
  // A file Ether creates is still an audio file, and the rule does not exempt it. BroadcastEditor
  // gets this right (audioLibraryDir()); these two write into the profile directory instead, so the
  // row they create points outside the catalogue by construction. Neither has ever run on this dev
  // machine — no such folders exist — so they have produced no bad rows here yet.
  const KNOWN_OUTSIDE = [
    ["src/components/VoiceTracker.tsx", "voice-tracks/", "writeTakeFile"],
    ["src/audio/imagingCommit.ts", "imaging/", "renderRegionToDisk"],
  ];
  for (const [f, marker, fn] of KNOWN_OUTSIDE) {
    let src;
    try { src = read(f); } catch { continue; }
    const usesProfileDir = new RegExp(`getAppDataDir[\\s\\S]{0,200}?${marker.replace("/", "\\/")}`).test(src);
    if (usesProfileDir) {
      // Reported, not failed: moving these is a decision Jeff has not made yet (the imaging path
      // organises by reel subfolder, which a flat catalogue would collapse). Recorded here so it
      // cannot be forgotten, and so the day it is fixed this check flips to a PASS on its own.
      console.log(`  NOTE  ${f} · ${fn}() writes generated audio to <profile>/${marker} — outside the catalogue (open decision)`);
    } else {
      pass(`${f} · ${fn}() no longer writes outside the catalogue`);
    }
  }
}

console.log(failures === 0
  ? "\nVERDICT: PASS — no door stores an operator-chosen path without copying it into the catalogue.\n"
  : `\nVERDICT: FAIL — ${failures} door(s) store a path without copy-on-import.\n`);
process.exit(failures === 0 ? 0 : 1);

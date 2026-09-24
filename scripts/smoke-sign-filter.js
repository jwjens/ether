'use strict';

// scripts/smoke-sign-filter.js — the Windows code-signing file filter, checked the way
// electron-builder will actually apply it.
//
// WHY THIS EXISTS: the v4.6.47 tag build reached the signed Windows publish (build.yml:249) for the
// first time and died there —
//
//   SignTool Error: This file format cannot be signed because it is not recognized.
//   ...\app.asar.unpacked\node_modules\onnxruntime-node\bin\napi-v3\linux\x64\onnxruntime_binding.node
//
// — because `signExts: [".node", ".dll"]` selected onnxruntime-node's Linux and macOS prebuilds,
// which ship inside the Windows package. Authenticode cannot sign an ELF or a Mach-O. Nothing was
// wrong with the signing secrets; Azure Trusted Signing had already authenticated.
//
// The failure only appears on a tag build with real credentials, which is the most expensive place
// to find it, so the policy is asserted here instead. Run:  node scripts/smoke-sign-filter.js
//
// SELECTION IS NOT GLOB MATCHING. shouldSignFile below is transcribed from
// node_modules/app-builder-lib/out/winPackager.js:197-214 — a plain endsWith() suffix compare that
// tests every POSITIVE pattern before any negative '!' one. That ordering is the whole reason a
// blanket ".node" cannot be narrowed by "!linux/x64/...": the positive matches first and wins.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const ebConfig = require(path.join(ROOT, 'electron-builder.json'));
const signExts = ebConfig.win.signExts;

// electron-builder VALIDATES its config against a strict schema and rejects unknown properties
// outright (app-builder-lib/src/util/config/config.ts:239). JSON has no comments, so a "_why" key
// explaining signExts is not a comment — it is a build-breaking config error, and on a tag the build
// that finds it is the RELEASE build. That is exactly what happened: a '_signExts_why' array added
// beside the fix below failed electron-builder at configuration load, before one file was packaged.
// The rationale therefore lives in THIS file, and the config stays machine-clean.
const WIN_KEYS_26_8_1 = new Set([
  'appId', 'artifactName', 'asar', 'asarUnpack', 'azureSignOptions', 'compression', 'cscKeyPassword',
  'cscLink', 'defaultArch', 'detectUpdateChannel', 'disableDefaultIgnoredFiles', 'electronLanguages',
  'electronUpdaterCompatibility', 'executableName', 'extraFiles', 'extraResources', 'fileAssociations',
  'files', 'forceCodeSigning', 'generateUpdatesFilesForAllChannels', 'icon', 'legalTrademarks',
  'protocols', 'publish', 'releaseInfo', 'requestedExecutionLevel', 'signAndEditExecutable',
  'signExts', 'signtoolOptions', 'target', 'verifyUpdateCodeSignature',
]);

/** VERBATIM from app-builder-lib/out/winPackager.js:197-214. Do not "improve" it — its value is that
 *  it is the shipped algorithm, including the positive-before-negative ordering. */
function shouldSignFile(file, fallbackValue = false) {
  const backwardCompatibility = file.endsWith('.exe');
  if (!signExts?.length) return backwardCompatibility || fallbackValue;
  if (signExts.some(ext => file.endsWith(ext))) return true;
  if (signExts.some(ext => ext.startsWith('!') && file.endsWith(ext.substring(1)))) return false;
  return backwardCompatibility || fallbackValue;
}

// signApp() collects files under resources/app.asar.unpacked with walk(..., shouldSignFile(file)) —
// winPackager.js:248, i.e. fallbackValue = FALSE. Anything matching no pattern is never offered to
// signtool at all. That is the default this policy leans on.
const selected = f => shouldSignFile(f, false);

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}` + (cond ? '' : `  — ${detail || ''}`));
  cond ? pass++ : fail++;
};

// ── Which files are Windows PE, decided by PATH, the way the packager sees them ────────────────
// Native prebuild trees name their platform in the path. Anything under a linux*/darwin dir, or
// carrying a linux*/darwin- prebuild basename, is not a PE file.
const NON_WINDOWS = /([\\/]|^|-)(linux|linuxmusl|darwin)([\\/]|-)/i;

// ── The fixture: every signable path the 4.6.47 Windows package actually contained ─────────────
// Captured from dist-electron/win-unpacked so the check still runs on a machine with no build.
const FIXTURE = [
  'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll',
  'vk_swiftshader.dll', 'vulkan-1.dll', 'Ether.exe',
  'resources/native/ether-audio.node',
  'resources/app.asar.unpacked/native/ether-audio.node',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-arm64.node',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-x64.node',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-arm64.node',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linuxmusl-arm64.node',
  'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll',
  'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_providers_shared.dll',
  'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node',
  'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/win32/arm64/onnxruntime.dll',
  'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/win32/arm64/onnxruntime_providers_shared.dll',
  'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/win32/arm64/onnxruntime_binding.node',
  'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node',   // the v4.6.47 killer
  'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/linux/arm64/onnxruntime_binding.node',
  'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/darwin/x64/onnxruntime_binding.node',
  'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node',
  'resources/app.asar.unpacked/node_modules/sharp/build/Release/sharp-win32-x64.node',
  'resources/app.asar.unpacked/node_modules/sharp/build/Release/libvips-42.dll',
  'resources/app.asar.unpacked/node_modules/sharp/vendor/8.14.5/win32-x64/lib/libglib-2.0-0.dll',
];

// The packager hands native paths, so the policy must hold for BOTH separator spellings.
function auditList(files, label) {
  const signed = [], skipped = [];
  for (const f of files) (selected(f) ? signed : skipped).push(f);

  const wrongly = signed.filter(f => NON_WINDOWS.test(f));
  check(`${label} · no non-Windows binary is offered to signtool`, wrongly.length === 0,
    wrongly.join('\n      '));

  const missed = skipped.filter(f => !NON_WINDOWS.test(f) && /\.(node|dll|exe)$/i.test(f));
  check(`${label} · every Windows binary is still signed`, missed.length === 0,
    missed.join('\n      '));

  return { signed, skipped };
}

console.log('=== signExts policy (electron-builder.json → win.signExts) ===\n');
// Checked FIRST: if the config will not load, nothing below it matters.
{
  const unknown = Object.keys(ebConfig.win).filter(k => !WIN_KEYS_26_8_1.has(k));
  check('electron-builder.json win carries no key the schema will reject (JSON has no comments)',
    unknown.length === 0, unknown.join(', '));
  const pseudo = [];
  for (const [section, obj] of Object.entries(ebConfig)) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const k of Object.keys(obj)) if (k.startsWith('_')) pseudo.push(`${section}.${k}`);
  }
  check('no underscore-prefixed pseudo-comment anywhere in electron-builder.json',
    pseudo.length === 0, pseudo.join(', '));
}

const posix = auditList(FIXTURE, 'fixture, posix separators');
auditList(FIXTURE.map(f => f.replace(/\//g, '\\')), 'fixture, native separators');

// The specific regression, named so a future edit cannot quietly undo it.
check('the exact file that failed the v4.6.47 tag build is NOT signed',
  !selected('resources\\app.asar.unpacked\\node_modules\\onnxruntime-node\\bin\\napi-v3\\linux\\x64\\onnxruntime_binding.node'));
check('its win32 sibling IS signed (the fix narrows, it does not disable signing)',
  selected('resources\\app.asar.unpacked\\node_modules\\onnxruntime-node\\bin\\napi-v3\\win32\\x64\\onnxruntime_binding.node'));
check('the Rust audio addon IS signed', selected('resources\\app.asar.unpacked\\native\\ether-audio.node'));
check('Ether.exe is signed via the .exe short-circuit, with no pattern of its own',
  shouldSignFile('Ether.exe') && !signExts.some(e => e === '.exe'));

// ── The dry listing, against the real package if one is on disk ────────────────────────────────
const unpacked = path.join(ROOT, 'dist-electron', 'win-unpacked');
if (fs.existsSync(unpacked)) {
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
  };
  const real = walk(unpacked).filter(f => /\.(node|dll|exe)$/i.test(f));
  console.log(`\n=== DRY LISTING — ${path.relative(ROOT, unpacked)} (${real.length} signable candidates) ===`);
  const { signed, skipped } = auditList(real, 'real win-unpacked');
  console.log(`\n  WOULD SIGN (${signed.length}):`);
  for (const f of signed) console.log('    + ' + path.relative(unpacked, f));
  console.log(`\n  WOULD SKIP (${skipped.length}):`);
  for (const f of skipped) console.log('    - ' + path.relative(unpacked, f));
} else {
  console.log(`\n(no dist-electron/win-unpacked on this machine — fixture only)`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);

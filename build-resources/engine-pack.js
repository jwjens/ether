// ENGINE PACKAGING — the native engine lands where the daemon and main load it, for the arch being packed,
// or the build fails. docs/mac-install-no-engine-windows-paths-2026-09-30.md §1 and §6.
//
// Both loaders resolve `native/ether-audio.node` next to their own code inside app.asar.unpacked:
//   audiod/ether-audiod.js:140   path.join(__dirname, "..", "native", "ether-audio.node")
//   electron/main.js:387         require("../native/ether-audio.node")   (asar redirects to .unpacked)
// 4.6.52 shipped a Mac with NO engine there (the old `extraResources` "native" entry made electron-builder
// exclude it from the app files) and an arm64 engine inside the x64 DMG (one CI build for both arches). The
// daemon died on MODULE_NOT_FOUND and nothing said so at build time.
//
//   beforePack (macOS): copy native/target/<rust triple>/release/libether_audio.dylib for THIS arch to
//                       native/ether-audio.node, after checking it is a Mach-O for that CPU. Missing → throw.
//   afterPack  (every platform): the packaged app.asar.unpacked/native/ether-audio.node must exist and be
//                       the right format (and, on macOS, the right CPU). Otherwise → throw; nothing is published.
//
// Windows and Linux keep their existing flow (CI copies the one build to native/ether-audio.node); they get
// the afterPack check. NOTE (local Mac builds): beforePack overwrites the tracked Windows DLL at
// native/ether-audio.node, as CI always has — `git checkout native/ether-audio.node` afterwards.
"use strict";
const fs = require("fs");
const path = require("path");
const { Arch } = require("builder-util");

const ROOT = path.join(__dirname, "..");
const ENGINE = path.join(ROOT, "native", "ether-audio.node");
const MAC_TRIPLE = { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" };
const MACHO_CPU = { x64: 0x01000007, arm64: 0x0100000c };   // CPU_TYPE_X86_64, CPU_TYPE_ARM64

function head(file, n) {
  const fd = fs.openSync(file, "r");
  try { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, 0); return b; } finally { fs.closeSync(fd); }
}

// What the file actually is: "macho:x64", "macho:arm64", "macho:<cpu hex>", "pe", "elf", or "unknown".
function kind(file) {
  const b = head(file, 8);
  if (b.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = b.readUInt32LE(4);
    const name = Object.keys(MACHO_CPU).find(k => MACHO_CPU[k] === cpu);
    return "macho:" + (name || cpu.toString(16));
  }
  if (b[0] === 0x4d && b[1] === 0x5a) return "pe";
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return "elf";
  return "unknown";
}

function expectedKind(platform, arch) {
  if (platform === "darwin") return "macho:" + arch;
  if (platform === "win32") return "pe";
  return "elf";
}

function archName(context) {
  const a = Arch[context.arch];
  if (!a) throw new Error(`[engine-pack] unknown arch ${context.arch}`);
  return a;
}

exports.beforePack = async function beforePack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const arch = archName(context);
  const triple = MAC_TRIPLE[arch];
  if (!triple) throw new Error(`[engine-pack] no engine build for macOS arch "${arch}" — only x64 and arm64 are built`);
  const src = path.join(ROOT, "native", "target", triple, "release", "libether_audio.dylib");
  if (!fs.existsSync(src)) {
    throw new Error(`[engine-pack] ENGINE MISSING for macOS ${arch}: ${src}\n` +
      `  build it: cd native && cargo build --release --target ${triple}`);
  }
  const got = kind(src);
  if (got !== "macho:" + arch) throw new Error(`[engine-pack] ${src} is ${got}, not a Mach-O for ${arch}`);
  fs.copyFileSync(src, ENGINE);
  console.log(`  • [engine-pack] macOS ${arch}: ${path.relative(ROOT, src)} → native/ether-audio.node (${got})`);
};

exports.afterPack = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = archName(context);
  const resources = platform === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const packed = path.join(resources, "app.asar.unpacked", "native", "ether-audio.node");
  if (!fs.existsSync(packed)) {
    throw new Error(`[engine-pack] ENGINE NOT PACKAGED: ${packed}\n` +
      `  the daemon (audiod/ether-audiod.js) and main (electron/main.js) load it from exactly there`);
  }
  const want = expectedKind(platform, arch);
  const got = kind(packed);
  if (got !== want) throw new Error(`[engine-pack] packaged engine is ${got}, expected ${want} for ${platform} ${arch}: ${packed}`);
  console.log(`  • [engine-pack] packaged engine OK: ${path.relative(context.appOutDir, packed)} (${got})`);
};

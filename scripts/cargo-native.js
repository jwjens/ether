// scripts/cargo-native.js — run `cargo <args>` in native/ with CMake findable.
//
// The Remote Link's Opus codec is libopus, which its crate (opusic-sys) compiles with CMake
// (docs/remote-link-design-2026-09-28.md, "Build environment finding"). GitHub's runners have CMake on PATH.
// A Windows dev box often has it only inside Visual Studio Build Tools; this points the build at that copy when
// `cmake` is not on PATH and CMAKE is not already set. Nothing is installed, nothing outside this process changes.
//
//   node scripts/cargo-native.js test --release --lib -- --nocapture
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const env = { ...process.env };
const onPath = spawnSync(process.platform === "win32" ? "where" : "which", ["cmake"], { stdio: "ignore" }).status === 0;
if (!env.CMAKE && !onPath && process.platform === "win32") {
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter(Boolean);
  const editions = ["BuildTools", "Community", "Professional", "Enterprise"];
  const years = ["2022", "2019"];
  for (const r of roots) for (const y of years) for (const e of editions) {
    const p = path.join(r, "Microsoft Visual Studio", y, e, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe");
    if (!env.CMAKE && fs.existsSync(p)) env.CMAKE = p;
  }
  if (env.CMAKE) console.log(`[cargo-native] CMake: ${env.CMAKE}`);
  else console.log("[cargo-native] no CMake found (not on PATH, not in Visual Studio) — libopus will not build. Install CMake or the VS 'C++ CMake tools' component.");
}
const r = spawnSync("cargo", process.argv.slice(2), { cwd: path.join(__dirname, "..", "native"), env, stdio: "inherit", shell: false });
process.exit(r.status === null ? 1 : r.status);

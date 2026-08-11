// defineConfig comes from vitest/config rather than vite so the `test` block below is typed. This
// adds no constraint on building: vite itself is already a devDependency, so any machine that can
// run `vite build` has vitest too.
import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 1420, host: "127.0.0.1",
    strictPort: true,
    watch: { usePolling: true },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  test: {
    // BUILD OUTPUT IS NOT A TEST SUITE.
    //
    // electron-builder packages `audiod/**/*`, which sweeps up scheduler-core.test.js, so every
    // build leaves a copy at dist-electron/win-unpacked/resources/app.asar.unpacked/audiod/. Vitest
    // then collected BOTH: 25 tests ran twice, and half of them ran against whatever code was
    // packaged at the last build rather than what is on disk now.
    //
    // That is worse than noise in a count. A suite that green-lights a stale copy can report a pass
    // for code you have since changed — and after `git clean`, the same tests silently vanish. Test
    // totals must mean something, so the artifact directories are excluded.
    //
    // configDefaults.exclude is spread rather than retyped: it carries **/node_modules/**, and a
    // hand-written list that drifts would start running the tests inside every dependency.
    exclude: [...configDefaults.exclude, "**/dist-electron/**", "**/dist/**", "**/win-unpacked/**"],
  },
});

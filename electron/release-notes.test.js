// Update window → Details lists the notes of every version from this one up to the update (Jeff, 2026-10-30).
// electron/release-notes.js + src/components/Updater.tsx.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { notesBetween, releaseNotesFor } = require_("./release-notes");
const read = (p) => readFileSync(join(__dirname, "..", p), "utf8");

const rel = (v, extra = {}) => ({ tag_name: `v${v}`, name: `Ether ${v}`, body: `notes ${v}`, published_at: "2026-10-30T00:00:00Z", ...extra });
const page = [rel("4.6.70"), rel("4.6.69"), rel("4.6.68", { draft: true }), rel("4.6.67"), rel("4.6.66", { prerelease: true }), rel("4.6.65"), rel("4.6.64")];
const okFetch = (rows) => async () => ({ ok: true, status: 200, json: async () => rows });

describe("release notes between two versions", () => {
  it("skipping 4.6.65 → 4.6.69 shows every published version in between, newest first", () => {
    expect(notesBetween(page, "4.6.65", "4.6.69").map(r => r.version)).toEqual(["4.6.69", "4.6.67"]);
  });
  it("a one-step update shows just that version", () => {
    expect(notesBetween(page, "4.6.69", "4.6.70").map(r => r.body)).toEqual(["notes 4.6.70"]);
  });
  it("loads from GitHub and reports nothing missing when the update's own notes are there", async () => {
    const a = await releaseNotesFor({ from: "4.6.65", to: "4.6.69", fetchImpl: okFetch(page) });
    expect(a.ok).toBe(true);
    expect(a.releases.map(r => r.version)).toEqual(["4.6.69", "4.6.67"]);
    expect(a.missing).toEqual([]);
  });
  it("says so when the update's own notes are not found", async () => {
    const a = await releaseNotesFor({ from: "4.6.65", to: "4.6.71", fetchImpl: okFetch(page) });
    expect(a.missing).toEqual(["4.6.71"]);
  });
  it("a failed or slow answer is a failure the popup can say, never a throw", async () => {
    expect(await releaseNotesFor({ from: "4.6.65", to: "4.6.69", fetchImpl: async () => ({ ok: false, status: 403 }) }))
      .toEqual({ ok: false, error: "GitHub answered 403" });
    expect((await releaseNotesFor({ from: "4.6.65", to: "4.6.69", fetchImpl: async () => { throw new Error("offline"); } })).ok).toBe(false);
    const slow = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    expect(await releaseNotesFor({ from: "4.6.65", to: "4.6.69", fetchImpl: slow, timeLimitMs: 20 }))
      .toEqual({ ok: false, error: "GitHub did not answer in time" });
  });
  it("main answers updater:release-notes from the running version", () => {
    const h = read("electron/main.js").match(/ipcMain\.handle\("updater:release-notes"[\s\S]{0,600}?\n\}\);/)[0];
    expect(h).toMatch(/releaseNotesFor\(\{ from,/);
    expect(h).toMatch(/if \(!app\.isPackaged\) \{ try \{ from = require\("\.\.\/package\.json"\)\.version/);   // Ether's version, not Electron's
  });
  it("every update window (available, downloading, ready, failed) has the Details button, and the update path never waits on it", () => {
    const u = read("src/components/Updater.tsx");
    expect(u.match(/\{detailsBtn\}/g)?.length).toBe(4);
    expect(u).toMatch(/invoke\("updater:release-notes", version\)/);
    const hook = u.slice(u.indexOf("export function useUpdater"), u.indexOf("export function UpdateBanner"));
    expect(hook).not.toMatch(/release-notes/);
    expect(u).toMatch(/The release notes could not be loaded/);
  });
});

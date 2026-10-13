// THE DUCK AMOUNT IS SET IN PREFERENCES, NEVER BY CODE (Jeff's ruling, 2026-10-13; docs/duck-from-preferences-2026-10-13.md).
// It replaces "ducker defaults agree everywhere" (2026-10-11), which pinned FIVE copies of the same numbers. Now there is
// no copy: the engine has no duck amount of its own, the applier sends exactly what Preferences holds, the starting
// values live in ONE file and are written INTO Preferences once, and a disagreement shows on the Health page.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const require_ = createRequire(import.meta.url);
const B = require_("./board-state.js");
const START = require_("./duck-defaults.js");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

function db(kv = {}) {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE stations (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT);
          CREATE TABLE deck_configs (station_id INTEGER, slot TEXT, type TEXT, kind TEXT, enabled INTEGER, channel_on INTEGER, duck INTEGER, duckable INTEGER, deleted_at TEXT);
          CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, deleted_at TEXT);
          INSERT INTO stations (id, name) VALUES (1, 'One');`);
  const ins = d.prepare("INSERT INTO station_config_kv (station_id, key, value) VALUES (1, ?, ?)");
  for (const [k, v] of Object.entries(kv)) ins.run(k, String(v));
  return d;
}
const ALL = { duck_depth_db: -18, duck_threshold_db: -40, duck_attack_ms: 12, duck_hold_ms: 900, duck_release_ms: 650 };

describe("the ducker's values come only from Preferences", () => {
  it("the engine has no duck amount of its own (native/src/audio.rs BusState::new)", () => {
    const src = read("native/src/audio.rs");
    const init = src.slice(src.indexOf("duck_set: false,"), src.indexOf("duck_release_ms: 0.0,") + 25);
    expect(init).toMatch(/duck_set: false,[\s\S]*duck_threshold: 0\.0,[\s\S]*duck_depth_db: 0\.0,[\s\S]*duck_attack_ms: 0\.0,[\s\S]*duck_hold_ms: 0\.0,[\s\S]*duck_release_ms: 0\.0,/);
    expect(src).not.toMatch(/duck_depth_db: -2[28]\.0/);
    expect(src).not.toMatch(/duck_threshold: 0\.0056/);
    expect(src).toMatch(/let duck_running = bus\.duck_set && \(/);          // no values → no duck
    expect(read("native/src/show.rs")).toMatch(/p\.duck_set\s+= true;/);     // only the Preferences setter sets them
  });

  it("the applier sends exactly what Preferences holds — and nothing when Preferences has nothing", () => {
    expect(B.readSavedBoard(db(ALL), 1).duckParams).toEqual({ depthDb: -18, thresholdDb: -40, attackMs: 12, holdMs: 900, releaseMs: 650 });
    const none = B.readSavedBoard(db(), 1);
    expect(none.duckParams).toBeNull();
    expect(none.duckMissing).toEqual(Object.values(B.DUCK_KEYS));
    const partial = B.readSavedBoard(db({ duck_depth_db: -18 }), 1);
    expect(partial.duckParams).toBeNull();                                    // never four from Preferences + one from code
    for (const v of Object.values(B.DUCK_KEYS)) expect(typeof v).toBe("string");   // keys only — no numbers
  });

  it("the starting values live in ONE file and are written INTO Preferences — only where a value is missing", () => {
    const d = db({ duck_depth_db: -18 });                                     // the operator set the depth; nothing else
    const wrote = [];
    const upsert = (sid, key, value) => { wrote.push([key, value]); d.prepare("INSERT INTO station_config_kv (station_id, key, value) VALUES (?, ?, ?)").run(sid, key, value); };
    expect(B.seedDuckPreferences(d, 1, upsert)).toEqual(["duck_threshold_db", "duck_attack_ms", "duck_hold_ms", "duck_release_ms"]);
    expect(wrote).toEqual([["duck_threshold_db", String(START.thresholdDb)], ["duck_attack_ms", String(START.attackMs)],
                           ["duck_hold_ms", String(START.holdMs)], ["duck_release_ms", String(START.releaseMs)]]);
    expect(B.readSavedBoard(d, 1).duckParams.depthDb).toBe(-18);             // the operator's value untouched
    expect(B.seedDuckPreferences(d, 1, upsert)).toEqual([]);                  // once
    expect(B.DUCK_START).toEqual(START);
  });

  it("no other file holds a duck amount", () => {
    const panel = read("src/components/DuckerSection.tsx");
    expect(panel).not.toMatch(/DUCK_DEFAULTS/);
    expect(panel).not.toMatch(/depthDb:\s*-\d/);
    const sp = read("audiod/show-presets.js");
    expect(sp).not.toMatch(/DUCK_DEFAULTS/);
    expect(sp).not.toMatch(/depthDb:\s*-\d/);
    const main = read("electron/main.js");
    expect(main).not.toMatch(/DUCK_KEYS\.\w+\[1\]/);
    expect(main).not.toMatch(/num\('duck_depth_db', -/);
    const pm = read("src/components/PodcastMode.tsx");
    expect(pm).not.toMatch(/DUCK_LEVEL/);
    const bs = read("audiod/board-state.js");
    expect(bs).not.toMatch(/\["duck_depth_db", -/);
  });

  it("Preferences and the engine disagreeing is a board mismatch (the Health page error)", () => {
    const saved = B.readSavedBoard(db(ALL), 1);
    const live = (dp) => ({ ok: true, control: { slots: {}, duck_params: dp } });
    const exact = { depth_db: -18, threshold: 10 ** (-40 / 20), attack_ms: 12, hold_ms: 900, release_ms: 650 };
    expect(B.compareBoard(saved, live(exact)).filter(d => /^duck/.test(d.setting))).toEqual([]);
    const duckOnly = (r) => r.filter(d => /^duck/.test(d.setting));
    const notSet = duckOnly(B.compareBoard(saved, live(null)));
    expect(notSet.map(d => d.setting)).toEqual(["duckEngine"]);
    expect(notSet[0].label).toBe("Ducker settings in the engine");
    const deeper = duckOnly(B.compareBoard(saved, live({ ...exact, depth_db: -22 })));
    expect(deeper.map(d => [d.setting, d.saved, d.live, d.label])).toEqual([["duckDepth", -18, -22, "Ducker depth"]]);
    const noPrefs = duckOnly(B.compareBoard(B.readSavedBoard(db(), 1), live(exact)));
    expect(noPrefs.map(d => d.setting)).toEqual(["duckPrefs"]);
  });
});

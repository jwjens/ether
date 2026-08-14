// ── The category gate: an uncategorised MUSIC song must never be picked ──────────────────────────
//
// A MUSIC song with category_id NULL can never air. Every on-format read derives its universe from
// clock_slots.category_id, so a song in no category is dropped by all of them — placing one produces
// a row that sits pending forever, counted in the missed backlog, never selectable.
//
// The gap this pins was REAL and specific: pickTier applies its category filter only when formatCats
// is non-empty ("formatCats [] = no category restriction"), so the last-ditch tier — the one that
// runs when a station has no usable categories — was the single path that could reach one.
//
// It is NOT the path that produced the 82 Munsters rows. Those were written with category_id 14 and
// 7 recorded on the log row; the song was uncategorised LATER. Verified 2026-08-11 against the live
// DB: every NULL-category MUSIC row in generated_schedule (82 missed + 4 pending + 83 played) has a
// category on the log row. Generate never wrote one. This gate is the guard, not the cure.
//
// JINGLES AND SPOTS DO NOT HAVE CATEGORIES AND MUST NOT BE AFFECTED — they are filed by
// jingle_category_id / spot_category_id and selected by their own paths. 64 of the 74 uncategorised
// songs on the live install are JIN and 2 are SPOT; only 8 are MUSIC.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require_ = createRequire(import.meta.url);
const { _test } = require_("./loggen.js");
const { baseConditions, pickTier } = _test;

let db;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE songs (
      id INTEGER PRIMARY KEY, title TEXT, artist_id INTEGER, category_id INTEGER,
      file_path TEXT, file_key TEXT, duration_ms INTEGER, intro_end REAL, outro_start REAL,
      rotation_status TEXT, content_class TEXT, daypart_mask INTEGER, no_repeat_hours INTEGER,
      -- deleted_at added 2026-08-13: the pickers now exclude soft-deleted songs, and this fixture
      -- had drifted from the real schema (which has had the column since the sync work). A fixture
      -- that is missing a column the product filters on cannot test the product.
      deleted_at TEXT
    );
    INSERT INTO artists (id,name) VALUES (1,'An Artist');
    -- categorised music: pickable
    INSERT INTO songs (id,title,artist_id,category_id,file_path,duration_ms,content_class)
      VALUES (1,'Categorised Song',1,7,'C:/a.mp3',180000,'MUSIC');
    -- uncategorised MUSIC: must NEVER be picked (this is "The Munsters" Theme's shape)
    INSERT INTO songs (id,title,artist_id,category_id,file_path,duration_ms,content_class)
      VALUES (2,'"The Munsters" Theme',1,NULL,'C:/b.mp3',180000,'MUSIC');
    -- uncategorised JINGLE: correct by design, and excluded here by the MUSIC gate, not the new one
    INSERT INTO songs (id,title,artist_id,category_id,file_path,duration_ms,content_class)
      VALUES (3,'audiocoffee-halloween-impact',1,NULL,'C:/c.mp3',9000,'JIN');
    -- pre-v29 row: content_class NULL is treated as MUSIC, so the category gate still applies
    INSERT INTO songs (id,title,artist_id,category_id,file_path,duration_ms,content_class)
      VALUES (4,'Legacy Row',1,NULL,'C:/d.mp3',180000,NULL);
    -- SOFT-DELETED but otherwise perfectly pickable: categorised, MUSIC, has a file. This is the
    -- exact shape of "Perfect Revenge" (deleted 2026-07-20, still holding 63 future slots on
    -- 2026-08-13 because every picker ignored deleted_at).
    INSERT INTO songs (id,title,artist_id,category_id,file_path,duration_ms,content_class,deleted_at)
      VALUES (5,'Perfect Revenge',1,7,'C:/deleted.mp3',180000,'MUSIC','2026-07-20T20:38:11.116Z');
  `);
});

const OPTS = { daypart: false };   // no daypart_mask/play_log needed for these

describe("baseConditions", () => {
  it("carries the category gate", () => {
    expect(baseConditions(0, [], 1, OPTS)).toContain("s.category_id IS NOT NULL");
  });

  it("still gates on MUSIC, so jingles and spots are excluded by class, not by category", () => {
    const c = baseConditions(0, [], 1, OPTS);
    expect(c).toContain("s.content_class IS NULL OR s.content_class = 'MUSIC'");
  });
});

describe("pickTier never returns a DELETED song", () => {
  // The grep guard in electron/song-picker-guard.test.js proves the clause is present. This proves
  // it WORKS — a deleted song that is otherwise a perfect candidate must not come back from any
  // tier, including the last-ditch one with no category restriction.
  it("excludes it in the LAST-DITCH tier, where nothing else would stop it", () => {
    const paths = pickTier(db, 10, 0, 1, [], [], OPTS, "random").map(r => r.file_path ?? r.filePath);
    expect(paths).not.toContain("C:/deleted.mp3");
    expect(paths).toContain("C:/a.mp3");        // and the live song is still pickable
  });

  it("excludes it in the on-format tier, where it shares the category with a live song", () => {
    const paths = pickTier(db, 10, 0, 1, [7], [], OPTS, "random").map(r => r.file_path ?? r.filePath);
    expect(paths).not.toContain("C:/deleted.mp3");
    expect(paths).toEqual(["C:/a.mp3"]);
  });
});

describe("pickTier never returns an uncategorised music song", () => {
  it("excludes it in the LAST-DITCH tier — formatCats [], where there is no category restriction", () => {
    // This is the tier that could reach it before the fix.
    const got = pickTier(db, 10, 0, 1, [], [], OPTS, "random");
    const paths = got.map(r => r.file_path ?? r.filePath);
    expect(paths).toContain("C:/a.mp3");
    expect(paths).not.toContain("C:/b.mp3");
  });

  it("excludes a legacy content_class NULL row too — it counts as music", () => {
    const paths = pickTier(db, 10, 0, 1, [], [], OPTS, "random").map(r => r.file_path ?? r.filePath);
    expect(paths).not.toContain("C:/d.mp3");
  });

  it("excludes it in the on-format tier as well", () => {
    const paths = pickTier(db, 10, 0, 1, [7], [], OPTS, "random").map(r => r.file_path ?? r.filePath);
    expect(paths).toEqual(["C:/a.mp3"]);
  });

  it("returns NOTHING rather than an uncategorised song when the library has only those", () => {
    // Starvation is the correct outcome: it is loud (fill-starved health event) and recoverable.
    // Airing a song that can never be scheduled again is neither.
    db.exec("DELETE FROM songs WHERE id = 1");
    expect(pickTier(db, 10, 0, 1, [], [], OPTS, "random")).toEqual([]);
  });

  it("does not pick the jingle either — a music slot is never filled by imaging", () => {
    const paths = pickTier(db, 10, 0, 1, [], [], OPTS, "random").map(r => r.file_path ?? r.filePath);
    expect(paths).not.toContain("C:/c.mp3");
  });
});

// Every query that CHOOSES A SONG TO AIR must exclude soft-deleted rows.
//
// On 2026-08-13 two songs deleted on 2026-07-20 were still holding 63 future slots on halloVeen.
// Across the library: 28 deleted songs, 729 future scheduled rows, and 438 plays logged AFTER the
// song's own delete timestamp. The delete worked every time and was recorded as a mutation every
// time — the pickers simply never looked at `deleted_at`.
//
// It was missing from ALL THREE generators: the Electron generator, the daemon's loggen, and the
// in-process TS twin. In generate-core.js the two statements DIRECTLY ABOVE the candidate pool
// (stmtShows, stmtSlots) both filtered it correctly — so this is not a knowledge gap, it is a habit
// gap, and a habit gap needs a test rather than a fix.
//
// Same shape and same reasoning as src/lib/deleted-shows-guard.test.ts, added the day before for the
// identical defect on `shows`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** The files that pick songs for air. Not every `FROM songs` in the tree — COUNT(*) probes, FTS
 *  triggers, migrations and R2 backfills legitimately see everything. These are the selection
 *  paths, listed explicitly so adding a new generator is a deliberate act. */
const PICKERS = [
  "electron/generate-core.js",
  "audiod/loggen.js",
  "src/audio/loggen.ts",
];

/** A `FROM songs` occurrence plus the window that would hold its WHERE clause. */
function songQueries(src) {
  const out = [];
  const re = /FROM\s+songs\b/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    // Look BACKWARD too: audiod/loggen.js builds `${SELECT} WHERE ${NOT_DELETED} AND (...)`, so the
    // guard can sit either side of the FROM.
    out.push(src.slice(Math.max(0, m.index - 400), m.index + 500));
  }
  return out;
}

describe("song pickers exclude deleted songs", () => {
  for (const rel of PICKERS) {
    it(`${rel} — every song query carries a deleted_at guard`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      const queries = songQueries(src);
      expect(queries.length, `no 'FROM songs' found in ${rel} — has it moved?`).toBeGreaterThan(0);

      // A query passes if it carries the clause inline, OR delegates its WHERE to a builder /
      // shared fragment that does. The delegated builders are asserted separately below, so
      // delegation cannot be used to hide a missing filter.
      const guarded = (q) =>
        /\bdeleted_at\s+IS\s+NULL/i.test(q) ||   // inline
        /NOT_DELETED/.test(q) ||                 // audiod/loggen.js shared fragment
        /\$\{cond/.test(q) ||                    // `WHERE ${cond}` / `${conditions}`
        /\$\{conditions/.test(q) ||
        // DELIBERATE EXEMPTION: the artist-separation subquery `FROM songs s2` asks "which artists
        // aired recently", not "what may I play". A song that aired an hour ago put that artist on
        // air whether or not it has since been deleted — filtering here would UNDER-count recent
        // airplay and let an artist repeat inside their separation window. It selects no candidate.
        /FROM\s+songs\s+s2\b/i.test(q);
      const offenders = queries.filter(q => !guarded(q))
        .map(o => o.replace(/\s+/g, " ").slice(0, 160));
      expect(offenders, `${rel}: song query with no deleted_at guard`).toEqual([]);
    });
  }

  // The delegated builders. Without these, a query could pass the sweep above merely by using
  // `${cond}` while the builder had no filter at all — which is exactly the state before this fix.
  it("src/audio/loggen.ts buildBaseConditions carries the guard", () => {
    const src = readFileSync(join(ROOT, "src/audio/loggen.ts"), "utf8");
    const m = src.match(/function buildBaseConditions[\s\S]{0,900}/);
    expect(m, "buildBaseConditions not found — has it been renamed?").toBeTruthy();
    expect(m[0]).toMatch(/s\.deleted_at\s+IS\s+NULL/i);
  });

  it("audiod/loggen.js NOT_DELETED is the guard, and every ${SELECT} WHERE uses it", () => {
    const src = readFileSync(join(ROOT, "audiod/loggen.js"), "utf8");
    expect(src).toMatch(/const NOT_DELETED\s*=\s*`s\.deleted_at IS NULL`/);
    // Every `${SELECT} WHERE` must apply it — a new call site that forgets is the whole risk.
    const wheres = src.match(/\$\{SELECT\}\s*WHERE[^`]*/g) || [];
    expect(wheres.length, "no ${SELECT} WHERE call sites found").toBeGreaterThan(0);
    for (const w of wheres) expect(w, `unguarded: ${w.slice(0, 90)}`).toMatch(/NOT_DELETED/);
  });

  it("pins the specific query that put 729 deleted-song rows in the log", () => {
    const src = readFileSync(join(ROOT, "electron/generate-core.js"), "utf8");
    const m = src.match(/stmtCandidates:[\s\S]{0,600}/);
    expect(m, "stmtCandidates not found — has it been renamed?").toBeTruthy();
    expect(m[0]).toMatch(/s\.deleted_at\s+IS\s+NULL/i);
  });

  it("a clock slot naming ONE deleted song resolves to nothing", () => {
    const src = readFileSync(join(ROOT, "electron/generate-core.js"), "utf8");
    const m = src.match(/stmtSongById:[\s\S]{0,400}/);
    expect(m, "stmtSongById not found").toBeTruthy();
    expect(m[0]).toMatch(/s\.deleted_at\s+IS\s+NULL/i);
  });
});

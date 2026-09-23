// A soft delete is only as good as its readers. On 2026-08-12 a show deleted from the Shows page was
// still airing on the Calendar, and the cause was one missing clause — repeated in TEN places.
//
// ShowsTab (the page you delete from) filtered correctly, so the delete looked like it worked. The
// ProgramLog, MasterOutput, BroadcastMonitor, OnShiftScreen, ProducerDesk,
// VoiceTracker and showClock.ts did not. showClock was the serious one: a deleted show could still
// select the clock that governs an hour.
//
// This test greps the tree rather than testing a function, deliberately — the defect is not in any
// one module, it is in the habit. Same shape as local-only-keys.test.js, which guards the KV
// allowlist the same way and for the same reason.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/** Every `FROM shows` occurrence with the ~400 chars that follow — enough to cover a multi-line
 *  WHERE, an ORDER BY, and the closing backtick of a template literal. */
const SHOWS_RE = /FROM\s+shows\b/gi;
const CATS_RE  = /FROM\s+categories\b/gi;
function tableQueries(src: string, re: RegExp): string[] {
  const out: string[] = [];
  re.lastIndex = 0;                 // shared literal: reset before every file
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(src.slice(m.index, m.index + 400));
  return out;
}
const showsQueries = (src: string) => tableQueries(src, SHOWS_RE);

describe("every query that reads `shows` must exclude soft-deleted rows", () => {
  const files = walk(SRC);

  it("finds the show queries at all (the grep itself still works)", () => {
    const total = files.reduce((n, f) => n + showsQueries(readFileSync(f, "utf8")).length, 0);
    expect(total).toBeGreaterThan(10);
  });

  it("has no `FROM shows` without a deleted_at guard", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const q of showsQueries(src)) {
        // The guard may be written `deleted_at IS NULL` or `s.deleted_at IS NULL` / `sh.` / any alias.
        if (!/\bdeleted_at\s+IS\s+NULL/i.test(q)) {
          offenders.push(`${f.replace(SRC, "src")} :: ${q.split("\n").slice(0, 3).join(" ").trim().slice(0, 120)}`);
        }
      }
    }
    expect(offenders, `these read shows without excluding deleted rows:\n  ${offenders.join("\n  ")}`)
      .toEqual([]);
  });
});

// 2026-09-24: the identical defect, in the identical shape, on `categories`. The Categories tab's own
// list did NOT filter, so deleting a category set deleted_at, the list re-read, the row came back, and
// the screen never changed — no error, because nothing had failed. ClocksTab kept offering the deleted
// category as a clock-slot target. Exactly the ShowsTab story above: the page you delete FROM is the
// one that lies to you. docs/category-delete-silent-2026-09-24.md
describe("every query that reads `categories` must exclude soft-deleted rows", () => {
  const files = walk(SRC);
  // A sub-select counting songs BY category (`... FROM songs WHERE category_id = c.id)`) is not a read
  // OF categories. Only a real `FROM categories` is this guard's business.
  const EXEMPT = [
    /FROM\s+categories\s*\)/i,     // `(SELECT COUNT(*) … FROM songs …)` closing a sub-select
    /FROM\s+categories\s*\./i,     // prose naming a COLUMN ("from categories.overlay_lead_in_sec")
  ];

  it("finds the category queries at all (the grep itself still works)", () => {
    const total = files.reduce((n, f) => n + tableQueries(readFileSync(f, "utf8"), CATS_RE).length, 0);
    expect(total).toBeGreaterThan(3);
  });

  it("has no `FROM categories` without a deleted_at guard", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const q of tableQueries(src, CATS_RE)) {
        if (EXEMPT.some(re => re.test(q))) continue;
        if (!/\bdeleted_at\s+IS\s+NULL/i.test(q)) {
          offenders.push(`${f.replace(SRC, "src")} :: ${q.split("\n").slice(0, 3).join(" ").trim().slice(0, 120)}`);
        }
      }
    }
    expect(offenders, `these read categories without excluding deleted rows:\n  ${offenders.join("\n  ")}`)
      .toEqual([]);
  });
});

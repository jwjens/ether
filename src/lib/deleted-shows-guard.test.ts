// A soft delete is only as good as its readers. On 2026-08-12 a show deleted from the Shows page was
// still airing on the Calendar, and the cause was one missing clause — repeated in TEN places.
//
// ShowsTab (the page you delete from) filtered correctly, so the delete looked like it worked. The
// Calendar, ProgramLog, MasterOutput, BroadcastMonitor, SchedulePreview, OnShiftScreen, ProducerDesk,
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
function showsQueries(src: string): string[] {
  const out: string[] = [];
  const re = /FROM\s+shows\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(src.slice(m.index, m.index + 400));
  return out;
}

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

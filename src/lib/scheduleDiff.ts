// src/lib/scheduleDiff.ts — what APPLY does to ONE date.
//
// docs/announcement-schedule-frame-design-2026-08-26.md.
//
// The Announcements panel stages an editor and commits it with APPLY: each selected date's schedule
// becomes exactly the list in the editor. The naive way to do that is to delete the date's rows and
// write the editor back — and it is WRONG, because a row carries `last_played_at`, which is the 120s
// double-fire guard the 250ms tick relies on. Recreating an unchanged line would reset its guard and
// let an announcement re-fire inside its own window, seconds after it aired.
//
// So APPLY diffs. A line already present on the date KEEPS ITS ROW untouched; only what actually
// changed is written. Pure and in its own module so the rule has a test rather than a comment.

export interface ExistingRow {
  uuid: string;
  announcement_uuid: string;
  trigger_time: string | null;
}

export interface DraftLine {
  announcement_uuid: string;
  trigger_time: string;
}

export interface ScheduleDiff<E, D> {
  /** Rows already matching a draft line — left completely alone, guard intact. */
  keep: E[];
  /** Rows the editor no longer contains — deleted. */
  remove: E[];
  /** Draft lines with no matching row — created. */
  create: D[];
}

/**
 * Match by (announcement, time) as a MULTISET, not a set: the same announcement genuinely can be
 * scheduled twice at the same time on one date (a double-play), and set semantics would silently
 * collapse the second one into the first and then delete a row the operator had asked for.
 */
export function diffSchedule<E extends ExistingRow, D extends DraftLine>(
  existing: readonly E[],
  draft: readonly D[],
): ScheduleDiff<E, D> {
  const pool: (E | null)[] = existing.slice();
  const keep: E[] = [];
  const create: D[] = [];

  for (const line of draft) {
    const t = line.trigger_time || "";
    const i = pool.findIndex(
      e => e != null && e.announcement_uuid === line.announcement_uuid && (e.trigger_time || "") === t,
    );
    if (i >= 0) { keep.push(pool[i] as E); pool[i] = null; }
    else create.push(line);
  }

  return { keep, remove: pool.filter((e): e is E => e != null), create };
}

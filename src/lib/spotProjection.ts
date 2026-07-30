// ── SPOT SCHEDULE PROJECTION (display-only) ───────────────────────────────────────────────────────────
// Answers "when will this pending spot ACTUALLY air?" so the Health Monitor can show a spot going
// amber/red BEFORE it misses its anchor, not after.
//
// Pure: no I/O, no engine, no DB. Given the queue ahead of the seam and the spot anchors, it walks
// forward accumulating durations. Read-only by construction — it computes a projection, it never
// changes what airs.
//
// ⚠ IT MIRRORS audiod/loggen.js `orderForNearestAnchor` for flipped stations. Two implementations of one
// rule drift apart; see the build report's "Known duplication" section for why this exists and what the
// permanent answer is (the daemon exposing its own projection). Keep the constants below in step with
// loggen's NEAREST_ANCHOR_TIE_SEC and the reach test.

export const TIE_SEC = 2;                       // must match loggen.NEAREST_ANCHOR_TIE_SEC

export type QueueItem = { title?: string; durationMs?: number; contentClass?: string | null; scheduledAt?: number };
export type SpotRow = { scheduledAt: number; durationS: number; state: string; playedAt: number | null; title: string };

export type ProjectedSpot = SpotRow & {
  /** epoch seconds this spot is projected to air. When `beyondQueue` it is a LOWER BOUND — the end of
   *  the visible queue — not an exact time. null only when there is nothing to compute from at all. */
  projectedAt: number | null;
  /** true when the projection ran off the end of the visible queue: the spot airs at or after
   *  `projectedAt`, we just cannot see far enough to say when. An honest "≥", never a blank. */
  beyondQueue: boolean;
  /** true when the top-of-hour hard cut owns this anchor (minute 0) — it lands exact by construction */
  hardCutOwned: boolean;
  /** signed seconds: fired−anchor when played, projected−anchor when pending; null when unknown.
   *  With `beyondQueue` this is a lower bound too (it can only get later, never earlier). */
  driftSec: number | null;
};

/** Minute-0 anchors belong to `_hardCutTopOfHour`, which re-queues from the hour boundary. They land
 *  exact for that reason, not because the schedule is well-behaved — worth saying so on screen. */
export function isHardCutOwned(anchorSec: number): boolean {
  const d = new Date(anchorSec * 1000);
  return d.getMinutes() === 0 && d.getSeconds() === 0;
}

/** The nearest-anchor comparison, mirrored from loggen.orderForNearestAnchor. Would the selector promote
 *  a spot anchored at `A` ahead of a music row of `d` seconds, at a seam of `seamTs`? */
function wouldPromote(seamTs: number, A: number, d: number, nextHourTs: number): boolean {
  if (!(d > 0) || !Number.isFinite(A)) return false;
  if (A >= nextHourTs) return false;              // §4 — the hard cut owns it
  if ((A - seamTs) > d) return false;             // §1 — out of reach
  const nowDist = Math.abs(seamTs - A);
  const afterDist = Math.abs((seamTs + d) - A);
  return (afterDist - nowDist) > TIE_SEC;         // §2 — clear win only
}

/**
 * Walk the queue from the projected seam and stamp each PENDING spot with when it will really air.
 *
 * @param spots      the hour's spot rows, anchor-ascending
 * @param queue      the pending queue in play order (engine.getQueue()), durations in ms
 * @param seamTs     epoch seconds of the next seam (now + remaining on the playing deck)
 * @param flipped    true when the log-reader flip is ON for this station — the selector may promote a
 *                   spot ahead of a music row. False = legacy: the spot waits behind everything cued,
 *                   which is the honest truth of legacy and exactly what the operator should see.
 * @param nextHourTs epoch seconds of the next top of the hour
 */
export function projectSpots(
  spots: SpotRow[], queue: QueueItem[], seamTs: number, flipped: boolean, nextHourTs: number,
): ProjectedSpot[] {
  // A WALK, not a predicate. Earlier this only placed a spot when the nearest-anchor selector WOULD
  // promote it — a promotion test, not a projection — so any anchor out of reach got no answer and the
  // board read "—" everywhere. Now every pending spot is placed where it will actually air given the
  // queue as it stands; promotion is a MODIFIER that can move a spot earlier, never the gate.
  const pendingSpots = spots
    .filter(s => s.state !== "played" && !s.playedAt)
    .sort((a, b) => a.scheduledAt - b.scheduledAt);
  const placed = new Map<number, number>();     // anchor → projected epoch seconds
  const durOf = (a: number) => pendingSpots.find(s => s.scheduledAt === a)?.durationS ?? 0;

  let t = seamTs;
  let next = 0;                                  // index into pendingSpots of the soonest unplaced anchor
  for (const item of queue) {
    const dur = (item.durationMs || 0) / 1000;

    // A SPOT sitting in the queue airs at this seam — that IS its projection, no arithmetic needed.
    if (item.contentClass === "SPOT") {
      const anchor = Number.isFinite(item.scheduledAt as number)
        ? (item.scheduledAt as number)
        : (pendingSpots[next]?.scheduledAt ?? NaN);
      if (Number.isFinite(anchor) && !placed.has(anchor)) placed.set(anchor, t);
      while (next < pendingSpots.length && placed.has(pendingSpots[next].scheduledAt)) next++;
      t += dur;
      continue;
    }

    // A music row. On a FLIPPED station the selector may jump the next unplaced spot ahead of it — that
    // moves the projection EARLIER. On legacy it simply waits its turn in the queue, which is the honest
    // truth of legacy and exactly what the operator should see.
    if (flipped && next < pendingSpots.length) {
      const a = pendingSpots[next].scheduledAt;
      if (!placed.has(a) && wouldPromote(t, a, dur, nextHourTs)) {
        placed.set(a, t);
        t += durOf(a);                           // the spot's own duration pushes the seam along
        while (next < pendingSpots.length && placed.has(pendingSpots[next].scheduledAt)) next++;
      }
    }
    t += dur;
  }
  const queueEndTs = t;                          // everything unplaced airs at or after here

  const out: ProjectedSpot[] = [];
  for (const s of spots) {
    const hardCutOwned = isHardCutOwned(s.scheduledAt);
    const played = s.state === "played" || !!s.playedAt;
    if (played) {
      out.push({ ...s, projectedAt: null, beyondQueue: false, hardCutOwned,
        driftSec: s.playedAt ? s.playedAt - s.scheduledAt : null });
      continue;
    }
    // A top-of-hour anchor is FIRED BY THE HARD CUT, not reached by the queue. Walking the queue to it
    // gives a meaningless "late" (the cut pre-empts whatever the walk predicted), so project it AT its
    // anchor — which is what actually happens, and why these land exact.
    if (hardCutOwned) {
      out.push({ ...s, projectedAt: s.scheduledAt, beyondQueue: false, hardCutOwned, driftSec: 0 });
      continue;
    }

    const exact = placed.get(s.scheduledAt);
    // Unplaced = past the end of the visible queue. Report the queue end as a LOWER BOUND rather than a
    // blank: it can only get later, so if the bound is already past the anchor that is a real warning.
    const projectedAt = exact ?? (queue.length ? queueEndTs : null);
    const beyondQueue = exact === undefined && projectedAt !== null;
    // A lower bound EARLIER than the anchor carries no information — it does not mean the spot airs
    // early, only that we cannot see that far yet. Report drift as unknown rather than a confident
    // negative, which would paint a red "−31:14" on a spot that is perfectly fine.
    const driftSec = projectedAt === null ? null
      : (beyondQueue && projectedAt < s.scheduledAt) ? null
      : projectedAt - s.scheduledAt;
    out.push({ ...s, projectedAt, beyondQueue, hardCutOwned, driftSec });
  }
  return out;
}

/** Drift banding. Green ≤15s, amber ≤60s, red beyond — same thresholds for fired and projected, so an
 *  about-to-miss spot goes amber/red BEFORE it misses. */
export function driftLevel(driftSec: number | null): "ok" | "warn" | "error" | "unknown" {
  if (driftSec === null || !Number.isFinite(driftSec)) return "unknown";
  const a = Math.abs(driftSec);
  if (a <= 15) return "ok";
  if (a <= 60) return "warn";
  return "error";
}

/** "+1:23" / "−0:09" / "on time" — signed, so early vs late is readable at a glance. */
export function fmtDrift(driftSec: number | null): string {
  if (driftSec === null || !Number.isFinite(driftSec)) return "—";
  const a = Math.abs(Math.round(driftSec));
  if (a === 0) return "on time";
  const sign = driftSec < 0 ? "−" : "+";
  return a < 60 ? `${sign}${a}s` : `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
}

/** 12-hour with AM/PM, matching the on-air clock in the header — an operator reads "1:19:50 PM", not
 *  "13:19:50". Seconds are kept: this table is about drift, and drift is measured in seconds. */
export function fmtClock(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "—";
  return new Date(sec * 1000).toLocaleTimeString([], { hour12: true });
}

/**
 * OpenAir Scheduler Engine
 * 
 * Pure TypeScript — no Tauri/Rust dependency.
 * Runs in the renderer process or can be extracted to a worker.
 * 
 * Responsibilities:
 *   1. Given a ClockWithSlots + candidate pool, fill a log hour
 *   2. Score each candidate against active scheduling rules
 *   3. Return ordered LogEntry[] or dry-run preview
 */

import type {
  ClockWithSlots, ClockSlot, SongView, SpotView,
  LogEntry, LogHour, SchedulingRule, SchedulerCandidate,
  RuleViolation, GenerateLogOptions, Category,
} from '../types/models';
import { DaypartMask } from '../types/models';

// ============================================================
// TYPES (local to scheduler)
// ============================================================

interface SchedulerContext {
  date: string;
  hour: number;
  clock: ClockWithSlots;
  rules: SchedulingRule[];
  /** Songs played in the last N hours, ordered newest-first */
  recentHistory: RecentPlay[];
  /** All eligible songs grouped by category_id */
  songPool: Map<number, SongView[]>;
  /** All eligible spots */
  spotPool: SpotView[];
}

interface RecentPlay {
  song_id: number;
  artist_id: number | null;
  played_at: number;     // unix timestamp
  played_hour: number;
}

interface SlotFill {
  slot: ClockSlot;
  song?: SongView;
  spot?: SpotView;
  violations: RuleViolation[];
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

/**
 * Generate a log hour from a clock definition + candidate pool.
 * Returns the filled slot list. Caller persists to DB.
 */
export function generateHour(ctx: SchedulerContext): SlotFill[] {
  const filled: SlotFill[] = [];
  // Track what we've scheduled THIS hour for intra-hour separation
  const scheduledThisHour: RecentPlay[] = [];

  for (const slot of ctx.clock.slots) {
    if (slot.slot_type === 'music') {
      const fill = fillMusicSlot(slot, ctx, scheduledThisHour);
      filled.push(fill);
      if (fill.song) {
        scheduledThisHour.push({
          song_id: fill.song.id,
          artist_id: fill.song.artist_id,
          played_at: Date.now(),
          played_hour: ctx.hour,
        });
      }
    } else if (slot.slot_type === 'spot_break') {
      filled.push(fillSpotSlot(slot, ctx));
    } else {
      // liner, sweeper, talkset, etc. — no selection logic needed
      filled.push({ slot, violations: [] });
    }
  }

  return filled;
}

// ============================================================
// MUSIC SLOT FILL
// ============================================================

function fillMusicSlot(
  slot: ClockSlot,
  ctx: SchedulerContext,
  scheduledThisHour: RecentPlay[],
): SlotFill {
  const categoryId = slot.category_id;
  if (!categoryId) {
    return { slot, violations: [{ rule_id: null, rule_type: 'song_separation', message: 'No category assigned to slot', is_hard: true }] };
  }

  const candidates = ctx.songPool.get(categoryId) ?? [];
  if (candidates.length === 0) {
    return { slot, violations: [{ rule_id: null, rule_type: 'song_separation', message: `No eligible songs in category ${categoryId}`, is_hard: true }] };
  }

  const allHistory = [...scheduledThisHour, ...ctx.recentHistory];
  const scored = candidates.map(song => scoreSong(song, ctx.rules, allHistory, ctx.hour));
  scored.sort((a, b) => b.score - a.score);

  // First hard-rule-passing candidate wins
  const winner = scored.find(c => c.violations.filter(v => v.is_hard).length === 0)
    ?? scored[0]; // fallback: least-violations song

  return {
    slot,
    song: winner.song,
    violations: winner.violations,
  };
}

// ============================================================
// SCORING
// ============================================================

/**
 * Score a candidate song against all active rules.
 * Higher score = better fit. Hard violations are tracked separately.
 */
function scoreSong(
  song: SongView,
  rules: SchedulingRule[],
  history: RecentPlay[],
  currentHour: number,
): SchedulerCandidate {
  const violations: RuleViolation[] = [];
  let score = 1000;

  for (const rule of rules) {
    if (!rule.is_active) continue;
    // Check if rule applies to this song's category or globally
    if (rule.scope === 'category' && rule.scope_id !== song.category_id) continue;
    if (rule.scope === 'song' && rule.scope_id !== song.id) continue;

    const result = applyRule(song, rule, history, currentHour);
    if (result) {
      violations.push(result);
      score += result.is_hard ? -10000 : -100;
    }
  }

  // Positive scoring: prefer songs not played recently
  const lastPlayed = song.last_played_at;
  if (lastPlayed) {
    const hoursSincePlayed = (Date.now() / 1000 - lastPlayed) / 3600;
    score += Math.min(hoursSincePlayed * 10, 200); // up to +200 for 20+ hours
  } else {
    score += 300; // never played = high priority
  }

  // Prefer songs with fewer total spins (fairness)
  score -= song.spins_this_week * 2;

  return { song, score, violations, warnings: violations.filter(v => !v.is_hard) };
}

// ============================================================
// RULE APPLICATION
// ============================================================

function applyRule(
  song: SongView,
  rule: SchedulingRule,
  history: RecentPlay[],
  currentHour: number,
): RuleViolation | null {
  switch (rule.rule_type) {
    case 'song_separation': {
      const minHours = rule.value_int ?? 2;
      const lastSongPlay = history.find(h => h.song_id === song.id);
      if (lastSongPlay) {
        const hoursSince = (Date.now() / 1000 - lastSongPlay.played_at) / 3600;
        if (hoursSince < minHours) {
          return {
            rule_id: rule.id,
            rule_type: 'song_separation',
            message: `"${song.title}" played ${hoursSince.toFixed(1)}h ago (min: ${minHours}h)`,
            is_hard: rule.is_hard_rule,
          };
        }
      }
      return null;
    }

    case 'artist_separation': {
      const minHours = rule.value_int ?? 1;
      const lastArtistPlay = history.find(h => h.artist_id === song.artist_id);
      if (lastArtistPlay && song.artist_id) {
        const hoursSince = (Date.now() / 1000 - lastArtistPlay.played_at) / 3600;
        if (hoursSince < minHours) {
          return {
            rule_id: rule.id,
            rule_type: 'artist_separation',
            message: `"${song.artist_name}" played ${hoursSince.toFixed(1)}h ago (min: ${minHours}h)`,
            is_hard: rule.is_hard_rule,
          };
        }
      }
      return null;
    }

    case 'daypart_restriction': {
      if (!DaypartMask.includesHour(song.daypart_mask, currentHour)) {
        return {
          rule_id: rule.id,
          rule_type: 'daypart_restriction',
          message: `"${song.title}" not scheduled for hour ${currentHour}`,
          is_hard: true, // always hard — daypart is explicit
        };
      }
      return null;
    }

    case 'energy_flow': {
      if (!rule.value_json) return null;
      const { min_delta, max_delta }: { min_delta?: number; max_delta?: number } =
        JSON.parse(rule.value_json);
      const lastSong = history[0];
      // We'd need the last song's energy — this requires joining history
      // For now, return null (implement when history carries energy)
      return null;
    }

    case 'gender_balance': {
      if (!rule.value_int) return null;
      const maxConsec = rule.value_int;
      // Count consecutive same-gender at head of history
      const recentGenders = history.slice(0, maxConsec).map(h =>
        (h as any).gender as string | undefined
      );
      const allSameGender = recentGenders.every(g => g === song.gender);
      if (recentGenders.length >= maxConsec && allSameGender && song.gender !== 'unknown') {
        return {
          rule_id: rule.id,
          rule_type: 'gender_balance',
          message: `${maxConsec} consecutive ${song.gender} voices`,
          is_hard: rule.is_hard_rule,
        };
      }
      return null;
    }

    default:
      return null;
  }
}

// ============================================================
// SPOT SLOT FILL
// ============================================================

function fillSpotSlot(slot: ClockSlot, ctx: SchedulerContext): SlotFill {
  const now = new Date().toISOString().split('T')[0];
  const eligible = ctx.spotPool.filter(spot => {
    if (!spot.is_active) return false;
    if (spot.start_date && spot.start_date > now) return false;
    if (spot.end_date && spot.end_date < now) return false;
    if (spot.max_plays_per_day && spot.spins_today >= spot.max_plays_per_day) return false;
    if (!DaypartMask.includesHour(spot.daypart_mask, ctx.hour)) return false;
    return true;
  });

  eligible.sort((a, b) => {
    // Prioritize: fewer plays today, higher priority score
    const aScore = a.priority - a.spins_today * 10;
    const bScore = b.priority - b.spins_today * 10;
    return bScore - aScore;
  });

  return { slot, spot: eligible[0], violations: [] };
}

// ============================================================
// UTILITY EXPORTS
// ============================================================

/** Convert SlotFill[] → LogEntry[] for DB persistence */
export function slotFillsToLogEntries(
  fills: SlotFill[],
  logHourId: number,
  startWallClock: string, // "HH:00:00"
): Omit<LogEntry, 'id'>[] {
  let runningMs = 0;
  const [startH, startM, startS] = startWallClock.split(':').map(Number);
  const startTotalMs = (startH * 3600 + startM * 60 + startS) * 1000;

  return fills.map((fill, idx) => {
    const durationMs = fill.song?.duration_ms
      ?? fill.spot?.duration_ms
      ?? fill.slot.duration_ms
      ?? 0;

    const absoluteMs = startTotalMs + runningMs;
    const h = Math.floor(absoluteMs / 3600000) % 24;
    const m = Math.floor((absoluteMs % 3600000) / 60000);
    const s = Math.floor((absoluteMs % 60000) / 1000);
    const scheduledTime = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;

    runningMs += durationMs;

    return {
      log_hour_id: logHourId,
      position: idx,
      slot_type: fill.slot.slot_type,
      song_id: fill.song?.id ?? null,
      spot_id: fill.spot?.id ?? null,
      scheduled_time: scheduledTime,
      actual_time: null,
      duration_ms: durationMs,
      status: 'pending',
      played_at: null,
      override_reason: fill.violations.length > 0
        ? fill.violations.map(v => v.message).join('; ')
        : null,
      notes: null,
    };
  });
}

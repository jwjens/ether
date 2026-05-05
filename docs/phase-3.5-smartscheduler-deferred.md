# Phase 3.5 Deferral — SmartScheduler.tsx

## Status: Deferred — schema mismatch, not a simple migration

## Component is reachable

`SmartScheduler` renders at `App.tsx:1459` when `panel === "smartschedule"`,
gated to `admin` / `music_director` roles. It is live, not dead code.

## The problem

The DB write path at lines 153–160 has been silently failing since Commit 2 landed
the `db:execute` synced-table guard. The `localStorage` path at line 151 is the only
persistence today — rules survive a session reload only because of that.

**Line 153:** `execute("DELETE FROM smart_schedule_rules WHERE station_id = ?", ...)`
— blocked by `SYNCED_TABLES_SET` guard, fails silently.

**Lines 156–160:** `executeScopedInsert("INSERT OR REPLACE INTO smart_schedule_rules (id, data) VALUES (?, ?)", ...)`
— the `smart_schedule_rules` schema has no `id` (string) or `data` columns.
The actual columns are `rule_type, scope, value, is_hard, is_active, description`
(matching the separation-rules pattern). A column mismatch error would fire even
if the guard weren't blocking it first.

## Root cause

`SmartScheduler`'s `SmartRule` type is an AI-generated rule object
`{ id: string, description: string, ... }` with a free-form shape — it does not
map to the `smart_schedule_rules` table schema at all.

## Decision needed before migration

1. Does `smart_schedule_rules` stay in its current separation-rules-style schema,
   and `SmartScheduler` gets refactored to write individual field rows?
2. Or does `smart_schedule_rules` get a new schema (`id TEXT, data TEXT`) that
   matches what the component actually writes?
3. Or does `SmartScheduler` get its own dedicated table?

Until that decision is made, `localStorage` remains the only persistence.
Migrating the broken writes as-is would lock in a wrong schema.

## What the code looks like today (SmartScheduler.tsx)

```typescript
// line 151 — localStorage path: works correctly
localStorage.setItem("ether_smart_rules", JSON.stringify(r));

// line 153 — BROKEN: blocked by db:execute guard + wrong table usage
execute("DELETE FROM smart_schedule_rules WHERE station_id = ?", [stationId]).catch(() => {});

// lines 156-160 — BROKEN: blocked by guard + column names don't exist in schema
executeScopedInsert(
  "INSERT OR REPLACE INTO smart_schedule_rules (id, data) VALUES (?, ?)",
  [rule.id, JSON.stringify(rule)],
  stationId
).catch(() => {});
```

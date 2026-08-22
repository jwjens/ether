# v4.4.229 second CI block — proc-meters carried an integer station id

**Date:** 2026-08-21 · **Run:** Build Ether (re-tag) · **Gate:** `scripts/test-station-identity-leak.js`
**Result:** `14 integer-station emit-calls > baseline 13` → all three platform build jobs failed.

## Not a new leak — a newly *visible* one

The guard is textual:

```js
/(broadcast|sendToAllWindows|webContents\.send)\([^)]*\bstationId\b/g
```

`f76ca2c` (2026-08-18) changed the emit:

```diff
- sendToAllWindows("audio:proc-meters", m);
+ sendToAllWindows("audio:proc-meters", { ...m, stationUuid: _stationUuidById(m.stationId) });
```

`m` **always** contained an integer `stationId` — every consumer filtered on it. The guard could not
see it because the old line never spelled the word. The new line does, inside the UUID *lookup*.

So the line was flagged **because it was migrated toward UUIDs**, and `13` was an undercount:
proc-meters had been leaking an integer identity across the boundary for the last 13 tags, invisibly.

## What was actually wrong

Consumers were split three ways:

| Consumer | Filtered on | After |
|---|---|---|
| `src/components/health/HealthMeters.tsx:120` | `m.stationUuid` (already migrated) | unchanged |
| `src/components/HealthMonitor.tsx:933` | `m.stationId` (integer) | `m.stationUuid` |
| `src/components/SettingsPanel.tsx:744` (`AudioProcessingSection`) | `m.stationId` (integer) | `m.stationUuid` |

## The fix (3 files, 22 insertions)

`electron/main.js` — hoist the UUID lookup off the emit line and drop the integer from the payload:

```js
const _procUuid = _stationUuidById(m.stationId);
const { stationId: _procIntId, ...procFrame } = m;
sendToAllWindows("audio:proc-meters", { ...procFrame, stationUuid: _procUuid });
```

`_noteProcSample(m)` still receives the full frame — that is internal retention, not a boundary
crossing, so the integer stays available where it is legitimate.

Both renderer consumers adopt HealthMeters' proven pattern, which never lets the meters go dark:

```js
if (!m) return;
if (stationUuid && m.stationUuid != null && m.stationUuid !== stationUuid) return;
```

**BASELINE was NOT raised** — it stays 13, and the guard now reports exactly 13 (no stale-baseline
warning either). The ratchet rule held: migrate the channel, never move the number.

## Rejected

- **Raise BASELINE to 14.** Forbidden by the ratchet's own contract.
- **Hoist the lookup only, keeping `...m`.** One line, CI green, zero behaviour change — and
  dishonest: it restores the guard's blind spot while the integer stays in the payload.

## Gates after the fix

| Gate | Result |
|---|---|
| `scripts/test-station-identity-leak.js` | 13 = baseline ✅ |
| `scripts/check-no-global-audio-statics.js` | pass ✅ |
| `npx tsc --noEmit` | exit 0 ✅ |
| `npx vitest run` | 24 files / 332 tests ✅ |

## UNVERIFIED — needs Jeff's eyes

Static gates cannot prove a meter renders. After installing the published 4.4.229:

1. **Settings → Audio Processing** — turn a processing toggle on with audio flowing; IN/OUT LUFS,
   GR and peak must move (not sit null/idle).
2. **Health Monitor → program meters** — same frame, second subscriber; must track, not go dark.

If either stays blank, the cause is `stationUuid` being empty for the active station, not the frame:
the fallback deliberately renders untagged frames, so a *blank* panel means the frame is tagged with
a uuid that does not match `useActiveStation().stationUuid`.

## Standing gap (second receipt)

`build.yml` runs the leak-guard **only on a `v*` tag**, so this sat red from 2026-08-18 until the
release attempt three days later — the same tag-only-CI blind spot recorded in
`docs/ci-test-isolation-2026-08-21.md`. Two blockers in one release, both from gates nobody can see
between tags.

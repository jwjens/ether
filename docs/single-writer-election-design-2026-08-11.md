# Single-writer: DESIGNATION (supersedes the lease election)

**Date:** 2026-08-11 - **Status:** Phase A built in 4.4.188 (observability only).

---

## 0. THE LEASE APPROACH IS CONSIDERED AND SUPERSEDED

A competing lease with heartbeat and expiry was designed, built and shipped in **4.4.187**, then
retired the same day. It is recorded rather than deleted, because the reasoning is the useful part.

**Why it went:** the lease existed to arbitrate automatically between machines. But takeover had
already been ruled **human-only** (no silent seizure of OV's station), and the runway gauge makes a
stalled generator visible for days before it matters. Automatic failover was solving a problem the
operator was already going to see and decide. What remained was competition machinery - expiry,
split-brain, HLC tiebreak - carrying real complexity for a decision nobody wanted made automatically.

**Retired in 4.4.188:** `electron/generation-lease.js`, its 15 tests, the 5-minute heartbeat and the
Health Monitor lease row are deleted. `kill_lease` is migrated to `kill_designation`, then removed.

**Correction carried forward:** the earlier doc cited `synced-tables.js:327` as proof that
`station_config_kv` supports synced keys. That line is `generated_schedule.source: 'local-only'` -
wrong table. Real receipts: **line 49** lists `station_config_kv` among the synced tables, **line 833**
registers it with `scope: 'station'`. Only `LOCAL_ONLY_KEYS` are withheld.

---

## 1. The designation model

| | |
|---|---|
| **Record** | synced `station_config_kv` key `designated_generator` |
| **Value** | `{ machine_id, machine_name, designated_at, last_checked, last_generated }` |
| **Written by** | explicit operator action, or first-auto-generate when no record exists |
| **Never** | taken automatically from a machine that already holds it |

**The gate (Phase B):** a machine auto-generates only if it is designated **and** has
`auto_generate_enabled` locally. Non-designated machines sync only.

**Heartbeat:** the designated machine stamps `last_checked` on each `_autoExtendTick` (30 min) - proof
it is alive and watching. `last_generated` is stamped separately, only when the log is actually
extended. **The two are deliberately distinct:** a machine can be healthy and watching while
generating nothing because the runway is long, and conflating them would make a working station look
idle.

**Zero-config:** a station with no record designates the machine that next auto-generates it, with one
transition event. A single-machine station needs no configuration at all.

**Kill switch:** `kill_designation` (local). Set to "1" and every switched-on machine generates -
today's behaviour, restored without a release.

---

## 2. Phase A is observability only

`_autoExtendTick` is **not** gated. Every switched-on machine still generates exactly as before. Phase
A exists so the display can be proven correct across two real machines for a week before it is allowed
to stop one of them generating.

---

## 3. PIN - inventoried, NOT built (Phase C)

A PIN primitive already exists: `users.pin_hash`, 4-digit, per-station, set in Settings > Users.
**Two defects found, both material to a takeover gate:**

1. **Plaintext fallback.** `SettingsPanel.tsx:3313` writes the raw PIN into `pin_hash` when the hashing
   IPC is unavailable - a column whose name asserts otherwise.
2. **`users` does not sync.** Absent from `synced-tables.js`, so a PIN set on OV does not exist on dev,
   and a PIN-gated takeover on dev could never verify it.

**Phase C therefore needs an ACCOUNT-level PIN**, synced, distinct from the per-station operator PINs:
a takeover is an account-owner decision, not a shift operator's, and this avoids moving per-station
credential material between machines. Design and review before any PIN code is written.

---

## Appendix - the superseded lease design (historical)

(no prior doc found)

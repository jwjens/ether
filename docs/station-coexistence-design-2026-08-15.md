# Account coexistence on one install — confirm + design (2026-08-15)

Read-only. Nothing built. This is the design Jeff reads before any build.

---

## 1. The history — verdict

**Partly confirmed, and the causal half is wrong.**

Multiple accounts' stations *could* sit in the local `stations` table at once — nothing prevents it, then
or now. But **not** "because it had no ownership column." The column has existed since **2026-06-17**.

| Receipt | |
|---|---|
| `afc43de` 2026-06-17 | `feat(accounts): scope station visibility to the signed-in account` — introduces `owner_license_key` |
| `710a13c` 2026-06-18 | `fix(stations): account-scope the station list resiliently — show, do not hide (v4.3.84)` |
| `9d4b605` 2026-06-24 | universal station register + **owner self-heal** in reconcile |
| `6652594` 2026-07-05 | `fix(v2): TOTAL sign-out invariant + signup routed through clean-room decision table` |
| `fcee8cd` 2026-07-05 | `fix(v2): clean-room sign-in` — the wipe on the sign-in path |
| `1d2811b` 2026-07-06 | account-aware clean-room (stops the reboot data-loss of v4.4.31) |

So the clean-room work landed **5–6 July**, not the 13th, and it landed *after* ownership existed.

**The real reason coexistence was unsafe is that ownership is recorded but never enforced.** The schema
comment says so in the tree today — `electron/main.js:1794-1800`:

> *"this column is recorded but NOT currently enforced at the list layer — `stations:list` and
> `:get-active` … return ALL local non-deleted rows regardless of `owner_license_key` / the signed-in
> account. License-scoped visibility is intentionally deferred to the v4.5 account-vs-license rework."*

Still true, verbatim, in the current build:

```js
// electron/main.js:8501
ipcMain.handle('stations:list', () =>
  getDb().prepare("SELECT * FROM stations WHERE deleted_at IS NULL ORDER BY id").all()
);
// electron/main.js:8505
ipcMain.handle('stations:get-active', () =>
  getDb().prepare("SELECT * FROM stations WHERE is_active=1 AND deleted_at IS NULL LIMIT 1").get() ?? null
);
```

**One-line verdict:** coexistence was always structurally possible and is still unenforced — the
clean-room wipe is not a side effect, it *is* the account-separation mechanism, and removing it without
scoping first would leak one account's stations into another's view.

---

## 2. PRIOR ART — this was already designed and parked. Do not rebuild it.

`docs/ensurecleanroom-scoping-2026-07-07.md` (commit `f176d85`, *"ensureCleanRoom removal blocked on v4.5
list-scoping (verified fail); no code changed"*) contains this exact design, its proof, and its sequencing.
It even proved the leak on a throwaway 2-owner copy: with jensj's rows plus one synthetic second owner,
`stations:list` returned **all** rows to either account.

Its verdict and sequence stand unchanged:

1. enforce scoping at the list layer,
2. prove it on a 2-owner copy,
3. *then* remove the wipe.

`ffaafde` (2026-07-08) recorded the same order as the next session's priority. **Nothing has changed since**
— I re-checked the handlers above. This document extends that one with what a year of newer data now shows;
it does not replace it.

---

## 3. The design

### Principle
**Signing in is a read, not a write.** It may change what you *see*. It must never delete anything.

### 3.1 Ownership is the filter
`stations.owner_license_key` becomes the scope key at the **list layer**, filtered by the *signed-in
account's* license — never by the active-station anchor, which is circular (the anchor is derived from a
station, so it cannot decide which stations are visible).

Verified on the live DB — the column is populated and internally consistent:

```
id=1 owner=ETH-STN-BAA8-E056-6FC8 "Open Format"
id=2 owner=ETH-STN-BAA8-E056-6FC8 "halloVeen"        (active)
id=3 owner=ETH-STN-BAA8-E056-6FC8 "Magical Forest"
id=4 owner=ETH-STN-BAA8-E056-6FC8 "Christmas in Jully"
distinct owners: 1        orphans (NULL): 0
per-station KV license_key and license_email agree with the column on all four rows
```

It is trustworthy **on this machine**. It is not *proven* trustworthy in general: the backfill
(`main.js:1805-1818`) only fills NULLs from per-station KV, so a station created by a build older than
2026-06-17 that never carried a per-station `license_key` stays NULL. Orphans are deliberately not
deleted. **The design must decide what an orphan means** — see Open Decisions.

### 3.2 Sign-in stops wiping
`ensureCleanRoom` (`OnboardingFlow.tsx:534-560`) loses its wipe. A different-account sign-in **proceeds**:

- account's stations resolve from `/account/connect` as they do now (`OnboardingFlow.tsx:376-450`);
- **zero stations → the existing `addStation` path, untouched** (`:428`);
- jensj signs in → sees his four, because they carry his license;
- the other account's rows stay on disk, hidden, intact.

Switching back is then instant and lossless — the payoff the July doc already recorded.

### 3.3 Clean-room survives as a deliberate act only
One explicit **Factory Reset** in Preferences, typed confirmation (the word, not a button), naming what it
destroys. Never reached by signing in. The machinery already exists and is sound — `cleanRoomReset` now
refuses to relaunch on a failed wipe (`5c93322`), so a reset that cannot complete says so instead of
looping.

---

## 4. Blast radius — honest

### 4.1 Station read paths: 35 SQL reads of `stations`, 10 of them unscoped all-station sweeps
`grep -rn "FROM stations" electron/` → 35. Most take an explicit `id` and are safe by construction. The
ones that enumerate *every* station are the exposure, because each becomes a cross-account actor the moment
two accounts coexist:

| Site | What it does with every station |
|---|---|
| `main.js:8502` | `stations:list` — the UI list. **The leak the July doc proved.** |
| `main.js:8505` | `stations:get-active` — can hand back another account's station |
| `main.js:7563` | designation tick |
| `main.js:7659` | auto-generate / runway sweep |
| `main.js:7748` | **deletion sweep** — releases R2 audio |
| `main.js:7933` | `_autoExtendTick` — builds logs |
| `main.js:3933` | station id sweep |
| `main.js:8512` | `stations:switch` — deactivates "others" |
| `main.js:8705` | diagnostics dump |
| `library-health.js:45` | health across stations |

Two deserve naming: **`7933` would build playout logs for a signed-out account's stations**, and **`7748`
would release that account's R2 audio**. Both are unattended writers. Scoping the list layer alone does
**not** fix them — they query `stations` directly, not through the IPC handler.

### 4.2 Sync: two accounts, one push identity — the sharpest edge
`electron/sync/transport-http.js:127-129` resolves **one** license key for the whole install:

```
install_config_kv.account_license_key
  → any station's owner_license_key (ORDER BY is_active DESC, id ASC)
    → any station_config_kv license_key
```

With two accounts resident, **every mutation from both is pushed under whichever key wins** — account B's
edits land in account A's cloud. The transport has no concept of per-mutation ownership.

The local `mutations` table *can* attribute most rows (`station_id`, `station_uuid` present), but:

```
mutations rows                     509,991
mutations with station_id IS NULL   10,746
```

Those 10,746 are the account-scoped tables (library and friends). **They cannot be attributed to an account
at all** — there is nothing to attribute them by.

This is not a scoping tweak. It is a per-account push identity, and it is the largest piece of work in the
design. (Related and already known: peer-sync routes by local station INTEGER rather than UUID — a separate
defect, not created by this work but colliding with it.)

### 4.3 Station-scoped data: mostly free — with one exception that decides the whole design
Measured on the live DB:

```
generated_schedule   station_id=YES   129,662
play_log             station_id=YES    47,153
station_config_kv    station_id=YES        76
shows / clocks / categories / spots / station_programming / jingle_categories  station_id=YES
songs                station_id=NO        543     <-- THE LIBRARY
```

Everything that hangs off a station scopes for free once station visibility is scoped.

**`songs` has no `station_id` and no owner column of any kind.** The library is account-scoped by
*assumption* — the same fact the deletion-sweep work relied on ("the `songs` table has no station_id column
at all — the library is ACCOUNT-scoped, shared across the stations on the account"). With two accounts
resident on one install:

- both libraries occupy one table with nothing distinguishing them;
- every music selector, the generator, search, rotation and Library view would see both;
- the deletion sweep's sole-reference check spans both accounts, so **account A deleting a song could
  release audio account B still references** — or be blocked by a `permanent_shared` hold from an account
  the operator cannot even see.

**This is the blocker.** Station coexistence without library ownership is not a smaller version of the
feature; it is a different and worse product — mixed libraries are exactly the "two accounts bleeding into
each other" failure the wipe exists to prevent. `songs` needs an owner column, backfilled from the
station-KV license the same way `stations` was in June, before the wipe can come out.

---

## 5. Sequence (each step independently revertable)

1. **`songs` ownership** — add `owner_license_key`, backfill, prove on a 2-owner copy. *Blocking.*
2. **List-layer scoping** — `stations:list` / `:get-active` filtered by the signed-in account. Prove the
   July doc's 2-owner test now returns only the caller's rows.
3. **Scope the unattended writers** — the 10 sweeps in §4.1, especially `_autoExtendTick` (7933) and the
   deletion sweep (7748).
4. **Per-account push identity** in the sync transport (§4.2), or an explicit decision that sync is
   single-account-per-install and the second account is local-only until switched to.
5. **Only then** remove the wipe from `ensureCleanRoom` and move clean-room behind a typed Factory Reset.

Steps 1–4 are the work. Step 5 is three lines.

---

## 6. Open decisions for Jeff

1. **Orphans.** A station with `owner_license_key IS NULL` (older build, no per-station KV) — visible to
   everyone, visible to no one, or adopted by the first account that signs in? Hiding them risks a customer
   whose station vanishes after an update; showing them re-opens the leak. *Recommendation: visible, with a
   one-time "which account owns this?" prompt — never silently adopted.*
2. **Sync scope.** Full per-account push identity (§4.2, large), or "only the signed-in account syncs; the
   resident account is local-only until you switch to it" (small, and arguably correct — a signed-out
   account should not be talking to the cloud)? *Recommendation: the second.*
3. **Does the library follow the account, or the install?** §4.3 assumes per-account. If a shared library
   across accounts on one machine is ever wanted, say so now — it changes the column and the sweep.
4. **Scope of this build.** Jeff's ask was coexistence. Steps 1–4 are considerably more than the three-line
   step 5. If the immediate need is only "the customer can sign in without being wiped", there is a much
   smaller change available: keep the wipe, but require an explicit typed confirmation before it runs — the
   operator is told their machine holds another account and chooses. That ships this week and destroys
   nothing silently; full coexistence follows.

---

## Status

Nothing built. `5c93322` (the loop fix) is the only related change in the tree, and it is independent of
everything above. The July park (`f176d85`) remains the governing prior design; this document extends it
with the library finding (§4.3) and the sync push-identity finding (§4.2), neither of which it covered.

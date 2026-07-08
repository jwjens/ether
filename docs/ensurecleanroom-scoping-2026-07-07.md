# ensureCleanRoom removal — BLOCKED on list-scoping (2026-07-07)

Task: verify `owner_license_key` station-scoping, then remove `ensureCleanRoom`. **Result: scoping check
FAILED → removal STOPPED per Jeff's rule ("if scoping fails, make scoping true before the wipe comes
out").** Read-only; nothing changed. Receipts below.

## The scoping check — FAILED
1. **`stations:list` is unfiltered** — `electron/main.js:6197`:
   `getDb().prepare("SELECT * FROM stations WHERE deleted_at IS NULL ORDER BY id").all()` — no
   `owner_license_key`, no account filter. `stations:get-active` (`:6201`) same.
2. **The schema comment says so outright** — `electron/main.js:893-897`: *"this column is recorded but NOT
   currently enforced at the list layer — `stations:list` and `:get-active` … return ALL local non-deleted
   rows regardless of owner_license_key / the signed-in account. License-scoped visibility is intentionally
   deferred to the v4.5 account-vs-license rework."*
3. **Real-data proof (this machine):** the live DB currently holds **one** owner —
   `ETH-STN-BAA8-E056-6FC8` (jensj), 3 stations (OV, Halloween, Magical Forest). The djdeniro history is
   **already gone** — wiped by a prior `ensureCleanRoom`. That absence is the tell: **the wipe IS the
   current account-separation mechanism**, not scoping.
4. **2-owner demonstration (throwaway copy, synthetic second owner — no customer data):** with jensj's 3
   rows + 1 synthetic `SYNTHETIC-OTHER-ACCT` row, the exact `stations:list` query returns **all 4 rows**.
   A sign-in as either account sees both, including the other account's station. **Scoping NOT enforced.**

Proof tool committed: `scripts/diag-station-scoping.js` (read-only; run via electron-as-node against a
COPY). The synthetic-2-owner step ran only on a scratchpad copy.

## Why removal is blocked
`ensureCleanRoom` (account-aware, `OnboardingFlow.tsx:471-486`) wipes on a different-account switch. Today
that wipe is the **only** thing preventing cross-account leak, because the list layer shows everything.
**Remove the wipe now and an A→B switch leaks A's stations into B's view** (proven above). So removal is
gated on list-scoping.

## Corrected fix — "make scoping true" FIRST
Enforce `owner_license_key` at `stations:list` + `stations:get-active`, filtered by the **signed-in
account's** license (not the active-station anchor, which is circular). This is the deferred v4.5
account-vs-license work (`docs/account-license-architecture-v4.5.md`). Sequence:
1. Implement list-layer scoping (signed-in account → its license key(s) → filter stations).
2. Prove it on a 2-owner DB copy: each account sees only its own rows.
3. THEN remove `ensureCleanRoom` + its two call sites (`OnboardingFlow.tsx:494,689`).

## Design payoff (recorded, per Jeff) — why this is worth doing right
With the wipe gone **and** scoping enforced, an A→B account switch **preserves A's local data
hidden-but-intact** — so switching **back** to A is instant with everything still there (imports,
categories, stations, session). That's account-switching-as-first-class, correct **by construction**
rather than by destroying the other account's data. It cannot be achieved by removing the wipe alone; it
requires scoping to land first.

## Status
- ensureCleanRoom: **UNCHANGED** (removal blocked). Stays as the account-separation mechanism until
  list-scoping lands.
- OPEN item reclassified: "ensureCleanRoom removal" → **depends on v4.5 list-layer scoping.**

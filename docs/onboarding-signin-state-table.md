# Sign-in / Onboarding — State Table (the MONDAY GATE)

Every reachable state of the sign-in + onboarding flow (post Phase-4 rework), what the user sees, and at
least one path forward from each. **No undefined branches, no generic failure screens, no dead ends.**
"Nothing to sync yet" is a NORMAL state with a normal screen — the old "Sync failed" dead-end was an
*unenumerated* state getting a generic error; the cure is enumeration, not error copy.

**Status legend:** ✅ demonstrated on this box · 🔶 Monday-verified (packaged / jensj / OV — not yet run) ·
⛔ OPEN (needs a fix or a test before Monday) · 🔒 deferred post-launch (by decision).

Source of truth for behavior: `src/components/OnboardingFlow.tsx` (doSignIn + decision table + provisionAttached),
`src/App.tsx` (render gate + reconcile), `src/lib/provisioning.js` (attachment-aware materialize),
`electron/main.js` (factory reset, renderer smoke).

---

## A. Boot / render gate (App.tsx)

| # | State | Trigger | User sees | Path(s) forward | Status |
|---|-------|---------|-----------|-----------------|--------|
| A1 | Splash / booting | app launch | splash → auto-advance | automatic → A2 or A3 | ✅ |
| A2 | Account sign-in required | no valid account session | OnboardingFlow `auth` | sign in / sign up → B | ✅ |
| A3 | Session valid → app | valid session present | UserLogin (profile PIN) → OnShift → main app | operate | ✅ (existing) |
| A4 | Renderer fails to load | module/render exception at boot | (was) blank white window | **guarded**: smoke check catches pre-ship; `did-fail-load` force-shows the window | dev ✅ / packaged 🔶 |

> **Packaged-smoke coverage caveat:** `smoke-renderer.ps1 -Mode packaged` launches the packaged **renderer bundle under an Electron binary** — it verifies the renderer mounts, but it is **NOT** the true installer output (NSIS install, asar packing, code signing, auto-update delivery). A green packaged smoke ≠ installer coverage. Real installer verification is a separate step (install the built artifact, launch it, smoke that).

## B. Sign-in → station-provisioning decision (post-auth, `doSignIn`)

| # | State | Trigger | User sees | Path(s) forward | Status |
|---|-------|---------|-----------|-----------------|--------|
| B1 | Auth screen | A2 | email + password (sign in / sign up) | submit → decision table | ✅ |
| B2 | Invalid credentials | desktop-activate 401 | inline error on auth screen | re-enter → B1 | ✅ |
| B3 | Account owns **0** stations | `res.ok` + `stations:[]` | create-your-station (`addStation` → wizard) | create a station → done | ✅ (normal, NOT an error) |
| B4 | Account owns **1** station | `stations:[one]` | *(nothing — silent)* → station on screen | auto: monitor-attach + materialize → done | ✅ **DEMONSTRATED (djdeniro)** |
| B5 | Account owns **≥2** stations | `stations:[…]` | `placement`: "Which stations does this machine run?" (checkboxes, min one) | pick ≥1 → monitor-attach chosen → materialize → done | 🔶 (OV 3-station, during authoring) |
| B6 | Placement, none checked | on `placement` | Continue disabled | check ≥1 | ✅ |

## C. Failure / edge during sign-in

| # | State | Trigger | User sees | Path(s) forward | Status |
|---|-------|---------|-----------|-----------------|--------|
| C1 | **Server unreachable (flaky network)** | `/account/connect` fetch throws (status 0) | "Couldn't reach the server to load your stations — try Sign in again" (never falls through to create) | ✅ **FIXED v4.4.65** — status-branched message in `routeAfterAuth` |
| C2 | **Sign-in mid-deploy** | backend 502/restarting → non-OK HTTP | "The server couldn't load your stations right now (error N) — try again in a moment" | ✅ **FIXED v4.4.65** — 5xx/other non-OK branch (retry, not create) |
| C3 | **Seat limit reached** | `/account/connect` 403 | "This account's devices are full — free one (Manage Devices)" | ✅ **FIXED v4.4.65** — 403 branch (Manage Devices affordance still backlog) |
| C3b | **Invalid license key** | `/account/connect` 401 `invalid_license_key` (rotated/revoked/mis-stamped) | "Your account's license was rejected — contact support to restore it" | ✅ **FIXED v4.4.65** — 401 branch. Root-cause diag: `docs/signin-couldnt-reach-server-diagnosis-2026-07-20.md` |
| C3c | **Trial expired** | `/account/connect` 401 `trial_expired` (license `expires_at` past — a lapsed trial, distinct from a bad key) | "Your free trial has ended. Your stations and library are safe — pick a plan to keep broadcasting." + **Choose a plan** button → `renew_url` (external browser) | ✅ **FIXED v4.4.66** — backend `lookupLicenseDetailed` returns distinct `trial_expired` body; desktop copy+button branch. Data-safety verified (expiry gates access, never deletes). Root cause: `docs/license-trial-expiry-401-rootcause-2026-07-20.md`. Help: `docs/help-trial-ended.md` |
| C4 | Interrupted provisioning mid-sign-in | attach/reconcile fails after auth | station simply not yet on screen | fail-closed (nothing materialized) → retry on 20s poll; idempotent add-only | ✅ **DEMONSTRATED (Phase 3)** |
| C5 | Playout held by another machine | (only at go-on-air claim) | under **C**, onboarding attaches monitor → **no collision in onboarding** | D3 graceful "held by \<machine\>" msg + transfer | 🔒 deferred (backend path proven) |

**C1–C3 root cause (one fix):** `doSignIn` swallows network error, non-OK HTTP, and 403 all into `stations=[]`
(OnboardingFlow.tsx:473) → the 0-branch (create). Fix: route to create ONLY on an affirmative `res.ok` +
`data.stations === []`; on throw / non-OK / 403 go to a dedicated **"can't reach server"** state (retry;
never create — creating on a populated account makes a duplicate). Monday-relevant (mid-deploy sign-in).

## D. Account switching (djdeniro ↔ OV — first-class, demonstrated feature)

| # | State | Trigger | User sees | Path(s) forward | Status |
|---|-------|---------|-----------|-----------------|--------|
| D1 | Switch account | signed in as A, choose B | sign out → relaunch → auth | sign in B → B-decision for B | 🔶 (walk repeatedly this week) |
| D2 | Signed out, idle | sign out, no re-sign-in | auth screen | sign in → B | ✅ |
| D3 | **Existing session present, user initiates NEW-account signup** | signed in as A (djdeniro), sign up B (jensj) WITHOUT signing out | **DEFECT (observed): account identity switches to B, but A's local station row persists + stays active → badge shows A's station under B's account (looks like "hijack to A"); B's station blocked from materializing by the multi-station audit gate** | **CORRECT: the signup path must FORCE SIGN-OUT/clear the prior account's local state first (session + station rows + active station + station-scoped config), OR run fully independent of any stored session.** | ⛔ **OPEN — defect, fix before Monday-adjacent account switching** |

**D1 assertions to prove on this box this week:** sessions never bleed (A's data gone after switch to B);
attachments/claims stay per-account; scoped library swaps cleanly; badge always shows who's signed in.

## E. Cross-cutting / migration

| # | State | Trigger | User sees | Path(s) forward | Status |
|---|-------|---------|-----------|-----------------|--------|
| E1 | **Fresh wipe → sign in** (Monday's jensj path) | factory-reset/clean install → sign in | clean fresh provisioning | B-decision | ✅ **DEMONSTRATED (djdeniro post-wipe)** |
| E2 | **Pre-rework local state boots reworked flow (NO wipe)** — "**row 18**" | existing install auto-updates to this build (stale `first_run_complete` / `onboarding_*` flags, station already materialized, old attach=claim attachment) | **FAILURE MODE: lands on "Choose Your Path" / a legacy onboarding screen** instead of its correct screen — this is row 18 failing its *defined* screen (stale-flag routing), NOT stale UI copy | **Correct**: route to the right screen — main app if already onboarded, else the proper B-decision. Fix = stale-flag routing in the resume path. **Demo must show a history-laden machine reaching the CORRECT screen, not merely booting.** | ⛔ **SCHEDULED** — this week if cheap, **week 4 at the latest**. Not deferrable: **every auto-updating customer machine post-launch crosses E2.** |
| E3 | Factory reset — dev | reset in dev | wipe works; app does NOT self-return (vite orchestration torn down) | manual dev relaunch | ✅ (known dev artifact) |
| E4 | Factory reset — packaged | reset in packaged | expected: self-relaunch → auth | verify before Monday | 🔶 |

---

## OPEN before Monday (from this table)

1. ⛔ **C1–C3** — sign-in when the server is unreachable / mid-deploy / seat-limited must NOT fall through to
   create-a-station. One fix in `doSignIn`: only create on `res.ok && data.stations.length === 0`; otherwise a
   "can't reach the server — Retry" state (and a distinct seat-limit message for 403). **Recommend fixing now.**
2. ⛔ **E2 / row 18 — SCHEDULED (this week if cheap, week 4 latest), not deferrable.** Every auto-updating
   customer machine crosses it. Fix the stale-flag routing so a history-laden boot reaches its CORRECT screen
   (not "Choose Your Path"). Demo must show a history-laden machine routing correctly, not just booting.
3. 🔶 **A4 / E4** — run the packaged renderer smoke (`scripts/smoke-renderer.ps1 -Mode packaged`) and packaged
   factory-reset → relaunch, against the packaged build. **Caveat: packaged smoke ≠ installer coverage** (it runs
   the renderer under an Electron binary, not the NSIS-installed/signed/auto-update artifact — verify that separately).
4. 🔶 **B5 / D1** — demonstrate the ≥2 placement (OV) and account-switching rows on this box during OV authoring.

Demonstrated green so far: A1–A3, B1–B4, B6, C4, D2, E1, A4(dev).

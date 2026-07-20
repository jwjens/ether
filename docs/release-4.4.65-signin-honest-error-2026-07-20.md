# v4.4.65 — Sign-in error copy: honest-by-status (closes C1–C3) — build report, 2026-07-20

**One line:** the account sign-in screen no longer says *"Couldn't reach the server"* when the
server actually **answered with a rejection**. `routeAfterAuth` now branches the message by the
real `/account/connect` HTTP status. Honest-UI applies to error copy too.

---

## Why (root cause this closes)

Operator hit *"Couldn't reach the server to load your stations"* on 4.4.64 first launch, network
fine. Full diagnosis: `docs/signin-couldnt-reach-server-diagnosis-2026-07-20.md`.

**Pinned:** backend is UP (`/health` 200). `POST /account/connect` with **this box's real stored
values** (machine-id `8e8f6181-…-641b`, license `…6FC8`, len 22) returns:

```
{"error":"invalid_license_key"}   HTTP 401
```

- machine-id present + healthy (written 2026-07-05) → NOT a 400 missing-fields case.
- stored license `…6FC8` (carried by all 3 stations, `account_license_key`, and
  `accountLicenseKey()`) is **rejected as invalid** by the live backend — cleared/replaced/revoked
  server-side, or mis-stamped.
- signed-in account (decoded JWT): uid 25, `jensj@opportunityvillage.org`.

The old code fired ONE catch-all message whenever `connectOk` was false — i.e. for a thrown fetch
**and** any non-200 (401/403/5xx) alike. "Couldn't reach the server" for a *rejection* sends the
operator chasing their network instead of the real cause. This is the long-documented **C1–C3 gap**
in `docs/onboarding-signin-state-table.md`.

## What changed

Single file: `src/components/OnboardingFlow.tsx`, `routeAfterAuth()`. Capture `res.status` +
backend error code, then branch the message. Provisioning decision (create-vs-attach) is unchanged —
still only creates on an AFFIRMATIVE `res.ok && stations.length === 0`.

| Condition | Message | Gap |
|-----------|---------|-----|
| status **0** (fetch threw) | "Couldn't reach the server to load your stations… try Sign in again." | C1 (truly offline) |
| **401** / `invalid_license_key` | "Your account's license was rejected by the server, so your stations can't load. Please contact support to restore it." | C3b (new) |
| **403** | "This account's devices are full. Free up a device (Manage Devices), then try Sign in again." | C3 |
| other non-OK (**5xx**/mid-deploy) | "The server couldn't load your stations right now (error N: …). Please try Sign in again in a moment." | C2 |

`docs/onboarding-signin-state-table.md` C1/C2/C3 flipped ✅ FIXED v4.4.65; added row C3b (401).

## Architecture Compliance

- **Honest-UI (CLAUDE.md "Imaging & production surfaces" §, honest-state principle):** error copy is
  now observed-not-claimed — the message states what the server actually did, never a fabricated
  "couldn't reach" for a request the server answered.
- **Account-is-the-root:** unchanged. Sign-in still gates on `/account/connect`; a non-OK never
  falls through to create-a-station (the C1–C3 duplicate-station risk stays closed). No routing
  change — only the failure *message* differs.
- **Governing doc:** `docs/onboarding-signin-state-table.md` (the enumerated sign-in state table).
  This build implements its open C1–C3 rows exactly as specified there ("treat non-OK ≠ zero
  stations; distinct seat-limit message for 403").
- **Correct-minimal:** message-branch only. Did NOT build the Manage-Devices seat UI (403 affordance
  stays backlog) or any retry/offline mode — out of scope for an error-copy fix.

## Gate results

- `npx tsc --noEmit`: **zero NEW errors**. The 3 remaining are known pre-existing
  (`App.tsx:4914`, `OnboardingFlow.tsx:2018`, `PhoneDesk.tsx:777`) — the exact files CLAUDE.md
  lists; none in the changed region (~line 372–410).
- `npm run build`: renderer OK (built in 12.4s).
- `npm run electron:build:win -- --publish never`: OK, signed.

## Artifact

`C:\openair\dist-electron\Ether Setup 4.4.65.exe` — 202,611,236 bytes, built 2026-07-20 11:27,
`--publish never` (nothing pushed/tagged). **Install manually.**

## Files touched

- `src/components/OnboardingFlow.tsx` — status-branched sign-in error.
- `package.json` — 4.4.64 → 4.4.65.
- `docs/onboarding-signin-state-table.md` — C1/C2/C3 → FIXED, added C3b.
- `docs/signin-couldnt-reach-server-diagnosis-2026-07-20.md` — root-cause diagnosis (prior step).
- `docs/release-4.4.65-signin-honest-error-2026-07-20.md` — this report.

**No help-corpus entry:** this is error-copy branching, not a new user-facing feature — the messages
themselves are the surface, nothing to tour.

## Follow-up (NOT in this build — for Jeff)

The 401 root cause is data, not code: the license persisted on this box is invalid at the backend.
To restore uid 25 (`jensj@opportunityvillage.org`): sign in with the OV password (re-mints a fresh
key via `/api/user/desktop-activate`) or look up the account's current key on the backend. Verify
`desktop-activate` and `/account/connect` agree on that account's key — sign-in mints from
`desktop-activate`, so if it hands back a key connect rejects, that's a backend split-brain to fix
server-side.

---

*Nothing committed. Local build only.*

# v4.4.66 — trial_expired doorway + OV account unblock — build report, 2026-07-20

**One line:** an expired trial is now a doorway, not a dead end. `/account/connect` distinguishes a
lapsed trial from a bad key; the desktop shows a "your data is safe — pick a plan" screen with a
**Choose a plan** button. Also: cleared the leftover trial clock that had locked the founder's own
paid lifetime account.

Root cause + receipts: `docs/license-trial-expiry-401-rootcause-2026-07-20.md`.

---

## §2 — DB unblock (APPLIED to prod)

Founder's paid lifetime license carried a leftover trial `expires_at` (2026-07-20 16:55Z) that fired
today → `lookupLicense` treated it as no-match → 401. Minimal fix (no plan change):

```sql
UPDATE licenses SET expires_at = NULL WHERE id = 24;   -- rowCount 1
UPDATE users    SET trial_ends_at = NULL WHERE id = 25; -- rowCount 1
```

Verified: `licenses.id=24 expires_at → null`, `users.id=25 trial_ends_at → null`, plan unchanged
(`station_lifetime`). End-to-end proof: `POST /account/connect` with the box's real key `…6FC8` →
**HTTP 200** with all three OV stations (was 401). One-shot write script created, run, and deleted.

## §3 — trial_expired doorway (SHIPPED)

### 3a. Backend (`ether-backend/src/index.js`) — DEPLOYED via `railway up` (deployment ce1e8167)

- New `lookupLicenseDetailed(rawKey)` → `{row, reason}` where reason ∈ `ok | expired | notfound`.
  `expired` = key matches a row but `expires_at` is past (a lapsed trial). **The existing
  `lookupLicense` is untouched** — every other caller keeps its current behavior.
- `/account/connect` now branches: `reason==='expired'` → `401 {error:"trial_expired",
  renew_url:"https://signup.ether-technologies.com"}`; otherwise unchanged
  (`invalid_license_key` for a real bad key).
- Regression-verified live: bogus key → `invalid_license_key`; real key → 200. No change to any
  other endpoint.

### 3b. Desktop (`src/components/OnboardingFlow.tsx`) — installer built

- `routeAfterAuth` captures `renew_url` and branches the sign-in message on `trial_expired`:
  **"Your free trial has ended. Your stations and library are safe — pick a plan to keep
  broadcasting."** rendered in reassurance-green (not error-red), plus a **"Choose a plan →"**
  button that opens `renew_url` in the external browser via the existing `open_url` IPC.
- A genuinely invalid key keeps the v4.4.65 contact-support copy. 403/offline/5xx branches unchanged.

### 3c. Docs + help

- `docs/onboarding-signin-state-table.md`: added row **C3c — trial expired** (✅ FIXED v4.4.66).
- `docs/help-trial-ended.md`: new help-corpus entry **"What happens when my trial ends"** — leads
  with data-safety, then the Choose-a-plan steps, then how to tell the other sign-in messages apart.
  `tour: true`, wired from the trial-expired sign-in screen (the Choose-a-plan button).

## Data-safety (verified) — expiry gates access, never destroys data

No expiry-driven deletion exists in the backend (grep for cron/interval/purge-on-expiry is empty;
every `DELETE FROM stations` is an explicit operator-initiated handler). Expiry only makes
`lookupLicenseDetailed` withhold the row → 401. Stations, programming, library, and R2 audio all
persist and resume on renewal. The "your data is safe" copy is factually accurate.

## Gate results

- Backend: `node --check src/index.js` OK; deployed (ce1e8167 live); regression probes green.
- Desktop: `npx tsc --noEmit` — **zero NEW errors** (3 pre-existing: `App.tsx:4914`,
  `OnboardingFlow.tsx:2039` [the render-fn error, shifted from 2018 by added lines],
  `PhoneDesk.tsx:777`). `npm run build` OK. Installer built.

## Artifact

`C:\openair\dist-electron\Ether Setup 4.4.66.exe` — built `--publish never`. **Install manually.**

## Files touched

- `ether-backend/src/index.js` — `lookupLicenseDetailed` + connect trial_expired branch (deployed).
- `src/components/OnboardingFlow.tsx` — trial_expired copy + Choose-a-plan button.
- `package.json` — 4.4.65 → 4.4.66.
- `docs/onboarding-signin-state-table.md` — row C3c.
- `docs/help-trial-ended.md` — new help entry.
- `docs/license-trial-expiry-401-rootcause-2026-07-20.md` — status updated.
- `docs/release-4.4.66-trial-expired-doorway-2026-07-20.md` — this report.

Nothing committed (awaiting Jeff's verify); nothing pushed to GitHub. Backend deployed via
`railway up` (direct, no git-remote push).

## Next release — §4 owner-login re-route

The two-door leftover (desktop signs in via `/api/user/desktop-activate`, minting a *trial*
identity, instead of routing through owner-login with an lk-bearing token) is the root that stamped
a trial clock on a paid account. Next small release: desktop → `/api/auth/owner-login`
(lk-bearing token); connect + cloud ops read that identity so a paid account never re-acquires a
trial `expires_at`. **Design end-to-end (client + backend) first, then build.**

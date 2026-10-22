# Admin login shows "Good afternoon Shawna" (4.6.62) — 2026-10-21

## Jeff's report (verbatim)

> Admin login shows "Good afternoon Shawna" since 4.6.62. READ-ONLY first: on both machines, show the users rows for
> Admin and Shawna (uuid, name, station, role, PIN format) and every sync change to them since the 4.6.62 installs. Did
> the user sync merge or swap them? Whose permissions does an Admin login get? Fix the cause in code; don't change user
> rows by hand without my OK.

**The defect:** signing in as Admin, the shift screen greets Shawna.

## OVEVENTS (this machine, client `8e8f6181`, schema 68) — read-only

| id | uuid | name | role | station | PIN | state |
|---|---|---|---|---|---|---|
| 1 | `64cd6ed1-d290-43a7-a2b8-ca417c95693f` | Admin | admin | Open Format (#1) | scrypt | live |
| 4 | `04312fa1-3bf7-4de0-8e95-0ef3fe7851d6` | Shawna | admin | halloVeen (#2) | salt:sha256 | live |
| 7 | `717fd5be-1a67-4165-8726-1f466baa77f9` | Admin (OV's) | admin | Open Format (#1) | scrypt | **deleted 13:04:42 PDT** |

(also live: id 2 jeff, 3 Ryan, 5 Donavon, 6 Steve.)

Every users change in OVEVENTS's journal since the install:

| PDT | row | from | change |
|---|---|---|---|
| 11:57:47 | Admin `64cd` | OVEVENTS | PIN salt:sha256 → scrypt (sign-in upgrade) |
| 12:49:26 | Admin `717f` | OV | PIN salt:sha256 → scrypt (OV's sign-in upgrade); arrived here as **id 7** (new row) |
| 13:04:42 | Admin `64cd` | OVEVENTS (merge) | **PIN replaced with OV's Admin PIN**; role and colour unchanged |
| 13:04:42 | Admin `717f` | OVEVENTS (merge) | removed (soft delete) |

**Merge or swap? A merge, of the two Admins only — Shawna was never touched.** Same station + same name: the smaller
uuid (`64cd`, OVEVENTS's Admin) is kept on every computer, with the newest PIN (OV's); OV's own Admin row (`717f`) is
removed on every computer. Checked here: the kept Admin's PIN now equals OV's Admin PIN (equality only, no value read).
So **Admin's PIN on OVEVENTS is now OV's Admin PIN** — by the merge's design ("takes the newest's role/colour/PIN").

**OV — not yet read.** OV's database is not reachable from this machine; its rows are visible through its journal on the
server, and the Railway CLI login expired (`invalid_grant`) before that read. Expected on OV from the design: OV's own
Admin (`717f`, OV's local id 1) removed, `64cd` arrived under a new, higher id — making Shawna the lowest live id.
**UNVERIFIED** until the server read (`scratchpad/diag-users-server.js`).

Seen in passing: v67 gave every existing user a uuid but did not journal them, so a user nobody has changed since the
install has not travelled (OVEVENTS's Shawna `04312fa1` and OV's Shawna are different rows until one is edited).

## Cause (code)

`OnShiftScreen.tsx` chose who is on shift as **the lowest live user id** (`setOperator(ops[0])` over `ORDER BY id`), and
`App.tsx` never told it who signed in. Admin was greeted correctly only while Admin was id 1. After the merge, OV's
Admin is no longer id 1, so the lowest id — Shawna — is greeted, Iris greets Shawna, and the shift note is read and saved
under Shawna's id.

## Whose permissions does an Admin login get?

The signed-in user is the Admin row the PIN unlocked (`UserLogin` → `App` `currentUser`); the shift screen's pick never
fed back into it (`onStart` ignores its argument). **But roles gate nothing today:** `src/UserContext.ts` defines the
role checks (`useCanAccessSettings` …), and no component provides `UserContext` or calls them. From the code, every login
has the same access. Runtime: UNVERIFIED. Not changed here.

## Fix

- `OnShiftScreen` takes `signedInId` / `signedInName` from `App`'s `currentUser`. `pickOnShift`: the signed-in id; if
  that row was merged away, the same name (users sync's own rule); lowest id only as the last fallback, so Start is never
  blocked. The On Shift picker still lets a co-host be chosen by hand.
- No user rows changed.

Test: `src/components/OnShiftScreen.test.ts` 5/5 (Admin → Admin on OV's post-merge ids; merged-away row → same name;
Shawna → Shawna; fallback; empty). tsc 0.

## Not verified

The screen on OV after the next build: sign in as Admin, the greeting says Admin.

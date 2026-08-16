# Profile-per-account — one account, one directory (2026-08-15)

Built. Gates green, migration proven on a copy, no version bump — Jeff walks it through.

Supersedes the coexistence approach in `docs/station-coexistence-design-2026-08-15.md` and the park in
`docs/ensurecleanroom-scoping-2026-07-07.md`. Those designs asked "how do we make two accounts share
one database safely?" — a question whose honest answer was a five-step sequence ending in a library
ownership column. This build asks a different question: **why are they sharing a database at all?**

## The model

Windows user profiles. Each account gets its own data directory and its own database; sign-in selects
the profile. **Isolation is the directory** — no owner-column scoping, no wipe.

```
%LOCALAPPDATA%\Ether\
  profiles\
    active                          <- POINTER: plaintext license key. Machine-level.
    ETH-STN-BAA8-E056-6FC8\         <- one account's entire world
      openair.db (+ -wal/-shm)      health-events.jsonl   logs\
      backups\  clips\  r2-cache\   automation-intent.json  music-dir.txt
      restore-failures.log          r2-deletion-report.jsonl  ai-config.json
      .ether-on-air  .ether-keep-session
    _pending\                       <- scratch profile carrying a sign-in before its key is known
  engine\                           <- staged audio engine — MACHINE-level, shared by all profiles
%LOCALAPPDATA%\EtherMachine\machine-id   <- machine identity, survives everything
%APPDATA%\Roaming\Ether\                 <- MACHINE-level plumbing (see §Classification)
```

## 1. Identity — the foundation, verified before anything was built

The precondition was: *what uniquely identifies the account at sign-in time, on every path?* Verified
in the tree, and it failed twice.

**Every interactive sign-in path does produce the key:**

| Path | Receipt |
|---|---|
| `doSignIn` | `OnboardingFlow.tsx:563` → `activateAndContinue:454` → throws at `:485` if `!data.license_key` |
| `doSignUp` | `OnboardingFlow.tsx:797` → `:828` → same `activateAndContinue` |
| Manual key entry | `OnboardingFlow.tsx:836`, `:909` — guarded on `!licenseKey.trim()` |

**`owner-login` does not exist in this tree.** No route, no fetch, no handler. `CLAUDE.md:175` calls
it a backlog item. The app's auth endpoints are `/api/user/desktop-activate`, `/api/user/signup`,
`/api/user/login`, `/account/connect`.

**Two paths sign in with no key and no account identity at all:**

| Path | What it actually checks |
|---|---|
| `account:was-on-air` (`App.tsx:919` → `main.js:3195`) | `existsSync(.ether-on-air) && !!process.env.ETHER_WATCHDOG_PID` |
| `account:resume-session` (`App.tsx:923` → `main.js:3218`) | a bare timestamp in `.ether-keep-session`, <2 min old |

Under one directory that was coherent — there was only one database to resume. Under profiles they
would be *unnameable profiles*. They are now gated: both refuse when no profile is open (edge rule 1),
so the app lands on sign-in instead of guessing.

### The boot circularity — the real blocker, and the pointer that breaks it

All three license-key slots live **inside** the database: `install_config_kv.account_license_key` →
`stations.owner_license_key` → `station_config_kv.license_key` (`sync/transport-http.js:127-129`).
But `app.whenReady()` (`main.js:2637`) calls `initDb()` **before any window exists** — no sign-in has
happened, no key can be known.

> To pick the directory you must read the key. To read the key you must have opened a directory.

`profiles/active` is the only account fact readable before the first open. It is written **only** by a
sign-in that genuinely produced a key, and by the migration as its final step. The precedent is
already in the tree: `_machineIdDir()` (`main.js:906`) keeps `machine-id` outside the wipe path for
exactly this kind of reason.

## 2. Sign-in selects the profile — and adopts BEFORE it stamps

`profile:adopt` (`main.js`) runs the moment the key is in hand and **before one byte of identity is
written**:

```
already on that profile      -> re-affirm the pointer
profile exists on this box   -> open it            (instant switch, nothing copied, nothing lost)
signed in on _pending        -> rename _pending -> <key>   (that scratch dir IS this account's now)
different account, new here  -> create an empty profile -> existing addStation path (OnboardingFlow:428)
```

**Order is the whole point.** A cold start with a stale session opens account A's profile and still
shows sign-in. If B signed in and the stamp landed first, B's license, email and JWT would be written
into A's database — one account silently contaminating another. That is the failure `ensureCleanRoom`
was flailing at. Adopt first, stamp second, and it cannot happen.

The switch is **in process** — close DB, move directory, reopen (`initDb()`, the same call used after
a restore at `main.js:1391`/`:1489`). No relaunch: relaunching mid-sign-in drops the operator back at
the sign-in screen with onboarding half-finished, which is the sign-in loop this codebase has already
paid for twice (4.4.46, `5c93322`).

## 3. What the wipe became

- `ensureCleanRoom` — **removed**, with both call sites (`OnboardingFlow.tsx`). It made signing in a
  destructive act; it shipped total data loss in v4.4.31 when a reboot was mistaken for a switch.
- `account:cleanRoomReset` — **removed** (main). Nothing calls it.
- Sign Out — **no longer wipes**. It clears the pointer and **exits completely** (see §3.1).
- Switch Account — **removed entirely** in 4.4.216 (see §3.1).
### 3.1 One door out — Sign Out, and it quits (4.4.216)

`Switch Account` is gone: the File menu item, the `account:switch-to` handler, the
`doAccountSwitch` interstitial in `OnboardingFlow`, and the `Switch Account` button in
`SubscriptionPanel` (which stripped `license_key`/`license_email`/`plan_tier` and the onboarding
flags out of the *current* account's database — under profiles that damages the profile it leaves
behind rather than switching away from it).

**Sign Out is the whole protocol:**

1. Confirm — *"Ether will close completely, including the audio engine. Reopen it to sign in."*
2. Stand the watchdog down (`_userFullQuit`, `.ether-clean-exit`), stop the daemon, clear the on-air
   marker while the profile is still resolvable, clear the pointer, close the database.
3. **`app.exit(0)` — full exit, no relaunch.**

The full exit is the load-bearing part. The app and the daemon both hold the outgoing profile's
database open, and Windows cannot rename or adopt a directory while a file inside it is open. A
relaunch raced its own file handles: the next sign-in could arrive while the old process was still
letting go, and `profile:adopt` would refuse with `profile_in_use`. Quitting completely means the
next launch starts with nothing holding files, so any account's sign-in adopts its profile cleanly.

- `_wipeLocalIdentityAndData` — **kept**, because the typed-confirmation Factory Reset UI exists
  (`SettingsPanel.tsx:2113-2139`, double-email confirmation → `system:factoryReset`). It is now
  **scoped to the active profile**: it used to remove `%LOCALAPPDATA%\Ether` wholesale, which under
  profiles would destroy every account on the machine plus the staged engine.

## 4. Classification — what is per-account, what is machine-level

**Per-account (in the profile).** `openair.db` + WAL/SHM, `restore-failures.log`,
`r2-deletion-report.jsonl`, `health-events.jsonl` (the health ledger), `logs/`, `backups/`, `clips/`,
`r2-cache/`, `music-dir.txt`, `ai-config.json`, `automation-intent.json`, `cloud-restore.db`,
`logreader-shadow.jsonl`, `scheduler-core-shadow.jsonl`, `playhead-divergence.jsonl`,
`.ether-on-air`, `.ether-keep-session`.

**Machine-level (outside every profile).**

| Thing | Why |
|---|---|
| `profiles/active` | names the profile — cannot live inside one |
| `EtherMachine\machine-id` | must outlive every wipe so the server reuses the activation slot |
| `Ether\engine\` | a build for this machine/arch, shared by all profiles |
| `.ether-expected-restart`, `.ether-ha-alarm`, `ha-config.json`, `watchdog.log`, `.ether-watchdog.pid` | **the watchdog resolves Roaming\Ether independently and knows nothing about accounts** (`watchdog/watchdog.js:57-58`, `watchdog/platform/win32.js:14`) |
| `ether-startup.log` | must be writable when no profile exists |
| `popout-bounds.json` | window geometry — a machine preference |
| Chromium session/cache, updater state, single-instance lock | Electron plumbing |

The Roaming split folds in as instructed **except** for the watchdog's own files. Moving
`.ether-ha-alarm` into a profile was caught during the build: the app would have watched for an alarm
the watchdog never puts there.

## 5. Design property — signed-out profiles are fully dormant

**Only the ACTIVE profile's daemon, auto-generate, sweeps and backups run.** This is structural, not
policed: every one of those resolves its database through `getDbPath()` → `_etherDir()` →
`P.activeKey()`, and nothing enumerates profiles to do work (`P.listProfiles()` has exactly one
non-test caller, the read-only `profile:list` IPC). A signed-out profile has no process touching it —
its stations do not broadcast and do not maintain themselves.

Account switch = stop daemon → switch profile → restart daemon (`profile:adopt`, and the daemon
resolves the new path from the refreshed `ETHER_DB_PATH`). No guard rails about broadcast state; the
operator regulates that.

## 6. Sync / license — nothing global

Every license, JWT and push-identity read resolves from the profile's own database:
`transport-http.js:_getLicenseKey` (`install_config_kv` → `stations` → `station_config_kv`),
`cloud-backup.js:getBackupLicenseKey:372`, and every `account_jwt` read (`main.js:2882, 2992, 3030,
4632`). There is no file-based or global token store. Each profile therefore carries its own
`account_jwt`, license slots and push identity for free.

This also closes §4.2 of the coexistence doc — "two accounts, one push identity" — without building
per-mutation ownership. There is only ever one account resident in an open database.

## 7. Migration — one-time, non-destructive, proven on a copy

`electron/profile-migrate.js`. On first launch, before `initDb()`:

1. pointer already present → no-op
2. no legacy `openair.db` → nothing to do
3. read the key from the legacy DB in the transport's order of trust; **no key → refuse** (an
   unnameable profile is never invented)
4. target profile already exists → refuse (never merge two databases)
5. **`fs.renameSync`** the directory — atomic, same volume, no duplicate bytes
6. verify: the moved database exists and re-reads the *same* key
7. fold in the Roaming per-account artifacts (best-effort — logs must not strand a verified database)
8. **write the pointer LAST** (edge rule 2)

On failure it refuses **loudly**, moves nothing, and the app keeps running on the legacy path. A
Windows directory rename fails while any process holds a file inside it open — and the audio daemon
holds `openair.db` open on any machine that has played audio. That is the *normal* failure, not a
corner case, which is why there is no copy fallback and no partial state.

### Proof — `scripts/prove-profile-migration.js`, 30/30 on a real copy

Run: `cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/prove-profile-migration.js`

Copies the **real 693.6 MB `openair.db`** into a sandbox `%LOCALAPPDATA%` and runs the actual
migration against it. The live directory is opened read-only and never written.

| Scenario | Result |
|---|---|
| happy path | migrated; profile named `ETH-STN-BAA8-E056-6FC8` from the live DB; legacy dir gone; **727,265,280 bytes preserved exactly**; pointer written; moved DB re-reads the same key |
| locked database | refused; **not one byte moved**; legacy DB still there; no pointer; no half-moved directory |
| no license key | refused, naming the missing key as the cause; legacy DB untouched |
| already migrated | no-op; profile bytes unchanged |
| dangling pointer | routes to sign-in; the named profile is **not** auto-created |

Plus `electron/profile-paths.test.js` — 16 tests in the vitest suite covering key sanitising
(traversal refused, not escaped), pointer atomicity, all four edge-rule-1 cases, directory isolation,
and in-process switching.

## 8. Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors** |
| `node --check` (8 changed JS files) | clean |
| `npm run verify:schema` | **PASS** (8 passed, 0 failed) |
| `npx vitest run` | **331 passed / 331** (24 files; 16 new) |
| migration proof on a copy | **30 passed / 0 failed** |

**No version bump.** Nothing committed.

## 9. Architecture compliance

- **The account is the root of everything** (`CLAUDE.md:26-50`) — strengthened. The license key now
  literally names the directory that holds the stations, database and library. `account login →
  carries the license key → which determines the stations → which carry the databases` is now the
  filesystem layout, not just a mental model.
- **Sign-in is the unconditional gate** (`CLAUDE.md:46-48`) — preserved and hardened: the two
  identity-less resume doors now refuse without a profile, so a stale marker can no longer open the app.
- **The ONLY sign-in-skip exception is the watchdog on-air restart** (`CLAUDE.md:50`) — preserved;
  `_wasOnAir()` still requires `ETHER_WATCHDOG_PID`, and now also requires a profile to come back into.
- **`CLAUDE.md:15` tension, surfaced not silently resolved.** That line says the legacy
  `com.ether.radio` directory name is cosmetic and must not be renamed on an installed build. The
  layout Jeff specified puts `openair.db` directly in `profiles/<key>/`, so the migration does move
  data out of `com.ether.radio`. This is a structural change with a proven, verified, refuse-loudly
  migration — not a cosmetic rename — but it is a deliberate departure from that line and Jeff should
  confirm it.

## 10. What structurally cannot be per-profile

- **The watchdog's files.** It is a separate process that resolves `Roaming\Ether` with no account
  context. Per-profile watchdog state needs the watchdog taught about profiles — out of scope here.
- **The staged audio engine.** A per-machine binary; per-profile copies would waste disk and diverge.
- **The machine id.** Deliberately outlives every profile so the server reuses the activation slot.
- **Chromium session/cache, updater state, single-instance lock.** Electron owns these paths.

## 11. Open for Jeff

1. **`CLAUDE.md:15`** — confirm the move out of `com.ether.radio` (§9).
2. **Old profiles are never garbage-collected.** Each signed-in account keeps its directory forever.
   That is the point (switching back is lossless), but there is no UI to list or delete a profile —
   `profile:list` exists as an IPC with no screen. Worth a Preferences panel later.
3. **A pre-2026-06-17 install with no license key anywhere** migrates to nothing: it refuses, keeps
   running on the legacy path, and the operator sees no change. Correct, but silent to them — the
   refusal is console-only. Say the word and it becomes a visible notice.

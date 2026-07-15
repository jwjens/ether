# Ether / EtherCast — Project Context for Claude Code

This file is the source of truth Claude Code reads at the start of every session.
Do not make Jeff re-explain anything written here. If something below conflicts
with what you find in the code, surface it — don't silently assume.

---

## What this is

- **Company:** Ether Technologies
- **Product:** EtherCast (the broadcast automation app)
- A professional radio/broadcast automation platform competing with RCS Zetta and WideOrbit.
- **Repo:** `jwjens/ether`  ·  **Dev root:** `C:\openair`
- Internal/legacy codename in some on-disk paths is still `openair` (e.g. `com.ether.radio\openair.db`). That's cosmetic, lives only in hidden AppData, and is not user-facing. Do not "fix" it by renaming files on an installed build — that's a source change for later.

## Stack

- Electron + React + TypeScript front end
- Rust NAPI audio engine
- Out-of-process audio daemon: `ether-engine` / `audiod/ether-audiod.js`
- Local-first with cloud sync (NOT cloud-authoritative). Each station runs one always-on local audio engine. Cloud (Cloudflare R2, Lightsail/Icecast) is the relay/sync hub and transmitter, not the playout engine.

---

## THE MOST IMPORTANT ARCHITECTURAL TRUTH — the account is the root of everything

Read this before touching any startup, routing, sign-in, station, or onboarding code.

**The account is the identity that the entire app hangs off of.**

```
account login → carries the license key
            → which determines the stations
            → which carry the databases
            → which carry the song libraries
```

A program director can sign into their account on ANY computer, anywhere in the
country. Their stations, databases, and song libraries pull down from the cloud
(R2). Within minutes (depending on library size / R2 pull time) they can go live.
**The machine is just a terminal. The account is everything.**

### Consequences that are NON-NEGOTIABLE:

1. **The account sign-in screen is ALWAYS the first screen on launch — unconditionally** — unless a valid signed-in account session already exists.
2. **No account = nothing.** No account → no license key → no stations → no DB → no library → nothing to show. There is no app without an account.
3. **The account session is the GATE for the entire app.** Until a valid account session exists, the ONLY screen that can render is account sign-in. This is not "route to sign-in when conditions match" — account-or-nothing is the hard prerequisite for everything downstream.
4. **UserLogin / profile-select is a DEEP screen, not a first screen.** It only has meaning AFTER an account is signed in and its stations have resolved. It can NEVER legitimately appear before account sign-in. If it ever renders on a no-account install, that is a bug.
5. **The ONLY exception** to "sign-in first" is the watchdog auto-restarting after a crash *while a station was actively streaming live to Icecast* — that path may come straight back on air without re-sign-in. Nothing else.

### User profiles are unrelated to accounts
In-app user profiles (e.g. "Admin" user login, "Jeff" start-shift profile) are for
**in-app restrictions/permissions only**. They have NOTHING to do with the account
identity or station identity. Don't conflate "user login / profile select" with
"account sign-in."

---

## Desktop app tenancy

- **Single-tenant per install.** One account per install, one at a time.
- Core behavior (shipped v4.3.80): sign out of one account → sign into a different account → see ONLY the second account's stations. Stations are scoped by `owner_license_key`.
- Multi-tenant (god-mode across all accounts) does NOT live in the desktop app. It is a SEPARATE web console: `platform.ether-technologies.com` (for Jeff / IT / engineering to troubleshoot clients remotely). That's a future build (Track 2) — currently shows no station cards.

## Infrastructure

- Backend (`ether-backend`) on Railway. `/account/connect` returns the account's authoritative station list by license key.
- PWAs on Cloudflare Pages: `listen.ether-technologies.com`, `app.ether-technologies.com`.
- Stream via Icecast on Lightsail (`stream.ether-technologies.com:8443`), mounts `/ov` `/usph`.
- Auto-update via electron-updater. NOTE: the audio daemon does NOT reload on auto-update — clients must fully close and reopen the app.

## DB locations (Windows)

- App data lives at `%LOCALAPPDATA%\Ether\com.ether.radio\openair.db` (LocalAppData, NOT Roaming — Roaming is redirected to a network share on managed boxes like OV, where SQLite WAL fails).
- The audio engine must resolve the DB path the SAME way the main app does and must `mkdir` the parent folder before opening (SQLite throws SQLITE_CANTOPEN on a missing parent — this caused a fresh-install crash).

---

## Deployments

- **OV** = Opportunity Village (Las Vegas nonprofit), Windows, managed corporate box with McAfee. First client deployment. Roaming AppData redirected to network `H:\`.
- **USPH** = US Phenomenon, macOS.

### Standard final step of EVERY release — build the installer locally (do it without being asked)

After the version bump + commit + push, always build the Windows installer locally so Jeff has the artifact in hand:

```
npx tsc --noEmit                           # TYPECHECK — vite/esbuild STRIPS types and never typechecks;
                                           # this is the ONLY gate that catches a "not defined"/prop-type
                                           # crash before it ships. Known pre-existing errors live in
                                           # App.tsx / Scheduler.tsx / OnboardingFlow.tsx / PhoneDesk.tsx;
                                           # the bar is ZERO NEW errors in the code you changed.
npm run build                              # vite renderer (dist/) — prerequisite
npm run electron:build:win -- --publish never   # electron-builder, LOCAL ONLY (never publishes)
```

- Output lands in `C:\openair\dist-electron\Ether Setup <version>.exe` (config: `electron-builder.json` → `directories.output: dist-electron`, `productName: Ether`, nsis default artifact name). E.g. `C:\openair\dist-electron\Ether Setup 4.4.54.exe`.
- **Always pass `--publish never`** — a local build must not push to the GitHub release. Report the exact `.exe` path when done. **STOP before install** — Jeff installs manually.
- **Every feature ships with its help entry.** A new/changed user-facing feature is not done until it has a plain-language, step-by-step `docs/help/<feature>.md` written to the template in `docs/help/jingles.md` (the built-in help corpus the Iris tour layer consumes verbatim). Discoverability counts: a feature its own owner can't find is a bug — wire an in-app affordance to it. Note the help entry in the build report.

## Workflow & division of labor

- **Jeff** architects and reviews. He is the sole developer.
- **Claude Code** executes ALL git/build/file/terminal work in the terminal.
- Jeff often relays between a separate chat (architecture/planning) and Claude Code. He's frequently copy-pasting and relies on the tools to hold the thread — DO NOT make him repeat himself, and DO NOT run ahead.

### Hard rules
- **Propose first, change nothing, wait for explicit confirmation.** Investigate read-only before edits. Never run ahead or overstep.
- **Never commit or push before Jeff verifies.** Local commits only unless told otherwise. Never tag/release without explicit go-ahead (tagging triggers CI + client auto-update).
- **The only valid test of a UI/routing fix is launching the app and seeing the actual screen.** A passing database query is NOT proof the screen is correct. Do not claim a routing bug is fixed based on a DB-level test.
- Never use inline `node -e` / `electron -e` (fails/quoting issues) — write a `.js` diag script and run it.
- `schema_version` lives in its own table (rows 1..N), not in `system_state`.
- `window.ether.<table>.list()` IPC returns `{rows:[...]}` — unwrap `.rows`.
- Physical deck positions are sacred — Deck X UI always shows what Rust deck X is decoding; Esc never kills audio.
- Take Jeff's prior troubleshooting at face value; root-cause over workarounds. Don't revisit closed avenues.
- Files made in chat only exist in chat until Jeff downloads and places them in the repo — Claude Code can't pull files from chat.
- **TEMPORARY TOOLING EXPIRES.** Any watcher, poller, scheduled task, or background process created for diagnosis must be (1) logged in `docs/backlog.md` with a teardown note when created, and (2) torn down when its purpose completes or its replacement ships. Never leave diagnostic persistence armed on any machine. This machine is NOT Ether's permanent home — nothing here should assume permanence.
- **BUILD THE SENSE, NOT THE SCAFFOLD.** Every feature ships with its own built-in observability: honest state (observed, never claimed), health events to the ledger, and visibility in the Health Monitor — in v1, not bolted on later. If a diagnosis ever seems to need a temporary watcher/poller/task, that is a product gap: propose the permanent built-in sense instead. No diagnostic persistence on any machine, ever.
- **ARCHITECTURE BEFORE CODE.** Months of architecture work govern this codebase — `docs/` holds binding design decisions (bus architecture, ONE-scheduler model, UUID identity, content-hash/snapshot data model, content-class isolation, and the design doc for whichever feature is being built). Before implementing ANY feature: locate and read the governing docs, cite them, and design within them. Never rebuild what exists — search for prior implementations and designs first (features here shipped in phases; check CHANGELOG and git log for the feature's history). Every build report includes an **Architecture Compliance** section with receipts. If an implementation would contradict a design doc, STOP and surface the conflict for Jeff instead of building over it.

## Engineering bar

"Better and faster than RCS Zetta — functional enough that Zetta/G-Selector/NewsBoss never catch up." Correctness is the constraint; cost and timeline are not.

---

## Current known-bug state (update as resolved)

- **Fresh-install crash (addressed v4.3.81):** app opened the SQLite DB without creating the `com.ether.radio` parent folder → SQLITE_CANTOPEN on a clean machine. Fix: `mkdir` recursive before open in both the main app and `ether-audiod.js`; engine now resolves the DB path the same way the main app does.
- **Fresh install shows UserLogin instead of account sign-in (OPEN / IN PROGRESS):** on a no-account install the app renders the profile-select (UserLogin) screen instead of account sign-in. This violates the account-is-the-root rule above. The account session must be the unconditional gate for the entire app — until a valid account session exists, the ONLY renderable screen is account sign-in. A v4.3.80 station-scoping change (get-active returns null with no account) contributed to a routing hang. The real fix is structural: account session gates everything; profile-select lives behind it.

---

## Project map (permanent ground truth — verified 2026-07-14)

Local dir → what it is → deploy target → domain. **Web UIs deploy via `wrangler`; the desktop app releases via GitHub Actions (`.github/workflows/build.yml` publishes installers on push).** Do not confuse these repos — each is a separate tree.

- `C:\openair` → **EtherCast desktop app** — repo `github.com/jwjens/ether`. Releases: GitHub Actions `build.yml` (installers on push).
- `C:\ether-dashboard` → **web control UI "Ether Control Center"** — repo `jwjens/ether-dashboard` → wrangler Pages project **`ether-dashboard`** → **app.ether-technologies.com**.
- `C:\ether-cast` → **listener PWA** ("Ethercast"; not a git repo) → wrangler Pages project **`ether-cast`** (deploy: `C:\openair\ec-deploy.sh` = `wrangler pages deploy . --project-name ether-cast`).
- `C:\ether-listener` → **listen.ether-technologies.com** — repo `jwjens/ether-listener` ("Ether Radio").
- **Backend:** Railway (`ether-backend-production.up.railway.app`) — **stays, no migration.**

> Caveat (cast vs listener domain): the only *local* reference to `listen.ether-technologies.com` is in `C:\ether-cast`'s `index.html`; `C:\ether-listener` carries no domain marker in-tree. The `ether-listener → listen.*` mapping is per the operator / Cloudflare custom-domain config (authoritative). Confirm the cast/listener domain split against the Pages dashboard before relying on it.

---

## Categories/programming mirror — the rails (2026-07-14, v4.4.53)

Categories / programming / clocks mirror between the dashboard and the install over **two proven, license-keyed / command-bus channels** — NOT the staged pipeline or `sync_enabled`:

- **Web→desktop (edits):** dashboard `CategoriesPanel`/`ProgrammingPanel` run in **live mode** (`staged={false}`, `ether-dashboard StationDetail.tsx`) → `db:apply` create/update/delete over `POST /api/cmd` → SSE `/api/cmd-stream` → install `execCmd` → `applyDbMutation`.
- **Desktop→web (display):** install `pushCcTable` → `POST /api/account/data/sync` (**`x-license-key`**) → `station_cc_data`, read by the dashboard's `/data`. Fires on every CC `db:apply` + a 60s refresh (`App.tsx`).

**DEPRECATED for these tables** (left in place, do not flip/fix): the **staged pipeline** (`importStagedProgramming`, `/api/account/station/:uuid/staged*`) and the **`sync_enabled`** mutation push. The staged pull forced `op:"create"` so updates/renames no-op'd and rows were marked-imported unapplied (silent loss). The `account_jwt`/`lk` token is unrelated to this mirror (it only gates the dashboard's account-scoped *reads*); routing the desktop sign-in through owner-login is a separate backlog item.

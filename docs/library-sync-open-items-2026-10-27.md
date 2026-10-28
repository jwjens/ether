# Library & sync — five open items: where each really stands (2026-10-27)

**Jeff:** "lets finish these" — the one-time file-location repair (dry run done, `--apply` waiting), the users list
flipping between machines, roles don't restrict anything, the runaway `station_config_kv` writer, machine-local paths
travelling through sync. Then: "ether is live at ov so if we can do this without touching ovowforestmusic lets do it."

Constraint for all of it: **nothing touches ovowforestmusic** (OV, live). Work = code here + read-only checks on a
copy of THIS computer's database (OVEVENTS, the dev machine). Nothing built yet — this is the investigation.

## 1. One-time file-location repair — nothing to repair on this computer
- The earlier dry run (commit `91800ba`, a copy of OVEVENTS): 2,134 kept, 0 to repoint, 17 awaiting download, 0 missing.
- **Re-run today** on a fresh read-only copy (SQLite backup API; Ether was running), current catalogue (673 files):

  | table | kept | repoint | download | missing |
  |---|---|---|---|---|
  | songs | 551 | 0 | 0 | 0 |
  | announcements | 5 | 0 | 0 | 0 |
  | spots | 4 | 0 | 0 | 0 |
  | cart_slots | 13 | 0 | 0 | 0 |
  | library_asset | 560 | 0 | 0 | 0 |
  | generated_schedule (planned) | 302 | 0 | 0 | 0 |
  | **TOTAL** | **1435** | **0** | **0** | **0** |

- `--apply` writes only "repoint" rows → it would write **nothing** here. The 17 downloads have since happened.
- OV was never measured and is out of bounds. Since 0bb0197 the app itself lists files not in the catalogue and asks
  before moving/repointing, so OV is covered by the app the next time it updates — no script on that machine.
- **Proposal:** close the item; don't run `--apply` anywhere.

## 2. Users list flipping between machines — cause found (code), fix is mostly backend
- Documented, never investigated: `docs/backend-deploy-compat-4.6.61-2026-10-20.md:101-103` ("OV's 12:49 push
  revoked jeff / Steve / Donavon … revoked and recreated many times since September as the two computers push
  different user lists to `/api/account/users/sync` (its reconcile step revokes users the pushing computer doesn't
  have)"); `docs/park-staff-login-2026-10-13.md:68`.
- Desktop: `src/lib/syncUsers.ts:18-33` POSTs the **whole local list**; the backend revokes anyone missing. Two
  computers with different lists → the account's users swap to whoever pushed last. (Inference from code.)
- Also: users that arrive by sync or by the same-person merge never trigger a push or a refresh — the merge emits
  `users:changed` (`electron/main.js:9149`) and nothing in `src/` listens; Preferences → Users only re-reads after a
  local edit (`SettingsPanel.tsx:4132-4170`).
- **Fix that needs nothing on OV:** the backend stops revoking on "missing from the list" (treat a push as upserts);
  removals become explicit (by uuid) from new desktops. OV's installed build keeps pushing full lists — under the new
  backend rule that only adds/updates, so the flip stops without touching OV. Desktop half: send explicit removals;
  listen for `users:changed` → refresh the list and push. Backend is the separate `ether-backend` repo (Railway) —
  a backend deploy is outward-facing → needs Jeff's go.

## 3. Roles don't restrict anything — confirmed in code; the permission table was never approved
- `docs/account-users-rbac.md:3` "Status: Spec / not started"; :59 says to *define* a matrix — none was ever approved.
- `src/UserContext.ts` has 8 permission hooks (the only matrix in the tree): edit, spots, scheduler, studio,
  delete tracks = admin + music_director; Settings, macros, streaming = admin only; default role jock.
  **No component provides `UserContext`** and **no hook has a caller** → every login has the same access.
  The only menu gates that ever existed were in the React menubar deleted in `4d8bfb0` (never rendered).
- Only real checks: "can't delete the last admin" (`SettingsPanel.tsx:4145`, `electron/sync/handlers/users.js:83`).
- **Needs Jeff:** approve the who-may-do-what table before it's enforced (proposal = the table in `UserContext.ts`).
  Then: provide `UserContext` from the signed-in user (`App.tsx:673`), gate the surfaces (Preferences, Smart
  Scheduler, Station Manager, Macros, Stream Manager, Studio, Spots, library delete) in the hamburger menu AND the
  native menu (`electron/main.js:3634,3703,3707`), and refuse the destructive IPC in main (e.g. `library:delete-asset`
  `main.js:4089`) — not just hide buttons.

## 4. Runaway `station_config_kv` writer — already fixed in August; backlog entry stale
- Found and fixed the day it was filed: `f582ec3` (4.4.225) — `stampLicenseEverywhere` re-stamped `license_key` every
  20 s (2,312 of 2,312 mutations identical before/after); no-op guard added
  (`electron/sync/handlers/station_config_kv.js:291-303`). `docs/fix-pass-2026-08-17-sync.md:28-33`.
- **Measured today on this computer** (read-only copy): 286 `station_config_kv` mutations in 24 h (~12/h, was ~745/h
  on OV). Top keys: `monitor_volume` 82, `park_sound_last` 61, `aux_monitor_levels` 21, `board_levels` 9,
  `sweeper_placement_log` 8 — **0 identical before/after**: every one is a real change (Park volume/sound commands,
  board moves, sweeper placement).
- Small leftovers (code): `stationConfigKvUpdate`/`Create` have no same-value guard; `last_error` from the Health
  Monitor error boundary is unbounded if a component crash-loops.
- **Proposal:** close `docs/backlog.md:622` pointing at `f582ec3` + today's numbers; add the same-value guard to
  Update/Create. OV's rate could be read from the backend (read-only) without touching OV, if wanted.

## 5. Machine-local paths travelling through sync — receiving fixed, sending not
- Design: `docs/design-machine-local-paths-2026-09-04.md` — Status **PROPOSED**; target B (`file_path` never synced,
  `file_key` identifies the file), bridge A, requires amending `sync-protocol-v0.md` §4.3 first (never done).
- Receiving side fixed: `localizeBlobRef` keeps the basename only (`electron/sync/mutation-writer.js:618-633`);
  `91800ba` keeps this computer's location unless the file changed (`merge-engine.js:292-310`).
- Sending side NOT fixed: `serializePayload` (`mutation-writer.js:542-551`) still sends the full absolute path for
  songs/library_asset/announcements/cart_slots/play_log/published_episodes/spots/voice_tracks `file_path` and
  `songs.intro_version_path`. **Live leak:** `library_asset.intro_version_path` is registered `scalar`
  (`synced-tables.js:159`) — travels raw and is stored raw on the receiver.
- **The OV catch:** HalloVeen is a station shared by OVEVENTS and ovowforestmusic, so whatever this computer sends,
  OV receives. A new envelope (`__blob_key` only) is safe only if OV's installed build already reads `__blob_key`.
  To check without touching OV: OV's reported version (backend, read-only) vs when `merge-engine.js:302` landed.
- **Proposal:** (a) now: register `library_asset.intro_version_path` as a blob-ref (receiver keeps basename) — safe
  for any receiver; (b) the protocol amendment + basename-only sending, after the OV-version check; (c) Option B
  (stop syncing `file_path`) stays a later, design-amendment-first step.

---

# Outcome (Jeff, 2026-10-27: "1. close it … 2. … guard … 3. Users list: yes … 4. Roles: don't build yet … 5. Paths: yes …
# don't change the sending format until OV understands it. Each change its own commit with a test. Don't touch
# ovowforestmusic, and don't build Ether.")

Nothing touched ovowforestmusic. Ether was not built. Desktop commits are local on branch `fix/library-sync-open-items`.

## 1. File-location repair — CLOSED
Not run anywhere; no `--apply`. The script (`scripts/repair-file-locations.js`) stays in the tree, read-only by default.

## 2. station_config_kv — CLOSED, guard added — `f3e9689`
- `docs/backlog.md` entry closed with today's numbers (286 / 24 h, 0 identical).
- `stationConfigKvUpdate`: the stored value again (or only `updated_at`) on a live row → nothing journaled.
- `stationConfigKvCreate`: a key this station already holds live with the same value → nothing journaled, no second row.
- Test: `npm run test:sync` — T-41b, T-41c (both FAIL on the previous handler, PASS now); 66/66.

## 3. Users list — server DEPLOYED, desktop committed
- **ether-backend `2cf4037`** (`src/lib/install-users.js`): `users` only adds/updates install users; `removed: [name]`
  revokes that one; a name in both is kept; dashboard users never touched; other licenses never touched.
  Test: `node --test src/lib/install-users.test.js` 8/8 (all 148 lib tests pass).
  **Deployed:** pushed `2cf4037` to `main` (fast-forward from `59a8b94`); Railway deployment `523fc2de` SUCCESS on
  commit `2cf4037` at 2026-10-27 22:19 PDT. Live log afterwards: `license:24 machine:041ceb96 (ovowforestmusic)` connecting
  normally. From this moment no computer — including OV's installed build — can remove a user by leaving them off its list.
- **Desktop `a52142d`**: sends `removed` = names deleted here or whose PIN was cleared, that no live user with a PIN still
  carries; a sync pull that applied `users` rows emits `users:changed`; Users & Security re-reads; App pushes.
  Test: `npx vitest run src/lib/syncUsers.test.ts` 5/5; `tsc --noEmit` 0 errors; `test:preload-bridge` PASS.
  Help: `docs/help-users.md` → "Signing in on the web".
- Accounts 21 and 23: not touched (the change is code; tests include "another license's users are never touched").
- **UNVERIFIED at runtime:** the desktop half needs a build; not built (Jeff: don't build Ether).
- Left as is: a person deleted on a new build but still live with a PIN on an old build is re-added by the old build's
  push and removed again by the new build's next push, until both run the same build (users sync since v67).

## 4. Roles — NOT BUILT. The table for Jeff's approval
The only who-may-do-what table in the code (`src/UserContext.ts`; nothing enforces it today). Three roles: **Admin**,
**Music Director**, **Jock** (a user with no role is treated as Jock).

| Action | Admin | Music Director | Jock |
|---|---|---|---|
| Open Preferences / Settings (incl. Users & Security) | yes | no | no |
| Edit songs and library items (titles, cues, categories) | yes | yes | no |
| Delete songs / library items | yes | yes | no |
| Manage Spots (commercials) | yes | yes | no |
| Open the Scheduler (clocks, programming, Generate) | yes | yes | no |
| Open the Studio (Show+ production) | yes | yes | no |
| Macros | yes | no | no |
| Streaming (Stream Manager, Icecast) | yes | no | no |
| Run the board, decks, play / stop, take a break | yes | yes | yes |

The last row isn't a hook in the code; it's what "everything not listed" means. Questions for Jeff are in the reply.

## 5. Paths — OV checked; the change is HELD (it would change the sending format OV understands)
**OV's version (read-only, backend Postgres, SELECT only, in a read-only session):** machine `041ceb96`
(ovowforestmusic), last seen 2026-10-27 22:31 UTC. Every mutation it sent in the last 3 days is **schema v68** (4,288,
latest 04:15 UTC 2026-10-28), so it runs the same schema as this build. Every v68 build contains the `__blob_key` reader
(`9bf3523`, first tagged v4.6.49). OV sends no `__blob_key` itself (no build does).

**Why it's held:** a column's wire format comes from the **sender's** registry, and how it's read comes from the
**receiver's** registry. On OV's installed build, `library_asset.intro_version_path` is `scalar`. Register it `blob-ref` here,
and this computer sends an envelope object `{__blob_ref, __blob_origin, …}` for it. OV's scalar reader would hand that
object to SQLite as the value, and better-sqlite3 refuses to bind an object. **That library_asset change would fail on
OV.** My earlier write-up said it was "safe for any receiver". That was wrong.

- Rows affected today: **0**. On this computer, 0 of 689 library items have an intro version, and no library_asset
  mutation in the journal carries one. Nothing leaks right now.
- **Options for Jeff:**
  - (i) Register it `blob-ref` in a build that BOTH computers install. Only switch the sending side once OV runs it.
  - (ii) Now: send the bare file name as a plain string (same scalar format, file name only). OV would store just the name.
    This changes the value, not the format, but it is a protocol-level change (`synced-tables.js`: "do not edit category
    values without consulting the protocol doc").
- Recommendation: (i). Nothing is affected today, so there's no urgency.

# Roles enforcement — what exists, the design, and one conflict held for Jeff (2026-10-29)

**Jeff (verbatim):** "4. Roles: build the table in docs/library-sync-open-items-2026-10-27.md as it stands, enforced in
the menus, the Park page and the main process."

The table: `docs/library-sync-open-items-2026-10-27.md` §4, continued (with the 2026-10-29 correction: closing time is
everyone; announcements edit is Admin/MD, Park view only). Nothing is built yet: this doc is the read-only map (from the
code, file:line) plus one conflict that needs Jeff's call before the main-process part can be built.

## What the code does today (static reading; runtime UNVERIFIED unless said)

- **No role reaches the screen.** `src/App.tsx:20` imports `UserContext` but never renders `UserContext.Provider`; the
  signed-in profile lives in `App.tsx:673` `currentUser` state. So `useRole()` is always "jock" and none of the
  `useCan*` hooks (`src/UserContext.ts`) is called by any door. Today every profile can do everything.
- **The main process doesn't know who is signed in.** The PIN is checked in main (`user:verify-user-pin`,
  `electron/main.js:7980`), but main keeps nothing: no current-profile state exists there.
- **Pop-out windows skip the profile gate** (`src/main.tsx:67,112` → `PopoutRenderer`), as do `#desk` and `#cueeditor`.
- **`ether.invoke(channel)` reaches any channel** (`electron/preload.js:597`), so enforcement must be in main; gating
  preload methods alone would be decoration.
- **The Park page already matches the table.** It offers only: closing time, master level, mute, fire carts, listen,
  hold to talk (`/public/ops/:slug/*` in ether-backend) — every one is "yes" for a Park login in the table, and it has no
  announcement editing, board, AUTO or ON AIR. Enforcing the Park column means pinning that list with a test so nothing
  else is ever added without a role decision.
- Noted only (doors): Settings has no hamburger/drawer door (native File → Settings only); the Macros panel has no door
  at all (`App.tsx:3249`, no `setPanel("macros")`).

## The design (within the existing architecture)

1. **One table, one module** — `shared/roles.js` (CommonJS, read by main and renderer): action → which of admin /
   music_director / jock / park may do it, exactly the approved table. Unit-tested row by row against the doc.
2. **Main knows the profile, proven in main.** `user:verify-user-pin` success sets main's current profile; a profile
   with no PIN can be selected without one (that is today's rule, `UserLogin.tsx:136`); switch user clears it. The role
   is re-read from the `users` table on every check, so a role change applies at once.
3. **Main enforces.** A guard at the two registration points every handler already goes through —
   `routeScreenReads(...).handle` (`electron/screen-reads.js:26`, all typed tables) and the `ipcMain` used by main.js —
   maps write channels to table actions and refuses with `role_forbidden: <action>` (shown in plain words).
4. **Menus show only what the profile may do** — `UserContext.Provider` rendered with `currentUser`; every door for a
   restricted action (native menu actions, drawer, view tabs, shortcuts, buttons) reads the same table; pop-outs follow
   the main window's signed-in profile.
5. Help entry `docs/help-roles.md`; Health Monitor shows the signed-in profile and its role.

## CONFLICT — held for Jeff: dashboard edits run through the same channels

Dashboard edits reach the install over the command bus: `db:apply` → `execCmd` (`App.tsx:1789`) →
`applyDbMutation` (`src/lib/ccData.ts:1257`) → **the same typed channels the desk uses** (`ether[ns].create/update/
delete`). The tables it writes (`ccData.ts:836`): categories, clocks, clock_slots, shows, songs, station_programming,
artists, albums, spots — exactly the Admin/MD-only rows.

So a main-process guard keyed on the desk's signed-in profile would **refuse every dashboard edit while a Jock is on
shift** (main can't tell a desk click from a dashboard command — both arrive from the renderer). That breaks the
categories/programming mirror (CLAUDE.md "the rails"). Under "stop if something breaks", the main-process part is not
built until Jeff decides:

- **(1) Recommended: dashboard commands carry their own authority.** The command bus is received by the main process
  instead of the renderer, so main knows a write came from the dashboard (already authorized by the backend for that
  account) and applies it whatever profile is at the desk. Desk clicks are checked against the desk profile. Larger
  change (moves the SSE consumer to main), but it is the only version where main can tell the two apart.
- **(2) Interim:** enforce in main only the rows the command bus never writes (Settings/users, backup & restore, Patch
  Bay, streaming setup and ON AIR, macros, Generate and Program Log edits, cart wall, announcements), and enforce the
  library / spots / scheduler-table rows in the menus only until (1) is built.
- **(3)** Dashboard edits are refused while a restricted profile is on shift (the literal reading; breaks the mirror).

Also for Jeff: should pop-out windows follow the main window's profile (proposed), and should a profile with no PIN
keep logging in with one click (today's behaviour, proposed to keep)?

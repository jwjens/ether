# Park page staff login — the existing username + PIN users (2026-10-13)

Jeff: staff log in with the SAME username + PIN system Ether already has. Reuse it, don't build a second one. Keep the long key working until he says to remove it. GO given to test and deploy.

## The existing user/PIN system (as found)

- **Where users are made:** **Ether → Settings → Users & Security** on each air machine. Each user has a name, a role (admin/jock) and a 4-digit PIN, stored scrambled ("salt:sha256"), never as digits.
- **Copied to the server:**
  - Ether copies every user that has a PIN up to the account (`POST /api/account/users/sync`, `src/lib/syncUsers.ts`), as soon as users change and whenever someone signs in.
  - On the server they're `account_users` (username + PIN), the same people who sign in to the Remote page (app.ether-cast.com).
  - The Remote page's **Users** tab only *listed* them until now.
- **Lockout:**
  - The server's login locked a user out after **5** wrong PINs for **15** minutes. Both numbers were constants in code.
  - Ether's own profile screen has no lockout (it only shakes).

## What was built

**Server (`ether-backend` `028b41a` + `9727acc`, deployed 09:35 UTC):**
- `POST /public/ops/:slug/login` (username + PIN).
  - The server checks the PIN, applies the lockout, and checks that this user is allowed on this station's Park page.
  - It returns a device session; the server keeps only its fingerprint.
- `GET /public/ops/:slug/me` and `POST /public/ops/:slug/logout`.
- **Every Park change** (sound level, MUTE, carts, closing time) goes through one check (`parkActor`): a staff session, **re-checked on every request**, or the long `?k=` key.
  - Log out, a PIN change, removing the user, or taking away their Park access logs that device out at once.
  - A device otherwise stays logged in (no expiry).
- **Login safety settings**, per account (`account_security_settings`): wrong-PIN tries and lock-out minutes. They are used by **both** the Remote page login and the Park page login. Values in use until saved: 5 / 15, what applied before.
- **Who did what** (`park_audit`): every log in, log out, sound level, MUTE, cart and closing-time change, with the staff name (or "Staff link (long key)") and the time.
- Rules in `src/lib/park-auth.js`.

**Remote page → Users (`ether-dashboard` `14318b4`, deployed):**
- Under each user: **"Can use the Park page for: ☐ Christmas In July ☐ Halloween ☐ Magical Forest ☐ Opportunity Village"** (every station with a public page). Tick to allow, untick to remove; the device is logged out at once.
- **Login safety:** "Wrong PIN tries before the user is locked out" and "Lock-out time (minutes)" → **Save login safety**.
- **Park page activity:** When / Who / Station / What, newest first (last 200).

**Park page (`ether-park`, deployed):**
- A big **LOG IN** bar at the bottom of the left column. It opens Username + PIN.
- Once logged in: **"Logged in: Maria"** and a big **LOG OUT**.
- Without a login (or the long key) the page is view-only and says so.
- A lost login shows the server's reason ("Your PIN was changed. Please log in with the new PIN.").

## Tests

- `park-auth.test.js`: 11. All server unit tests: 119/119.
- **End to end:** the real server code ran locally on a throwaway Postgres (torn down after) — **26/26**:
  - no access → refused by name;
  - access granted on the Users tab;
  - settings 3 tries / 10 min → locked on the 3rd wrong PIN for 10 min, even the right PIN refused;
  - right PIN (any case) → "Logged in: Maria";
  - changes refused without login or key;
  - the long key still works, a wrong key is refused;
  - PIN change → logged out;
  - access removed → logged out;
  - user removed → logged out;
  - stays logged in across refreshes; Log out ends it;
  - the Remote page login follows the same 3-try setting;
  - log ins and log outs appear in the activity.
- **Screenshots:** the local login flow and the Users tab, plus the live Park page (LOG IN) and the live Users tab (the four real users with their Park boxes).
- **Not tested live:** a real staff login on HalloVeen. Nobody has Park access yet, and I didn't create users or tick boxes on Jeff's account.

## To use it

1. Make sure the staff member exists in **Ether → Settings → Users & Security**, with a PIN.
2. **Remote page → Users** → tick **Halloween** under their name.
3. On their phone: park.ether-cast.com/halloween → **LOG IN** → username + PIN.

## Found, not changed

- **Two machines, two user lists.** Users aren't shared between installs (`users` is not a synced table). Each machine's push *removes* account users the other machine doesn't have.
  - So if OVEVENTS and ovowforestmusic have different users, whichever pushed last decides who exists. A user missing on one machine can be dropped, and their Park login with it.
  - Park access is kept by username, so it comes back with the user, but they'd have to log in again.
  - Fix proposed separately, not built.
- **HalloVeen's MONITOR level is 0** (set 08:32 UTC, before tonight's install; no Park command sent it). The Park page shows MUTED / off because that is the real level. Not changed.

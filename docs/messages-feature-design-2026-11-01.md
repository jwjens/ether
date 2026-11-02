# Messages — notification popups from the platform (design, 2026-11-01)

**Status: DESIGN ONLY. Nothing built. Waiting for Jeff's OK; screenshots before any deploy.**

## Jeff's ask (verbatim)
- "In the platform: a Messages page where I write a title, the text, and an optional button (label + link). I choose who
  gets it: everyone, a plan, trials only, or specific licenses (by number/email). Optional start and end date."
- "In Ether: it shows as the same popup style as the billing notices: readable, with Dismiss (and the button if I added
  one). Never blocks the app, never takes keyboard focus, never stops audio. Once dismissed, that user doesn't see it
  again. Picked up by the regular 20-second account check."
- "Also show it on the account site and web dashboard."
- "In the platform, show who has seen and dismissed each message."
- "If the 4.6.57 report finds any existing way to show server text in old builds, use it so old builds get the message
  too, without blocking anything."
- "Don't change any license."

## Old builds (4.6.57) — what the report found
4.6.57 has **no** surface that shows server text without blocking (`docs/desktop-4.6.57-server-text-and-expired-trial-2026-11-01.md`):
it ignores `billing_notice` / `entitlements`, has no message channel, and shows server text only on failed sign-in calls
(which block). So Messages reach **builds from the next release on**, plus the account site and the web dashboard for
everyone. Nothing is sent to old builds through an error path.

## Who "a user" is
The **account** (= its license). Seen and dismissed are kept per license, so a message dismissed in Ether doesn't come
back on the account site or the dashboard, and vice versa. (Several computers on one account share it.)

## Data (backend, two new tables; no license column touched)
```sql
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,            -- up to 80 characters, plain text
  body         TEXT NOT NULL,            -- up to 600 characters, plain text (line breaks kept, no HTML)
  button_label TEXT, button_url TEXT,    -- optional together; https:// only
  audience     JSONB NOT NULL,           -- {"type":"all"} | {"type":"plan","plans":["station",…]} | {"type":"trials"}
                                          -- | {"type":"licenses","license_ids":[…]}  (emails resolved to ids when sent)
  starts_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at      TIMESTAMPTZ,              -- optional; "Stop" sets it to now
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS message_receipts (
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  license_id   INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ, seen_on TEXT[] NOT NULL DEFAULT '{}',   -- 'ether' / 'account' / 'dashboard'
  dismissed_at TIMESTAMPTZ, dismissed_on TEXT,
  PRIMARY KEY (message_id, license_id)
);
```
- **Audience**, resolved when a license asks (so a license that joins a plan later still gets a running message):
  everyone = every active license; a plan = the license's plan as the catalog names it (Local, Live 128, Live 320,
  Network; lifetime/Enterprise count as Network); trials = licenses on a trial (an end date, not lifetime, not Stripe),
  ended trials included; specific licenses = the listed ids. ▶ Lifetime and platform-made licenses are included in
  "everyone" (they're accounts too) — say if they should be left out.
- A message is **due** for a license when now is between start and end, the audience matches, and it has no
  `dismissed_at` for that license.

## Delivery
- **Ether (new builds):** `/account/connect` (the 20-second check) adds `messages: [{ id, title, body, button? }]` —
  the due ones, oldest first. Ether shows them **one at a time** in the billing popup's style and place (top right),
  after any billing notice is closed. Same rules as that popup: not modal, no backdrop, never takes keyboard focus
  (buttons out of the tab order; a click doesn't move focus), never touches audio. **Dismiss** (and the button, if any:
  it opens the link in the browser and also dismisses). Shown → `POST /account/messages/:id/seen`; Dismiss →
  `POST /account/messages/:id/dismiss` (license key header, like connect). A due message that is open stays open across
  check-ins; it disappears when dismissed, stopped or past its end.
- **Account site:** `/api/user/me` adds `messages`; the same popup the account site already uses for billing notices,
  with Dismiss → `POST /api/user/messages/:id/dismiss`. Seen recorded on display.
- **Web dashboard:** its account data read adds `messages`; same popup and dismiss (owner sign-in).
- Recording seen/dismissed never fails or delays anything; a failed call just retries on the next check.

## Platform: Messages page (new menu item)
- **Compose:** Title, Text, optional Button (label + link), Who gets it (Everyone · A plan [pick] · Trials only ·
  Specific licenses [numbers or emails, one per line — each shown resolved as "license N (email)" before sending, unknown
  ones flagged]), Start (default now), End (optional). A live preview in the Ether popup style. **Send**.
- **List:** each message with its window, audience, and counts — *Reaches* (licenses in the audience now) · *Seen* ·
  *Dismissed* — and **Stop** (ends it now). Messages are not edited after sending (send a new one; stop the old).
- **Who saw it:** per message, a table — license N (email), plan, first seen (and where: Ether / account / dashboard),
  dismissed (when, where), or "not yet".
- Platform sign-in only (`requirePlatform`), like Licenses.

## Safety
Plain text only, length limits enforced on the server; button links https:// only (opened in the external browser);
nothing a message does can block, take focus or affect playout. No license row is ever written.

## Tests (planned)
Audience resolution (each type; plan mapping incl. lifetime; trials incl. ended; specific licenses by id and email);
due/not due (before start, after end, stopped, dismissed); connect/me/dashboard carry exactly the due ones; seen recorded
once per surface; dismiss on one surface hides it on all; limits and https-only enforced; the platform counts and the
who-saw-it table; the desktop popup never takes focus, never touches audio, shows one at a time after the billing
notice; no license row changes (byte-for-byte check).

## Screenshots before deploy
Platform compose (with preview) and list/who-saw-it; the Ether popup (desktop dev build); the account site popup; the
dashboard popup — desktop and phone width.

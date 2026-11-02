# Claim a license with its key — design (2026-11-01)

**Status: DESIGN ONLY. Nothing built. Waiting for Jeff's OK on the decisions marked ▶.**

## Jeff's rules (verbatim)
- "My 10/28 rule stands: a license is claimed only with its key or by a verified, invited member."
- "On the account site, a signed-in user with a confirmed email can enter a license key to link that license to their
  account. Only if the license is active and no other account has it. Wrong or already-claimed keys get a clear message."
- "The issued key must keep working after it's claimed: never replace or change the key. If that needs a database change,
  show me the design before building."
- "Nothing automatic: licenses 21 (netgeak@gmail.com) and 23 (cristianmalliani@gmail.com) are only linked if those
  customers enter their own key themselves."
- "Someone already on a trial who claims a key: show me the plan for their existing stations before building it."
- Platform key email: "Create your account at [account site link], confirm your email, then enter this key under Have a
  license key. Then install Ether and sign in."
- "Don't change any license."

## Facts (receipts)
- **Production today** (read-only, `scripts/prod-claim-scope-readonly.js`): 16 licenses, **all 16 already have an
  account linked**; 0 waiting to be claimed. License 21: plan free, plaintext key, account linked, 2 stations. License 23:
  plan station, plaintext key, account linked, 1 station. So this feature only matters for licenses issued from now on.
- **How a key is stored.** Older licenses keep the key in plain text (`licenses.license_key`). Licenses made since the
  bcrypt change (platform issue, Stripe) keep only `key_prefix` + `key_hash`; the key itself exists only in the email.
- **Why "never change the key" needs a change.** Desktop sign-in (`/api/user/desktop-activate`) must hand Ether a key.
  For a hash-only license it has none, so today it **makes a new key and overwrites `license_key`/`key_prefix`/`key_hash`**
  on the license. After that the emailed key no longer works. This must never happen to a claimed license.
- **Where an account's stations live.** Server: `stations.license_key_id` and everything under the station; plus
  `station_attachments`, `library_songs` / `library_snapshot_version` / `library_tombstones` (one cloud library per
  license), `mutations`, `license_activations` and `backups` (by key text), memberships / account_users / positions
  (account = license), library grants, jukebox, payouts, park sessions. R2: `{license id}/backups/…`. **Desktop: one data
  folder per license key** (`%LOCALAPPDATA%\Ether\profiles\<key>\openair.db`, `electron/profile-paths.js`), with
  `stations.owner_license_key` inside it.

## Design

### 1. The claim (account site → backend)
`POST /api/user/claim-license` `{ license_key }`, signed-in user only (Bearer). In one transaction:
1. **Email confirmed** (`users.email_verified`) — else refuse.
2. **Find the license by its key** the same way the server already checks keys (`key_prefix` + bcrypt, or the plaintext
   column for older keys). Not found → refuse.
3. **Active**: `active = true` and not expired (a lapsed trial key can't be claimed).
4. **No other account has it**: no `users.license_key_id` points at it and no claim row exists for it. (A unique rule in
   the database makes two claims at the same moment impossible — see §2.)
5. **The user's own situation** (▶ decision in §4): no license yet → link. Already linked to this license → "already
   yours". Already on a paid plan → refuse ("contact support to combine"). On a trial → §4.
6. Link: `users.license_key_id = license.id`, and write the claim row (§2). **The license row is not written** — not its
   key, plan, status, dates, email or seat tier.

Limits: 10 tries per 15 minutes per account and per address (wrong-key guessing), same as the other sign-in limits.

Messages (plain words):
| Case | Message |
|---|---|
| Email not confirmed | "Confirm your email first. We sent a link to {email}." + Send a new link |
| Key not found | "That key isn't valid. Check it against your email and try again." |
| License switched off / expired | "That license isn't active. Contact support@ether-technologies.com." |
| Linked to another account | "That key is already linked to another Ether account. If that isn't you, contact support@ether-technologies.com." |
| Already yours | "That key is already linked to your account." |
| You already have a paid plan | "Your account already has the {plan} plan. Contact support to combine them." |
| Too many tries | "Too many tries. Wait 15 minutes and try again." |
| Linked | "Linked: Ether {plan}. Install Ether and sign in with this email and password." |

### 2. Keeping the issued key working — the database change ▶
New table, nothing else changes:
```sql
CREATE TABLE IF NOT EXISTS license_claims (
  license_id  INTEGER PRIMARY KEY REFERENCES licenses(id) ON DELETE CASCADE,  -- one account per license
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  key_enc     TEXT NOT NULL,          -- the key the user typed, encrypted (AES-256-GCM, LICENSE_CLAIM_SECRET on Railway)
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_ip  TEXT                    -- the trusted address (clientIp)
);
```
- The key is checked against the license's own hash before it is stored, so it is exactly the issued key.
- **Desktop sign-in change:** when the account's license has no plaintext key, use the claimed key from
  `license_claims` (decrypted) — **never mint a new one, never write the license**. The re-key stays only for a license
  nobody was ever given a key for (an account-site Stripe purchase); a claimed license never reaches it.
- Ether then connects with the issued key; the server already accepts it (prefix + hash), so nothing on the desktop changes.
- ▶ Encrypted (recommended; needs one new Railway secret) or stored in plain text like trial keys already are.

### 3. Licenses 21 and 23
Nothing automatic anywhere: the only way any license gets linked is a person typing its key (or a verified invited
member, as today). Both already have their own accounts linked, so for them a claim would answer "already yours" (or,
for anyone else, "linked to another account").

### 4. Someone on a trial who claims a key ▶
Their trial stations live under the trial license on the server, in R2, and in a separate desktop data folder named by
the trial key. Signing in with the claimed license opens a different folder, so those stations would look gone.
- **A — v1, recommended.** Trial with **no stations**: link at once (the trial license is left as it is, unused).
  Trial **with stations**: don't link; say "Your trial has {n} stations. Claiming this key would start you on it without
  them. Contact support and we'll move them." Nothing is lost, nothing moves.
- **B — move the stations** (later, its own design): one server transaction re-points every table above from the trial
  license to the claimed one (merging clashes when the claimed license already has stations or a library), copies the R2
  backups, and the desktop re-files the local folder and `owner_license_key`. Large and touches many tables; I would
  design and test it separately before building.
- **C — let them choose** "start fresh on the claimed license" (trial stations stay under the trial, reachable only by
  support). Simple, but a person can lose sight of their work.

### 5. Account site
A "Have a license key?" section on the account page: one field + **Link key**. Disabled with the confirm-email message
until the email is confirmed. Shows the messages above; on success the page reloads into the claimed plan.

### 6. Emails
- Platform-issued key email (both `/api/platform/licenses` and `/admin/issue`), Jeff's words: "Create your account at
  {account site link}, confirm your email, then enter this key under **Have a license key**. Then install Ether and sign
  in." Key kept in the email as the reference; download links kept.
- The thank-you email for a buyer with **no account** (old payment link) gets the same steps (it currently says "create
  your account, then install and sign in", which would land them on a trial).

### 7. Tests (one per check)
Claim refused: email not confirmed · wrong key · inactive · expired · linked to another account · claim row exists ·
two claims at the same moment (only one wins) · user already paid · trial with stations (A). Claim allowed: hash-only key,
plaintext key, trial with no stations. The license row is byte-for-byte unchanged after every claim. Desktop sign-in on a
claimed hash-only license returns the issued key, never writes the license, and the key keeps passing `/account/connect`.
Rate limit per account and per address. Licenses are never linked without a typed key (the 10/28 STRANGER test stays).

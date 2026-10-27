# Account sign-in: remember me, password managers, Google / Microsoft / Apple — PLAN (no build) — 2026-10-26

Jeff, 2026-10-26: "Plan (no build yet): account sign-in improvements. 1) 'Remember me': a secure, revocable sign-in token
stored with Electron safeStorage / Windows protected storage; never store the password. 2) Sign-in fields compatible with
password managers. 3) Sign in with Google, Microsoft and Apple via the system browser (OAuth with PKCE), linked to the
existing Ether account by verified email, no duplicate accounts. Include sign-out everywhere and how a lost computer's
token is revoked. Station PINs are unchanged. Backend and app changes, security, and phases each with a test."

## Where it stands today (measured, not assumed)

| | Today | Receipt |
|---|---|---|
| Desktop sign-in | email + password → `POST /api/user/desktop-activate` | OnboardingFlow.tsx:487 |
| What comes back | one JWT `{ uid, email, typ:"user" }`, **12 h**, no refresh token | ether-backend index.js:72, :2202 |
| Server-side session | **none** — `requireAuth` only verifies the signature, so a token cannot be revoked before it expires | index.js `requireAuth` |
| Where the desktop keeps it | `install_config_kv.account_jwt`, **plain text inside `openair.db`** | OnboardingFlow.tsx:532; main.js:4070 |
| Does it sync? | No — 0 journal entries carry it (OVEVENTS copy) | `mutations` on the live copy |
| Does it leave the machine? | **Yes, inside backups**: local and cloud backups are copies of `openair.db` (`<lic>/backups/*.db.gz` in R2) | backups are whole-file copies |
| Password field | `type="password"`, no `<form>`, no `name` / `autocomplete` | OnboardingFlow.tsx:1243 |
| safeStorage | already used once (main.js:9292, a key encrypted with DPAPI) | main.js:9292-9302 |
| Station PINs | separate (scrypt, synced `users`) | **unchanged by this plan** |

## The design

### A. Sessions the server can revoke (the base everything else stands on)

- New table `auth_sessions`: `id` (uuid, = `sid`), `user_id`, `machine_id`, `device_name`, `created_at`, `last_used_at`,
  `expires_at`, `revoked_at`, `revoked_reason`, `refresh_hash` (sha-256 of the current refresh token, never the token),
  `family_id` (rotation chain), `method` (`password` | `google` | `microsoft` | `apple`).
- **Access token**: JWT `{ uid, email, typ:"user", sid }`, **15 min**. `requireAuth` additionally refuses a token whose
  `sid` is revoked (one indexed lookup, cached ~30 s), so revocation takes effect within seconds, not at expiry.
- **Refresh token**: 256-bit random, opaque, **rotated on every use**; lifetime 90 days sliding (a setting, not a constant).
  Presenting an already-used refresh token = theft signal → the whole `family_id` is revoked and the user must sign in.
- Endpoints: `POST /api/auth/session` (password → access + refresh), `POST /api/auth/refresh`, `POST /api/auth/logout`
  (this session), `POST /api/auth/logout-all`, `GET /api/auth/sessions` (my computers), `DELETE /api/auth/sessions/:id`.
  Platform owner: `GET/DELETE /api/platform/users/:id/sessions`.
- **Password change or reset revokes every session** of that user.
- Old 12 h tokens without `sid` keep working until they expire (no forced sign-out on deploy), then are gone.

### B. "Remember me" on the desktop (item 1)

- The **refresh token only** is stored, encrypted with `safeStorage.encryptString` (Windows: DPAPI, bound to the Windows
  user; macOS: Keychain), in `profiles\<key>\auth.bin` — **outside `openair.db`**, so it is in no backup, local or cloud.
  The password is never stored, never written to a log, never kept in memory past the request.
- The access token lives in main's memory only; the renderer never sees the refresh token.
- Launch: refresh → new access token → signed in. Refresh refused (revoked / expired / reused) → `auth.bin` deleted →
  sign-in screen with the reason in plain words ("This computer was signed out from another device").
- "Remember me" unchecked → refresh token in memory only; quitting signs out.
- `safeStorage.isEncryptionAvailable()` false → Remember me is disabled with that reason shown; never a plaintext fallback.
- **Offline first stays true:** a station that is on air keeps playing with no network and with an expired session;
  the session gates account and cloud features, never playout (feedback_offline_first_self_sufficient).
- Migration: on first launch of the new build, an existing `account_jwt` is exchanged once for a session and then
  **deleted from `install_config_kv`** (and the key added to the backup scrubber, so old ones are not re-copied).

### C. Password-manager friendly fields (item 2)

- A real `<form method="post">` with a `type="submit"` button (Enter submits; managers detect the form).
- Email: `type="email" name="email" id="ether-email" autocomplete="username" inputmode="email" autocapitalize="off"
  spellcheck="false"`. Password: `name="password" autocomplete="current-password"`; sign-up `autocomplete="new-password"`
  with `passwordrules` (minlength 8). Paste always allowed; no `onCopy/onPaste` blockers.
- Honest limit: Electron has no browser-extension password managers. What works on Windows is **paste** and desktop
  auto-type (1Password / Bitwarden / KeePass), which need standard fields and a stable window title ("Sign in — Ether").
  The OAuth buttons (D) cover passkeys and saved Google/Microsoft/Apple logins through the user's real browser.

### D. Sign in with Google, Microsoft, Apple through the system browser (item 3)

Flow (RFC 8252 native-app pattern, PKCE S256 end to end):
1. Desktop makes `code_verifier` (random 64 bytes) + `state` + `nonce`, opens a loopback listener on `127.0.0.1:<random
   port>` and opens the **system browser** at `https://ether-backend…/auth/oauth/<provider>/start?state&code_challenge
   &port`.
2. Backend redirects to the provider (its own PKCE + `nonce`), receives the callback at its HTTPS redirect URI (Apple
   allows no loopback — another reason the backend is the provider's client), validates the **ID token** (signature via
   the provider's JWKS, `iss`, `aud`, `exp`, `nonce`).
3. Backend redirects the browser to `http://127.0.0.1:<port>/callback?code=<one-time Ether code>&state`. The Ether code
   is single use, 60 s, stored hashed, bound to the `code_challenge`.
4. Desktop checks `state`, posts `code + code_verifier` to `POST /api/auth/oauth/exchange` → a session exactly as in A.
   No provider token is ever stored; Ether keeps only `(provider, subject)`.

Linking — **no duplicate accounts**:
- New table `user_identities(user_id, provider, subject, email, linked_at)`, `UNIQUE(provider, subject)`.
- Known `(provider, subject)` → that user. Otherwise link to the existing user **only when** the provider asserts the
  email is verified **and** `users.email` matches case-insensitively **and** `users.email_verified` is true.
  - Google: `email_verified: true`.
  - Microsoft: the `email` claim is NOT proof of ownership for work/school tenants (the "nOAuth" class) → link only when
    the verified-email claim (`xms_edov`) is present, else require one password sign-in to link.
  - Apple: real email with `email_verified`; a **private relay** address (`@privaterelay.appleid.com`) never matches →
    "sign in with your password once to link Apple".
- No matching account → **no account is created** (Ether accounts belong to a license); the screen says "No Ether account
  uses <email>" with Sign in with password / Create account.
- Settings → Account → "Sign-in methods": linked providers, link / unlink (never unlink the last way in).

### E. Sign out, everywhere, and a lost computer

- **Sign out (this computer):** `POST /api/auth/logout` → server revokes the session; `auth.bin` deleted; existing
  sign-out (engine stopped, profile dormant) unchanged.
- **Sign out everywhere:** Settings → Account and app.ether-technologies.com → Account: `logout-all` → every session
  revoked; each computer drops to the sign-in screen at its next request (seconds, via the `sid` check).
- **Lost / stolen computer:** from any signed-in Ether, or app.ether-technologies.com → Account → **Computers & sessions**
  (name, last used, IP city, method) → **Sign out this computer**: its session is revoked (refresh refused, access refused
  by `sid`), and the existing **Remove machine** frees its seat (now on the owner dashboard too, 59a8b94). The platform
  owner can do the same for any user. What it does NOT do: wipe the station already on that disk (it is local, offline
  data); its station PINs still guard the console. Remote wipe is out of scope.
- Password reset from "Forgot password" also revokes every session — the lost-computer path for someone who has lost
  every signed-in device.

## Security notes

- Refresh tokens and one-time codes stored only as sha-256 hashes; constant-time compare; rotation + reuse detection.
- `authLimiter` on every new auth endpoint; lockout signal on repeated refresh failures from one session.
- Loopback listener: `127.0.0.1` only, random port, accepts one request with a matching `state`, closes in 5 min.
- Logs never contain a password, refresh token, access token, Ether code, or ID token (one test greps for them).
- `auth.bin` is user-bound (DPAPI): copying the profile folder to another machine or Windows user does not carry a
  usable session.

## Phases — each ships alone, each with its test

| Phase | What | Test |
|---|---|---|
| **0** | Token out of the database: existing `account_jwt` → safeStorage `auth.bin`, key deleted from `install_config_kv`, backup scrubber | Desktop: after migration `openair.db` and a fresh backup contain no `account_jwt` and no JWT-shaped string; `auth.bin` is not plaintext; decrypts to the token |
| **1** | Backend sessions (A): table, refresh rotation, revocation, logout / logout-all / sessions list, password change revokes | Backend pg-mem: rotation issues a new token and refuses the old; reuse revokes the family; revoked `sid` → 401 within the cache window; logout-all; password reset revokes; old no-`sid` tokens still verify until expiry |
| **2** | Desktop remember me (B) + sign out / sign out everywhere / lost-computer UI (E), web Account → Computers & sessions | Desktop: remember on → relaunch signs in with no password; off → relaunch shows sign-in; server revocation → next launch shows sign-in with the reason; no password anywhere on disk (grep of profile + logs); playout continues with a revoked session |
| **3** | Password-manager fields (C) | DOM test: form/submit, names, autocomplete values, no paste blockers; Enter submits |
| **4** | Google + Microsoft (D) | Backend with a mocked provider (local JWKS): bad `state`, PKCE mismatch, replayed Ether code, expired code, wrong `aud`/`iss`/`nonce` all refused; verified email links the existing user; unverified (incl. Microsoft without `xms_edov`) does not; no `users` row is ever created; desktop loopback accepts only the matching `state` |
| **5** | Apple (D) — needs an Apple Developer account, Services ID, key | Same suite + private-relay email never auto-links |

## Decisions for Jeff before Phase 1

1. Remember me **on by default**, or off?
2. Access token 15 min and refresh 90 days sliding — or other numbers (they become settings, not constants)?
3. May Google/Microsoft/Apple ever **create** a new Ether account, or only sign in to an existing one (this plan: only existing)?
4. Microsoft: personal accounts only, or work/school too (work/school links only with `xms_edov`, else one password sign-in)?
5. Apple needs the Apple Developer Program (Services ID + signing key) — who holds it?

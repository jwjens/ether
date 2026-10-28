# Sign in with Google and Microsoft — what Jeff sets up (2026-10-28)

**Jeff (verbatim):** "Before writing code that needs them, give me step-by-step instructions for what I have to set up
myself: the Google Cloud OAuth client (including the consent screen) and the Microsoft Entra app registration, with the
exact redirect addresses to enter. I'll create them. Never ask me to paste a secret into chat; tell me which Railway
variable to put each one in."

Phase 4 of `docs/account-sign-in-plan-2026-10-26.md`. The desktop opens the **system browser**; the provider sends the
browser back to **Ether's backend** (never to the desktop directly), which checks the provider's ID token and hands the
desktop a one-time code over `127.0.0.1`. Sign-in only: it matches an **existing** Ether account by an email the provider
says is verified, and never creates one.

**The two redirect addresses (enter exactly, no trailing slash):**

| Provider | Redirect URI |
|---|---|
| Google | `https://ether-backend-production.up.railway.app/auth/oauth/google/callback` |
| Microsoft | `https://ether-backend-production.up.railway.app/auth/oauth/microsoft/callback` |

**The four Railway variables** (Railway → project → service **ether-backend** → **Variables** → New Variable). Paste
each value there; never into chat:

| Variable | Value comes from |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Google, step 3 ("Client ID") |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google, step 3 ("Client secret") |
| `MICROSOFT_OAUTH_CLIENT_ID` | Microsoft, step 1 ("Application (client) ID") |
| `MICROSOFT_OAUTH_CLIENT_SECRET` | Microsoft, step 4 (the secret's **Value**, not its ID) |

Saving a variable redeploys the backend; the code that reads them is not deployed yet, so nothing changes until then.

## Google

1. **Project.** https://console.cloud.google.com → project picker → **New project** → name `Ether Sign-In` → Create.
   Make sure it is the selected project for the next steps.
2. **Consent screen.** Menu → **APIs & Services → OAuth consent screen** (newer console: **Google Auth Platform →
   Branding**).
   - User type: **External** → Create.
   - App name `Ether`; User support email: yours; App logo optional; App home page `https://ether-cast.com`;
     Authorized domains: add `ether-cast.com` and `railway.app`; Developer contact: your email → Save and continue.
   - **Scopes** (Data access): Add → tick `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` → Update →
     Save. These three are non-sensitive: no Google review is needed.
   - **Test users** (Audience): while the app is in **Testing**, only listed Google accounts can sign in. Add your own
     to try it; when ready for everyone, **Publish app** (Audience → In production). With only these scopes, publishing
     needs no verification.
3. **Client.** **APIs & Services → Credentials → Create credentials → OAuth client ID** (newer console: **Clients →
   Create client**).
   - Application type: **Web application**; Name `Ether backend`.
   - Authorized JavaScript origins: none.
   - **Authorized redirect URIs → Add URI:** `https://ether-backend-production.up.railway.app/auth/oauth/google/callback`
   - Create. Copy **Client ID** into Railway `GOOGLE_OAUTH_CLIENT_ID` and **Client secret** into
     `GOOGLE_OAUTH_CLIENT_SECRET`.

## Microsoft (Entra ID) — personal and work/school accounts

1. **App registration.** https://entra.microsoft.com → **Identity → Applications → App registrations → New
   registration**.
   - Name `Ether`.
   - Supported account types: **Accounts in any organizational directory (Any Microsoft Entra ID tenant -
     Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)**.
   - Redirect URI: platform **Web**, `https://ether-backend-production.up.railway.app/auth/oauth/microsoft/callback`
   - Register. On the Overview page copy **Application (client) ID** into Railway `MICROSOFT_OAUTH_CLIENT_ID`.
2. **API permissions.** It starts with Microsoft Graph `User.Read`; add **Microsoft Graph → Delegated → `openid`,
   `email`, `profile`** → Add permissions. No admin consent is needed for these.
3. **Token configuration (the verified-email check).** **Token configuration → Add optional claim** → Token type **ID**
   → tick **`email`** and **`xms_edov`** → Add. If asked, tick "Turn on the Microsoft Graph email permission".
   `xms_edov` ("email domain owner verified") is how Ether tells that a work/school account's email is really verified;
   without it a work/school account is refused, as the plan requires.
4. **Secret.** **Certificates & secrets → Client secrets → New client secret** → Description `Ether backend`, Expires
   **24 months** → Add. Copy the **Value** at once (it is shown only once) into Railway `MICROSOFT_OAUTH_CLIENT_SECRET`.
   Note the expiry date: the secret must be renewed before then (Ether's Health page will warn 30 days ahead — part of
   the build).
5. **Branding (optional).** **Branding & properties** → Publisher domain / logo. Without a verified publisher, the
   consent screen says "unverified" for work/school users; sign-in still works.

## What happens after

1. Tell me "set up" (no values). I check, read-only, that the four Railway variables exist (names only).
2. The backend part (`/auth/oauth/<provider>/start` and `/callback`, the one-time code exchange) and its tests —
   including the stranger tests: a provider email that matches no Ether account, an unverified provider email, and a
   work/school account without `xms_edov` are all refused — are shown to you before deploying.
3. The sign-in screen gets **Sign in with Google** and **Sign in with Microsoft** next to email and password.
4. Apple waits.

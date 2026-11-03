# Settings, Streaming, Help, Tiers and Iris — design plan

**Date:** 2026-10-05 · **Type:** READ-ONLY design. No code changed, no commits.
**Trees:** `C:\openair` `main` @ `d17f911` (4.6.58), `C:\iris` (2 commits plus uncommitted work), `C:\ether.wiki`.

**Method:**
- Four read-only search agents swept: (a) every "Preferences" occurrence, (b) streaming output, (c) help, subscription and updater, (d) Iris.
- Load-bearing claims were re-checked by hand (marked ✔).
- The Iris runtime state comes from read-only process, port, log and `.env`-name checks run on this machine. No values were printed and nothing was started or stopped.
- **Governing docs:**
  - `docs/paywall-entitlements-plan.md`: the catalog `/public/plans` (P2), the lapse rule §4.8, decisions 2/3/10.
  - `docs/iris-ether-contract.md`: tiers, the GO gate, and §6 packaging.
  - `docs/iris-integration-arc-2026-08-06.md`: the D2 knowledge base, the D4 bundled key, Wall 3.
  - `docs/help-sweepers.md`: the help template.
  - CLAUDE.md "doors before rooms" and "every feature ships with its help entry".

---

## 1. Rename Preferences → Settings, with a gear icon

### What exists (receipts)
- **The screen is already called Settings.** Only the door says "Preferences".
  - Component `SettingsPanel` (`src/components/SettingsPanel.tsx:2393`).
  - `SettingsCategory` (`:29`).
  - Heading `<h1 …>Settings</h1>` (`:3041`) and rail label "Settings" (`:3062`).
  - Panel id `"settings"` (`App.tsx:143`, `:3192`); route `#settings/<cat>` (`App.tsx:1215`).
- **Doors today:**
  - Native **File → Preferences** (`electron/main.js:2840`, `send("file:preferences")`, handled at `App.tsx:1240`).
  - The `ether:open-preferences` / `ether.openPrefs` triggers fired from strips, Health, MasterOutput, and the hamburger's Remote Link item (`App.tsx:1213-1224`, `:3023`).
  - **Settings isn't in the hamburger or the header**, so it currently has no icon anywhere.
- **No accelerator.** `CmdOrCtrl+,` appears nowhere, yet the unreachable HelpPanel documents "Ctrl/⌘ + , — Settings" (`HelpPanel.tsx:470`).

### Inventory to change (labels only)
| Kind | Count | Where |
|---|---|---|
| **Labels in code** | 20 | `main.js:2840` (menu), `:5761`; `audiod/ether-audiod.js:279`; `Announcements.tsx:1029`, `:1132`; `CloudBackup.tsx:391`; `ConsoleStrip.tsx:443`; `health/MicInputsHealth.tsx:21`; `health/PflCueHealth.tsx:24`; `health/RemoteLinkHealth.tsx:29`; `MasterOutput.tsx:246-247`; `MicStatusPanel.tsx:22`, `:35`; `lib/sourceKinds.ts:53`, `:57`; `SourceChannelStrip.tsx:223`, `:228`, `:234`; `UserLogin.tsx:186` |
| Optional log / check strings | 4 | `useMicMigration.ts:70`, `audiod/smoke-pfl.js:43`, `:71`, `native/src/micin.rs:521` |
| **Help docs + manual** | 52 | 15 `docs/help-*.md` files (e.g. `help-remote-link.md` ×7, `help-mic-input.md` ×6) and `docs/manual-ethercast.md` ×19 |
| **Wiki** | 3 live | `Accounts-Stations-and-Profiles.md:37`, `Multi-Device-Sync.md:14`. Releases.md history (`:43`, `:377`, `:616`) stays as written |
| Identifiers (optional) | 4 names | `openLinkPreferences` (`useRemoteLink.ts:160`), `openMicPreferences` (`useMicInputs.ts:105`), `OPEN_PREFS_KEY`, `prefsTick` |
| Tests | 1 title | `src/lib/micInputsLabels.test.ts:11` (a describe name, not an assertion) |

### Keys that stay unchanged (so no setting or behaviour is lost)
- `"file:preferences"`: menu → window message (`main.js:2840`, `App.tsx:1240`).
- `"ether:open-preferences"`: window event (`App.tsx:1221`; `useMicInputs.ts:107`; `useRemoteLink.ts:162`).
- `"ether.openPrefs"`: localStorage cross-window trigger (`useMicInputs.ts:103`, read at `App.tsx:1220`).
- **None is a stored setting.** No database column, kv key or route contains "pref". Keeping the three names costs nothing and avoids breaking pop-out → main signalling between windows on different versions. **Nothing needs a migration.**
- Not touched, since they aren't the label: `webPreferences` (Electron), `$ErrorActionPreference` (PowerShell), the macOS `PreferencePanes` path.

### The icon
- **No icon library** (none in `package.json`). The app uses inline Feather-style SVG (`viewBox 0 0 24 24`, `stroke="currentColor"`, width 2), plus emoji in the hamburger list.
- **A Feather gear already exists, unused:** `NAV_ICONS.settings` (`App.tsx:233`; the `NAV_ICONS` map at `:221` is defined and never read). Reuse it.
- **Placement:**
  1. a **gear button in the header's right zone**, next to the existing badges, with title "Settings (Ctrl+,)";
  2. a **"Settings" row with the gear in the hamburger**.
- **Hamburger constraint:** `src/lib/drawerDoors.test.ts` requires every "ONE LIST" entry to be a `PopoutRenderer` case, and `settings` isn't one. So the row goes **outside that array**, like Remote Link, Desk and Captions already do (`App.tsx:3021-3029`).
- **Menu:** File menu label → "Settings…", with `accelerator: "CmdOrCtrl+,"`.

### Flags
- None blocking: every label is free to change.
- Wording note: the HelpPanel already says "Settings → …" everywhere (`HelpPanel.tsx:36`, `:37`, `:79`…). The rename makes the app agree with it.

---

## 2. Settings → Streaming: "Connect your stream" (Local users, own server)

### What exists today
**Config model:** one Icecast destination per station, stored on the `stations` row.
- Fields: `icecast_server_url`, `icecast_mount`, `icecast_password` (local-only, never synced), `icecast_bitrate`, `icecast_format` (`main.js:2060-2064`; sync policy `electron/sync/synced-tables.js:1086-1094`).
- **`icecast_port` exists in the baseline schema but is dead.** No ALTER adds it on upgraded installs, it isn't in the `stations:update` allow-list (`main.js:11892-11895`), and Go Live hard-codes 8000 (`:11715`, `:11735`).
- There's no destinations table for Icecast. RTMP video is separate (`rtmp_destinations`).

**Editors:**
- StationManager (`StationManager.tsx:295-368`) and the New Station modal (`ActiveStationBadge.tsx:226-325`): five fields, with **no validation** beyond the name.
- The "Broadcast" section (`SettingsPanel.tsx:516-710`): one shared `playout_server` plus per-station GO LIVE.
- `StreamManager.tsx` is **fully disconnected**: it drives stub IPCs (`main.js:6962-6993`).

**Encoder** (`audiod/stream.js:61-82`, in-process `main.js:11724-11757`):
- MP3 only (`libmp3lame`). `icecast_format` is ignored, so the AAC/OGG choices in the UI do nothing.
- 44.1 kHz.
- URL `icecast://source:<pw>@<server>:8000<mount>`, with:
  - **no TLS**
  - **no Shoutcast**
  - **no URL-encoding of the password** (`@ : / #` break it)
  - **no normalisation** of `http://host` or `host:port`
  - username hard-coded `source`
- The in-process fallback ignores bitrate (hard-coded `128k`, `main.js:11746`).

**Reconnect:** respawn after 500 ms. After 3 failures in 10 s it shows "error", retries after 30 s, and stays armed (`stream.js:105-125`).

**Errors understood:** connection refused, 401, 403, timed out, failed to connect (`main.js:11508-11523`). Others (DNS, a 403 for "mount in use") surface only as a generic message.

**Metadata: none reaches Icecast today.** `electron/metadata-dispatcher.js` is never required, its table is never created, and `StreamMetadataPanel` returns early (`StreamMetadataPanel.tsx:77`).

**Hosted versus own server:**
- **There's no "own server" mode.** A blank server silently becomes Ether's Lightsail box `44.244.52.207`. That's baked in at `main.js:2060`, `:2123`, `:3142`, `:9456`, `:11711`, `:11731`, `:11857`; `SettingsPanel.tsx:516`; `ActiveStationBadge.tsx:245`.
- Default password `hackme`.
- Mount auto-derived for the "shared server" (`main.js:2410-2413`).
- The public page editor **forces** `https://stream.ether-technologies.com:8443/<mount>` (`SettingsPanel.tsx:1641`, `:1836-1849`).

**Latent credential leak:**
- The `playout_server` value is also where the app POSTs R2 keys at startup (`main.js:3132-3161`, `http://<server>:3500/api/playout/r2config`).
- It's **skipped today** because desktop R2 keys are empty (✔ `main.js:3137-3139` "Startup R2 push skipped — credentials not configured").
- But pointing that field at a customer's own server would send keys there if keys ever exist. The wizard must not reuse that field.

**Test today:** only a renderer `fetch('http://<server>:8000/')` (`SettingsPanel.tsx:557-569`). It doesn't check credentials or the mount, and it can't handle TLS or another port.

**Live safety (good news):**
- The encoder is a separate ffmpeg process reading a TCP tap of the program bus. Starting or stopping it never touches playout (`stream.js:7-9`, `:79-80`; `App.tsx:1513-1515`).
- **But:**
  - edits made while live don't apply until the next go-live (`main.js:11891-11914`);
  - a daemon reload replays the **old** cached intent (`main.js:11720`, `:1055-1056`);
  - Go Live while live restarts the encoder, with a brief listener drop (`stream.js:76-77`).

**Indicators:** `StreamStatusProvider` (`src/contexts/StreamStatusContext.tsx:52-80`) and `GlobalOnAirBadge` (`App.tsx:2862-2867`).
- Daemon gaps: `stream:get-status` / `get-all-status` read only the in-process map (`main.js:11781-11821`), and daemon mode emits on state changes only (`stream.js:98-100`). The first snapshot can say "off" while live.

### Design
**Door:** a new **Settings → Streaming** category. That's a new `SettingsCategory` value `"streaming"`; additive, nothing renamed. It gets a door in the hamburger ("Connect your stream") and from the header ON AIR badge's empty state.

**Wizard steps (all in one panel; each step can be revisited):**

1. **Where are you streaming?**
   - **My own server**: Icecast · Shoutcast v1 · Shoutcast v2.
   - **Ether hosted stream**: available on the Station/Pro/Unlimited plans.
   - **"I don't have a server"** → two buttons:
     - "Get a hosted stream" opens the signup checkout for the Station plan. The price comes from `/public/plans`; before that endpoint exists, the button reads "See plans", with no number.
     - "How to get a server" opens the help page `help-stream-to-your-own-server.md`.
2. **Provider preset (optional).**
   - Presets are a local JSON list. Each one only pre-fills defaults (server type, port, mount pattern, TLS):
     - Generic Icecast (8000)
     - Generic Shoutcast v2 (8000, SID 1)
     - Generic Shoutcast v1 (8000; source on port+1)
     - "Icecast with HTTPS (8443)"
     - named hosts, e.g. Radio.co, Caster.fm, Shoutcast.com
   - Named-provider defaults are **UNVERIFIED** and must be checked against each provider's docs before shipping.
3. **Connection.**
   - **Paste a full URL**, e.g. `https://user:pass@host:8443/mount`, `http://host:8000/stream` or `host:8000;sid=1`. It's parsed into fields that show what was understood, **or** filled in by hand.
   - Fields: server address, port, mount (Icecast) / SID (Shoutcast v2), username (Icecast, default `source`), password, "Use HTTPS (TLS)".
   - Validation shows next to the field: strip a scheme typed into the address box, add the leading `/` to a mount, warn on spaces.
4. **Sound:** bitrate (64–320) and codec.
   - **MP3** at first. AAC is listed only once the encoder actually produces it; today the format field is ignored, and per the honest-UI principle no choice is shown that does nothing.
   - Sample rate 44.1 kHz.
5. **Test** (see below) → **Save** → **Go live**.
   - "Go live" is the existing GO LIVE path, a separate deliberate click.

**Data:**
- Keep using the station row: one destination per station, as today.
- **Additive** migration (next schema version): make `icecast_port` real on every install, and add `stream_server_type` (`icecast|shoutcast1|shoutcast2`), `stream_tls` (0/1), `stream_username`, `stream_sid`.
- Sync policy: server, type, port, mount, TLS, SID and bitrate sync as today's scalars. **The password stays local-only** (unchanged rule, `synced-tables.js:1088`).
- **"Own server" mode removes the hidden fallback to `44.244.52.207`.** A blank server is an error that says so, never a silent redirect to Ether's box. The managed host is used only by the hosted-plan path.
- A separate `stream_server` field replaces reusing `playout_server`, which keeps the R2 push away from customer servers. Belt and braces: that push is also restricted to the managed host (or removed; it's dead today).

**Encoder changes** (`audiod/stream.js` plus the in-process mirror):
- Build the URL from parts: URL-encode the username and password; `icecast_port` instead of 8000; ffmpeg's `-tls 1` when TLS is on; honour bitrate in both paths.
- **Shoutcast:** ffmpeg has no native Shoutcast source protocol. Design a small source shim. ffmpeg writes MP3 to a pipe, and a Node socket performs the handshake:
  - **Shoutcast v1:** connect to port+1, send the password line, wait for `OK2`, send the `icy-*` headers.
  - **Shoutcast v2:** a v1-style "legacy" source using `password:#sid`.
  - Both behaviours are **UNVERIFIED** until tested against a real DNAS v1 and v2.
- Add `-ice_name` / `-ice_description` / `-ice_url` from the station's name and page.

**Test button (a real source connection that never disturbs a live stream):**
- **It runs in the main process with a plain Node `net`/`tls` socket, not ffmpeg and not the daemon.** It has no access to the program bus, so it physically can't affect on-air audio.
- **If that station is already live to the same server and mount, the test doesn't connect.** It reports "This stream is live right now — the live connection is working" (from the live status). A second source on the same mount would either be refused ("mount in use") or, on some servers, knock the live source off.
- **If the target differs from the live one** (the user is setting up a new server), the test is allowed: it's a different server or mount.
- **The sequence:** resolve DNS → connect TCP (5 s timeout) → TLS handshake if on → send the source request with auth (Icecast `PUT /mount` with `Expect: 100-continue`, or the Shoutcast handshake) → read the status → **close immediately, before sending any audio**. A server that needs a few bytes before it answers gets one second of silence frames generated by the test itself, never program audio.
- **Plain-English results** (mapped from socket and HTTP results):

| Result | What the user reads |
|---|---|
| `ENOTFOUND` | "We can't find a server called *host*. Check the spelling of the address." |
| `ECONNREFUSED` | "We reached *host* but nothing answered on port *N*. Check the port, and that the stream server is running." |
| timeout | "*host* didn't answer. A firewall may be blocking port *N*, or the address is wrong." |
| TLS: certificate / hostname / protocol | "The secure (HTTPS) connection failed: *the certificate has expired / is for a different name / the server doesn't speak HTTPS on this port*. Try turning HTTPS off, or use the port your provider gives for HTTPS." |
| 401 / Shoutcast `invalid password` | "The server says the password is wrong." |
| 403 + mount in use | "That mount (*/mount*) is already in use, maybe by another computer. Pick another mount or stop the other stream." |
| 404 / unknown mount (servers that predefine mounts) | "The server doesn't have a mount called */mount*." |
| 200 / 100-continue / `OK2` | "Connected — your server accepted this stream. Press Save, then Go live." |

**Save:**
- Writes the station row and never restarts anything on its own.
- **If the station is live**, the panel says "Saved — this applies the next time you go live", with an optional **"Apply now"** button. Pressing it restarts only the encoder: listeners hear a short drop, and **on-air playout is unaffected**.
- Also fix the stale daemon-replay intent: on replay, re-read the station row instead of the cached arguments.

**Live / offline indicator:** reuse `StreamStatusProvider` / `GlobalOnAirBadge`, plus a status line inside the Streaming panel. Fix the daemon snapshot gap (`get-all-status` asks the daemon) so it never shows "off" while live.

**Metadata ("now playing" on the stream):**
- Wire it, mount-scoped, using the station's own source credentials. Icecast's `/admin/metadata?mount=…&mode=updinfo` accepts source credentials for that mount on stock servers (**UNVERIFIED** per server). For Shoutcast, `admin.cgi?mode=updinfo` with the password (and SID for v2).
- One update per track (the existing `now-playing-update`, `App.tsx:2640-2662`).
- A failure just shows as a status note and never retries in a tight loop.
- **The admin password is never requested** (contrast the legacy `StreamManager.tsx:68-70`).

**Independence:**
- The wizard, the test, save, go-live and metadata talk only to the user's own server.
- **No Ether backend, no account feature, no entitlement check.** It works fully offline from Ether's cloud.
- Lapse rule: streaming to one's own server is local, so a lapsed Local license keeps it working (§4.8 of the paywall plan).

**Listener page for Local users on their own server (decision 2: included, with "Powered by EtherCast"):**
1. **Backend** (`/api/station/:uuid/metadata`):
   - Accept a full **https** `stream_url` on a non-managed host for any license.
   - Reject managed-host mounts not allocated to that station; this is the M2 fix from `docs/multitenancy-audit.md`, done properly with server-allocated mounts for hosted plans.
   - Store `stream_source = "own" | "hosted"`.
2. **Desktop editor:**
   - For own-server stations, show a free-form stream URL field pre-filled from the Streaming settings, instead of the forced managed prefix (`SettingsPanel.tsx:1836-1849`).
   - Warn: "Your server needs HTTPS for the listener page — browsers won't play an http stream inside an https page."
3. **Listener PWA** (`ether-listener` / `ether-cast` repos): render a small "Powered by EtherCast" mark whenever `stream_source = "own"`.
4. **Now-playing on the page** comes from the desktop's existing push (`App.tsx:2625-2632`), not from the stream host, so it works unchanged.
   - Caveat: a Local user's page is a **cloud** service (the backend and Pages host it). It's offline-tolerant (it simply goes stale), but it does need an account.

---

## 3. Help: plans and how individual stations work

### Where help lives today
- **`docs/help-*.md`**: 45 files on the template in `docs/help-sweepers.md`.
  - Frontmatter: `feature, title, summary, where, since, audience, tour`.
  - Then the template's fixed section order: What it is / When to use it / Set it up / … / Related.
  - **None of them reaches the app.** No `import.meta.glob`, no generated JSON, no script bundles them. They appear only in comments and smoke checks.
- **In-app `HelpPanel.tsx`**: 641 lines, 16 **hardcoded** topics. It's **unreachable**, because nothing calls `setPanel("help")` (only rendered at `App.tsx:3186`).
  - The native Help menu offers Keyboard Shortcuts, Documentation (the GitHub repo URL), Check for Updates and About (`main.js:2935-2941`).
- **Wiki:** 12 pages.
  - `Plans-Sign-In-and-Activation.md` is stale: Activate is described "at the bottom" but sits at the top; it describes "Switch Account", which was removed in 4.4.216. There are no prices.
  - **No wiki page covers streaming or Icecast.**
  - Only `Roadmap.md` is generated from the repo (`sync-roadmap-wiki.yml`).
- **Existing plan help:** `docs/help-trial-ended.md` describes the **old** behaviour, the drop to Solo with a modal. It's superseded by the P0b banner and must be rewritten when P0b ships.

### Design
- **One source:** `docs/help-*.md` stays the single source of truth (flat naming, the template).
- **Bundle it into the app at build time:** `import.meta.glob('../../docs/help-*.md', { query: '?raw', eager: true })` plus a tiny frontmatter parser, giving an in-app corpus with search.
- **Rewrite `HelpPanel`** to render that corpus instead of its hardcoded `TOPICS`, keeping search.
- **Doors:**
  - a "Help" row in the hamburger
  - **F1**
  - Help menu → "Help topics"
  - an `openHelp(feature)` event, so any panel can put a "?" next to its title
- **New pages** (each on the template, in `docs/`, flat):
  - `help-plans.md`: Local · Station · Pro · Unlimited; what each adds; annual (10 months' price); the 3+ station discount.
  - `help-local-license.md`: **Local is per station** ($/station from the catalog): what "station" means, how adding a station changes the bill, the 15-day trial with no card.
  - `help-hosted-streaming.md`: hosted streams; the bitrate per plan; listener caps (50 / 150 / pooled 250); **add-ons** (+50: per stream on Station/Pro, into the pool on Unlimited); what happens at the cap.
  - `help-trial-and-renewal.md` (replaces `help-trial-ended.md`): **on air keeps running when a trial or payment lapses**; the banner; no new updates; cloud features stop after grace (7/30/90); nothing is deleted without notice.
  - `help-stream-to-your-own-server.md`: the wizard step by step (Icecast / Shoutcast v1 / v2), what each test result means, HTTPS for the listener page, "Powered by EtherCast".
- **Prices never hardcoded:**
  - Pages use tokens such as `{{price:local.monthly}}`, `{{price:station.monthly}}`, `{{listeners:pro.per_stream}}`.
  - The help renderer fills them from the cached `/public/plans` catalog (cached in `install_config_kv` for offline).
  - With no catalog yet, or offline and never cached, the token renders as "see current prices in Settings → Plans". **Never a stale number.**
- **Wiki:** generate wiki copies of the help pages from the repo, extending the existing `sync-roadmap-wiki.yml` pattern, so the wiki can't drift. The tokens render the same fallback text there, or are filled by the sync job from `/public/plans`. Fix or replace the stale `Plans-Sign-In-and-Activation.md` with the generated `help-plans` copy.

---

## 4. Tier screen and update button

### Today
- **`SubscriptionPanel.tsx`** (744 lines):
  - Billing toggle Monthly/Lifetime (`:313-345`) with "SAVE UP TO 63%" (`:340`).
  - Product Hunt `PHUNT50` banner (`:357-370`).
  - Activate box (`:375-479`).
  - Cards with **hardcoded** prices:
    - Solo $0 (`:493-494`)
    - Studio $19 (`:519-520`)
    - Network $79 (`:551-552`)
    - Studio Lifetime $299 (`:615`)
    - Network Lifetime $899 (`:681`)
  - "Upgrade to Studio — $19/mo" (`:733`); "14-day free trial" (`:740`); the `FEATURES` list with Iris quotas (`:27-48`); `ADMIN_KEYS` (`:101-107`, B4).
  - B8: the lifetime links are fixed on the unmerged `fix/p0b-trial-banner` branch (`21197b1`). **On `main` they are still placeholders.**
- **Other hardcoded prices:** `usePlan.tsx:144-146` (`UpgradePrompt` "$19/mo" / "$79/mo") and `NowPlaying.tsx:91-93` (mock ads).
- **Doors:** the header "Upgrade"/"Studio" button (`App.tsx:2816-2821`) and the `ether:open-subscription` event (`App.tsx:1269-1274`). **No native-menu entry.**
- **Updater** (`src/components/Updater.tsx`, main `main.js:7620-7686`):
  - Auto-checks 10 s after start, then every 30 min.
  - Shows a bottom-right toast: available → "Update Now" / "Later" → downloading → "Restart & Update".
  - **Gaps:**
    - a manual Help → Check for Updates gives **no feedback** when there's no update;
    - once dismissed, the toast stays hidden for the session, even after a manual check;
    - `updater:download` adds a new progress listener on every click.
  - **No plan gating** (as designed so far).

### Design
- **The tier screen renders everything from `/public/plans`** (P2), cached for offline:
  - cards for **Local**, **Station**, **Pro**, **Unlimited**, the **+50 listeners add-on** and a **Monthly / Annual** toggle (annual = the catalog's `annual_months_charged`);
  - the 3+ station discount line.
- **Current plan block** (from the cached signed entitlement, P3):
  - plan name, status (trial N days / active / lapsed / grandfathered Legacy Lifetime / Founding Local)
  - **stations covered**: "Local covers N stations at {{price:local.monthly}} each", with the list
  - hosted streams in use / allowed, and the listener cap
- **Actions:**
  - Upgrade / Add a stream / Add listeners / Switch to annual → the Stripe checkout or portal (P4).
  - **Renew Local** when lapsed.
  - **Manage billing** (portal).
- **Removed:** `ADMIN_KEYS` (B4); the Lifetime purchase cards (no longer offered); the `PHUNT50` banner (expired campaign, Jeff to confirm); the `FEATURES` Iris quotas (no quota code exists; `SubscriptionPanel.tsx:43`, `:46`).
- **Update button under the lapse rule:**
  - **current / trial:** normal behaviour (the toast and the manual check).
  - **lapsed:** the check still runs.
    - If the newest version was released after `updates_until`, the toast reads **"Renew Local to get updates"** with "You can still install: vX.Y.Z (released on or before *date*)", plus [Renew] and [Install vX.Y.Z].
    - It never blocks anything, and dismissing it is always allowed.
    - Releases on or before `updates_until` install normally.
  - **unknown** (no cache): "Couldn't check your license — updates paused until you're online and signed in." Non-blocking.
  - Fix the gaps: "You're up to date (vX.Y.Z)" on a manual check; reset the dismissed flag on a manual check; register the progress listener once.

### What can be built before P2
| Item | Before P2? |
|---|---|
| Settings rename + gear + accelerator | ✅ |
| Help corpus bundling, Help panel, doors, the five new pages, using token fallbacks | ✅ (prices show the fallback text until the catalog exists) |
| Updater fixes (up-to-date feedback, dismiss reset, listener leak) | ✅ |
| Removing `ADMIN_KEYS` / dead Lifetime cards / Iris quota copy | ✅ |
| **`/public/plans` endpoint** (backend; the first P2 slice, read-only config) | ✅ (recommended next backend step; it unblocks every price below) |
| Tier screen with real prices | ⏳ needs `/public/plans` |
| Current plan, stations covered, renew/upgrade actions | ⏳ needs P2 entitlements + P3 cache + P4 checkout |
| Lapse-aware updater ("Renew Local to get updates") | ⏳ needs P3 (`updates_until` in the signed cache) |

---

## 5. Order of work, blast radius, and release grouping

| # | Item | Blast radius | Depends on |
|---|---|---|---|
| A | Settings rename + gear + `CmdOrCtrl+,` | Labels only; 3 internal keys untouched; 1 test title. No data | — |
| B | Help corpus bundled + Help panel rewired + doors (hamburger, F1, menu, `openHelp`) + five new pages (token fallback) + `help-trial-ended` rewrite | Renderer only; build adds `?raw` imports of `docs/help-*.md`. Help docs become shipped content, so `docs/*-design-*.md` must never be globbed (pattern `help-*.md` only) | — (the trial page assumes P0b's banner) |
| C | Updater fixes | `Updater.tsx` / `main.js` updater handlers | — |
| D | Honest Iris badge + presence fix (§6) | `IrisBadge.tsx`, the `main.js` presence logic | — |
| E | Streaming wizard v1, **Icecast**: URL/port/TLS/encoding, real non-disruptive test, save semantics, own-server mode with no hidden default, `stream_server` split from `playout_server`, metadata via source credentials, daemon snapshot + replay fixes | **Encoder** (`audiod/stream.js`): the daemon must be reloaded (full quit). **Schema migration** + sync transformer (upgrade the fleet together, like v62). Packaged-build smoke on the exact artifact, plus an on-air acceptance run while live | — |
| F | Shoutcast v1/v2 source shim | New socket code in the encoder path | E, plus a real DNAS v1/v2 to test against |
| G | `/public/plans` (backend, P2 slice 1) | Backend read-only route + config file | — |
| H | Tier screen with prices | `SubscriptionPanel` rewrite | G (actions need P2–P4) |
| I | Lapse-aware updater | `Updater.tsx` | P3 |
| J | Own-server listener page ("Powered by EtherCast") | Backend metadata validation (M2), desktop editor, listener PWA | E, M2 |
| K | Iris I1–I4 (§6) | See §6 | I1 before any Iris UI action |

**Can ship together:**
- **Release 1 (desktop, low risk): A + B + C + D**, and optionally P0b (TrialBanner + B8, already built on `fix/p0b-trial-banner`). All renderer and labels; no engine, schema or backend.
- **Release 2 (desktop, medium risk): E alone.** It touches the encoder and the schema, so it gets its own on-air acceptance run.
- **Backend:** G any time (no client depends on it until H).
- **Later:** F; H + I with the P2/P3 entitlement work; J with the multitenancy M2 work.

---

## 6. Iris: diagnosis, and connecting her to this help

### Current state: why she isn't working (runtime receipts from this machine)
1. **Iris isn't running.**
   - Nothing listens on her ports: 3399 (`iris-server`), 3401 (Iris Watch), 3402 (hardware). `netstat` showed only Ether's `0.0.0.0:3400`.
   - No Iris process (two `node.exe` processes hold no TCP connections).
   - She has to be started by hand: `C:\iris\Iris.bat` → `npm run dev` (Vite :5173 + Electron in development mode + the hardware server).
   - There's no service, scheduled task or startup entry; the only scheduled task is `EtherHAWatchdog`.
   - Her only log, `C:\iris\iris-launch.log`, was last written on **2026-05-18** and holds just the npm header and a Ctrl+C.
2. **A customer install never gets Iris.**
   - `electron-builder.json` packages nothing from `C:\iris`.
   - The main process spawns only the watchdog, PowerShell and ffmpeg.
   - The contract's "Iris ships inside Ether's installer" (`iris-ether-contract.md` §6) is unbuilt, so only machines with `C:\iris` checked out can run her.
3. **Keys are present, so a missing key isn't the cause here.** `C:\iris\.env` has `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `DEEPGRAM_API_KEY` and `BRAVE_API_KEY` all set (names and lengths checked, values not read). The model is hardcoded to `claude-haiku-4-5-20251001` (`iris-brain.js:574`).
4. **Ether can't tell she's absent.**
   - The renderer heartbeat `iris:state` (~3 s, `App.tsx:2604-2616`) sets `irisLastSeen = Date.now()` (✔ `main.js:8443`).
   - So while a station engine runs, Ether shows Iris **connected** whether or not she is.
   - The badge's absent-state text also promises an auto-start that doesn't exist (`IrisBadge.tsx:59`, `:81`).
5. **Chat replies arrive unmatched.** Iris POSTs `/api/captions/iris` and `/api/iris/status`, never `/iris/reply` with the request `id` (`C:\iris\electron\main.js:115`, `:164`). So replies reach Ether with `id: null`. Whether the badge drops them is **UNVERIFIED** at runtime. The second `/api/captions/iris` handler (`main.js:8761-8775`) is dead code, shadowed by the route at `:8595`.
6. **Her knowledge is a separate, hand-kept file.**
   - `C:\iris\ether-tours.json`: 12 tours and 13 concepts, loaded at boot (`iris-brain.js:59-65`).
   - It doesn't read `docs/help-*.md`, some content looks stale (e.g. "Ether2Go"), and with no matching tour she is told to improvise (`iris-brain.js:400-406`).
   - This is exactly the "help and Iris disagree" risk.
7. **Ether's own tour** (`OnboardingTour.tsx`, 7 steps) is real, but 4 of its 7 spotlight targets (`logo`, `nav-library`, `deck-a`) don't exist in the DOM, so those steps fall back to a centred callout (inferred from code).
8. **A safety gap that blocks any Iris UI action.**
   - The :3400 server binds **`0.0.0.0`** with no auth and open CORS (✔ `main.js:8809`).
   - **`POST /api/transport/:action` plays, pauses, stops or skips decks with no gate** (✔ `main.js:8669-8682`). The code says the fix is "built and tested … held WITH the operator-token gate" (`:8659-8668`).
   - Today any machine on the station's LAN can stop a deck. Noted here because §6's walkthrough design depends on it; I didn't investigate further.
9. **A second "Iris" lives inside Ether:** `ai:ask` with its own "You are Iris, the Executive Producer" prompt (`main.js:7762`), using the BYO key from Settings → Integrations.
   - That key is stored in `ai-config.json`, encrypted with Electron `safeStorage`, falling back to base64 `:plain` (`main.js:7688-7720`).
   - There's also an orphaned plaintext `station_config_kv.anthropic_api_key` writer (`SettingsPanel.tsx:2995-3003`, UNVERIFIED-dead).
   - Three renderer features call Anthropic directly with **no key header**, so they can't work as written: `SmartScheduler.tsx:35-39`, `PodcastMode.tsx:578-582`, `ProducerDeskWindow.tsx:46-50` (inferred).

### Design: one knowledge source
- **Ether serves the help corpus to Iris.** The same bundled `docs/help-*.md` as §3, via read-only loopback routes on :3400: `GET /api/help/index` (feature, title, summary, where) and `GET /api/help/:feature` (markdown with tokens filled).
- **Iris's `ether_help` / `ether_tour` tools call those routes** instead of reading `ether-tours.json`. That file is retired, or generated from the corpus at build time so it can never drift.
- The "improvise from your own knowledge" fallback is replaced with "I don't have a help page for that yet", plus a pointer to the Help panel.
- **Prices:**
  - Ether exposes its cached catalog at `GET /api/plans` (from `/public/plans`).
  - Iris's system prompt rule: quote plan prices and limits **only** from the `/api/plans` response in this conversation, never from memory or training, and never from a copied list.
  - If the call fails: "I can't see current prices right now — they're in Settings → Plans."
  - Enforced in two places: the prompt, and the help tokens being filled by Ether, not by the model.
  - Iris's design docs (`docs/*-design-*.md`) are never in the corpus (arc D2).

### Design: the streaming walkthrough
- **A new UI-intent command class**, separate from transport, sent Iris → Ether over the existing POST channel:
  - `ui:open { panel: "settings", category: "streaming", step: "server" | "connection" | "sound" | "test" }`: Ether opens Settings → Streaming at that step.
  - `ui:fill { field: "address" | "port" | "mount" | "username" | "server_type" | "bitrate" | "tls", value }`: allowed **only with a value the user typed in the current conversation**.
    - Iris sends the quoted user utterance with the value. Ether's handler checks that the value appears in it, and refuses anything else.
    - **The password is never fillable by Iris.** The user types it into the field.
  - Filled fields are highlighted "Filled by Iris — check this", and nothing is saved until the user presses **Save**.
- **Never Iris's to do:**
  - **Test**, **Save**, **Go live**, **Apply now**, stop or restart of any stream, and any deck/transport/on-air action are **not in Iris's command set**. They exist only as buttons the user clicks.
  - Ether's handler refuses any such intent from Iris outright, the same way the transport tier holds for an operator GO (`iris-ether-contract.md:27-55`), but stricter: there is **no Iris path to them at all**.
  - Iris's job is to say "Press Test", then read the result the UI shows.
- **Prerequisite (I1):**
  - Ship the held operator-token gate together with the closure of the ungated `/api/transport/:action` route (`main.js:8659-8668`).
  - Bind :3400 to loopback for Iris routes. LAN features such as `/remote` and replication need an explicit, separately authenticated listener; Wall 3 is in the arc doc.
  - Add a local API token minted at install and injected at spawn.
  - Until I1 ships, **Iris gets no UI-intent ability.**

### Offline / no key / no Iris
- **The Help panel and the Streaming wizard never depend on Iris.** They're plain app features (§2, §3).
- **Badge (fixes D):**
  - Presence comes only from Iris's own `/ping` and SSE stream, never from the renderer heartbeat. Remove the `irisLastSeen` write from `iris:state`.
  - When she's absent, the badge shows a plain note: "Iris isn't running on this computer. Help is in the Help panel (F1)." No error styling, and no promise of auto-start until packaging exists.
  - No-key state (once packaged): "Iris needs an AI key — add one in Settings → Integrations." A link, never a modal.

### Making Iris work for customers (packaging options, plain English, no build)

| Option | What it means | For | Against |
|---|---|---|---|
| **A. Bundle "headless Iris" inside Ether's installer** (recommended) | Ship Iris's brain (Node: `iris-brain.js`, memory, the Ether feed) as files in Ether's install. Ether starts and supervises it like the audio daemon, running under Ether's own runtime. **Drop Iris's separate Electron window**; chat lives in Ether's badge | One product, one install, one update. No second ~200 MB runtime. Works offline for everything except the AI call. Matches contract §6 and level L3 | Ether must supervise one more process (the restart policy exists for the daemon). Iris's code needs a clean "no window" mode. Customers must bring a key (or see option D) |
| B. Keep Iris a separate optional download | Customers download and run "Iris" themselves | Least work | Breaks "the user sees one product". Two update streams, support burden, version drift against Ether's contract |
| C. Iris as an Ether cloud service | The backend hosts the brain; Ether talks to it over the internet | No customer key; central knowledge; one deployment | Costs per conversation; station data leaves the building; nothing works offline; contradicts "Iris is her own local process". A big new backend surface |
| D. Add-on to A: bundled AI key tier (arc D4) | Ether supplies a small-model key for basic help on some plans, BYO key for full features | Iris works out of the box | Real per-user cost, so it needs a pricing decision (arc D4, still open) and abuse limits |

**Key handling for A:**
- One key store: Settings → Integrations (`ai-config.json`, `safeStorage`). Ether hands the key to the Iris process at spawn through the environment or a pipe, never on disk in Iris's folder.
- **Remove the plaintext `anthropic_api_key` writer.**
- **If `safeStorage` is unavailable, refuse to store** rather than fall back to base64 (`main.js:7698-7703`).

**Scope for customer v1:**
- Text chat + help + the walkthrough only.
- **Exclude voice** (ElevenLabs/Deepgram), the hardware mic server and the Atom Echo TCP listener on `0.0.0.0:5555` (`C:\iris\electron\main.js:401`). These add keys, network listeners and support load that a first customer release doesn't need.

### Iris order of work
| Step | What | Blast radius |
|---|---|---|
| D | Honest badge + presence fix | `IrisBadge.tsx` + `main.js` presence; no behaviour change for audio |
| **I1** | Operator-token gate + close `/api/transport/:action` + loopback-only Iris routes + local token | Every Iris → Ether call, the LAN remote page, and replication (needs its own listener). Iris must be updated in step |
| I2 | `/api/help/*` + `/api/plans`; Iris tools rewired; `ether-tours.json` retired or generated | Iris knowledge only |
| I3 | `ui:open` / `ui:fill` with provenance check; no test/save/go-live path | Ether handler + the Streaming panel highlight |
| I4 | Packaging option A (headless, supervised, BYO key) | Installer contents, process supervision, key hand-off. The biggest step; the Iris repo needs a no-window mode first |

---

**Temporary tooling:** none persistent. The read-only checks were `netstat`, a process list, scheduled tasks, `.env` key names and lengths only, and a read of `iris-launch.log`.

**Stop.** Awaiting Jeff's review and GO.

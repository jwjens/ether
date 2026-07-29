# Build report — Cloudflare TURN for Show+ guests (both ends)

**Date:** 2026-07-28 · **Desktop branch:** `log-reader-flip` · **Box:** `guests.ether-technologies.com` (44.244.52.207)
**Status:** built, typechecked, deployed to disk on the box. **Service NOT restarted. No version bump, no commit, no
push, no installer.** Awaiting GO — and awaiting the two credential values (see *Blocking* at the end).

---

## What was built

Both ends now receive their ICE servers — STUN **and** a Cloudflare TURN relay — from the signaling server, minted
fresh per connection. Neither end hard-codes anything, and neither end silently falls back to STUN-only.

The API shape was taken from the page cited in the instruction
(`https://developers.cloudflare.com/realtime/turn/generate-credentials/`), read before any code was written:

```
POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers
Authorization: Bearer $TURN_KEY_API_TOKEN
body: {"ttl": 86400}
201 → { "iceServers": [ { "urls": ["stun:stun.cloudflare.com:3478", …] },
                        { "urls": ["turn:…", "turns:…"], "username": "…", "credential": "…" } ] }
```

Two consequences worth stating, both of which shaped the implementation:

- **The response is already a valid `iceServers` array and already contains `stun.cloudflare.com`.** So the mint result
  is passed through verbatim to both ends. That satisfies "keep stun.cloudflare.com, Google STUN comes out" without
  either end assembling a list of its own.
- **TTL is a plain seconds field.** Set to **3600 (1 hour)** via `TURN_TTL_SECONDS`, minted per connection — long
  enough for a session, not open-ended. Credentials are not cached or reused across sessions.

---

## PART 1 — Signaling server (`/opt/ether-signal/server.js`)

**Backup taken BEFORE any edit**, as instructed (the file is not under git):

```
$ cp -p /opt/ether-signal/server.js /opt/ether-signal/server.js.bak-before-turn-20260729_003214
-rw-rw-r-- 1 ubuntu ubuntu 10925 May  4 23:58 /opt/ether-signal/server.js.bak-before-turn-20260729_003214
```

Editing was done on a scratchpad copy and written back with `scp`; the box was never edited in place with a fragile
in-line command. File grew 10,925 → 16,328 bytes.

### Changes (line numbers in the deployed file)

| Region | Lines | What |
|---|---|---|
| Credential config | `server.js:44,46,48` | `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`, `TURN_TTL_SECONDS` read from `process.env` only — never literals |
| Doc-of-record comment | `server.js:26-42` | Why this exists + the exact Cloudflare API contract, so the next reader doesn't have to re-derive it |
| `mintIceServers(who)` | `server.js:55-119` | POSTs to `…/keys/${TURN_KEY_ID}/credentials/generate-ice-servers` (`server.js:65`) with `Authorization: Bearer` (`:73`) and `{ttl}` (`:75`); returns the array or **null** |
| Host delivery | `server.js:531-551` | On host connect, mints and sends `{type:'ice-servers', payload:{iceServers, ttl}}`, or `{type:'ice-servers-error', payload:{error}}` on failure (`:543`, `:545`) |
| Guest delivery | `server.js:643-661` | `welcome` now carries `iceServers` (`:655`); a mint failure sends `welcome-error` instead (`:657`) |
| Guest page — build from server list | `server.js:397` | `new RTCPeerConnection({ iceServers: msg.iceServers })` |
| Guest page — fail closed | `server.js:360-368`, `:383-393` | Handles `welcome-error`, and refuses to build a connection if `welcome` carries no usable list — shows the operator-facing reason and closes |
| Google STUN | — | **Removed.** `grep stun.l.google.com` over the deployed file returns nothing |

### Logging — a mint failure is loud, never silent

```
[TURN] minted for host a1b2c3d4: entries=2 urls=8 relay=true ttl=3600s
[TURN] MINT FAILED for guest 5e6f7a8b: HTTP 401 Unauthorized …
[TURN] MINT FAILED for host a1b2c3d4: TURN_KEY_ID / TURN_KEY_API_TOKEN not set (check EnvironmentFile /etc/ether-signal.env)
[TURN] WARNING for guest …: minted list contains NO turn: url — relay will not be available
```

`server.js:107` logs **shape only** — entry count, URL count, whether a relay URL is present, and TTL. **The
`username` and `credential` fields are never logged**, and the request (which carries the bearer token) is never
logged. The `!hasRelay` warning at `server.js:109` catches the subtle case where a mint succeeds but returns no
relay — which would otherwise look like success while reproducing the original bug.

### Secrets

```
$ sudo ls -la /etc/ether-signal.env
-rw------- 1 root root 521 Jul 29 00:33 /etc/ether-signal.env      ← 0600, root:root

$ sudo grep -v '^#' /etc/systemd/system/ether-signal.service
[Service] … Environment=NODE_ENV=production
          EnvironmentFile=/etc/ether-signal.env                     ← added
```

The unit runs `User=ubuntu`, but systemd reads `EnvironmentFile` as root before dropping privileges, so 0600
root-only is both correct and sufficient. The unit was backed up first
(`/etc/systemd/system/ether-signal.service.bak-before-turn-20260729_003307`); the only change is the one added line:

```
$ sudo diff …bak-before-turn-20260729_003307 /etc/systemd/system/ether-signal.service
28a29
> EnvironmentFile=/etc/ether-signal.env
```

Secrets appear in exactly one place on disk, readable only by root. Nothing was written to git, to the desktop app, to
client JS, or to any log.

### Safety on a live box

```
$ /usr/bin/node --check /opt/ether-signal/server.js     → SYNTAX OK   (node v20.20.2, has global fetch)
$ systemctl is-active ether-signal.service              → active
$ ps -o etime= -p 216579                                → 85-00:33:26   ← unchanged; still the OLD code in memory
$ systemctl is-active icecast2.service                  → active        ← untouched
$ systemctl is-active nginx.service                     → active        ← untouched
```

**The new code is on disk and syntax-valid but is NOT running.** No `systemctl daemon-reload`, no restart. Icecast
served its three stations without interruption; nginx was not touched.

---

## PART 2 — Desktop client (`src/components/ShowPlus.tsx`)

| Change | Lines | What |
|---|---|---|
| State + ref | `ShowPlus.tsx:413-418` | `turnState` (`waiting`/`ready`/`error`) and `iceServersRef`, with the rationale comment |
| Receive credentials | `ShowPlus.tsx:445-461` | Handles `ice-servers`; stores the list, logs shape only (`:450-456`) — entries/urls/relay/ttl, never username or credential |
| Receive failure | `ShowPlus.tsx:462-466` | Handles `ice-servers-error`; logs and moves `turnState` to `error` |
| **Fail closed** | `ShowPlus.tsx:518-529` | `acceptGuest` returns early — before any `RTCPeerConnection` — when no server list has arrived, with `[TURN] Refusing to accept guest …` and a user-visible reason |
| PC built from server list | `ShowPlus.tsx:539` | `new RTCPeerConnection({ iceServers })` — the hard-coded Google STUN array that was at `:494-496` is gone |
| Surfaced in the UI | `ShowPlus.tsx:2375-2387` | Line in the GUESTS section: "Getting connection credentials…" (waiting) or red "Connection relay unavailable — …" (error) |
| Accept disabled | `ShowPlus.tsx:2393-2395` | Accept is disabled and greyed with a tooltip until `turnState.status === "ready"` |
| Threading | `ShowPlus.tsx:691`, `:2564`, `:2722`, `:2293`, `:2304` | Hook return → `ShowPlus` → `ShowPlusPanel` prop + type |

Verification that nothing is hard-coded any more:

```
$ grep -rn "stun.l.google.com\|stun1.l.google.com" src/     → NONE
$ grep -rn "turn:\|turns:" src/                             → only the word "Returns:" in two unrelated files
```

### Typecheck gate

```
$ npx tsc --noEmit
src/components/OnboardingFlow.tsx(2039,42): error TS2366: …
src/components/PhoneDesk.tsx(777,21): error TS2345: …
```

**PASS — exactly the 2 standing baseline errors. Zero new errors, none in `ShowPlus.tsx`.**
Re-run after the two follow-ups below: same result. Final diff: **89 insertions, 9 deletions, 1 file.**

---

## Behaviour change you are buying — read this before GO

**This is fail-closed, by your instruction ("do not build the peer connection with a STUN-only fallback").** That is a
real behaviour change on both ends:

- **Before:** every guest got a STUN-only connection. Guests on friendly networks worked; guests needing a relay
  failed at `checking` with no explanation.
- **After:** if the mint fails — bad credentials, empty env file, Cloudflare unreachable — **no guest can connect at
  all**, including the ones that work today. The failure is loud in the log, in the guest page, and in the GUESTS
  panel, but it is total.

This is the correct trade, and it is what you specified. It does mean **the env file must hold real, working values
before `ether-signal.service` is ever restarted.** Right now it holds empty placeholders, so a restart today would
take guest connections from "works on friendly networks" to "works nowhere".

---

## Follow-up 1 — the embedded studio's dead Accept button (FIXED in this release)

Flagged in the first draft of this report as a limitation and correctly rejected: an Accept that stays clickable, does
nothing, and explains nothing is a dead control. It now gets the identical treatment to the main GUESTS panel.

| Change | Lines | What |
|---|---|---|
| Prop + type | `ShowPlus.tsx:1958`, `:1974` | `turnState` threaded into `EmbeddedStudio` |
| Passed in | `ShowPlus.tsx:2666` | From `ShowPlus` at the `<EmbeddedStudio>` call site |
| Status line | `ShowPlus.tsx:2101-2113` | Same two messages, same colours: "Getting connection credentials…" / red "Connection relay unavailable — …" |
| Accept disabled | `ShowPlus.tsx:2118-2120` | `disabled={turnState.status !== "ready"}`, greyed to `BG3`/`TXT2`, `cursor: not-allowed`, tooltip "Waiting for connection credentials" |

Both surfaces are now identical in behaviour and wording. The main panel's equivalents are `ShowPlus.tsx:2397-2409`
(status line) and `:2415-2417` (Accept).

## Follow-up 2 — one more stale-state gap closed

`ShowPlus.tsx:507-511`: when the signaling socket tears down (guest access toggled off, or the socket drops),
`iceServersRef` is cleared and `turnState` returns to `waiting`. Without this the panel would keep claiming "ready"
against credentials that came from a closed socket and expire on a 1-hour TTL — the same class of lie as the dead
button. The next connection mints fresh credentials.

---

## Follow-up 3 — is the guest flow otherwise unchanged?

Asked directly, so answered precisely. **Two of the three steps are byte-for-byte untouched. One step has a real
change, and it is not only the Accept gate.**

### Step 2 — Accept → connection built → guest sits in the waiting column, camera live: **UNCHANGED**

`acceptGuest` gains exactly one early return (`ShowPlus.tsx:521-533`) ahead of everything else. Past that point the
function is identical: same `setGuests` updater, same `peersRef` registration, same host-track/recvonly logic, same
`ontrack` → `stream` → state, same ICE queue and flush from 4.4.96. The only difference inside the
`RTCPeerConnection` constructor is *which* servers it is given (`ShowPlus.tsx:538`).

Proof the tile path was not touched — the diff contains no reference to either:

```
$ git diff src/components/ShowPlus.tsx | grep -c "GuestGridTile"      → 0
$ git diff src/components/ShowPlus.tsx | grep -c "addLayerFromSource"  → 0
```

### Step 3 — "+" → guest goes on the stage: **UNCHANGED**

`onToggleScene` → `addLayerFromSource` → `VideoEngineContext` → `VideoEngineCanvas` is untouched (0 diff hits above).
`GuestEngineSync` and `addGuestSource` are untouched.

### Step 1 — guest calls in → appears as pending: **CHANGED, in two ways**

1. **Timing (happy path).** The guest's `welcome` used to be sent synchronously on socket connect. It is now sent
   after the Cloudflare mint resolves (`server.js:643-661`) — one HTTPS round-trip, typically well under a second.
   The guest creates its offer on `welcome`, so the pending row appears on the host that much later. Same sequence,
   slightly delayed.
2. **Mint failure (the material one).** If the guest's mint fails, the server sends `welcome-error`
   (`server.js:657`), the guest page shows the reason and closes, and **it never sends an offer — so it never appears
   as a pending row at all.** The host does not see a "wants to join" card to gate.

That is a genuine change to step 1 and it is worth being clear-eyed about: the gate is not the only thing standing
between a guest and the host. When credentials are unavailable, the guest is stopped at its own end, before the host
ever learns it called in.

**Asymmetry worth knowing:** the host mints on its own socket connect and the guest mints on its own. In the normal
failure case (bad or empty credentials) both fail, so the host sees the red "Connection relay unavailable" line and
knows why nobody is arriving. But in a *transient* failure where only the guest's mint fails, the host sees nothing —
its own state still reads "ready", and the guest simply never appears. The evidence in that case is
`[TURN] MINT FAILED for guest …` in `/var/log/ether-signal.log`. Not fixed here; naming it rather than leaving it to
be discovered.

### Everything else in the panel

The credential line is inserted between the invite block and the pending list on both surfaces; the pending card, the
accepted-guest grid, `GuestGridTile`, the mic/×/+ controls, and Deny are all untouched.

---

## Architecture compliance

- **`CLAUDE.md` — "BUILD THE SENSE, NOT THE SCAFFOLD … honest state (observed, never claimed)."** The feature ships
  with its own observability in v1: `[TURN]` mint success/failure with shape on the server (`server.js:107,109`),
  `[TURN]` receipt/refusal on the client (`ShowPlus.tsx:450,459,464,522`), and a visible state in the GUESTS panel
  (`ShowPlus.tsx:2375-2387`). A silent STUN-only fallback would have recreated exactly the bug being fixed, so the
  design refuses it in both directions.
- **`CLAUDE.md` — "Correct minimal solution … name what you're deliberately NOT building."** Two files, one new
  function, one env file, one unit line. Explicitly untouched, per instruction: `getUserMedia` constraints
  (`server.js:225` — the 1080×1920 work), the guest-side ICE queue bug (`server.js:313`, the mirror of the 4.4.96 host
  fix), the tile's honest-state gap, late-track re-attach, and the dead guest components.
- **`CLAUDE.md` — "ARCHITECTURE BEFORE CODE."** Governing docs read first:
  `docs/lightsail-guests-box-survey-2026-07-28.md` (the box's actual topology and the proof no relay existed),
  `docs/showplus-guest-architecture-doc-audit-2026-07-28.md` (the documentation gap), and the Cloudflare credential
  page cited in the instruction.
- **Nothing contradicted the box survey.** Every fact it recorded held on re-inspection: `ether-signal.service` →
  `/opt/ether-signal/server.js`, node v20.20.2 (global `fetch` available, no dependency added), no `.git`, no
  EnvironmentFile previously, no coturn. **No STOP condition was triggered.**
- **Help entry:** not required — no new user-facing surface or control. The GUESTS panel gains a status line for a
  failure state that previously had no words at all.
- **Standing gap, unchanged by this work:** `/opt/ether-signal` is still not under git, so this patched `server.js`
  exists in exactly one place plus its `.bak` files. Recorded in the box survey; not acted on here.

---

## Blocking — the two values

The code, the env file, the unit wiring, and the client are all in place. **The only missing input is the pair of
secrets**, which I will not invent:

- `TURN_KEY_ID` — the **Turn Token ID**
- `TURN_KEY_API_TOKEN` — the **API token**

Both are currently empty in `/etc/ether-signal.env` (0600, root:root). Once you provide them, they go into that file
and nowhere else. Until then every mint fails closed and logs
`[TURN] MINT FAILED … not set (check EnvironmentFile /etc/ether-signal.env)`.

---

## DEPLOYED — 2026-07-29 01:09 UTC

Credentials supplied by the operator and written to `/etc/ether-signal.env` only.

### Credentials validated BEFORE the restart

Deliberate reordering of the requested sequence, for safety: because the design is fail-closed, restarting with a bad
token would have taken guest connections from "works on friendly networks" to "works nowhere" and straight into the
rollback path. So the credentials were proven against the live Cloudflare API *first*, with the service still running
the old code:

```
POST …/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers   →   HTTP 201

iceServers entries : 2
stun: urls         : 2
turn/turns: urls   : 6
username present   : 1
credential present : 1

relay hostnames (credentials NOT printed):
  turn:turn.cloudflare.com:3478?transport=udp
  turn:turn.cloudflare.com:3478?transport=tcp
  turn:turn.cloudflare.com:53?transport=udp
  turn:turn.cloudflare.com:80?transport=tcp
  turns:turn.cloudflare.com:443?transport=tcp
  turns:turn.cloudflare.com:5349?transport=tcp
```

Exactly the documented shape. **`relay=true` in substance: six relay URLs, TCP/UDP/TLS.** No rollback needed.

### Secret handling

```
$ sudo ls -la /etc/ether-signal.env
-rw------- 1 root root 448 Jul 29 01:06 /etc/ether-signal.env     ← 0600 root:root

$ sudo awk -F= '/^TURN_/ {print $1 " = <" length($2) " chars>"}' /etc/ether-signal.env
TURN_KEY_ID = <32 chars>
TURN_KEY_API_TOKEN = <64 chars>
TURN_TTL_SECONDS = <4 chars>
```

Written to that file and nowhere else. Never echoed back, never logged, not in git, not in the desktop app.

### Reload + restart

```
$ sudo systemctl daemon-reload                    → OK
$ sudo systemctl restart ether-signal.service     → OK
● ether-signal.service - Ether Guest Signaling Server
     Active: active (running) since Wed 2026-07-29 01:09:03 UTC
   Main PID: 759054 (node)          ← new PID; the 85-day-old process is gone, new code is live

$ sudo tail -1 /var/log/ether-signal.log
[SIGNAL] Server listening on 127.0.0.1:9091
```

EnvironmentFile plumbing confirmed inside the running process (presence and length only — values never printed):

```
TURN_KEY_ID        present=1 length=32
TURN_KEY_API_TOKEN present=1 length=64
TURN_TTL_SECONDS   present=1 length=4
```

### Icecast and nginx — untouched

```
icecast2 : active   since Fri 2026-07-24 18:48:22 UTC     ← predates all of this work; never restarted
nginx    : active   since Wed 2026-07-22 06:43:46 UTC     ← predates all of this work; never restarted
icecast  : http://127.0.0.1:8000/status-json.xsl → HTTP 200
```

Only `ether-signal.service` restarted, exactly as scoped.

### Why there are no `[TURN]` lines in the startup log

**By design, and worth being explicit about rather than papering over.** `mintIceServers()` is called on *connection*
(`server.js:531` for a host, `server.js:643` for a guest), never at boot. A freshly started server that nobody has
connected to has nothing to mint, so the startup log correctly contains only `[SIGNAL] Server listening`.

The mint path itself is nevertheless proven three ways above: the API returns 201 with six relay URLs; the credentials
are present in the running process's environment; and the code that reads them is the deployed file that passed
`node --check`. The first real `[TURN] minted for host …` line will appear the moment a host socket connects.

### What is and is not live

| Piece | State |
|---|---|
| Signaling server + guest page (TURN) | **LIVE** — new code running, credentials working |
| Guest page ICE servers | **LIVE** — guests now get STUN + Cloudflare relay, served fresh from the box |
| Desktop host ICE servers | **NOT live** — the client patch is committed to no build; the installed app still uses its own hard-coded STUN until an installer ships |

Consequence worth understanding before testing: with the *installed* app, a guest connecting today gets relay
candidates while the host still offers only STUN candidates. That is not the designed end state, but it may well be
enough to connect, since one relaying side is often sufficient. A clean end-to-end test of what was actually built
needs the desktop build — deliberately not made in this release.

## Stopped here

No version bump, no commit, no push, no installer, no install. Icecast and nginx untouched. Rollback assets remain in
place: `/opt/ether-signal/server.js.bak-before-turn-20260729_003214` and
`/etc/systemd/system/ether-signal.service.bak-before-turn-20260729_003307`.

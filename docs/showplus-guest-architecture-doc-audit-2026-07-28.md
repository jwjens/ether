# Show+ guest / WebRTC — designed architecture vs shipped code (documentation audit)

**Date:** 2026-07-28 · **Mode:** READ-ONLY. Nothing edited, nothing committed, nothing proposed.
**Question asked:** what does the architecture *say* the Show+ guest path is, and where has the code drifted from it?

**Operator facts taken as given:** Show+ guest video has worked on this setup before; the architecture is documented;
it goes through AWS; do not propose TURN as new work until the docs have been read.

---

## Headline

**There is no Show+ guest / WebRTC architecture document.** Not in `C:\openair\docs\` (86 files), not in any other
local tree, not in `CLAUDE.md`, not in the wiki. What exists is two **close-out-tracker entries** written as cleanup
notes for a *different* dead feature, which incidentally record two facts about the real path — and nothing else.

The AWS component is nevertheless identified, from the operator's Cloudflare DNS screenshot rather than from any
document: **`guests.ether-technologies.com` is an A record to `44.244.52.207`, DNS-only (unproxied)** — the **same AWS
Lightsail instance that runs Icecast**, documented at `docs/phase-a-amendment-2.md:5,15` and `CLAUDE.md:70`.

So Jeff is right that it goes through AWS. What is **not** documented anywhere is what runs on that box for guests,
whether it includes a media relay, and what ICE configuration the client is supposed to use. Those are UNKNOWN below,
each with the document that should have covered it.

**The one hard, code-level divergence:** whatever exists on `44.244.52.207`, **the shipped client cannot use it as a
relay** — `iceServers` names only Google's public STUN servers (`ShowPlus.tsx:494-496`) and never references
`guests.ether-technologies.com` or `44.244.52.207` in any ICE role. The guest path uses Ether's AWS box for
**signaling only**; media is left to whatever the two endpoints can negotiate between themselves.

---

## STEP 1 — Every document found

### Search performed

Trees searched: `C:\openair`, `C:\ether-backend`, `C:\ether-cast`, `C:\ether-dashboard`, `C:\ether-bridge`,
`C:\ether-admin`, `C:\ether-signup`, plus `C:\ether-listener`, `C:\ether-wiki`, `C:\ether.wiki`, `C:\ether-wiki-tmp`.
Terms: `guest`, `WebRTC`, `TURN`, `STUN`, `relay`, `signaling`, `guests.ether-technologies`, `AWS`, `EC2`,
`Lightsail`, `coturn`, `turnserver`, `iceServers`, `44.244.52.207`.

Structural findings before content:

- **Only two `docs/` folders exist** across all trees: `C:\openair\docs` and `C:\ether-listener\docs` (one file,
  `mobile-background-playback-2026-07-08.md`, unrelated). `ether-backend`, `ether-cast`, `ether-dashboard`,
  `ether-bridge`, `ether-admin`, `ether-signup` have **no `docs/` folder at all** — `ether-backend/README.md` is the
  only top-level markdown among them.
- **Only one `CLAUDE.md` exists** in any tree: `C:\openair\CLAUDE.md`.
- **The wiki (8 pages, `C:\ether-wiki` / `C:\ether.wiki`) contains zero hits** for guest, WebRTC, signaling, or TURN.
- **`CHANGELOG.md` contains zero** guest / WebRTC / signaling entries.
- **`docs/backlog.md` contains no guest, WebRTC, or TURN entry** — its only Show+ item is the device layer
  (`docs/backlog.md:3-16`).

### A. Documents that describe the real guest path (all two of them)

| # | Path | What it specifies |
|---|---|---|
| 1 | `docs/close-out-tracker.md:122` (OB15) | States plainly: *"The REAL video-studio + remote-guest feature is Show+ (`ShowPlus.tsx`), which uses `guests.ether-technologies.com` (plural) for its **production WebRTC signaling and invite-link infrastructure**."* Also: `PodcastMode.tsx`'s `guest.ether-technologies.com` (singular) is a dead placeholder pointing at *"a host that doesn't exist."* Filed as a delete-the-dead-code item. |
| 2 | `docs/close-out-tracker.md:124` (OB16) | Specifies the real invite-URL form: `https://guests.ether-technologies.com/join?s=<token>` — *"different host, query-param form, plural `guests.`"* Explicitly contrasts it with the Railway backend's orphan `/join/:token` + `public/guest-join.html`, and calls the real one **"the off-Railway `guests.ether-technologies.com` infrastructure."** |

That is the entire architectural record of the Show+ guest path. **Neither entry is an architecture document** — both
are cleanup tickets for `PodcastMode`, written 2026-05-23 during the `etherradio.app` → `ether-technologies.com`
rename arc (commit `a130842`). Neither says what runs on the guests host, who deploys it, or how media is relayed.

### B. Documents about the AWS box that DNS points `guests.*` at

| # | Path | What it specifies |
|---|---|---|
| 3 | `docs/phase-a-amendment-2.md:5,15` | The Lightsail instance: `44.244.52.207`, Ubuntu 24.04.4 LTS, user `ubuntu`, **Oregon Zone A**, reached by manual SSH. |
| 4 | `docs/phase-a-amendment-2.md:227` | *"The Lightsail Icecast server was provisioned manually (installed, configured, started)"* — flagged at the time as a weakness. |
| 5 | `docs/phase-a-execution-plan.md:52,66,390`, `docs/phase-a-step-2-v8-migration-plan.md:58,400` | The box's **documented job: Icecast**, mounts `/live` `/ov` `/usph` on `:8000`; mounts now provisioned via the Icecast Admin API (AD-11). |
| 6 | `docs/phase-a-amendment-3.md:159` | *"A single Lightsail instance at 44.244.52.207 serves all stations at launch."* |
| 7 | `docs/multi-station-broadcast-architecture.md:22` | *"Cloud infrastructure (Cloudflare R2, AWS Lightsail) acts as relay/CDN/sync hub. The cloud does not make playback decisions."* |
| 8 | `docs/multi-station-broadcast-architecture.md:199-206` (P15) | **Enumerates exactly five roles** for "Cloudflare + AWS Lightsail": Icecast relay, failover, CDN, now-playing backup, library-sync target. **WebRTC guest signaling is not among them.** |
| 9 | `CLAUDE.md:70` | *"Stream via Icecast on Lightsail (`stream.ether-technologies.com:8443`), mounts `/ov` `/usph`."* The box's only entry in the project's ground-truth infrastructure list. |
| 10 | `CLAUDE.md:22` | Cloud is *"the relay/sync hub and transmitter, not the playout engine."* |
| 11 | `docs/close-out-tracker.md:113` (OB5) | A second service on the same box: the playout API at `44.244.52.207:3500`. |
| 12 | `scripts/deploy-playout.sh:1-17,124-134` | The **only provisioning script for that box**. Installs Node 20, ffmpeg, icecast2; deploys `/opt/ether-playout`; opens **ports 3500 and 8000 only**. |
| 13 | `scripts/playout-service/` (`playout.js`, `ether-playout.service`, `icecast.xml`, `package.json`) | The full contents of what that script deploys. **No signaling server, no WebSocket server, no TURN/coturn, no reference to guests.** |

### C. Documents about Show+ that are silent on the guest transport

| # | Path | Relevance |
|---|---|---|
| 14 | `docs/showplus-device-layer-design-2026-07-27.md` | Show+ design of record for **local physical-device acquisition only**. Marked `DESIGN ONLY — build nothing from this doc yet` (line 3). Says nothing about WebRTC, signaling, or ICE. Its line 32-34 does establish the by-reference stream-sharing pattern. |
| 15 | `docs/studiopro-popout-window-design-2026-07-20.md:63` | One passing mention: *"the `videostudio` popout key is the **VideoStudio** (camera/WebRTC) component."* No transport detail. |
| 16 | `docs/showplus-guest-tile-black-video-trace-2026-07-28.md` | My trace from earlier today. §4 records that the guest page source is absent from every local tree; §7.3 records STUN-only. **Not an architecture source** — it documents the code, not the design. |
| 17 | `docs/build-report-guest-ice-candidate-queue-2026-07-28.md` | The 4.4.96 ICE-queue fix. Same caveat. |

### D. Non-document evidence (operator-supplied, 2026-07-28)

Cloudflare DNS dashboard for `ether-technologies.com`, screenshot provided by Jeff. **This is the only place the guests
host's location is recorded anywhere**, and it is not a document in any repo:

| Record | Type | Content | Proxy |
|---|---|---|---|
| `guests.ether-technologies.com` | **A** | **`44.244.52.207`** | **DNS only** |
| `stream.ether-technologies.com` | A | `44.244.52.207` | DNS only |
| `app.` | CNAME | `ether-dashboard.pages.dev` | Proxied |
| `ethercast.` | CNAME | `ether-cast.pages.dev` | Proxied |
| `listen.` | CNAME | `ether-listener.pages.…` | Proxied |
| `platform.` | CNAME | `ether-admin.pages.dev` | Proxied |
| `signup.` | CNAME | `ether-signup.pages.d…` | Proxied |

Two things follow directly, with no inference beyond reading the records: **(a)** the guests plane and the Icecast
stream plane are the **same AWS Lightsail host**; **(b)** `guests.*` is **DNS-only**, so unlike every Pages property it
gets **no Cloudflare proxy, no Cloudflare TLS termination, and no Cloudflare WebSocket handling** — the `wss://`
connection from `ShowPlus.tsx:425` and the `https://…/join?s=` page both terminate **on the Lightsail box itself**,
which must therefore carry its own certificate and its own listener on 443.

---

## STEP 2 — The designed architecture, from the docs

### What AWS component is in the guest media path, and what is its job?

**Partially answerable, and only from DNS — not from any document.**

- **Identified:** AWS **Lightsail** instance `44.244.52.207` (Oregon Zone A, Ubuntu 24.04.4 — `phase-a-amendment-2.md:15`).
  `guests.ether-technologies.com` resolves to it (operator DNS screenshot).
- **Its documented job:** Icecast relay (`CLAUDE.md:70`, `phase-a-execution-plan.md:66`) and the playout API on `:3500`
  (`close-out-tracker.md:113`). **Nothing more.**
- **Its guest job: UNKNOWN.** No document assigns this host any WebRTC role. `multi-station-broadcast-architecture.md:199-206`
  enumerates the cloud's five roles and guest signaling is not one of them; `CLAUDE.md:70` lists the box as Icecast only.
- **Whether it is in the guest *media* path at all: UNKNOWN.** Signaling ≠ media. Nothing in the docs, the deploy
  script, or the client code puts this host in the media path.

> **Doc that should have covered it:** a `docs/showplus-guest-architecture-*.md` that does not exist. Failing that,
> `docs/multi-station-broadcast-architecture.md` P15 (which claims to enumerate what the cloud provides) and the
> `CLAUDE.md` Infrastructure block (line 68-70) and Project map (line 141-153), both of which claim ground-truth status.

### Where does signaling run?

- **Client side, documented in code:** `wss://guests.ether-technologies.com/signal?role=host&token=<t>` —
  `ShowPlus.tsx:425`.
- **Host machine:** the Lightsail box, per DNS.
- **What software serves `/signal`: UNKNOWN.** No source, no config, no systemd unit, no deploy step exists in any
  local tree. `scripts/deploy-playout.sh` — the only provisioning script for that box — installs Node/ffmpeg/icecast2
  and opens only ports 3500 and 8000 (`deploy-playout.sh:17,124-134`); `scripts/playout-service/` contains no
  WebSocket or signaling code. A repo-wide grep for `role=host`, `WebSocketServer`, and `DurableObject` returns only
  `ShowPlus.tsx` (the client), my trace doc, and the built bundle `dist/assets/index-ZWNWYw7N.js`.

> **Doc that should have covered it:** the missing Show+ guest architecture doc, and `CLAUDE.md`'s "Project map
> (permanent ground truth — verified 2026-07-14)" at `CLAUDE.md:141-153`, which maps every local dir → deploy target →
> domain and **has no entry for `guests.ether-technologies.com`**.

### Where does media relay run, if anywhere?

**UNKNOWN — and no document anywhere states that a relay exists, was designed, or was provisioned.**

What can be stated with receipts:
- No document in any tree mentions TURN, coturn, turnserver, or a media relay for guests. The only `TURN`/`STUN`
  matches across all `docs/` are in my own two 2026-07-28 files; the `milestone-b-handoff.md` and
  `vu-meter-diag-2026-05-31.md` hits are false positives (`@aws-sdk`, the word `return`).
- The box's only provisioning script opens **8000 and 3500** — **not** 3478/5349 (STUN/TURN) and not 443
  (`deploy-playout.sh:124-134`). Whatever serves `wss://guests…` on 443 was added outside that script.
- **Whether coturn is in fact running on `44.244.52.207` today is not determinable from the repos.** It is
  determinable only by inspecting the box (SSH / Lightsail console) — deliberately not done here (read-only, and
  outside the scope given).

> **Doc that should have covered it:** the missing Show+ guest architecture doc. Note `phase-a-amendment-2.md:227`
> already identified hand-provisioning of this exact box as a known risk; that lesson was closed for Icecast mounts
> (AD-11) and never applied to the guests services.

### What `iceServers` config does the design call for?

**UNKNOWN — no document states any ICE configuration for Show+.** Zero occurrences of `iceServers` in any doc, wiki
page, or `CLAUDE.md` across all trees, other than my own two files from today.

> **Doc that should have covered it:** the missing Show+ guest architecture doc.

### What is the guest page, where does its source live, where is it deployed from?

- **What it is:** the page served at `https://guests.ether-technologies.com/join?s=<token>` —
  `close-out-tracker.md:124`; client generates the link at `ShowPlus.tsx:1102`, `:1972`, `:2289`.
- **Where its source lives: UNKNOWN.** Not in any of the ten local trees searched. Confirmed again in this pass.
- **Where it deploys from: UNKNOWN.** No repo, no wrangler config, no deploy script, no CI reference. The only
  deploy scripts found anywhere are `ec-deploy.sh` (ether-cast → Cloudflare Pages) and
  `scripts/deploy-playout.sh` (playout service → Lightsail); neither touches guests.
- **What it is *not*:** `ether-backend/public/guest-join.html` — documented as an orphan at `close-out-tracker.md:124`,
  and independently confirmed a stub (`guest-join.html:206` declares `peerConn` and never constructs it; line 335
  reads *"Real WebRTC would go here"*).

> **Doc that should have covered it:** `CLAUDE.md:141-153` Project map — it exists precisely to record
> "local dir → what it is → deploy target → domain" for every property, and `guests.*` is missing from it.

---

## STEP 3 — Design vs code

Most rows cannot be scored, because the design is silent. Scored honestly:

| # | What the design says | What the code does | Verdict |
|---|---|---|---|
| 1 | Show+ uses `guests.ether-technologies.com` for production WebRTC signaling (`close-out-tracker.md:122`) | `ShowPlus.tsx:425` opens `wss://guests.ether-technologies.com/signal?role=host&token=…` | **MATCHES** |
| 2 | Invite URL is `https://guests.ether-technologies.com/join?s=<token>` (`close-out-tracker.md:124`) | `ShowPlus.tsx:1102`, `:1972`, `:2289` build exactly that | **MATCHES** |
| 3 | Same, enforced server-side | `ether-backend/src/index.js:5568-5569` rejects any e-mail invite link not starting with `https://guests.ether-technologies.com/` | **MATCHES** |
| 4 | Show+ is the real remote-guest feature; `PodcastMode` is dead placeholder to be deleted (`close-out-tracker.md:122`) | `src/components/PodcastMode.tsx` still present and still wired into `src/canvas/WidgetCanvas.tsx:18,37-40` | **DIVERGES** (filed as OB15, still open — a second, non-functional "remote guest" door remains reachable) |
| 5 | Backend `/join/:token` + `public/guest-join.html` are orphans of the dead flow (`close-out-tracker.md:124`) | Both still registered/served in `ether-backend/src/index.js` | **DIVERGES** (filed as OB16, still open) |
| 6 | Cloud roles for Cloudflare + AWS Lightsail are exactly five, none of them WebRTC (`multi-station-broadcast-architecture.md:199-206`) | The Lightsail box also serves the entire Show+ guest signaling plane (DNS) | **DIVERGES — the doc is behind reality** |
| 7 | `CLAUDE.md:70` lists the Lightsail box as Icecast (+`:8443` stream) | Same box is also `guests.*` (DNS), plus the playout API on `:3500` (`close-out-tracker.md:113`) | **DIVERGES — ground-truth infra list understates the box by two services** |
| 8 | `CLAUDE.md:141-153` Project map claims permanent ground truth for every dir → deploy target → domain | No entry for `guests.ether-technologies.com`; no local dir; no deploy target recorded | **DIVERGES — the map is incomplete for a production plane** |
| 9 | The Lightsail box is provisioned by `scripts/deploy-playout.sh` (Node/ffmpeg/icecast2, ports 3500+8000) | Something also serves TLS + WebSocket on 443 for `/signal` and `/join` on that box, provisioned by nothing in-tree | **DIVERGES — a production service exists with no provisioning record**, the exact risk `phase-a-amendment-2.md:227` raised |
| 10 | *(no design statement on ICE)* | `ShowPlus.tsx:494-496` — `iceServers` is **Google public STUN only** (`stun.l.google.com:19302`, `stun1.…`); no Ether host in any ICE role | **UNKNOWN design / see below** |
| 11 | *(no design statement on media relay)* | Nothing in the client ever references `44.244.52.207` or `guests.*` for media | **UNKNOWN design / see below** |

### The finding that matters most (rows 10-11 stated plainly)

Jeff's instruction was not to propose TURN until the docs were read, because **the designed path may already cover it**.
After reading everything: **the docs do not cover it either way** — but the code settles half the question on its own.

**Even if a relay is running on `44.244.52.207` right now, this client cannot use it.** ICE only ever considers servers
listed in `iceServers` at `RTCPeerConnection` construction (`ShowPlus.tsx:493-495`). That list names two Google STUN
hosts and nothing else. There is no code path — no config read, no KV lookup, no fetch from the backend, no env var —
that could introduce an Ether-owned STUN or TURN server into the guest connection. Grep confirms: `iceServers` appears
exactly once in `src/`, and `44.244.52.207` appears in `electron/main.js` only for Icecast defaults (`:1200`, `:1247`,
`:2011`), never in `ShowPlus.tsx`.

So: the guest plane uses Ether's AWS box for **signaling only**. Media negotiation is delegated entirely to Google's
public STUN plus whatever the two endpoints can reach directly. That is a statement of what the code does — whether it
contradicts the intended design is **UNKNOWN**, because no document ever stated the intent.

**Also note, against Jeff's "already filed":** the TURN gap is recorded in commit `8db0925`'s message and in my two
2026-07-28 docs, but **`docs/backlog.md` has no TURN entry** — verified this pass. Per `CLAUDE.md`, the backlog is
where such items are supposed to live, so "filed" is currently true only in git history and in a trace document.

### Bearing on "it has worked before"

Not resolvable from documents, and not guessed at here. What the record supports: nothing in the codebase's history
ever pointed the client at an Ether-owned ICE server, so any previously working session ran on the same Google-STUN-only
configuration — meaning it worked because that particular host/guest network pair was traversable without a relay, or
because something changed on the box or the network path. **Which of those it was is UNKNOWN from the repos** and is
answerable only against the Lightsail box and the specific guest's network. Stated as an open question, not a
conclusion.

---

## STEP 4 — UNKNOWNs, and the document that should have covered each

| UNKNOWN | Document that should have covered it |
|---|---|
| What software serves `/signal` on `guests.ether-technologies.com` | Missing `docs/showplus-guest-architecture-*.md`; `CLAUDE.md:141-153` Project map |
| Where the `/signal` server's source lives, and how it deploys | Same; `CLAUDE.md:141-153` explicitly exists for this |
| Whether a TURN/coturn relay exists on `44.244.52.207` | Missing Show+ guest architecture doc; `scripts/deploy-playout.sh` (provisions that box but never mentions it) |
| What `iceServers` the design intends | Missing Show+ guest architecture doc |
| What the guest page is built from and who deploys it | `CLAUDE.md:141-153` Project map |
| Which ports the guests plane requires (443? 3478? 5349?) | `scripts/deploy-playout.sh:124-134` documents only 8000/3500 for that box |
| How TLS is terminated for `wss://guests…` given DNS-only (no Cloudflare proxy) | Missing Show+ guest architecture doc |
| Whether the guest page offers a video m-line, and whether it has an audio-only join toggle | Missing Show+ guest architecture doc; still open from `showplus-guest-tile-black-video-trace-2026-07-28.md` §4 |
| Whether Show+ guests were ever designed to be single-box (signaling + relay together) or split | Missing Show+ guest architecture doc; `multi-station-broadcast-architecture.md` P15 |

No gap above has been filled by inference. Where the answer required looking at the Lightsail box rather than at a
document, that is said outright rather than guessed.

---

## Scope note

Read-only throughout: greps and `git log` only. No file in any tree was modified, no command touched
`44.244.52.207`, no network probe was run, and nothing was proposed or fixed. No temporary tooling was created —
nothing is left armed on this machine.

The one non-repo input used is the operator's Cloudflare DNS screenshot, labelled as such in §1.D and never mixed in
with document receipts.

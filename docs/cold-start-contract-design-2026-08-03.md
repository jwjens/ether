# Cold-start contract — trace + design of record

**Date:** 2026-08-03 · **Status:** READ-ONLY trace + design. **Nothing built, nothing edited.**
**Contract source:** Jeff, 2026-08-03. **Governing:** `CLAUDE.md` — *the account is the root of
everything*; the machine is a terminal.

---

## The four complaints, traced

### 1 · Opens already signed in as jensj — PARTIALLY TRACED

The gate itself is **structurally correct** and the two documented bypasses are **tight**:

```js
// App.tsx:2114
if (firstRunChecked && !accountSignedIn) return <OnboardingFlow forceAuth … />;
if (!currentUser)                        return <UserLogin … />;
```

`accountSignedIn` and `currentUser` both start falsy every launch. The only three writers of
`setAccountSignedIn(true)` are sign-in completion (`:1278`) and two markers, both of which I read and
both of which are properly narrow:

- **`account:was-on-air` (`main.js:2485`)** — requires the on-air marker file **AND**
  `process.env.ETHER_WATCHDOG_PID`. A manual launch has no such env var, so a stale marker is ignored.
  This is exactly CLAUDE.md's single permitted exception, implemented correctly.
- **`account:resume-session` (`main.js:2508`)** — a keep-session marker, **consumed on read** and
  honoured only if **< 2 minutes** old. Written only before a continuation self-relaunch.

**So neither explains a manual cold launch adopting jensj**, and I will not claim they do.

**The one structural hole I can name from the code:** the sign-in gate is conditional on
`firstRunChecked`. While that flag is false, **the gate does not render at all** and evaluation falls
through to the next line. That is the same shape as the standing open bug in CLAUDE.md ("fresh install
shows UserLogin instead of account sign-in"). CLAUDE.md is explicit that account-or-nothing must be an
*unconditional* prerequisite, not a condition among conditions.

**OPEN 1 RESOLVED — NEGATIVELY (2026-08-03, receipts below). The mechanism is NOT where I predicted,
and three candidate paths are now eliminated:**

1. **`forceAuth` does NOT self-complete.** `OnboardingFlow.tsx:197` short-circuits *before* any KV read:
   `if (forceAuth) { setState('auth'); setResumeChecking(false); return; }` — its own comment reads "No
   account + nothing operating → ignore any stale resume flags and force sign-in." A stored
   `account_jwt` cannot advance it.
2. **The watchdog bypass is NOT firing.** `.ether-on-air` IS present and continuously refreshed (the
   daemon airs non-stop), but `_wasOnAir()` also requires `ETHER_WATCHDOG_PID` — and the running
   `Ether.exe` (pid 27120) has **parent `explorer`**, with **no watchdog process on the box**. So the
   guard correctly ignores the stale-ish marker and returns false.
3. **`UserLogin` does not auto-select.** Its mount effect only lists profiles; login requires selecting a
   profile AND a 4-digit PIN (`:68-81`), or setup mode when no users exist.

**So no auto-sign-in path exists in the code I traced, yet the symptom is real (Jeff's report outranks a
log/grep absence — standing rule).** Building D1's gate change on this trace would be building on an
unproven premise: I would be changing a path I have not shown to be the one firing.

**The one diagnostic that settles it, and it needs a RUNTIME receipt, not more grepping:** on a cold
manual launch, capture which screen actually renders first and the values of `firstRunChecked`,
`accountSignedIn`, `hasAccountJwt` and `currentUser` at that moment. The most likely remaining
explanation from the code is that **`firstRunChecked` is still false when the gate line evaluates**, so
`App.tsx:2114` is skipped entirely and rendering falls through — which is exactly the conditional-gate
hole D1 removes. **That would mean D1 is still the right fix, for a reason I have not yet proven.**

**Cheap clarifying question for Jeff that may settle it instantly:** on launch, does the app show a
sign-in screen at all (and it's the *stations* that arrive as jensj's), or does it go straight to the
board with no screen in between? Those are different bugs with different fixes.

**Superseded prediction (kept honest):** whether `OnboardingFlow forceAuth` **auto-advances** when it
finds a stored `account_jwt` (the durable marker read into `hasAccountJwt`, `App.tsx:549`). If it does,
the gate renders and then immediately completes itself — which would present exactly as "opens already
logged in" while every check above still reads correct. **I did not read `OnboardingFlow.tsx`'s auth
effect** (it is also one of the two files carrying the accepted pre-existing tsc errors). One targeted
read settles it, and the design below does not depend on which answer it gives.

### 1b · SETTLED (Jeff, 2026-08-03): the gate renders — adoption RACES it

**Jeff's observation is the receipt: the sign-in screen DOES appear, and the music starts WHILE it is
opening — before any sign-in or PIN.** So the gate is not bypassed; **station adoption and engine
startup simply do not wait for it.** Auth and adoption are parallel tracks, not an ordered pipeline.

**The React fact that makes it possible:** `App.tsx`'s sign-in early-return lives at **`:2114`** — below
every hook in the component. Hooks are not skipped by a later `return`, so **every startup effect above
that line has already run by the time the sign-in screen paints.** A gate placed in the render path
cannot hold back work scheduled in the hook path. Only per-effect gating can, and it is applied
inconsistently.

**The confirmed chain, in execution order:**

| # | Site | What it does before auth |
|---|---|---|
| 1 | `:588` `useRef(getActiveStationIdSync())` | **adopts jensj's persisted active station** synchronously at first render |
| 2 | `:531` `const engine = getEngine(stationId)` | constructs that station's engine during render |
| 3 | `:617` `useState(() => readAutoAdv(...))` | **adopts AUTO intent** from that station's stored KV |
| 4 | **`:1464` effect, deps `[engine]`** | **calls `engine.init()` — NO `accountSignedIn` gate** |

**Site 4 is the one that makes noise.** `engine.init()` starts the 250 ms poll loop, the daemon detect
and `attachDaemonEvents` — the full playout mirror — and it is gated only on `[engine]`, which is
non-null from the first render. Its own comment explains why it was deliberately placed *outside* the
startup effect (to survive station switches), and that reasoning is sound; the omission is that it never
also required an authenticated session.

**The contrast proves the inconsistency is accidental, not designed.** The neighbouring startup effects
DO gate — `:1342` opens with `if (!accountSignedIn) return;`, and the auto-resume path at `:1526`
requires `accountSignedIn && wasOnAir === true`. So the codebase already knows the rule; this effect and
the three synchronous adoptions above it simply never had it applied.

**Consequence, stated plainly:** on a machine that is a shell for *any* account, the app commits to the
last account's station, engine, audio and AUTO intent before it knows who is sitting down. Every one of
Jeff's four complaints except the daemon behaviour descends from this single ordering defect.

### D1 · REVISED SCOPE (supersedes the D1 below where they differ)

1. **The gate-line fix still ships** — `firstRunChecked` comes out of the gate condition. It is a real
   hole (rendering falls through while the flag is false) even though it is not today's symptom.
2. **The real fix — sequencing.** Everything account-derived moves BEHIND completed sign-in (account +
   PIN): station list, active station, engine construction and `init()`, monitor audio, AUTO intent.
   Until sign-in completes: **no stations, no engines, no local audio, indicators UNKNOWN.**
   Mechanically this means the pre-auth adoptions become *deferred* rather than synchronous — no
   `getActiveStationIdSync()` at render, no engine constructed until a session exists — and `:1464`
   gains the `accountSignedIn` guard its neighbours already carry.
3. **"Continue as \<account\>"** is the one-click path for the common case — an explicit act, never a
   silent adoption.
4. **The daemon is untouched.** Broadcast does not wait for login; the APP does.

**This folds into D4 as one ordered pipeline:** **auth completes → attach → adopt → project.** D4 already
defines attach/adopt/project; D1 simply makes auth its first stage instead of a parallel track. Building
D4 first remains correct — it establishes the pipeline that D1 then feeds.

### LAUNCH-DAY RUNTIME RECEIPT (Jeff, 2026-08-03) — all three defects in ONE launch

Not a trace, not an inference — **one observed launch, from the operator**:

1. **At the PIN screen, the Christmas station's audio STARTED — then cut off once the board rendered.**
   This is D1's race made audible, and the cut-off is itself diagnostic: the unauthenticated engine
   began playout, and the board's own initialisation then took over and stopped it. Audio ran on an
   engine belonging to an account nobody had authenticated yet.
2. **Queue and decks came up EMPTY** — the cold-stage populate miss (D4). Attach happened; adopt never
   did.
3. **AUTO was lit while NOTHING automated.** The daemon's `_started` was evidently false while the UI
   painted AUTO from KV — **the light contradicted the live engine on the same screen.** This is D3's
   defect exactly, now photographed rather than argued.

**Point 3 is the strongest single argument for D3.** A UI that reads its own memory can disagree with the
engine it is supposed to be reporting, in the same frame, and nothing in the product notices. That is the
honest-UI failure class the codebase already treats as a bug, appearing on the most-seen screen there is.

**D3 ACCEPTANCE TEST (from this receipt):** repeat this exact launch. AUTO/MANUAL must match the daemon's
actual `_started` **per station** — showing **UNKNOWN** until the daemon answers, and **never** painting
from KV. A launch where the daemon is not yet attached must show UNKNOWN, not AUTO. `readAutoAdv()`
survives only as the operator's stored *intent* for what to send after sign-in — never as a display
source.

### 2 · Local monitors blasting at boot — MECHANISM IDENTIFIED, LEVEL UNVERIFIED

There is **no boot-time monitor code in the renderer** — `audio:setMonitorVolume` (`main.js:3190`) is
only ever called from an operator action. So nothing *unmutes* monitors; **monitors are simply never
muted, and every station's engine now initialises at startup.** That second half arrived deliberately
in `558bc88` — *"HOP 4: every active station's engine initializes (fill sweep + position countdown on
switched-to stations)"*. Four engines up, each with whatever monitor gain it last persisted, and
nothing in the launch path asserts silence.

**Partial receipt, and it complicates the picture:** today's daemon log shows `mon=` differing per
station — `mon=0.43` on s2, `mon=0.00` on s1/s3/s4. So at least at that moment the monitor gains were
**not** uniformly open. Whether `mon` is the monitor bus gain, and whether the audible "all four at
once" comes from monitor gain or from a different path (device sharing, the program bus reaching the
default output), is **UNVERIFIED**. The design below makes this moot by asserting silence explicitly
rather than depending on which value happens to be persisted.

### 3 · AUTO already engaged — CONFIRMED

```js
// App.tsx:617
const [autoAdv, setAutoAdv] = useState<boolean>(() => readAutoAdv(getActiveStationIdSync()));
```

**The UI's AUTO light is initialised from persisted per-station KV — it is a memory of what was true
last session, presented as the daemon's current state.** Nobody pressed anything. Worse, the startup
sweep re-asserts it per station:

```js
// App.tsx:1349-1354
if (!readAutoAdv(sid)) continue;      // only stations the operator put in AUTO
eng.autoAdvance = true;
```

The *actual* `automationStart` is properly gated (`:1526` requires `accountSignedIn && wasOnAir === true`),
so this is primarily a **truthfulness** defect rather than an unbidden-playout defect — but it is exactly
the honest-UI violation the codebase already treats as a bug class: the light claims a state it read from
disk instead of one it observed.

### 4 · First load half-broken until a restart — CONFIRMED, and it is the cold-stage race

Live receipt from **today's 4.4.121 launch**, `ether-startup.log`:

```
15:58:17.956Z [renderer:error] [ENGINE] Poll error: … 'audio:getState': Error: daemon not connected
  … ~35 identical errors in ~70 ms …
15:58:18.024Z [audiod-client] post-spawn connect failed — scheduling reconnect
15:58:19.040Z [audiod-client] connected to daemon (probe)
```

The renderer polls, and **decides**, during a window in which the daemon is provably not answering. This
is the known family (`project_cold_stage_daemon_race_nextup`): the daemon is staged cold (~220 MB copy)
and the app's connect window expires first. `4.4.110` made the daemon-mode gate *TRUE-latches / FALSE
never does* precisely to stop a transient miss becoming permanent — but latching the **mode** does not
repopulate **content**: the queue and deck state that should have arrived on attach were never requested
again, so the panels stay empty until the next launch, when the daemon is warm and answers immediately.

**That is why closing and reopening fixes it** — and why it is a sequencing bug, not a rendering bug.

---

## Design of record

### D1 · The account gate becomes unconditional, and adoption becomes explicit

**Rule: until an account session exists this launch, the ONLY renderable screen is account sign-in.**
Remove `firstRunChecked` from the gate condition — a not-yet-known first-run state must render the gate
(or a splash), never fall through past it. `firstRunChecked` may gate *which* sign-in affordance shows;
it may never gate *whether* the sign-in screen shows.

**No silent adoption, ever.** A stored `account_jwt` may pre-fill and offer **"Continue as <account>"**
as a one-click affordance — it may never complete sign-in by itself. The two existing marker bypasses
(watchdog on-air recovery; <2 min continuation relaunch) stay exactly as they are: both are correct,
both are narrow, and the broadcast-continuity case depends on the first one.

**Until sign-in completes:** no station adopted, no station context resolved, no monitor audio, and no
AUTO assertion. The daemon is untouched by all of it.

### D2 · Monitors come up muted — asserted, not assumed

**On every launch, the app explicitly sets every station's monitor gain to 0 before any engine
initialises**, rather than inheriting persisted gain. Silence becomes a *positive assertion at a known
point in the sequence*, which is why it doesn't matter that §2's mechanism is only partly characterised.

Raising a monitor is an operator act, per station, and the UI must show which monitors are up — the park
case is a jock signing in and deliberately raising halloVeen. **Persisted monitor gain is remembered as
the operator's *preference*, restored only on that operator's explicit unmute, never applied at boot.**

**This must not touch the program bus.** Monitor gain is the local speaker feed; the stream path is
independent, and the daemon keeps airing at full level throughout. That separation already exists in the
audio graph — the design uses it, it does not modify it.

### D3 · ON AIR / OFF AIR and AUTO/MANUAL are OBSERVED, never presumed

Both indicators become **read-only projections of daemon state**, with a distinct third rendering for
*unknown* (pre-attach):

| Indicator | Source of truth | Before the daemon answers |
|---|---|---|
| ON AIR / OFF AIR | daemon stream state per station | **UNKNOWN** — never "OFF AIR" |
| AUTO / MANUAL | daemon `_started` per station | **UNKNOWN** — never "AUTO" |

`readAutoAdv()` stops seeding the UI's displayed state. It remains the operator's stored *intent*, used
to decide what to send the daemon **after** attach and **after** sign-in — never what to paint.

**"OFF AIR while airing" is the same lie as "AUTO while nobody pressed AUTO":** both come from the UI
answering from its own memory instead of asking. A third *unknown* state is the honest answer for the
one second before the daemon replies, and it makes the cold-start window visible instead of misreported.

### D4 · One attach sequence, and content is requested ON attach

The fix for §4 is sequencing, not a longer timeout:

1. **Attach** — connect to the daemon, with retry across the full cold-stage window (the ~220 MB copy),
   not a fixed 5 s. Report **UNKNOWN** while retrying.
2. **Adopt** — on first successful attach, request the full state set **as a unit**: engine state,
   queue, deck occupants, stream status, per-station AUTO. Not "resume polling" — an explicit
   populate-on-attach.
3. **Project** — paint from that snapshot; only now do the indicators leave UNKNOWN.
4. **Re-adopt on every reattach.** A reconnect after a daemon respawn must run step 2 again. **This is
   the actual bug: attach and populate are separate today, so a missed attach means content that is
   never requested again.**

**Acceptance:** cold-launch with the daemon airing → queue and decks populate on the *first* launch, no
restart. And the harder case, which is the one that proves it: **launch while the daemon is still cold**
(immediately after an update) and confirm the panels fill once attach succeeds, without a relaunch.

### D5 · What must not change

**The daemon keeps airing through app close/open. Broadcast never waits for a GUI login.** Nothing in
D1–D4 touches the daemon's lifecycle, its automation, or its stream. Every change above is in the app's
*launch sequence* and its *rendering of observed state*. The watchdog on-air recovery path stays intact —
it is the one case where a machine with no human present must come back on air unattended.

## Blast radius

Startup sequencing and the sign-in gate — the area CLAUDE.md flags as most sensitive, and where a
regression means an install that cannot reach its stations. Mitigations: D1 only *removes* a bypass
condition; D2 is an added assertion with no removal; D3 changes rendering, not commands; D4 adds a
populate step and a retry window without changing what attach means.

**The risk worth naming:** D3's *unknown* state touches every place the UI branches on AUTO or ON AIR.
That is a wide, shallow change, and the failure mode is a mislabeled indicator rather than dead air.

## Open, before build

1. **Read `OnboardingFlow.tsx`'s auth effect** and settle §1's UNVERIFIED question — does `forceAuth`
   self-complete on a stored `account_jwt`? The answer decides whether D1 is a one-line gate change plus
   a "Continue as" affordance, or also a change inside the flow.
2. **Characterise the boot audio for real** — is `mon=` the monitor bus, and were all four audible from
   monitor gain or from another path? D2 is correct either way, but the receipt should exist before it
   is called fixed.
3. **Confirm the cold-stage window empirically** — how long the ~220 MB stage actually takes on this box,
   so D4's retry window is set from measurement rather than a guessed constant.

---

## OPEN 2 — SETTLED: `mon=` is the monitor bus, and its default is FULL GAIN

Receipts from `native/src/audio.rs`:

```rust
:127  /// bus.monitor_vol — the local studio-monitor (device) gain; never the program bus.
:368  monitor_vol: 1.0,          // ← the default on a freshly-constructed bus
:1157 // PRE/POST monitor choice (broadcast is the stream branch above, unaffected).
      //    monitor_vol applies HERE only.
```

**`mon=` in the daemon log is `bus.monitor_vol` (`engine.js:179`), and a new bus starts at 1.0 — full
local speaker output.** Nothing has to "unmute" anything: **an engine that initialises is audible by
default.** Combined with §1b, that is the complete explanation of the launch-day receipt — an engine
initialised for an unauthenticated account came up monitoring at unity.

`:1157` also confirms the separation D2 depends on: `monitor_vol` applies **only** on the device branch;
the broadcast/stream branch is untouched. Muting monitors cannot affect air.

**This reconciles the earlier confusing sample** (`mon=0.43` on s2, `0.00` on s1/s3/s4): that was a
*later* steady state after the board rendered and applied per-station volumes — not the boot state.

**D2 is therefore NOT redundant with D1, and the earlier hypothesis that it might be is disproved.**
Sequencing engine init behind sign-in stops audio *before* auth; it does nothing about the fact that
every engine initialised *after* sign-in still starts at unity gain. **Silence must be asserted, because
the engine's own default is full volume.** D2 ships as designed.

## OPEN 3 — MEASURED: no fixed constant; retry until attach

Measured on this box (`%LOCALAPPDATA%\Ether\engine`):

| Metric | Value |
|---|---|
| Staged engine | **24 files, 307.1 MB** (larger than the ~220 MB carried in the earlier note) |
| Copy, **warm** cache | **539 ms** |
| Observed attach today (warm) | ~1 s — `post-spawn connect failed` 15:58:18 → `connected (probe)` 15:58:19 |

**The measurement's real lesson is that a constant is the wrong instrument.** 539 ms is the *warm floor*
on a fast local disk. The failing case is the opposite: first boot after an update, cold page cache,
307 MB read and written — and on a managed box like **OV, with McAfee scanning every one of those
bytes**, that is a different order of magnitude entirely. Any constant I picked from this box's warm
number would be a guess dressed as a measurement, and would fail exactly where it matters.

**D4 therefore retries until attach succeeds** — bounded backoff (e.g. 250 ms → 2 s), a long ceiling
(~120 s) purely as a runaway stop, never a 5 s cliff — and reports **UNKNOWN** throughout rather than
falling back to a wrong answer. **This also means the fix must be verified on a cold cache**, not just
by relaunching a warm app: the acceptance test is a launch immediately after an update.

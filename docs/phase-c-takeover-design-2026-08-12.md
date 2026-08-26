# Phase C — PIN-gated takeover for the designation system

**Date:** 2026-08-12 · **Status:** DESIGN ONLY, no code written. Review gate before any build.
**Governing docs:** `docs/single-writer-election-design-2026-08-11.md` (§0 supersession, §3 PIN
inventory), `docs/designation-upsert-fix-2026-08-12.md`, `docs/designation-ui-legibility-2026-08-12.md`.

---

## 0. TWO CORRECTIONS TO THE STATED CURRENT STATE — read before anything else

The brief describes a system that does not exist. Both corrections change Phase C's meaning, so they
are first rather than buried.

### 0.1 Phase B is NOT shipped. Enforcement does not exist.

> *Stated:* "Phase B: Only the designated machine auto-generates (enforcement)."

**Receipts:**

- `docs/single-writer-election-design-2026-08-11.md:3` — *"Status: Phase A built in 4.4.188
  (observability only)."*
- Same doc §2 — *"`_autoExtendTick` is **not** gated. Every switched-on machine still generates
  exactly as before."*
- `electron/main.js:7205` — *"PHASE A GATES NOTHING. `_autoExtendTick` still runs on every
  switched-on machine."*
- `electron/generation-designation.js:9` — *"PHASE A ENFORCES NOTHING … Phase B adds the gate."*
- `_autoExtendTick` reads `_autoGenerateEnabled(st.id)` and nothing else. There is no designation
  check on the generate path in the shipping tree.

**Consequence for Phase C — this is the important one.** Today, taking over changes **a label in the
Health Monitor and nothing else**. Every switched-on machine keeps generating before and after. A
PIN-gated takeover shipped onto Phase A is a ceremony in front of a control that does not yet control
anything. It is still worth building (see §6.4 for why), but sequencing it against Phase B is a real
decision and is raised in §7.

### 0.2 There is no automatic failover — it was deliberately retired.

> *Stated:* "No manual takeover mechanism yet – only automatic failover when the designated machine
> goes offline."

The opposite is true. Automatic failover is the one thing the architecture ruled out.

**Receipts:**

- `docs/single-writer-election-design-2026-08-11.md` §0 — a competing lease with heartbeat and expiry
  "was designed, built and shipped in **4.4.187**, then retired the same day … takeover had already
  been ruled **human-only** (no silent seizure of OV's station) … Automatic failover was solving a
  problem the operator was already going to see and decide."
- Same doc §1 — designation is **"Never** taken automatically from a machine that already holds it".
- `electron/generation-designation.js:54` — *"NEVER taken automatically. This is the whole difference
  from the lease it replaced."*

**Consequence for Phase C.** Manual takeover is not a convenience layered over failover — **it is the
only takeover mechanism there will ever be.** That raises its stakes considerably:

- If the designated machine dies and nobody can complete a takeover, that station's log is never
  extended again. Under Phase B that ends in dead air when the runway runs out.
- So the PIN's **recovery path is load-bearing**, not a nicety. A PIN that cannot be reset is a
  single point of failure for the station's programming. §1.6 treats it accordingly.
- The runway gauge is the compensating control the architecture leans on: a stalled generator is
  visible for days before it matters. Phase C should not weaken that — §2.3 puts the takeover
  affordance where the operator is already looking when runway goes amber.

**Everything below is designed against the verified state, not the stated one.**

---

## 1. Account-level PIN architecture

### 1.1 The requirement, restated precisely

One PIN per **account**, hashed, available on **any machine where that account is signed in**,
resettable through owner-account sign-in, and verifiable **offline**.

That last word is not in the brief but is non-negotiable here: Ether "boots/airs/self-repairs with NO
network" is a standing rule, and a takeover is most likely to be needed exactly when something has
gone wrong. A PIN check that requires the backend to be reachable would fail at the moment it is
needed most.

### 1.2 There is no `account` scope. This is the central design problem.

The sync registry has exactly two scopes:

```
scope: 'install'   — songs, artists, albums, install_config_kv, install_secrets_kv, …
scope: 'station'   — station_config_kv, clocks, categories, generated_schedule, …
```

*(`electron/sync/synced-tables.js`; `install_config_kv` at :336–351, `station_config_kv` registered
with `scope:'station'` at :833.)*

There is no account-scoped local table. "Account" exists **above** the local database — it is the
identity that carries the license key that determines the stations (CLAUDE.md, "the account is the
root of everything"). So an account-level PIN has no natural local home, and the candidates each
fail for a different reason.

### 1.3 Candidate homes, and why three of them are wrong

| Candidate | Scope | Verdict |
|---|---|---|
| `station_config_kv` | station | **Wrong granularity.** One PIN per account, not per station. Four stations would mean four PINs to keep in step, and a takeover on station 3 would consult station 3's copy. |
| `install_secrets_kv` | install | **Cannot sync, by rule.** `syncExcluded: true` — *"never leave the device in any sync payload per [Q-13]"* (`synced-tables.js:358`), enforced by tests T-25 and T-29. A PIN stored here exists on one machine only, which is the exact defect §3 of the governing doc identified in `users.pin_hash`. |
| `users.pin_hash` | — | **The thing being replaced.** Not in `synced-tables.js` at all, and carries a plaintext fallback. See §5. |
| `install_config_kv` | install | **Viable as a local cache** — already the home of `account_jwt` and `account_email` (`main.js:1007`, `:2775`, `:4459`), i.e. the established place for account-session state. Synced, not secret-excluded. |
| **ether-backend, keyed by account/license** | account | **The only true account scope.** Already the authority for what an account owns (`/account/connect` returns the station list by license key). |

### 1.4 Recommendation: backend is the authority, local copy is a cached verifier

```
   SET / RESET                                    VERIFY (takeover)
   ───────────                                    ─────────────────
   Settings ──► ether-backend                     PIN prompt
               (account PIN record,                    │
                keyed by account/license)              ▼
                        │                        local cached verifier
                        │  at sign-in,           (install_config_kv)
                        │  /account/connect,          │
                        ▼  and on change              ▼
               install_config_kv                 scrypt compare, offline,
               account_takeover_pin              no network required
```

- **Authority: the backend.** It is the only thing that is genuinely per-account, it is where the
  owner sign-in that gates reset already lives, and it makes the PIN follow the account onto a
  brand-new machine that has never synced with anything — which is the scenario in CLAUDE.md's
  opening ("a program director can sign into their account on ANY computer").
- **Verification: local, always.** The cached verifier is refreshed whenever the app talks to
  `/account/connect`. Verification never touches the network.
- **Not distributed by peer sync.** Deliberate. Peer sync is off by default, and it carries a known
  identity defect — it routes and merges by local station **integer**, not UUID, so two installs
  diverge (see the peer-sync backlog item). Making a load-bearing credential depend on that channel
  would be building on a defect we already have written down.

**New backend work required** (`ether-backend`, a separate repo — not in this tree, so the endpoint
shapes below are a **proposal, not a receipt**):

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/account/pin` | `x-license-key` or account JWT | returns `{ set: bool, hash, algo, params, updated_at }` — the verifier, never a PIN |
| `PUT /api/account/pin` | account JWT (owner sign-in) | set or change; body carries the **hash**, computed client-side |
| `DELETE /api/account/pin` | account JWT (owner sign-in) | the reset path (§1.6) |

`/account/connect` should also return the verifier inline, so an ordinary sign-in populates the cache
without a second round trip.

**The PIN is hashed on the client, before it leaves the machine.** The backend stores and returns a
verifier and never sees a PIN. This keeps the plaintext out of transport logs and out of the
backend's blast radius, and it is why the backend can be treated as a distribution channel rather
than as a trusted verifier.

### 1.5 Hashing — scrypt, not the existing sha256

The existing primitive is not adequate for this use:

```js
// electron/main.js:4154 — user:hash-pin
const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.createHash("sha256").update(salt + pin).digest("hex");
return salt + ":" + hash;
```

Salted, but **single-round**. A 4-digit PIN has a keyspace of 10,000. A single-round sha256 tests the
entire keyspace in well under a second on any machine in the building. That was tolerable when the
hash never left the device; **it stops being tolerable the moment the hash is distributed to every
machine on the account and stored on a server**, which is precisely what this design does.

**Proposed:** `crypto.scryptSync` (Node built-in, no new dependency), stored self-describing so the
parameters can be raised later without a flag day:

```
scrypt$N=16384,r=8,p=1$<salt-b64>$<derived-b64>
```

- `N=16384, r=8, p=1` — the Node default, ≈100 ms per verify. Against a 10,000-key space that is
  ~17 minutes of brute force per hash rather than microseconds.
- Salt: 16 random bytes, per PIN.
- Compare with `crypto.timingSafeEqual`.
- The `algo$params$` prefix means a future raise is a parse-and-upgrade, not a migration.

**On the threat model.** The brief is right that this is "a deliberateness gate, not a security
boundary", and that framing is respected: there is no rate-limit-by-IP, no lockout escalation, no
audit-grade tamper-evidence. Scrypt is proposed anyway because it costs one line and ~100 ms, and
because a column named `pin_hash` that yields to a wordlist in under a second is the kind of thing
that gets quoted back at us later. **It is cheap to be honest here.**

### 1.6 Reset — the load-bearing path (see §0.2)

Reset is through **owner-account sign-in**: the operator signs in with the account's email and
password (the credential the dashboard already uses), and clears or replaces the PIN.

This is the correct gate — it is strictly stronger than the PIN, it is already recoverable through
normal password recovery, and it requires no new credential.

**But §0.2 changes the stakes.** With no automatic failover, "PIN forgotten + designated machine
dead" means that station's log stops being extended, permanently, once Phase B ships. So:

1. **Reset must not require the designated machine.** It is done from any machine, or from the web
   dashboard, against the account. (The dashboard path is the better one — it works when the app
   cannot start.)
2. **Reset must work when the station is unreachable.** It touches only the account record.
3. **A no-PIN account is a valid state, not a broken one.** If no PIN is set, takeover proceeds with
   a plain confirm dialog. Requiring a PIN to exist before takeover is possible would create the
   deadlock this section is written to avoid. **An account that has never set a PIN must never be
   locked out of its own station.**
4. The Health Monitor states which mode is in force, so "why was I not asked for a PIN?" is never a
   mystery — see §2.4.

---

## 2. Takeover UI

### 2.1 Placement

Beside the **Designated generator** row in the Health Monitor, sharing the control line that already
holds REFRESH NOW and the "Designation read …" stamp (`HealthMonitor.tsx`, `DesignationRows`). No new
panel, no new door — this is the row the operator is already reading to answer "who builds this
station's log?", and the answer to "and how do I change that?" belongs in the same place.

```
Designated generator      BOOTH-2                                        ●
  BOOTH-2 — checked in 4 min ago
Log last extended         12/08/2026, 09:41

[ REFRESH NOW ]  [ TAKE OVER ]   Designation read 12s ago
```

### 2.2 Visibility

| Designation state | Button | Rationale |
|---|---|---|
| This machine (`mine`) | **hidden** | "Same-machine actions never prompt." There is nothing to take. |
| Another machine (`other`) | **TAKE OVER**, PIN-gated | The case the feature exists for. |
| None (`none`) | **CLAIM** *(see §7.1)* | Nothing is being taken from anyone. |
| Bypassed (`kill_designation`) | **hidden**, with a note | Designation is switched off; taking it would mean nothing. |
| Auto-generate OFF here | **disabled** + "Auto-gen off – cannot take over" | Consistent with the REFRESH NOW rule shipped in 4.4.194: this machine would take the designation and then not generate — strictly worse than leaving it where it is. |

That last row matters. Taking over onto a machine with auto-generate off would, under Phase B, stop
the working machine generating and not start this one. **The UI must make that unreachable, not merely
discouraged.**

### 2.3 Tie it to the runway

When a station's runway is amber/red **and** the designated machine's `last_checked` is stale, the
row should say so and point at the button:

> *BOOTH-2 has not checked in for 2 days and the log runs out in 14 hours. If BOOTH-2 is offline,
> take over to keep this station's log building.*

This is the compensating control the architecture chose instead of automatic failover (§0.2). Phase C
is where that promise is actually kept — without it, "the operator will see it and decide" relies on
them assembling two separate readings themselves.

### 2.4 The prompt

A modal, keyboard-first:

```
┌─ Take over generation for "Open Format" ────────────┐
│                                                      │
│  Currently designated:  BOOTH-2                      │
│  Last checked in:       2 days ago                   │
│                                                      │
│  This machine will build this station's log from     │
│  now on. BOOTH-2 will stop.                          │
│                                                      │
│  Account PIN   [ • • • • ]                           │
│                                                      │
│  Forgot the PIN? Reset it by signing in to the        │
│  account owner at app.ether-technologies.com.        │
│                                                      │
│              [ Cancel ]   [ Take over ]              │
└──────────────────────────────────────────────────────┘
```

- Names **what changes and who stops** in plain words, before the PIN field. The PIN is the
  deliberateness gate; the sentence above it is what makes the deliberateness informed.
- Autofocus the field; Enter submits; Esc cancels.
- When no PIN is set: the field is replaced by *"No account PIN is set. Anyone using this machine can
  take over. Set a PIN in Settings → Account."* and the confirm button still works (§1.6.3).
- **No optimistic paint.** The row updates only from the read-back the main process returns — the
  rule established in 4.4.194 and the reason that panel is trustworthy now.

### 2.5 Feedback states

| State | Button | Message |
|---|---|---|
| idle | `TAKE OVER` | — |
| verifying | `CHECKING…`, disabled | — |
| wrong PIN | `TAKE OVER` | red, under the field: *"That PIN is not correct."* Field cleared, focus retained, modal stays open. |
| transferring | `TRANSFERRING…`, disabled | — |
| success | modal closes | row flips to **This machine**, green, with a one-shot line: *"You took over from BOOTH-2."* |
| write failed | `TAKE OVER` | red, under the row: the real error — reusing the **"Designation record — NOT SAVED"** row from 4.4.193. |

---

## 3. Takeover flow

### 3.1 State machine

```
                    ┌──────┐
                    │ idle │
                    └──┬───┘
             click     │
                       ▼
              ┌─────────────────┐   no PIN set    ┌──────────┐
              │ prompt (PIN)    ├────────────────►│ confirm  │
              └──┬───────────┬──┘                 └────┬─────┘
        cancel / │           │ submit                  │
        Esc /    │           ▼                         │
        timeout  │   ┌──────────────┐  wrong           │
                 │   │  verifying   ├──────┐           │
                 │   └──────┬───────┘      │           │
                 │          │ correct      ▼           │
                 │          │        ┌──────────┐      │
                 │          │        │ rejected │      │
                 │          │        └────┬─────┘      │
                 │          │             │ retry      │
                 │          │             └──────┐     │
                 │          ▼                    │     │
                 │   ┌──────────────┐            │     │
                 │   │ transferring │◄───────────┼─────┘
                 │   └──────┬───────┘            │
                 │          │                    │
                 │    ┌─────┴─────┐              │
                 │    ▼           ▼              │
                 │  ┌────┐   ┌────────┐          │
                 │  │ ok │   │ failed │          │
                 │  └────┘   └────────┘          │
                 ▼                               ▼
            ┌───────────┐                  (back to prompt)
            │ abandoned │
            └───────────┘

  NO STATE EXCEPT `ok` MUTATES THE DESIGNATION RECORD.
```

### 3.2 Rules

1. **Same machine never prompts.** If `record.machine_id === this machine`, the button is not
   rendered and the IPC refuses the call. Belt and braces: a stale render must not be able to raise a
   prompt for a station this machine already owns.
2. **Verify before write, always.** The write is issued only from `verifying → correct`.
3. **Cancel, Esc, and timeout are identical** — no state change, no record touched. Timeout: **60 s**
   of no input closes the modal (an abandoned prompt on an unattended studio machine should not sit
   open all night waiting for a passer-by).
4. **Failure never half-applies.** The write goes through `stationConfigKvUpsertByKey` — one
   `withMutation` transaction. It lands or it does not.
5. **Read back and verify, then paint.** Same rule as the 4.4.193 fix: re-read the record; if it is
   not this machine, that is a failure with a stated reason, not a success.
6. **Wrong PIN is not rate-limited beyond a delay.** A fixed ~750 ms delay on failure (on top of
   scrypt's own ~100 ms), no lockout. Consistent with "deliberateness gate, not security boundary" —
   and a lockout on the only takeover mechanism (§0.2) would be a new way to strand a station.
7. **Takeover ignores `last_checked` staleness.** A takeover is valid whether or not the current
   holder looks healthy. The operator is the arbiter; the UI informs, it does not gate. This is the
   direct consequence of "takeover is human-only".

### 3.3 What the write does

`nextRecord()` currently preserves `designated_at` only when the record already belongs to this
machine, so a takeover naturally resets it — correct, and no change needed. Phase C adds provenance
fields (§4.2):

```jsonc
{
  "machine_id":       "<this machine>",
  "machine_name":     "BOOTH-1",
  "designated_at":    1755012345,
  "last_checked":     1755012345,
  "last_generated":   null,          // this machine has not generated yet — do NOT inherit
  "designated_via":   "takeover",    // "takeover" | "first-generate" | "claim"
  "designated_from":  "<prev machine_id>",
  "designated_by":    "<account email or account id>"
}
```

`last_generated: null` is deliberate. Inheriting the previous machine's timestamp would make a
machine that has never generated anything look like it just did — the exact conflation §1 of the
governing doc separated `last_checked` from `last_generated` to avoid.

---

## 4. Event schema

### 4.1 Health ledger

Via the existing `_healthEvent(kind, data)` (`main.js:6803`), which appends to
`health-events.jsonl` in `userData` and already stamps `t` as an ISO timestamp. Every event carries
`stationId`, `station`, `machineId`, `machineName`.

| `kind` | When | Extra fields |
|---|---|---|
| `takeover-attempted` | prompt submitted (before verify) | `fromMachineId`, `fromMachineName`, `pinRequired: bool` |
| `takeover-failed` | wrong PIN, timeout, cancel-after-attempt, or write failure | `reason: "wrong-pin" \| "timeout" \| "cancelled" \| "write-failed"`, `error?` |
| `takeover-succeeded` | record read back as this machine | `fromMachineId`, `fromMachineName`, `designatedBy` |

`station-designation-changed` already fires on the holder transition and is **not** duplicated —
Phase C events describe the *attempt*; that one describes the *effect*.

**Deliberate:** no PIN, no hash, no salt, and no attempt count is ever written to the ledger. The
ledger is a support artefact that gets emailed around.

### 4.2 Provenance travels with the record — the part that makes it auditable

The health ledger is **per machine and local**. A takeover performed on BOOTH-1 writes to BOOTH-1's
file; BOOTH-2 — the machine that just lost the designation — has no record of why. For a system whose
whole purpose is arbitrating between machines, an audit trail that only exists on the machine that
acted is not an audit trail.

So the three provenance fields in §3.3 ride **inside the synced `designated_generator` record**.
Every machine on the account can then answer "who took this, when, and from whom" from the record
itself, and the Health Monitor renders it:

> *This machine — taken over from BOOTH-2 on 12 Aug 2026 by jensj@ov.org*

This is the single most valuable auditability change in Phase C, and it costs three JSON fields.

### 4.3 Ledger visibility

`takeover-*` events surface in the Health Monitor's activity view alongside the existing
`station-designation-changed` and `station-designation-write-failed` rows. No new surface.

---

## 5. Migration from the existing per-station PINs

**Nothing is migrated, and `users.pin_hash` is not replaced.** They answer different questions:

| | `users.pin_hash` | account takeover PIN |
|---|---|---|
| Identifies | which operator is at the desk | that the account owner sanctions this |
| Scope | per station, per install | per account, everywhere |
| Gates | user login, jukebox mode, admin actions | designation takeover only |
| Syncs | no | yes |

Copying a shift operator's PIN into an account credential would move per-station credential material
between machines and would let a shift operator authorise an account-owner decision. The governing
doc reached the same conclusion (§3: *"a takeover is an account-owner decision, not a shift
operator's"*).

### 5.1 A live defect found next door — flagged, not bundled

The governing doc lists two defects in `users.pin_hash`. There is a **third**, on the read side:

```js
// electron/main.js:4159 — user:verify-pin
if (!stored.includes(":")) return pin === stored;   // legacy plaintext comparison
```

Both the write-side fallback (`SettingsPanel.tsx:3313`) and this read-side one mean a value that
never went through hashing still verifies. This affects **today's** user login and jukebox gates, not
Phase C.

Recommended as its own slice, **not** folded into Phase C:

1. Remove the write-side plaintext fallback; if the hashing IPC is unavailable, fail the write loudly
   rather than storing a raw PIN in a column named `pin_hash`.
2. Keep the read-side fallback temporarily, but **upgrade on successful verify**: when a legacy
   plaintext value verifies, immediately re-store it as a proper hash.
3. Remove the read-side fallback one release later, once the upgrade has had a chance to run.

Deleting the read-side fallback outright would lock out every operator whose PIN is still stored as
plaintext — a self-inflicted lockout on a login screen, which is exactly the "never dead-end a user"
rule.

---

## 6. Phased build plan

### C0 — Hashing primitive *(smallest, independent, ships alone)*
- `scrypt$…` format, `hashPin`/`verifyPin` v2, `timingSafeEqual`, self-describing params.
- Unit tests: format round-trip, wrong PIN, tampered salt, param upgrade parse, timing-safe compare.
- **No UI, no behaviour change.** Nothing depends on it yet.

### C1 — The account PIN exists and travels
- Backend: `GET/PUT/DELETE /api/account/pin`, plus the verifier inline on `/account/connect`.
- Desktop: cache in `install_config_kv`; refresh on sign-in and on connect.
- Settings → Account: set / change / clear, gated by owner sign-in.
- Health Monitor states whether a PIN is set for the account.
- **Ships without any takeover UI.** At this point the PIN is real, synced, and provably present on
  two machines — which is the thing worth proving before anything depends on it.

### C2 — Takeover *(the feature)*
- Button, prompt, state machine (§3), the three events (§4.1), provenance on the record (§4.2).
- Help entry: `docs/help-designated-generator.md` gains a takeover section.
- Gate: two real machines, one account. Take over in both directions; confirm the record, the events,
  and the provenance line on **both** machines.

### C3 — Nothing
There is no C3. Once Phase B lands, takeover already means what it says.

### 6.4 Why build this before Phase B, if it changes nothing today?

Because Phase B is the release that can take a station off the air by mistake, and the day it ships is
the wrong day to discover the takeover path does not work. C0–C2 landing first means Phase B's gate
arrives with its escape hatch already proven on two machines. That ordering is a recommendation, not
a decision — see §7.4.

---

## 7. Open decisions — for Jeff, before any code

### 7.1 Should claiming an *unclaimed* station need the PIN?
The brief says the button appears when no designation exists and that clicking it opens a PIN prompt.
**Recommendation: no PIN for an unclaimed station** — nothing is being taken from anyone, the
zero-config rule already hands designation to whichever machine generates first with no ceremony at
all, and a PIN prompt on a claim is stricter than the automatic path it sits next to. Labelled
**CLAIM** rather than TAKE OVER. Specified behaviour (PIN in both cases) is what gets built if you
prefer it.

### 7.2 Where does "Set account PIN" live in Settings?
There is no Settings → **Account** section today; the natural neighbours are Subscription and the
station-scoped Preferences. Creating one is a small door-building exercise, but it is a new door and
therefore your call.

### 7.3 Is the backend acceptable as the authority?
The alternative is `install_config_kv` + peer sync only, which keeps Phase C entirely inside this
repo but inherits the peer-sync station-identity defect and does not work on a fresh machine that has
never synced. The recommendation is the backend, which means work in `ether-backend` — a second repo
and a deploy.

### 7.4 Phase B before, or after?
§6.4 argues Phase C first. The counter-argument is that Phase B is the feature with actual value and
Phase C is currently ceremony. Either order is defensible; the one thing that should not happen is
Phase B shipping with no working takeover path, because §0.2 means there is then no way back.

### 7.5 Does the dashboard need the reset too?
§1.6 argues yes — reset that works when the desktop app cannot start is worth more than reset inside
it. That is `ether-dashboard` work, a third repo.

---

## Architecture compliance

- `docs/single-writer-election-design-2026-08-11.md` §3 explicitly defers the PIN to Phase C and
  specifies "an ACCOUNT-level PIN, synced, distinct from the per-station operator PINs". This design
  implements that and does not depart from it.
- §0 of the same doc — takeover is human-only, never automatic. Nothing here introduces automatic
  transfer; §3.2 rule 7 makes the operator the sole arbiter.
- §1 — the designation record stays the synced `station_config_kv` key `designated_generator`. Phase C
  adds fields to its JSON value; it does not add a table, a key, or a channel.
- CLAUDE.md, "the account is the root of everything" — the PIN hangs off the account, follows it to
  any machine, and is resettable through account sign-in.
- Offline-first — verification is local and never requires the network.
- Doors before rooms — the takeover control lives on the row it belongs to, and ships with its help
  entry (C2).
- Build the sense, not the scaffold — every attempt is observable in v1 via the ledger, and
  provenance is visible on every machine via the record itself. No diagnostic scaffolding is proposed
  and nothing needs tearing down.

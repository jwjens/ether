# Jukebox paywall — design

**Status:** Phase 1 BUILT 2026-09-11 (openair `84e04dd`, ether-backend `f53c447`, ether-listener
`3a2d95f`), plus the webhook narrowing (ether-backend `720e2ab`). Nothing pushed, nothing deployed.
Phases 2 and 3 remain proposals.
**Jeff, 2026-09-11:** *"The money going to the right place matters more than shipping fast."*
**Investigation this rests on:** `docs/jukebox-paywall-investigation-2026-09-11.md`.
**Governing:** the v38 migration header (the reserved `'awaiting'` status and `donation_cents` /
`payment_status` columns), `Jukebox.tsx:50-61` (the payment provider seam).

---

## 0a. THREE MODES, ALL REAL, ALL SHIPPING

**Jeff, 2026-09-11 (correcting an earlier answer of his own):**

> donations_mode is three real values, and all three ship.
> • **off** — no donation ask at all
> • **suggested** — the song plays either way. We ask, the guest can skip, nobody is turned away.
>   **This is what OV runs.**
> • **required** — payment gates the request. Another operator may want this.
>
> So "required" isn't a fallback state, it's a mode an operator chooses. The free-when-Stripe-isn't-
> ready answer applies to the required mode only.

This supersedes §6.1 and §6.5 as originally written, and it makes the design **smaller**, not bigger.
Almost everything I described as "the paywall" turns out to belong to ONE of the three modes.

### What is shared by suggested and required

| shared | why it does not vary by mode |
|---|---|
| Stripe **Connect onboarding**, `station_payouts`, account links, `charges_enabled` | you cannot take money at all without a connected account |
| **Direct charges** on the station's account (§0) | who the money belongs to is not a UX choice |
| The **phase-1 guards** — one at a time, dedupe, repeat window | fairness in the room; nothing to do with money |
| **`/webhook/stripe/jukebox`**, its secret, `account.updated`, idempotency | one endpoint, both modes |
| **Open amount, $1 minimum** | Jeff's §6.3 answer |
| **`donations.ready`** in the pool response | both modes must know whether the account can charge |
| **Entry only, never priority** | Jeff's §6.4 answer, and it holds in both |

### What belongs to `required` alone — and Jeff's expectation is correct on all three

**1. The reservation lock — REQUIRED ONLY.** Under `required` the request does not exist until it is
paid, so something has to hold the "one at a time" slot across the checkout, or a guest opens ten
tabs and buys ten songs. Under `suggested` the request is already real the moment it is admitted —
**the request row IS the lock.** There is no second concept, no `jukebox_web_requests` reservation
table, and no `status='awaiting'`. The v38 header reserved `awaiting` for "a payment gate is holding
it"; that is a `required` word and under `suggested` a row never enters it.

**2. The refund case — REQUIRED ONLY, and the reason is not technical.** Under `required` the payment
BUYS the request: if the request is then refused or never delivered, the guest paid for something
they did not get, and that is a refund somebody has to notice and perform. Under `suggested` the
payment is a **gift** — it buys nothing, so nothing can fail to be delivered. A refused request after
a donation is disappointing; it is not a debt.

**3. The offline-desktop case — REQUIRED ONLY.** "Money taken, request undeliverable" is only a state
that can exist when money and request are coupled. Under `suggested` an offline desktop is exactly
what it is today: the command queues, the page says *watch the screen*, and the donation is already
the nonprofit's. No paid-but-undelivered list, no reconciliation surface.

**4. Abandoned-checkout expiry — REQUIRED ONLY.** `checkout.session.expired` exists to release the
lock. No lock, nothing to release; an abandoned donation is simply no donation.

**5. The not-ready fallback — REQUIRED ONLY, per Jeff.** `required` + onboarding unfinished → requests
go through **free**. Under `suggested`, "not ready" is not a fallback at all: the ask is not shown and
the page behaves exactly like `off`. Under both, the Jukebox window must say loudly that donations
are configured and not being collected — the defect to avoid is silence, not the free behaviour.

### The ordering inverts between the two modes

```
required    guard → RESERVE → pay → deliver        money before the song
suggested   guard → deliver → (watch it land) → ask → pay      money after the song
```

**Under `suggested`, the ask must come AFTER the request is admitted — never before.** If the page
asked first, a guest could donate and then have the desktop refuse the request (queue full, played
recently), which manufactures precisely the refund case `suggested` does not otherwise have. Asking
afterwards also makes "nobody is turned away" visibly true rather than merely stated.

Best shape: the page already polls `/public/jukebox/:slug/state` and tells the guest to watch the
screen. Put the ask on that confirmation view, ideally once their name has actually appeared in the
queue. The donation then follows a confirmed outcome and reads as thanks rather than as a toll.

### A consequence worth raising before any of it is built — I am not a lawyer

Under `suggested` the money is a **gift**: given freely, buying nothing. Under `required` it is
**consideration for a service** — the guest pays, the song plays. For a 501(c)(3) those are not the
same transaction. A required payment is generally not a deductible charitable gift and may raise
questions the nonprofit's finance people will care about; the receipt wording differs; the accounting
differs.

**OV running `suggested` is therefore not only a kindness to the room — it is the mode that keeps the
gift a gift.** Worth confirming with whoever handles OV's finances before the first live donation,
and worth making the two modes' on-screen wording genuinely different: "Support Opportunity Village"
is not "Pay to play", and they should not look alike.

### Sequencing, revised

`suggested` needs: Connect onboarding, a donate button, a webhook that records a payment. It needs
**no** reservation table, no expiry, no refund list, no paid-but-undelivered state, no `awaiting`.
`required` needs all of those.

**So the mode OV actually runs is the cheap one.** Ship `off` + `suggested` first and `required`
after, rather than building the whole coupled machine to serve a station that never uses it:

- **Phase 2** — Connect onboarding, no charging. Unchanged by this correction.
- **Phase 3a** — `suggested`. The donate ask, the webhook, `donation_cents` written at last.
- **Phase 3b** — `required`. The reservation, expiry, refunds, the offline-paid list.

`donations_mode` carries all three values from the first migration regardless, so 3b is a UI and
logic change rather than a migration against a table holding live donation history.

---

## 0. The decision that everything else hangs off: DIRECT charges

Stripe Connect offers three charge shapes. Only one of them puts the money where Jeff says it has to go.

| shape | merchant of record | receipt says | fees come from |
|---|---|---|---|
| **Direct charge** on the connected account | **the station** | the station's name | the station's balance |
| Destination charge | **the platform (Jeff)** | Ether Technologies | the platform, then transferred |
| Separate charges + transfers | the platform | Ether Technologies | the platform |

**A nonprofit's donation must be a direct charge on the nonprofit's own account.** With a destination
charge, Opportunity Village's donor receives a receipt from Ether Technologies for a gift to Ether
Technologies, and the money lands in Jeff's balance before being transferred out. That is wrong
legally, wrong for the donor's tax position, and wrong for OV's books — regardless of the fact that
the cash eventually arrives.

Direct charges mean the API call carries a `Stripe-Account` header naming the connected account, the
charge never touches the platform balance, and **every webhook event for it arrives with
`event.account` set** — which is precisely why the platform endpoint had to be narrowed first, and
why the jukebox needs its own endpoint (§4).

**Account type: Standard, not Express.** A Standard account belongs to the station: their own Stripe
login, their own dashboard, their own dispute handling, their own tax reporting. Express is easier to
onboard but leaves the platform carrying obligations that should sit with the nonprofit. For a
501(c)(3) taking public donations, Standard is the honest fit and the lower liability for Jeff.

---

## 1. The web request path gets the kiosk's guards

Today the web path has **none** of them: no cap, no dedupe, no cooldown. And `repeatMinutes` is dead
on both paths — read from config at `Jukebox.tsx:411` and never compared against anything.

**The rule, per Jeff: one song at a time.** Concretely, three guards:

| guard | rule |
|---|---|
| **one at a time** | a requester with a request in `pending`/`awaiting`/`queued` cannot make another |
| **dedupe** | a song already `queued` for this station cannot be requested again |
| **repeat window** | a song played within `jukebox_repeat_minutes` cannot be requested again |

### Where they are enforced — and why not only on the desktop

The desktop holds the truth (`jukebox_requests`), but the command bus is **one-way**: `emitCommand`
returns `{delivered, queued}`, not a verdict. The phone can never learn that the desktop refused it.
Today that is merely unhelpful. **With money it is unacceptable** — a refusal after payment is a
refund, and a refund the operator has to notice and perform by hand.

So the guards move to where the phone can be answered synchronously, which is Postgres:

- **Backend is the gatekeeper.** Guards evaluate against a new Postgres table before any Stripe
  session is created. The phone gets a real answer, immediately, with no money taken.
- **Desktop stays the authority.** It re-checks on arrival. Anything that slips through a race is
  written `status='cancelled'` with a reason rather than silently dropped, so the wall tells the truth
  and the row records what happened — which is also the refund trail.
- **The repeat window needs play history**, which only the desktop has. The install already publishes
  live state to `jukebox_pool.state` every few seconds (`Jukebox.tsx:728`); extend that payload with
  recently-played song uuids and their timestamps. The backend then answers the cooldown question
  from a snapshot that is seconds old, and the desktop's re-check catches the edge.

### Ordering — the part that matters

**Guard, reserve, pay, deliver.** Never pay-then-guard.

```
phone picks a song
  → POST /public/jukebox/:slug/request   (guards run HERE, no money yet)
  → row created status='awaiting', payment_status='pending'   ← the reservation IS the "one at a time" lock
  → Stripe Checkout session created on the STATION's connected account
  → phone redirected to Stripe
  → payment succeeds → webhook → status='paid'
  → emitCommand to the desktop → desktop inserts into jukebox_requests as 'queued'
  → desktop confirms → row marked 'delivered'
```

The reservation is what makes "one at a time" enforceable: it exists before the payment, so a second
request is refused while the first is unpaid. An abandoned checkout must expire the reservation —
a TTL (say 10 minutes, surfaced not hardcoded) plus `checkout.session.expired` releasing it early.

**If the desktop is offline when payment succeeds:** the money is already taken. The row stays
`paid, undelivered`, `emitCommand` queues it (that already works), and the phone's confirmation page
must say *"paid — it will reach the booth when the station is back online"* rather than implying it is
on the wall. If it never delivers, that row is the refund list. This state must be visible in the
Jukebox window, not only in Postgres.

---

## 2. Identifying a requester

There is nothing today — a typed name, capped at 40. Two people called "Dave" are indistinguishable,
and so are one person and twenty of them.

**Proposal: a random token in `localStorage`, per slug.** `crypto.randomUUID()` minted on first visit,
stored as `ether_jb_<slug>`, sent with every request. Survives a refresh, a tab close, and a browser
restart, which is what Jeff asked for. Roughly ten lines in `JukeboxRequest.tsx`.

**Be clear about what it is not.** It is defeated by clearing site data, a private window, or a second
phone. It is not an identity system and must never be described as one. It is there to stop the
accidental twenty — the double-tap, the impatient re-send, the friend passing the phone around.

**The paywall is the real limiter.** Twenty requests costs twenty donations. That is the point: the
guards make abuse orderly, the price makes it self-limiting.

**Two further signals, for free, and worth using:**

- **The payer's email**, from the completed Stripe session. A real identity, verified by the act of
  paying, and the right key for the repeat window ("you already asked for this one tonight"). It
  arrives too late to gate the reservation, but it is the honest key for history.
- **IP, for rate limiting only** — `express-rate-limit` on `/public/jukebox/*`, which today is
  ungated while `/api/user/*` is limited to 40 per 15 minutes. **A venue caveat that must not be
  missed: everyone on OV's guest wifi shares one NAT address.** An IP cap tight enough to stop one
  abuser will silence the whole room. Key it on `slug + IP` with a generous ceiling — something like
  60/15min — and treat it as protection against a script, never as a per-person rule.

---

## 3. Stripe Connect — onboarding and refusal

### Where the account id lives

**Not on `jukebox_pool`.** That table is a publish target the install overwrites, and
`/api/account/jukebox/pool` already `DELETE`s sibling rows on republish. Money configuration must not
live somewhere a routine publish can erase.

New table, one row per station:

```sql
CREATE TABLE station_payouts (
  station_uuid      TEXT PRIMARY KEY,
  license_key_id    INTEGER NOT NULL,
  stripe_account_id TEXT,               -- acct_...
  charges_enabled   BOOLEAN NOT NULL DEFAULT false,
  payouts_enabled   BOOLEAN NOT NULL DEFAULT false,
  details_submitted BOOLEAN NOT NULL DEFAULT false,
  requirements_due  JSONB,              -- what Stripe is still waiting for, verbatim
  country           TEXT,
  currency          TEXT,
  connected_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Keyed by `station_uuid` because **each station connects its own account** — one license can hold four
stations and they may be different legal entities. `license_key_id` is carried for scoping and
auditing, not identity.

The three booleans come from `stripe.accounts.retrieve` and are refreshed by the `account.updated`
event (§4). They are **stored, never inferred**: a cached "connected" flag that stops tracking
Stripe's view is how a station takes money it cannot receive.

### The donation settings, per station

Alongside, or on the same row: `donations_mode` (`off` | `optional` | `required`), the amount options
(say 1/2/5 dollars plus "other"), and the currency. These are the operator's numbers and belong on
screen as settings, not as constants in code.

### The onboarding surface

In the Jukebox window's settings, beside the existing request-slug and cap fields — not buried in
Preferences. It is a jukebox feature and it belongs with the jukebox. Four states, each saying exactly
one thing:

1. **Not connected.** *"Donations are off. Connect a Stripe account to accept them — money goes
   straight to your organisation, not to Ether."* Button: **Connect a Stripe account**. Opens a
   Stripe-hosted Account Link in the system browser (never an embedded webview — a payment provider's
   login must be in a real browser with a real address bar).
2. **Started, incomplete.** *"Stripe still needs: business details, bank account."* — listing
   `requirements_due` verbatim, with a **Continue setting up** button that mints a fresh Account Link.
   Never paraphrase Stripe's requirement list; it changes and it is legally specific.
3. **Ready.** *"Connected — donations go to \<account name\>. Charges enabled."* plus the donation
   mode and amounts.
4. **Connected but charges disabled.** Stripe can disable a live account. *"Stripe has paused charges
   on this account"*, with the reason and a link to their dashboard.

Refreshed by polling `GET /api/account/jukebox/payouts` when the window opens, and by the
`account.updated` webhook in the background.

### How the request page refuses

Two layers, because the page cannot be trusted:

**The pool response carries it.** `GET /public/jukebox/:slug/pool` gains:

```json
"donations": { "mode": "required", "ready": false, "reason": "onboarding_incomplete",
               "amounts_cents": [100,200,500], "currency": "usd" }
```

The page renders the pay step only on `ready: true`. Not ready, and it never draws a pay button —
there is nothing to click and nothing to half-complete.

**The endpoint refuses independently.** `/public/jukebox/:slug/request` re-reads `station_payouts` and
returns `donations_unavailable` if the mode requires payment and the account is not ready. A page from
a stale cache, or a crafted POST, gets the same answer.

**What "not ready" does to requests is Jeff's call**, and the two options differ in a way worth
stating:

- **`mode: required` + not ready → requests CLOSED**, with *"Requests are paused right now."*
  Honest, but a half-finished Stripe onboarding silences the jukebox.
- **`mode: required` + not ready → fall back to FREE.** The jukebox keeps working, but the operator
  who asked for donations silently stops receiving them.

**Recommendation: closed, and loud in the Jukebox window.** A jukebox quietly taking free requests
when the operator configured donations is the same class of defect as a switch that says off while the
timer runs — the screen claiming one thing while the system does another. Better to stop and say so.

---

## 4. `/webhook/stripe/jukebox`

Its own endpoint, its own `STRIPE_JUKEBOX_WEBHOOK_SECRET`, its own `express.raw` mount beside the
existing one at `index.js:242`.

**Why not the existing endpoint.** Its second branch catches bare `checkout.session.completed`, reads
a customer email, and issues a licence key. Every jukebox donation is a `checkout.session.completed`.
Today it fails safe on the priceId lookup — by luck, because a session has no `lines` array — and it
logs `UNKNOWN priceId … Operator must issue manually`, which is the one alarm that means a real
customer did not get their key. Routing donations through it trains Jeff to ignore that alarm.

**The inverse guard.** The platform endpoint now returns early when `event.account` is set
(`720e2ab`). This endpoint does the opposite: it **requires** `event.account`, because with direct
charges every jukebox event originates on the station's connected account. An event without one is
either a misconfiguration or someone pointing the wrong webhook here.

**Events:**

| event | action |
|---|---|
| `checkout.session.completed` | reservation → `paid`; `emitCommand` to the desktop |
| `checkout.session.expired` | release the reservation — the "one at a time" lock must not outlive an abandoned checkout |
| `charge.refunded` | mark refunded; cancel the request if it has not aired |
| `account.updated` | refresh `charges_enabled` / `payouts_enabled` / `details_submitted` / `requirements_due` |

**Idempotency is not optional.** Stripe retries on any non-2xx and can deliver twice on a 2xx.
`stripe_session_id` gets a UNIQUE constraint and the paid transition is `UPDATE … WHERE status =
'awaiting'` so a replay changes nothing. Without it a retry queues the song twice for one payment.

**Signature failure stays a 400.** Everything else acknowledges, so Stripe does not retry for days
over a state we have deliberately handled.

---

## 5. Sequence, and what I would not build yet

1. **Guards and identity, no money** — §1 and §2 against the free flow. Shippable on its own, fixes
   the twenty-requests hole today, and proves the reservation lifecycle before a card is involved.
2. **Connect onboarding, no charging** — §3. A station can connect and the settings surface tells the
   truth about its state. Still free.
3. **Charging** — §4 plus the pay step. Only after 1 and 2 are real on OV.

**Not proposed, deliberately:** platform application fees. Taking a cut of a nonprofit's donations is
a business decision, not an engineering one, and the code should not quietly assume one either way.
`application_fee_amount` is omitted; adding it later is one field.

**Also not proposed:** storing card data, storing the payer's email beyond the request row, or any
donor record that would make Ether a custodian of donor data the nonprofit is responsible for. The
station's own Stripe dashboard is the donor record. That is a feature of direct charges, not a gap.

## 6. Answered by Jeff, 2026-09-11 — these are decisions now, not options

1. **Not ready → FREE, not closed.** A station whose Stripe onboarding is incomplete keeps taking
   requests, for nothing. My recommendation was the opposite and Jeff overrode it; the concern that
   drove the recommendation is met a different way: **the Jukebox window must say loudly that
   donations are configured and not being collected.** The defect I was guarding against was silence,
   not the free fallback — a screen that claims one thing while the system does another. An operator
   who is told is not deceived.
2. **No application fee. Nothing through Jeff's balance.** Direct charges on the connected account,
   as in §0. `application_fee_amount` is not set, and the code must not assume one later without a
   decision.
3. **Open amount, $1 minimum. A donate button, not fixed tiers.** So the amounts array in §3 becomes
   a minimum plus a free-entry field. Worth stating on the page what a small donation actually
   delivers: Stripe's per-charge fee makes $1 roughly 60¢ to the nonprofit.
4. **Entry only. No jumping the queue.** Paying buys a place in line, never a better one. The queue
   stays first-in-first-out and no code should carry a priority field "for later" — a field that
   exists is a field someone will wire up.
5. **`donations_mode` is a THREE-value column from day one** — `off` | `suggested` | `required` —
   **and all three ship.** My earlier framing of the third value as "optional, no UI yet" was wrong
   and Jeff corrected it: see §0a, which supersedes this. `suggested` is the mode OV runs and it is
   the SMALLER of the two paid modes, not a later extra.

   Jeff's reasoning was that "required + not ready → free" already covers the optional case. It
   covers half of it. That fallback is INVOLUNTARY free: the operator wants money and the system
   cannot take it. `optional` is DELIBERATE free: Stripe works perfectly and the operator still
   offers a donate button the guest may skip — which for a nonprofit is the standard posture, a
   suggested donation where someone who cannot pay still gets their song. The fallback cannot express
   that, because it only exists when onboarding is broken.

   So the column carries three values from the start and the UI offers two. Adding the third later
   is then a UI change rather than a migration against a table holding live donation history.

1. **Closed or free** when donations are required and Stripe is not ready (§3). I recommend closed.
2. **Application fee** — none proposed. Confirm.
3. **Amounts** — fixed options, free entry, or both? And a minimum, given Stripe's per-charge fee makes
   a $1 donation roughly 60¢ to the nonprofit.
4. **Does a donation buy priority**, or only entry? Today the queue is first-in-first-out. "Pay more
   to jump" is a different product with different fairness properties, and I have assumed **entry
   only**.
5. **Optional mode** — is "donate if you like, request either way" worth building, or is it only ever
   off/required?

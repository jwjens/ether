# Ether Onboarding — Spec v1

Status: DESIGN LOCKED. Ready for implementation.
Supersedes the onboarding sections of docs/onboarding-and-library-distribution-v0.md.
Relationship to roadmap: this is the customer-facing onboarding work that gates
Roadmap Item 2's real second-client deploy.

---

## What this spec covers

The customer's first-launch experience: from running the installer for the
first time on any machine, to having a working Ether station they can operate.
Covers both "this is my first install ever" and "I'm adding another machine
to an account I already have."

Does NOT cover: Stripe checkout flow, license key generation/issuance,
multi-operator (multiple people on one station), audio file distribution
(that's Milestone B — separate spec).

---

## Core concepts (lock these in before reading further)

**License key** — a string the customer receives when they pay (e.g.
`ETHER-PRO-XXXX-XXXX`). Unique per customer. Never changes. The license key
is the customer's *identity* with Railway. Used to:
- Prove the customer paid
- Group all of that customer's stations and seats together
- Key all backend storage (Railway records, R2 buckets)

**Account name** — a human-readable label for the customer ("WXYZ Broadcasting,"
"Joe's Radio"). Optional. Display-only. Can be renamed any time without breaking
anything because nothing on the backend is keyed by name.

**Station** — a single broadcast unit within an account. Has a name, optionally
a frequency and call letters. An account can have one or many stations
(multi-station is a Pro+ feature; tier gating is existing behavior, not new
work for this spec).

**Seat** — one installed copy of Ether on one machine, registered under a
license. Each license has a maximum of **5 seats**. A customer who exceeds
this hits a clear error and must deauthorize an existing seat before adding
a new one.

**One PC = one station** for v1. The "two operators sharing one station"
case is not in this spec. Adding it later does not require changes to v1's
data model.

---

## The flow

### Screen 1 — Welcome / choose path

Replaces today's behavior of dropping straight into FirstRunWizard.
Same visual design language as the existing wizard.

```
┌──────────────────────────────────────────────────────────┐
│                    Welcome to Ether                      │
│                                                          │
│  Are you setting up Ether for the first time, or         │
│  adding this computer to an existing account?            │
│                                                          │
│         [   Create new account   ]                       │
│         [  Connect to existing account  ]               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Screen 2a — Create new account

Shown if user picks "Create new account" on Screen 1.

```
┌──────────────────────────────────────────────────────────┐
│              Create your Ether account                   │
│                                                          │
│  License key:        [_______________________]           │
│                                                          │
│  Account name:       [_______________________]  optional │
│   (a label for your company or organization;             │
│    you can change this later)                            │
│                                                          │
│  Name your first station:                                │
│   Station name:      [_______________________]  required │
│   Nickname:          [_______________________]  optional │
│   Frequency:         [_______________________]  optional │
│   Call letters:      [_______________________]  optional │
│                                                          │
│                                  [  Create account  ]    │
└──────────────────────────────────────────────────────────┘
```

What happens on submit:

1. Client POSTs license_key to Railway. Railway validates the license.
   - If invalid → error message, stay on this screen.
   - If valid but already has an account associated → error: "This
     license already has an account. Choose 'Connect to existing
     account' on the welcome screen instead." Go back to Screen 1.
   - If valid and new → continue.
2. Client POSTs account creation: { license_key, account_name,
   station: { name, nickname, frequency, call_letters } }.
3. Railway records: license has 1 account, 1 station, 1 seat used
   (this machine).
4. Client writes license_key, account_name, plan_tier to
   station_config_kv. Sets first_run_complete = "1". Generates the
   local station record (uses the existing stations:create handler).
5. Ether opens to its normal main UI. Empty library.

### Screen 2b — Connect to existing account

Shown if user picks "Connect to existing account" on Screen 1.

```
┌──────────────────────────────────────────────────────────┐
│         Connect to your Ether account                    │
│                                                          │
│  License key:        [_______________________]           │
│                                                          │
│                                  [    Continue    ]      │
└──────────────────────────────────────────────────────────┘
```

What happens on submit:

1. Client POSTs license_key to Railway with a "list stations"
   request.
2. Railway validates:
   - License invalid → error, stay on this screen.
   - License valid but seat limit reached → error: "This license is
     using all 5 seats. To add this computer, deauthorize a seat in
     the Manage Devices panel on another machine."
   - License valid and seats available → returns the account name
     and the list of stations.
3. Client shows Screen 3 (station picker).

### Screen 3 — Pick or add a station

Shown after a successful "Connect to existing account" license check.

```
┌──────────────────────────────────────────────────────────┐
│              Welcome back, WXYZ Broadcasting             │
│                                                          │
│  Which station is this computer for?                     │
│                                                          │
│   ◯  98.5 The Wave                                       │
│   ◯  101.3 The Edge                                      │
│                                                          │
│   ◯  Add a new station                                   │
│                                                          │
│                                  [    Continue    ]      │
└──────────────────────────────────────────────────────────┘
```

If the customer picks an existing station:
- Client tells Railway: "this seat is now bound to station X."
- Client begins pulling the mutation history for that station.
- Show Screen 4 (pulling).

If the customer picks "Add a new station":
- Show Screen 3b (new station details):

```
┌──────────────────────────────────────────────────────────┐
│              Name your new station                       │
│                                                          │
│   Station name:      [_______________________]  required │
│   Nickname:          [_______________________]  optional │
│   Frequency:         [_______________________]  optional │
│   Call letters:      [_______________________]  optional │
│                                                          │
│                                  [   Create station   ]  │
└──────────────────────────────────────────────────────────┘
```

On submit:
- Client tells Railway: "create new station under this license, this
  seat is bound to it." Railway records the new station.
- The cluster-wide library data still pulls (categories, songs,
  artists — install-scoped mutations). Station-scoped data is empty
  for this new station; the customer builds clocks and programming
  fresh.
- Show Screen 4 (pulling).

Edge case: customer connects with a valid license but Railway returns
zero stations (someone created an account on PC #1 but never created a
station, or something went wrong). Screen 3 shows only "Add a new
station." Works.

### Screen 4 — Pulling library

Shown after the customer picks/creates a station. Library pull is
the metadata sync defined by Roadmap Item 2.

```
┌──────────────────────────────────────────────────────────┐
│           Connecting to 101.3 The Edge…                  │
│                                                          │
│   ✓ License verified                                     │
│   ✓ Account joined                                       │
│   ⏳ Downloading library… 1,247 / 5,890 entries          │
│                                                          │
│   Audio files will download in the background after      │
│   setup completes. Your library will appear immediately; │
│   songs become playable as their files arrive.           │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

When the pull finishes, Ether transitions to its normal main UI.

The audio file mention is honest disclosure of Milestone A vs B —
metadata syncs in this step, R2 audio distribution happens after.
This text can be removed once Milestone B is built and audio is
included in this screen's progress.

---

## State and resumption

The customer can close Ether mid-onboarding and come back to it.
The flow needs to remember where they were. New flags in
station_config_kv:

| Flag | Set when |
|---|---|
| `onboarding_path` | `/account/create` or `/account/connect` succeeded — value is `'create'` or `'connect'` |
| `onboarding_license_entered` | Screen 2a or 2b license validated |
| `onboarding_account_joined` | Screen 2a submitted OR Screen 3 station picked/created |
| `onboarding_library_pulled` | Screen 4 finishes |
| `onboarding_library_source` | Screen 3.5 button chosen (`skip` / `computer` / `cloud`) — written before the action fires so resumption knows the operator's intent if the app crashes mid-action |
| `first_run_complete` (existing) | All three above are set |

> **Resumption gap (B.3, 2026-05-22):** routing logic for the new `pickAudioLocation` state and `onboarding_library_source` key is deferred — a mid-state crash currently lands back at `pulling` per the existing resume rules. Follow-up commit needed if operators hit this edge.

On launch, if `first_run_complete !== "1"`, Ether routes to the
appropriate screen based on which flags are set. A customer who
closed Ether during library pull comes back to Screen 4 and the
pull resumes from the last `since_seq`.

**Why `onboarding_path`:** without it, a session that set
`onboarding_license_entered` but not `onboarding_account_joined` is
ambiguous on resume — the user could have been mid-2a (Create path,
unusual since `/account/create` writes both flags atomically) or
mid-pickStation (Connect path, the normal case). The path flag
disambiguates: with `onboarding_path = 'connect'` the resume re-fetches
the stations list via `/account/connect` and lands the user back on
Screen 3.

---

## Seat management (Manage Devices panel)

Not part of first-launch onboarding, but needs to exist for the
"seat limit reached" error to have an answer. New Preferences panel:
**Manage Devices**.

Shows: list of registered seats for this license. Each row: machine
name (hostname), station bound to (if any), date registered, "this
device" indicator on the current one.

Each non-current row has a "Deauthorize" button. Deauthorizing tells
Railway to release that seat. The deauthorized machine still has
Ether installed locally but, on next sync attempt, gets an
"unauthorized" response and either prompts to re-enter a license
or shows a read-only locked state. (Behavior on the deauthorized
machine is its own small decision; default to "show locked state
with a prompt to re-enter the license.")

---

## Station management (Manage Stations panel)

Also not part of first-launch onboarding. Existing surface — the
customer needs a place to rename a station, change its nickname /
frequency / call letters. If this panel doesn't exist yet in the
renderer, building it is in scope for this spec because the
onboarding flow promises "you can change this later."

If it does exist, just verify it covers the four station fields and
that rename writes a mutation that syncs to all seats under the
license.

---

## Backend work required (Railway)

These endpoints and schema changes do not exist today, per the investigation
report. Build them as part of this milestone.

### Schema (flatter than the original three-table sketch)

The original sketch had separate `accounts`, `stations`, and `seats` tables.
That collapsed during design: an account never carried information that wasn't
1:1 with a license, and a seat never carried information that wasn't 1:1 with
a `license_activations` row. The final schema:

**licenses** (existing — extended)
- `account_name TEXT` — display label (the "account name" field, optional, renamable)
- `onboarded_at TIMESTAMPTZ` — set when `/account/create` completes; "has this license onboarded?" check

**stations** (new)
- `id SERIAL PRIMARY KEY`
- `uuid TEXT UNIQUE NOT NULL` — matches the local station record's uuid
- `license_key_id INTEGER NOT NULL REFERENCES licenses(id)` — tenant link (matches the FK style used by the `mutations` table)
- `name TEXT NOT NULL`, `nickname`, `frequency`, `call_letters`
- `created_at`, `updated_at`
- Index: `idx_stations_license` on `license_key_id`

**license_activations** (existing — extended; doubles as the seat registry)
- `station_uuid TEXT REFERENCES stations(uuid) ON DELETE SET NULL` — which station this seat is bound to (NULL until the customer picks/creates one)
- `deauthorized_at TIMESTAMPTZ` — soft-delete marker; NULL means active. Counted by the seat-limit check in `/account/connect`.
- Index: `idx_activations_station` on `station_uuid`
- Index: `idx_activations_active` partial on `license_key WHERE deauthorized_at IS NULL` (seat-count query)
- `machine_id` continues to play the role of the per-device id ("client_id" in the original sketch); no separate column is added.

### New endpoints

**POST `/account/create`**
Body: `{ license_key, account_name, station: { name, nickname, frequency, call_letters }, machine_id, machine_name }`
- Validates license.
- Errors with `account_already_exists` if `licenses.onboarded_at IS NOT NULL`.
- In one transaction: sets `licenses.account_name` and `licenses.onboarded_at = NOW()`, inserts a `stations` row, and upserts the `license_activations` row for this `machine_id` (binding it to the new station via `station_uuid`, `deauthorized_at = NULL`).
- Returns: `{ account_name, station_uuid }`.

**POST `/account/connect`**
Body: `{ license_key, machine_id, machine_name }`
- Validates license.
- Counts active seats (rows in `license_activations` for this license where `deauthorized_at IS NULL`).
- If >= 5 active seats AND this `machine_id` is not already among them, returns `{ error: 'seat_limit_reached', seats: [list for Manage Devices] }`.
- Otherwise returns: `{ account_name, stations: [...], seats_used, seats_max: 5 }`. Reads `account_name` from `licenses` and `stations` filtered by this license.

**POST `/account/bind-seat`**
Body: `{ license_key, machine_id, machine_name, station_uuid }`
- Called after the customer picks a station on Screen 3.
- Upserts the `license_activations` row for this `machine_id`; sets `station_uuid` and clears `deauthorized_at`.
- Returns: `{ ok: true }`.

**POST `/account/add-station`**
Body: `{ license_key, machine_id, machine_name, station: { name, nickname, frequency, call_letters } }`
- Called after the customer fills Screen 3b for a new station.
- Inserts the `stations` row.
- Upserts the `license_activations` row and binds `station_uuid` to the new station.
- Returns: `{ station_uuid }`.

**POST `/account/deauthorize-seat`**
Body: `{ license_key, machine_id }`
- Called from the Manage Devices panel.
- Sets `deauthorized_at = NOW()` on the matching `license_activations` row (soft delete; the row is preserved for audit).
- Returns: `{ ok: true }`.

**GET `/account/seats`**
Auth: `x-license-key` header (not a query param, so the key doesn't land
in access logs, proxy logs, or browser history; matches `/api/cmd`).
- Returns active seats (`deauthorized_at IS NULL`) for the Manage Devices panel.
- Response: `{ seats: [...], seats_used, seats_max }`.

### Existing endpoints touched

**`/validate`** — minor query update. Seat-count and existing-machine
lookups now filter `deauthorized_at IS NULL` so deauthorized rows don't
inflate the count or block reactivation on the same machine. Activation
INSERT becomes an UPSERT (clears `deauthorized_at`) to reactivate a
previously-deauthorized seat cleanly given the UNIQUE(license_key,
machine_id) constraint. The new `/account/*` endpoints reuse the same
license-validation helper (`lookupLicense`) internally.

**`/licenses/:key/deactivate`** — switched from hard `DELETE` to soft
delete (`UPDATE … SET deauthorized_at = NOW()`). The row is preserved
for audit; the seat-limit count ignores it.

**`/licenses/:key/activations`** — list now filters
`deauthorized_at IS NULL` so the Manage Devices panel only shows active
seats.

---

## Frontend work required

### New component: `OnboardingFlow.tsx`

Replaces or wraps `FirstRunWizard`. Renders the four screens above
based on the onboarding flags in station_config_kv. State machine:

```
not started → Screen 1
license entered (create path) → Screen 2a
license entered (connect path) → Screen 2b → Screen 3 → [Screen 3b]
account joined → Screen 4
library pulled → exit onboarding, set first_run_complete, open main UI
```

### Routing change

In App.tsx, the first-launch check (today: `first_run_complete !== "1"`
shows FirstRunWizard) routes to `OnboardingFlow` instead.

### Reuse existing handlers

The `stations:create` handler already exists locally. The onboarding
flow calls it for both "create first station" (Screen 2a) and
"add new station" (Screen 3b), just with the additional step of
calling `/account/add-station` so Railway knows about it.

### New panels (Preferences)

- **Manage Devices** — lists seats, deauthorize button per row.
- **Manage Stations** — verify or build; lists stations for this
  account, edit name/nickname/frequency/call letters, rename, etc.

---

## What this build does NOT do

- Stripe checkout flow. The license key gets to the customer
  somehow (Stripe email, manual issue, etc.) — that's separate.
- Audio file distribution. Library is metadata-only after this
  flow runs. Songs visible, not playable. Milestone B handles audio.
- Multi-operator on one station. v1 is one PC = one station.
- Auto-deauthorize on seat 6. The customer gets an error and must
  manually deauthorize from another machine.
- Cluster *renaming* via the backend. Account name can be edited in
  Preferences but the schema doesn't allow merging or splitting
  accounts — one license = one account, period.

---

## Milestone B additions

This spec is Milestone A: onboarding for a metadata-only library sync.
The local SQLite database (`openair.db`) lives at a fixed path under
`<userData>`. Customers do not pick a location because no audio files
are being distributed yet.

Milestone B (audio file distribution via R2) introduces multi-GB
libraries that may live on a local drive, a NAS, or a station's
central server. The AppData default is wrong for that case. The
following screen is reserved in the onboarding state machine now, to
be built when Milestone B ships:

### Screen 3.5 — Pick audio library location (Milestone B only)

Inserted between Screen 3/3b (station picked or created) and Screen 4
(library pull). Skipped entirely in Milestone A.

```
┌──────────────────────────────────────────────────────────┐
│      Where should audio files live on this computer?     │
│                                                          │
│  Default:                                                │
│   C:\Users\<user>\AppData\Roaming\com.ether.radio\audio  │
│                                                          │
│                                  [    Browse...    ]     │
│                                                          │
│  (You can change this later in Settings.)                │
│                                                          │
│                                  [    Continue    ]      │
└──────────────────────────────────────────────────────────┘
```

What happens on submit:

1. If the customer never clicks Browse, the default path
   `<userData>/audio` is used (created on first download).
2. Browse opens Electron's
   `dialog.showOpenDialog({ properties: ['openDirectory'] })`.
   Selected path is written to `station_config_kv` key
   `audio_root_path`.
3. Continue advances to Screen 4. Audio files downloaded during
   Milestone B sync use `audio_root_path` if set, else default.

Editable later in Settings → System → Audio Library Location.
Moving files after the fact is out of scope for this spec.

### State machine impact

OnboardingFlow reserves a `pickAudioLocation` state slot between the
bolted screens (venue / experience / name) and `pulling`. In Milestone
A, transitions skip this state and go straight to `pulling`. In
Milestone B, the state is turned on and the flow routes through it.
Reserving the slot now means Milestone B is an insertion, not a
retrofit.

---

## Build order

1. Backend: tables (accounts, stations, seats) + the six new
   endpoints. Each endpoint independently testable.
2. Backend: extend `/validate` to also return account info if the
   license has an account (cheap optimization, optional).
3. Frontend: `OnboardingFlow.tsx` with the four screens. Hardcode
   the API calls. Visual style matches existing FirstRunWizard.
4. Frontend: routing change in App.tsx.
5. Frontend: Manage Devices panel.
6. Frontend: Manage Stations panel (verify or build).
7. Test on a throwaway profile using the existing
   `scripts/fresh-install-test.ps1` wrapper:
   - Create new account end-to-end
   - Connect to existing account from a different throwaway profile
   - Reach seat limit, see the error, deauthorize, retry
8. Install fresh on OV's machine using a real license key. This
   is the live deployment and the proof.

---

## Definition of done

A fresh Ether install on a clean machine:
- Boots to the onboarding welcome screen
- Accepts a valid license key
- Either creates a new account or connects to an existing one
- Lets the customer pick or add a station
- Pulls the library
- Opens to the main UI with the correct station active

No manual SQL. No environment variables. No backend URLs typed by
the customer. The license key is the only thing the customer enters.

The OV install is the final test — engineer types the license key,
sync starts, station opens. That's the milestone.

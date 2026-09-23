# Web remote controls reach the wrong machine — routing trace (2026-09-16)

**Read-only.** Nothing edited, committed, built or deployed; no command sent to the live bus; neither live
DB opened. Line numbers are the working trees at `C:\openair` (HEAD `4a7261b`), `C:\ether-dashboard`
(HEAD `e6cca4b`), `C:\ether-backend` (working copy; Railway deploy state not verified from here).

**Operator report, verbatim:** at app.ether-cast.com the controls read "ON AIR · ovowforestmusic" but act
on whichever machine Jeff is sitting at — he can take OVEVENTS off air from a button named for OV.
A PD needs AUTO off/on, Stop, and Restart stream to reach the machine that owns the station, and the
calendar to work there.

**Assumption stated once:** the page on Jeff's screen is the `ether-dashboard` tree — its
`StationControls.tsx:129` renders exactly `◉ ON AIR · {sourceName}`. CLAUDE.md maps that repo to
`app.ether-technologies.com`; that `app.ether-cast.com` is the same Pages project is UNVERIFIED here
(Cloudflare custom-domain config is not in any tree).

---

## 1. The record — every governing doc, what it ruled, whether it was built

`C:\ether-dashboard` and `C:\ether-backend` have **no `docs/` folder** (`ether-backend/README.md` only).
Everything below is in `C:\openair\docs`.

| Doc | What it ruled | Built? |
|---|---|---|
| `slice4-desktop-station-routing.md` (`:1-8`, `:9-24`) | "The command bus is **per-license**: `POST /api/cmd` → SSE `/api/cmd-stream` fans the command to EVERY desktop on the license." `execCmd` ignored `station_uuid` and acted on the captured engine. Fix = a pure resolver: no uuid → active station; uuid matches a local row → that station; uuid not on this machine → ignore. `:99` — never test against production `/api/cmd`. | **Built.** Resolver `e4c3864`; `execCmd` wiring `3d39dfb` (2026-06-29), live at `src/App.tsx:1310-1329`. The doc's status line (`:3`) still says "NOT done" — stale. |
| `web-ui-mirror-handoff-2026-07-14.md` (`:35-38`, `:47-52`) | Two identities: desktop pushes/subscribes by **license key** (`x-license-key`, `?key=`); the dashboard reads by **JWT `lk`** (license_key_id) from owner-login. `/api/cmd` from the dashboard rides the JWT's `lk`. | Diagnosis only; the mirror rails it describes are what shipped in 4.4.53 (CLAUDE.md "Categories/programming mirror"). |
| `web-health-monitor-design-2026-08-18.md` (`:39-43`, `:82-92`, `:140-143`) | `station_cc_data` = `(station_uuid, table_name, row_uuid, payload)` pushed by the install with `x-license-key`; the health frame is keyed `row_uuid = "<station_uuid>:<machine_id>"` because "**more than one machine can serve one station**" (`:62`). Uses the proven rail `POST /api/cmd → SSE → execCmd` for `health:watch` (`:140`). | **Built + deployed** (`:3`). Only the health frame is machine-attributed; nothing else on the bus is. |
| `ether-v2-data-architecture-spec.md` (`:5`, `:54-56`) | "Stations are fully cloud-defined entities; machines and surfaces SUBSCRIBE to them. **Playout responsibility is a CLAIM, not a binding.**" Claim transfer final form: "a new machine requests the seat → a profile 4-PIN confirms → the claim transfers → the old machine gives up the stream." Marked **DEFERRED BUILD, post-launch**. | Phase 1 `station_attachments` table + `/account/attach` **deployed** (`:11`; backend `src/routes/attachments.js:1-32` — playout role is EXCLUSIVE, 409 `playout_held`). The PIN transfer: **not built**. The desktop attaches only as role **`monitor`** (`src/components/OnboardingFlow.tsx:566-577`) — **no surface ever claims `playout`.** |
| `phase-c-takeover-design-2026-08-12.md` (`:1-3`, `:14`, `:68-72`) | PIN-gated takeover for the *designation* (log-generation) system; one account-level PIN. `§0.1`: "Phase B is NOT shipped. Enforcement does not exist." | **Design only.** (Designation Phase B later shipped in 4.4.201 per `generation-designation.js:9` — for log generation, not playout.) |
| `account-license-architecture-v4.5.md` (`:3`) | Stations are license-owned, not account-owned; `account_users` (dashboard PIN operators) are license-scoped (`:62`). | **Analysis only — not started.** |
| `station-coexistence-design-2026-08-15.md` (`:3`, `:118`, `:229-231`) | Station-context isolation on one install: components that enumerate *every* station "become a cross-account actor"; license-scoped visibility deferred to v4.5. | **Nothing built** (`:231`). |
| `desktop-member-sync-bridge.md` (`:1-7`, `:24`) | Cross-account operate bridge: a member of another account can *operate* that station on the desktop. Today accessible stations are display-only — "No operate/select path." | **SCOPE ONLY. No code.** |
| `roadmap.md` (`:12`, `:95-103`, `:276`) | Control Center (Item 5): web dashboard for visibility + control across licensed installs; Phase 1 (auth, dashboard, live station view, remote sign-in) in production. | Phase 1 **built**. |
| `generation-designation.js` (`:1-22`) — code, not doc | "which machine tops up a station's log": ONE machine designated, human-only takeover; stored in `station_config_kv` key `designated_generator` (**synced**), `{ machine_id, machine_name, designated_at }`. | **Built (4.4.201).** It is the only shipped "which machine owns this station" record — and it governs *generation*, not playout. |

Net of the record: the bus was ruled per-license and station-routed; a *machine* claim for playout was
specified and deferred; the desktop never claims playout; the only machine-level targeting on the bus
today is the optional `target_machine_id` added for the guided handoff (below).

---

## 2. Each web control — click → request → backend → who receives → desktop handler

Common path, with receipts:

1. **Click** — `ether-dashboard/src/components/StationControls.tsx:33-38 fire()`:
   `sendCommand({ ...body, station_uuid: uuid })`. **No `target_machine_id`** on any of the five.
2. **Request** — `src/api.ts:311`: `POST /api/cmd` with the dashboard's owner-login JWT (`Authorization: Bearer`).
3. **Backend** — `ether-backend/src/index.js:6488-6511`: JWT → `licenseId = String(p.lk)` (`:6492`);
   dashboard callers must be `role === "admin"` (`:6501`); then `emitCommand(licenseId, cmd, req.body)`
   (`:6506`). `emitCommand` (`:6034-6053`) writes the payload to **every** `sseClients.get(licenseId)`
   entry (`:6038-6041`) and logs `[cmd] <cmd> -> SSE fan-out to N client(s) for license=<id>`; with no
   listener it queues up to 20 per license (`:6045-6050`).
4. **Who receives** — `/api/cmd-stream` (`:6514-6556`) is keyed **only by license**: the desktop
   subscribes with `?key=<license key>` (`src/App.tsx:1696-1697`, one `EventSource` per main window;
   popouts do not mount `<App/>` — `src/main.tsx:64-109`). Every install signed in with that license
   key is in the same `Set` (`:6531-6533`). **The target is chosen by license and nothing else.** The
   payload's `station_uuid` is passed through untouched; the backend never consults
   `station_now_playing.source_machine_id`, `station_attachments`, or `license_activations`.
5. **Desktop handler** — `src/App.tsx:1310-1329`: for a station-scoped command (`cmd-routing.ts:24-40`
   lists them: `automation_on/off`, `stop_all`, `stream:start/stop`, `skip`, …)
   `resolveCommandTarget(data.station_uuid, activeId, SELECT id, uuid FROM stations)` → **`target` if the
   uuid matches ANY row in this install's `stations` table** (`cmd-routing.ts:62-70`), else ignore. Then
   `commandTargetsThisMachine(data.target_machine_id, machineIdRef.current)` (`:1325`,
   `cmd-routing.ts:50-54`) — **returns true when the field is absent**, which it always is from
   `StationControls`. So every install that has the station row acts.

Per control (desktop `execCmd`, `src/App.tsx`):

| Web control | Body sent | Desktop case | What runs, on EVERY machine holding the station row |
|---|---|---|---|
| AUTO off | `{cmd:"automation_off", station_uuid}` (`StationControls.tsx:74`) | `:1442-1445` | `writeAutoAdv(targetId,false)` (persists the intent for that station on this machine) + daemon `automationStop {stationId:targetId}` → `audiod/ether-audiod.js:373` `engines.get(id).stop()`. UI flag only if it is the active view. |
| AUTO on | `{cmd:"automation_on", station_uuid}` (`:74`) | `:1437-1440` | `writeAutoAdv(targetId,true)` + daemon `automationStart` → `ether-audiod.js:372` `getEngine(id).start()`. **Starts automation on every machine that has the station row, including ones that were idle.** |
| Stop | `{cmd:"stop_all", station_uuid}` (`:105`) | `:1414-1416` | daemon `stopAll {stationId:targetId}`. |
| Restart stream | `automation_off`, 600 ms, `automation_on` (`:42-50`) — **it is not a stream restart; it composes the two automation commands** | as above, twice | as above, twice, on every machine. |
| ON AIR · &lt;name&gt; → "Yes, off air" | `{cmd:"stream:stop", station_uuid}` (`:114`) | `:1458-1460` → `stream:stop-live {stationId:targetId}` | `electron/main.js:10891-10897`: `_streamIntent.delete(stationId)` + daemon `stopStream`. Runs on every machine; on the non-source machine the daemon stop is a no-op but the **stream intent is deleted there too**. |
| GO ON AIR | `{cmd:"stream:start", station_uuid}` (`:59`) | `:1455-1457` → `stream:go-live` | every machine with the row tries to source the mount; the second one gets Icecast 403 (the dashboard pre-empts only when a source is already attributed, `:55-58`). |

Machine choice, stated exactly: **license (backend) → any install on that license that has the station's
row in its local `stations` table (desktop) → all of them.** Not machine ID, not the on-air source, not
the designated generator. Both OVEVENTS and OV carry every station of the account (OV's `play_log` rows
sync into this box's DB — `docs/ovevents-crash-loop-alarm-2026-09-15.md` §4.1), so both match.

The one machine-targeted path that exists: `HandoffModal.tsx:10-16, :39-49` sends `stream:stop` /
`stream:start` **with `target_machine_id`** chosen from `GET /api/account/devices`
(`ether-backend/src/index.js:4919-4931` = `license_activations` rows). `StationControls` does not use it.

---

## 3. Where "ON AIR · &lt;station&gt;" comes from, and whether the command uses the same identity

- The label is **not a station** — it is a **machine name**: `StationControls.tsx:23-24`
  `sourceName = np?.source_machine_name`; `:129` renders `◉ ON AIR · {sourceName}`. "ovowforestmusic" is
  the `machine_name` the OV box registered at activation (`electron/main.js:11340-11351` sends
  `os.hostname()`), joined from `license_activations` by the backend (`index.js:2526-2527`,
  `:2969-2971`).
- Its source: `station_now_playing.source_machine_id` (`index.js:498`), written by the desktop's
  now-playing POST **only by the machine whose stream is live** (`src/App.tsx:544-547`,
  `station-state.js:22-41`), sticky via `COALESCE` (`index.js:5161`), released when the source's own
  heartbeat goes stale (`station-state.js:44-55`, `index.js:2559-2560`).
- The command that button fires carries **`station_uuid` only** (`StationControls.tsx:36`, `:114`).

**They differ, and that is the defect.** The label names the machine that holds the mount
(`source_machine_id`); the command is addressed to the station (`station_uuid`) and lands on every
machine on the license that has the station row (§2). The page already has the machine identity it
would need — `np.source_machine_id` is in the same object the label reads from (`HandoffModal.tsx:16`
uses it) — and the bus already honours `target_machine_id` (`cmd-routing.ts:50-54`, `App.tsx:1325`).
Neither is used by `StationControls`. Jeff's sentence is the literal behaviour: a button named for OV's
machine sent `stream:stop` to the license, and OVEVENTS — holding the station row — executed it.

A second identity mismatch on the same card: the AUTO/MANUAL toggle state is `displayState(np)` from
`np.engine_state` (`StationControls.tsx:22-24`), and `engine_state` is written by **every** machine
running an engine for that station (`src/App.tsx:2520-2540` publishes for every station with an engine;
the upsert is last-writer-wins for `engine_state`, `index.js:5155-5162` — only `source_machine_id` is
COALESCEd). So "AUTO" on the card reflects whichever machine posted last, while the button acts on all.

---

## 4. Is there a record of which machine holds playout for a station?

Three records exist; none is "who holds playout", and none is consulted by the bus:

| Record | Meaning | Written | Read |
|---|---|---|---|
| `station_now_playing.source_machine_id` / `_at` (`index.js:498-502`) | the machine currently sourcing the **Icecast mount** (streaming), with its own heartbeat | desktop `POST /api/now-playing` (`electron/main.js:7794-7801`, payload `src/App.tsx:547`), only while that machine's stream is live; server stamps `_at` (`index.js:5161-5162`) | dashboard station list (`index.js:2525-2560`, `:2969-2999`) → `np.source_machine_id/_name`; `HandoffModal.tsx:16,34`; `StationControls.tsx:23`. **Never read by `/api/cmd` or `emitCommand`.** |
| `station_attachments` (`index.js:873-876`, `src/lib/attachments-schema`; routes `src/routes/attachments.js`) | v2 subscription: surface ↔ station in a role; `playout` is exclusive (409 `playout_held`, `attachments.js:10-17`) | `POST /account/attach` — the desktop calls it **only with `role:'monitor'`** during onboarding (`OnboardingFlow.tsx:566-577`) | `attachmentsForSurface` (`attachments.js:36-41`) for sign-in provisioning. **No playout row is ever written; nothing routes on it.** |
| `station_config_kv['designated_generator']` (`electron/generation-designation.js:14-22, :30-37`) | the ONE machine that tops up the station's **log** (`{machine_id, machine_name, designated_at}`), synced to every install | the designated machine (`:45+` decide/stamp) | `_autoExtendTick` skip (`:9`), the ledger line `auto-extend-skipped-not-designated … designated to ovow…`. **Generation only; the bus and playout ignore it.** |

There is no heartbeat or claim that says "OV is airing halloVeen, OVEVENTS is not" — the nearest fact is
the mount source, and it is a *stream* fact (a machine can run AUTO with the stream off and be invisible
to it).

---

## 5. Desktop: does an arriving command check the station against what THIS machine is airing?

It checks the station **row**, not the air. `src/App.tsx:1318-1322`: `SELECT id, uuid FROM stations`
→ `resolveCommandTarget` → `target` on any match (`cmd-routing.ts:67-69`). Nothing asks whether this
machine's engine for that station is started, whether its stream is live, whether it is the designated
generator, or whether it is the `source_machine_id`. Then it acts on install state keyed by that local
station id:

- `writeAutoAdv(targetId, …)` (`:1439`, `:1444`) — persists the AUTO intent per station on **this**
  install (the file behind `automation-intent.json`), so a web "AUTO off" aimed at OV also rewrites
  OVEVENTS's stored intent for that station.
- daemon `automationStart/Stop`, `stopAll` (`:1416`, `:1440`, `:1445` via `dcmd`) — this machine's
  daemon engine for that station id (`ether-audiod.js:372-373`).
- `stream:stop-live` (`main.js:10891-10897`) — `_streamIntent.delete(stationId)` on this machine
  regardless of whether it was the source.
- UI state (`setAutoAdv`, `activeEngine.autoAdvance`) only when `targetId === activeId` (`:1438`, `:1443`).

`target_machine_id` is the only gate that would make it machine-specific (`:1325`), and it is honoured
— but the web controls never send it. `db:apply` and `library:*` are license-scoped on purpose and
bypass routing (`:1318` guard; `src/lib/ccData.ts:1030-1041` resolves `station_uuid` → local id) — that
is correct for shared tables and is not part of this defect.

---

## 6. The calendar

**There is no calendar in the web dashboard.** `ether-dashboard/src/components/StationDetail.tsx:63-65,
:255-260` — the station tabs are Station, Categories, Programming, Library, Listeners, Analytics,
Affidavit. No component, route, API call or built-bundle string mentions a calendar or
`generated_schedule` (grep over `src/` and `dist/assets/*.js`: none). `src/api.ts` has no schedule
endpoint. The desktop's calendar (`src/components/BroadcastCalendar.tsx`, `generated_schedule`) has no
web counterpart and no bus command (`schedule:generateDay` is desktop IPC only).

What the web *does* have on that tab is **Programming** = shows (dayparts) and clocks
(`ProgrammingPanel.tsx:5-7`): reads `GET /api/account/station/:uuid/data?table=…` (`api.ts:200-201`,
served from `station_cc_data` pushed by the installs), writes `db:apply` create/update/delete over
`/api/cmd` (`ProgrammingPanel.tsx:94, :120-153`). Those writes are license-scoped and applied on
**every** install (`cmd-routing.ts:24` excludes `db:apply` from routing; `App.tsx:1318`), resolving the
station by uuid on each (`ccData.ts:1038-1047`). So "work there" for shows/clocks means: they are
applied on the owning machine *and every other machine*, which for a synced table is the intended
outcome. If "the calendar" in the report means the desktop calendar, the answer is that nothing on the
web reaches it; if it means Programming, it reaches every machine, not the owner specifically — same
per-license fan-out as §2, without a machine identity anywhere in the path.

---

Report only. No fixes, no proposals.

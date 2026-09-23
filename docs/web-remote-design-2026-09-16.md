# Web remote controls reach the sourcing machine — design (2026-09-16)

**Proposal only. Nothing built.** Source: `docs/web-remote-routing-2026-09-16.md` (the trace).
Receipts are `file:line` in the working trees at trace time (`C:\openair` HEAD `4a7261b`,
`C:\ether-dashboard` HEAD `e6cca4b`, `C:\ether-backend` working copy).

**Jeff's ruling (verbatim):** the web remote controls ONLY the machine named on the station page
("LIVE · sourced from <machine>" / "ON AIR · <machine>") — the machine sourcing the station's stream
(`station_now_playing.source_machine_id`). No other machine ever acts on a web control. "Move broadcast"
(HandoffModal) is how that changes. No separate claim system.

**The defect (trace §3):** the label reads a machine (`np.source_machine_name`,
`ether-dashboard/src/components/StationControls.tsx:23-24, :129`; `StatusPill.tsx:57-67` "LIVE · sourced
from"), the buttons address a station (`:36`), the backend fans to every install on the license
(`ether-backend/src/index.js:6034-6041`), every install with the station row acts (`openair:src/audio/
cmd-routing.ts:62-70`, `src/App.tsx:1318-1322`). The machine is never in the path.

## 0. The contract

> **target = `station_now_playing.source_machine_id`, stamped by the backend. Every station control
> carries it. Only that machine acts. The page shows what that machine answered. The LOG on the page is
> that machine's own `generated_schedule`, pushed by that machine and no other.**

Build order 1 → 2 → 3 → 4 → 5 → 6 → 7. Slices 1–5 are one release (they are one contract); 6 is
independent and can ride with them; 7 is stated separately with what is safe before it.

---

## 1. Slice 1 — target = `source_machine_id`, stamped server-side

### The field, as it exists
- **Written** only by the machine whose stream is live: `openair:src/App.tsx:544-547`
  (`source_machine_id: source.live && source.machineId ? … : null`), through the single now-playing
  POST loop `electron/main.js:7760-7801` (dedup signature; `KEEPALIVE_MS = 20_000`). Server:
  `ether-backend/src/index.js:5155-5162` — `source_machine_id = COALESCE(new, old)` (**sticky**: a null
  report never clears it) and `source_machine_id_at = NOW()` only on a non-null write (the source's own
  heartbeat). Columns `:498-502`.
- **Read** for the page: `:2525-2560` (station list) — `source_machine_id` and `source_machine_name`
  (`license_activations.machine_name`, `:2526-2527`; the desktop registers `os.hostname()`,
  `electron/main.js:11340-11351`), **exposed only while fresh**: `resolveSourceMachineId`
  (`src/station-state.js:44-55`, `HEARTBEAT_STALE_MS = 90 s`, `:10`) returns null once the source
  stops affirming. The raw column keeps the last sourcer.

### Backend change — `/api/cmd` (`index.js:6488-6511`)
After `const { cmd } = req.body` (`:6503`), for every **station control** (§3's set):
1. Require `station_uuid`; verify it belongs to the caller's license (the same check as
   `/api/account/station/:uuid/data`, `:3086-3089`).
2. `SELECT source_machine_id, source_machine_id_at FROM station_now_playing WHERE station_uuid = $1`
   (the raw columns, `:498-502`). **Overwrite** `req.body.target_machine_id` with `source_machine_id`
   — the browser's value is discarded (it cannot choose another machine). Also stamp
   `target_machine_name` from `license_activations` (`:2526-2527` join) for the ack text.
3. No `source_machine_id` at all (never sourced) → `409 { error: "no_source_machine" }`. Not queued.
4. Then `emitCommand(licenseId, cmd, req.body)` (`:6506`) — unchanged fan-out (§2 narrows delivery).

**The one sanctioned exception — move broadcast:** `HandoffModal.tsx:10-16, :39-49` sends
`stream:stop` to the current source and `stream:start` with a *chosen* `target_machine_id` from
`fetchDevices()` (`api.ts:96-99` → `index.js:4919-4931`). Rule: `stream:start` **when the station has no
fresh source** (`resolveSourceMachineId` null) accepts the client's target, validated against
`license_activations … deauthorized_at IS NULL` (`:4923-4929`). Every other case is stamped. That is
exactly the handoff's two steps (release, then grab) and nothing else.

### Dashboard change
- `StationControls.tsx:23-24`: `sourceName = np.source_machine_name` stays the label source (it is the
  field). `:66-69` "Acts on **{name}**" → "Acts on **{station}** · **{sourceName}**". The card sends
  `station_uuid` only (as today, `:36`); the backend stamps the target. Nothing on the page chooses a
  machine except the handoff modal.
- `types.ts`: add `source_machine_id_at` (raw, for §2's "offline since") — backend exposes the raw
  `_at` beside the gated id (`:2559-2560`).

**Blast radius:** one guard + one query in one route; one string on the card. Playout untouched.
**Jeff verifies:** with OV sourcing halloVeen, press any control on the web from OVEVENTS's browser →
the backend log line `[cmd] automation_off -> … target=<ov machine id>` and OV acts; a hand-crafted POST
with `target_machine_id: <ovevents id>` is overwritten (the backend log shows the stamped id).
**Does NOT change:** who may *become* the source (still whoever goes on air / the handoff).

---

## 2. Slice 2 — stream down: the LAST sourcer is the target, and "connected" is known

### "last sourced from <machine> · offline since <time>"
- The raw `source_machine_id` is sticky (`index.js:5161`); `source_machine_id_at` is its last affirmation
  (`:5162`). `resolveSourceMachineId` nulls the *exposed* id after 90 s (`station-state.js:44-55`) — the
  page currently loses the name entirely (`StationControls.tsx:23-24` → `onAir=false`).
- Backend: in the station list (`:2555-2560`) add `last_source_machine_id`, `last_source_machine_name`,
  `last_source_at` = the raw columns, always. Keep `source_machine_*` as the fresh/live value.
- Dashboard: `StatusPill.tsx:60-67` — when `source` is null but `last_source_machine_name` exists:
  `"last sourced from <name> · offline since <last_source_at>"`. `StationControls` "Acts on" line reads
  the same fallback. `/api/cmd` step 2 (§1) already uses the raw column, so **Restart / AUTO / Stop
  target the last sourcer** without any page logic.

### "connected" — the bus learns which machine is on each SSE client
- Desktop: `src/App.tsx:1696-1697` connects `${STREAM_BASE}?key=<license>`; add `&machine_id=<id>` from
  `machineIdRef` (`:695`, filled at `:2464` from `ether.identity.get`; the connect already retries until
  the key is present, `:1688-1693` — retry until the machine id is present too).
- Backend: `/api/cmd-stream` (`:6514-6533`) stores `machine_id` on the client entry (`clients` is a
  `Set<res>`, `:6531-6533` → a `Map<res, {machineId}>` or a property on `res`). `emitCommand`
  (`:6034-6041`): **if `data.target_machine_id` is set, write only to the client(s) whose `machineId`
  matches**; return `{ delivered, target_connected }`. No matching client → **do not queue** a station
  control (`:6045-6050` queues only for untargeted commands) → `/api/cmd` answers
  `409 { error: "target_offline", machine: <name>, offline_since: <last_source_at> }`.
- Dashboard: the button shows it (§5): "**<name> is not connected** — offline since HH:MM. Not sent."

**Blast radius:** SSE registry gains one field; delivery narrows from "all on the license" to "the one
named" for station controls; untargeted commands (`db:apply`, …) fan out as before. A pre-slice desktop
that connects without `machine_id` can never be a target → its station controls from the web stop
working until it updates. That is the ruling ("no other machine ever acts"), stated so it is not a
surprise: **this slice ships with the desktop release that sends `machine_id`.**
**Jeff verifies:** stop OV's stream; the pill reads "last sourced from ovow… · offline since HH:MM";
press Restart → OV (still connected) restarts its stream; close Ether on OV → press Restart → "ovow… is
not connected — not sent", and nothing happens on OVEVENTS.
**Does NOT change:** the desktop's execCmd; the 90 s freshness rule for the *live* label.

---

## 3. Slice 3 — every station control carries the target; absent = nobody acts

**Station controls** (the set the backend stamps and the desktop requires): everything in
`cmd-routing.ts:24-40 STATION_SCOPED` — `automation_on/off`, `stop_all`, `skip`, `play_now`, `play`,
`pause`, `set_volume`, `play_emergency_cart`, `mic_on`, `deck:load/cue/crossfade/off`,
`queue:enqueue/reorder/remove/move/clear`, `stream:start/stop`, `cart:fire`, `ops:set-closing` — plus
`stream:restart` (§4). Web senders today: `StationControls.tsx:74, :90, :105, :114, :59`
(AUTO, Play now, Stop, off-air, on-air, Skip `:84`), `StationDetail.tsx:99` (`queue:reorder` from the
Up Next drag, `:83-99, :207-208`), `LibraryPanel.tsx:341-344` (`deck:load`, `queue:enqueue`),
`HandoffModal.tsx:39-49`.

### Backend
- `/api/cmd`: for any command in the set, after §1 stamping, `if (!req.body.target_machine_id)` →
  `400 target_machine_id_required` (only reachable when §1 found no source — i.e. `409
  no_source_machine` fires first; the 400 is the belt to that brace).
- The set lives in one place the backend and desktop both read: `openair:src/audio/cmd-routing.ts` is
  desktop-only today; mirror the list as `ether-backend/src/lib/station-commands.js` with a test that
  the two arrays are equal (same pattern as `slug.test.js`).

### Desktop (`cmd-routing.ts`, `App.tsx`)
- `commandTargetsThisMachine(targetMachineId, thisMachineId, cmd)` (`:50-54`): **for a station-scoped
  command an absent/blank target returns FALSE.** Unit test beside the existing ones.
- `App.tsx:1325` passes `cmd`; the ignore log exists (`:1326`); add the accept log
  `[RemoteCmd] <cmd> accepted for station <uuid> on this machine <id>` (the trace found zero
  `[RemoteCmd]` lines in `ether-startup.log` — nothing records a remote command landing).
- `resolveCommandTarget` (`:62-70`) is unchanged: the station row lookup still picks the local station
  id on the *target* machine.

### Commands that stay license-wide, and why
| Command | Why every install must receive it |
|---|---|
| `db:apply` (Categories / Programming / Clocks / Library edits) | mutations on **synced** tables; each install applies them and resolves the station by uuid (`ccData.ts:1030-1047`); a machine target would lose the edit on the others (`cmd-routing.ts:21-23`). |
| `library:addSong`, `library:syncDownload` | library is account-wide (`ccData.ts` push/pull paths). |
| `health:watch` | asks the whole fleet to raise its health-frame cadence (`docs/web-health-monitor-design-2026-08-18.md:140-143`). |
| `jukebox:request` | a guest's request rides the bus to whichever machine runs the jukebox (`App.tsx:1350-1352`); no source concept there — out of scope here. |

**Blast radius:** one line in the resolver, one guard in the route, one shared list. Web senders need
no change (the backend stamps). Any third-party sender of a station control without `station_uuid`
gets 400 — none exist (`api.ts:311` is the only web sender; the desktop never posts station controls).
**Jeff verifies:** drag a row in Up Next on the web → OV reorders, OVEVENTS logs the ignore line;
press Skip on the web → OV skips, OVEVENTS does not.
**Does NOT change:** what each accepted command does once on the target (`App.tsx:1414-1470`).

---

## 4. Slice 4 — Restart is a stream restart on the target

Today `restart()` = `automation_off` → 600 ms → `automation_on` (`StationControls.tsx:42-50`): a
*playout* restart on every machine, never touching the Icecast source.

- **Desktop:** new execCmd case `stream:restart` beside `:1455-1460`: `invoke("stream:stop-live",
  {stationId: targetId})` (`electron/main.js:10891-10897` → daemon `stopStream`, `ether-audiod.js:380`),
  wait for `streamStatus` ≠ live (`:381`) or 2 s, then `invoke("stream:go-live", {stationId: targetId})`
  (`main.js:10829-10850` reads the station's Icecast config → daemon `startStream`, `:379`).
  `stop-live` deletes `_streamIntent` (`:10894`) and `go-live` re-sets it, so the intent ends as it began.
  Automation is not touched; the song keeps playing through the encoder restart.
- **Dashboard:** `restart()` sends one command `{cmd:"stream:restart", station_uuid}`; confirm text:
  "Restart the stream from **<sourceName>** — listeners drop for a few seconds."
- **cmd-routing.ts:** add `stream:restart` to `STATION_SCOPED` (and the backend mirror).

**Blast radius:** one case reusing the desktop's own on-air lifecycle (`src/hooks/useStreaming.ts:8, :19`
call the same IPC). **Jeff verifies:** press Restart with OV sourcing → the listener page drops and
returns in ~5 s, the song does not restart, OV's daemon log shows `stopStream` then `startStream`.
**Does NOT change:** AUTO on/off; the ON-AIR button.

---

## 5. Slice 5 — no silent success

Three silent paths today: the backend queues for nobody (`:6045-6050`) and `/api/cmd` still answers
`{ok:true}` (`:6507`); every desktop ignores (`App.tsx:1326`, log only); the target acts and fails
(Icecast 403 inside `stream:go-live`). The toast says `Automation OFF → halloVeen` regardless
(`StationControls.tsx:36`).

- **Backend:** `/api/cmd` returns `{ ok, cmd_id, delivered, target_machine_id, target_machine_name,
  target_connected }` (the jukebox route already returns delivered/queued, `:6481`; `emitCommand` stamps
  `cmd_id` on the payload at `:6036`). New `POST /api/cmd/ack { cmd_id, station_uuid, machine_id, ok,
  error }` (`x-license-key`), kept in a per-license ring like `pendingCmds` (`:235`); `GET
  /api/cmd/ack/:cmd_id` (JWT).
- **Desktop:** after a station-control case runs (`App.tsx` after `:1414-1470`), POST the ack with the
  real result — `stream:go-live` already returns `{ok:false, error}` on a 403 (`main.js:10829+`);
  daemon calls return their `{ok}`. Best-effort, never blocks playout.
- **Dashboard:** `fire()` (`:33-38`) renders three distinct outcomes: `409 target_offline` →
  "**<name> is not connected** — offline since HH:MM. Not sent."; ack `ok:false` → "✗ <name>:
  <error>"; ack `ok:true` → "✓ <cmd> done on <name>"; no ack within 5 s → "no answer from <name>".
  "Sent" is never shown as success.

**Blast radius:** additive endpoints; one toast path. **Jeff verifies:** close Ether on OV → Stop →
"ovow… is not connected — not sent". GO ON AIR while another box holds the mount → "✗ ovow…: 403".
**Does NOT change:** what runs.

---

## 6. Slice 6 — web LOG on StationDetail, read-only: the sourcing machine's `generated_schedule`

### What the page already shows — reuse it
`StationDetail.tsx:173-215`: the three decks (`np.decks`, `:176-180`, A on air / B,C cued) and
**Up Next** (`np.queue`, `:86`, drag-reorder `:83-99`). Both come from `station_now_playing`, which is
**last-writer-wins across machines** (`index.js:5155-5162`; every machine with an engine posts,
`App.tsx:2520-2540`). Under the ruling that display must also be the source's. Two changes:
- Desktop: the now-playing payload always carries `reporter_machine_id` (`App.tsx:547` sends
  `source_machine_id` only while live; add the unconditional field).
- Backend upsert (`:5155-5162`): when the row has a fresh source and `reporter_machine_id ≠
  source_machine_id`, keep only the heartbeat (`engine_heartbeat_at`) and the reporter's own
  `last_error`; do not overwrite `title/decks/queue/engine_state`. With no fresh source, first writer
  wins as today. Decks and Up Next then show the source's, at the existing 20 s/5 s latency.

### The LOG tab — the source's own schedule, pushed by the source only
- **What is pushed:** rows of `generated_schedule` for this station, window = now − 2 h … now + 24 h
  (≈ 1,100 rows at ~40/h), fields `uuid, scheduled_at, title, artist, content_class, duration_ms, state,
  played_at, deck` — `state` ∈ pending/playing/played/missed and `played_at` are **already stamped by the
  sourcing machine's own daemon** (`audiod/engine.js:1774-1781` playing→played, `:1342` missed). No
  matching is needed on the web: the row *is* the machine's play record for that slot.
  (For a cross-check against the synced play history, the daemon does **not** set
  `play_log.scheduled_log_id` — `audiod/playlog.js:56` writes null — so matching would be by
  `file_path` + `played_at` within ±60 s of `scheduled_at`; and `station_play_history` is every
  machine's `play_log` merged with no machine column, `index.js:808-824`, `:3476-3484`, including the
  phantom `resume-playout` rows of `docs/ovevents-crash-loop-alarm-2026-09-15.md` §4. Not used.)
- **Transport:** the existing CC push, table `log`: `pushCcTable`/`pushCcData` (`src/lib/ccData.ts:5-14,
  :226-236`, add `log` to `NS` `:609-617` or push inline like the health frame, `:41-45`) →
  `POST /api/account/data/sync` (`index.js:2897`, `x-license-key`), `row_uuid = generated_schedule.uuid`.
  The backend's reconcile clause **tombstones any row_uuid no longer present** (`:3058-3067`,
  `table !== "health"`) — for `log` that is the feature: **regeneration replaces the forward rows, and the
  next push sweeps the old ones**, so the web matches the machine's new log on the next cadence.
- **When:** on every go-live (`playstart`, `engine.js:1690-1716`, which is when `state` flips) and on
  each Generate for the station (`schedule:generateDay` completion), throttled to ≥ 10 s apart; a 60 s
  keepalive push so the window slides. **Latency:** ≤ 10 s after a row flips + the page's 5 s poll.
- **Only the source pushes — three gates, any one is sufficient:**
  1. desktop: push `log` only when `streamStatusRef.current.get(stationId).live` (`App.tsx:2536`) — the
     same test that sets `source_machine_id` (`:547`);
  2. backend: `/api/account/data/sync` for `table === "log"` requires the poster's `machine_id` (add it
     to the body) to equal the raw `station_now_playing.source_machine_id`; otherwise `409 not_source` —
     **a non-source machine's push is refused, so it can never sweep the source's rows**;
  3. web: each row carries `machine_id`; the tab renders only rows whose `machine_id ===
     np.source_machine_id` (or `last_source_machine_id` when offline) and says "from <name>".
- **Read:** `fetchStationData(uuid, "log")` (`api.ts:200-201` → `index.js:3081-3100`, ordered by
  `updated_at`; the tab sorts by `scheduled_at`). Rendering: past rows with `state` played/missed
  (missed in red — the "spot did not air" line, `engine.js:1300-1318`), the `playing` row highlighted,
  pending rows forward. The page's decks/Up Next stay above it; the LOG is the calendar-shaped truth
  under them.
- **Offline:** when the source is stale (`resolveSourceMachineId` null) the tab keeps the last rows,
  greys them, and heads "last sourced from <name> · offline since <time> — log as of HH:MM:SS"
  (`station_cc_data.updated_at` is server time, `docs/web-health-monitor-design-2026-08-18.md:183`). It
  never falls back to another machine's rows (gate 3), and no other machine's rows exist (gate 2).
- **After a move broadcast:** the new source's first push sweeps the old source's rows (reconcile) and
  the tab flips to the new machine's log within one cadence.
- **generated_schedule does not start syncing** — nothing here touches `synced-tables.js`; the push
  is a one-way mirror of one machine's view, exactly like `categories` today (`ccData.ts:5-14`).

**Blast radius:** one more CC table at ≤ 6 pushes/min from one machine per station; one backend gate;
one tab. Playout untouched. **Jeff verifies:** with OV sourcing, the LOG tab shows OV's next hours;
a song ends on OV → its row turns "played" within ~15 s; a missed spot shows red; Generate on OV →
the forward rows change on the web; OVEVENTS running the same station locally puts nothing on the
tab; unplug OV → the tab greys with "offline since".
**Does NOT change:** the calendar on the desktop; `station_play_history`; the public listener feed.

---

## 7. Slice 7 — station-context isolation on the desktop (separate; what is safe before it)

For a machine sourcing **two** stations, the commands and the LOG must be scoped per station:

- **Already per station:** daemon engines and streams (`ether-audiod.js:372-373, :379-381`); the AUTO
  intent (`writeAutoAdv(stationId, …)`, `App.tsx:580`; file `main.js:448`); stream intent
  (`main.js:10894`); routing → a station id (`cmd-routing.ts:62-70`); `dcmd` carries `stationId:
  targetId` (`App.tsx:1335-1336`); the source test `streamStatusRef.current.get(st.id)` (`:2536`) — a
  machine can source station 2 and not station 3, and the LOG push (§6 gate 1) follows that.
- **Install-global today — what slice 7 scopes:**
  1. `useDaemon = activeEngine.isDaemonDriven` (`App.tsx:1332`) is read from the *active* engine and
     applied to the target. Scope: read from the target's engine / main's `AUDIO_DAEMON`.
  2. `set_volume`, `play_emergency_cart`, `mic_on` run only `if (isActive)` (`:1462-1470`) — a command for
     a background station is dropped without an ack. Scope: daemon-direct per station, or an explicit
     `ok:false, error:"not supported for a background station"` ack (§5 shape) so it is visible.
  3. `queue:reorder/remove/move/clear` and `deck:*` act through `dcmd(… stationId: targetId)` (already
     scoped) but the UI mirrors only the active view (`:1438/:1443` pattern) — correct; the background
     station's queue is re-read on switch.
  4. The now-playing `reporter_machine_id` (§6) is per install; `source_machine_id` is per station row —
     both correct as is.
- Governing doc: `docs/station-coexistence-design-2026-08-15.md` (nothing built, `:229-231`); its
  enumeration list (`:118`) is the checklist for any other "all stations" reader.

**Are slices 1–6 safe before 7?** Yes. The four transport commands and the queue/deck commands are
already station-routed and the machine gate only narrows them; the LOG push is per station by its gate.
Item 1 only matters if a machine mixed daemon and in-process modes across stations, which the code
says it cannot (`App.tsx:1332` "install-level mode — all stations share it"). Slice 7 is correctness for
the active-only commands (item 2), which are not the ones in the ruling's list.

---

## 8. Calendar — out of scope; what it would later need

A web calendar would be the §6 LOG widened to a date range (the same push, windowed per day, ~1,000
rows/day) and made editable — and editing is the hard part: an edit must land on the **source machine
only** (a license-wide `db:apply` would write one machine's log onto every machine, the exact thing the
no-sync rule forbids), so it needs a machine-targeted `db:apply` for `generated_schedule` riding the
§1–§3 stamping, the desktop applying it through the log-reader's own writers (the operator-row path,
`engine.js` `_writeOperatorLogRow`), and the `missed`/`played` stamps remaining the machine's. None of
that is proposed here.

---

Proposal only. Nothing built, nothing sent, nothing committed.

---

## Slice 1 — built (2026-09-16, `ether-backend` local commit `5d0157e`; NOT deployed, NOT pushed)

**Step 3 first — the current desktop already refuses a command aimed at another machine.**
`openair:src/audio/cmd-routing.ts:50-54 commandTargetsThisMachine`: a present `target_machine_id` that is
not this machine's id → false; `src/App.tsx:1325-1328`: on false, `[RemoteCmd] <cmd> ignored — targets
machine …` and return, before any action. Shipped in `3d39dfb` (2026-06-29), an ancestor of 4.6.45
(`4a7261b`; `git merge-base --is-ancestor` confirms). The id it compares — `machineIdRef` from
`identity:get` = `client_identity.client_id` (`electron/main.js:11341-11351`, `App.tsx:2460-2466`) — is
the same id the desktop registers in `license_activations` (`src/lib/ccData.ts:804,824`,
`licenseGuard.ts:145`, `OnboardingFlow.tsx:234,284,387` → `ether-backend/src/index.js:2313-2330`) and
posts as `source_machine_id` (`App.tsx:547`). So the stamped id and the desktop's own id are one value.
A machine whose identity is not seeded (`identity:get` → `ok:false`) has `machineIdRef` null and
**ignores every targeted command** — the safe direction, but it means a target machine must have its
identity row (every activated install does). **No desktop release needed for slice 1.**

**What changed (`C:\ether-backend`):**
- `src/lib/station-commands.js` (new) — `STATION_SCOPED` (`:21-31`, mirror of
  `openair:src/audio/cmd-routing.ts:24-40`, comment names the source; shared-list test = later slice),
  `isStationScopedCommand`, and the pure decision `stampTarget()` (`:48-76`): station_uuid required /
  owned (400); sticky `source_machine_id` → `target_machine_id`, client value discarded, name from the
  device lookup; never sourced → `409 no_source_machine` (`:73`); handoff grab = `stream:start` with no
  FRESH source keeps a client target that is a live activation (`:60-68`), else
  `400 unknown_target_machine` (`:65`).
- `src/index.js:53-54` require; `POST /api/cmd` `:6510-6555`: for station-scoped commands, three lookups
  — `stations WHERE uuid AND license_key_id` (`:6520`, the `/data` check), raw
  `station_now_playing.source_machine_id/_at` (`:6526-6527`), this license's live
  `license_activations` (`:6535-6537`, the `/api/account/devices` key resolution `:6528-6529`) — then
  `stampTarget` (`:6538`); refusal → `res.status(verdict.status)` and **no `emitCommand`** (`:6543-6546`,
  so nothing is queued); success → one log line `[cmd] <cmd> station=<uuid> target=<id> (<name>)
  via=source|last-source|handoff-grab license=<id>` (`:6548`) and `emitCommand(licenseId, cmd, body)`
  with the stamped body (`:6555`). Non-station commands take the old path untouched (`body = req.body`).
- Fan-out unchanged (`emitCommand :6034-6053` still writes to every SSE client on the license); the
  machine filter is the desktop's (step 3). Targeted delivery is slice 2.

**Tests** — `src/lib/station-commands.test.js` (`node --test`), verbatim:
```
✔ the list mirrors the desktop's STATION_SCOPED (cmd-routing.ts:24-40)
✔ stamping OVERWRITES a client-supplied target with the sticky source
✔ stream down: the LAST sourcer is still the target (sticky column, not the 90s view)
✔ no source machine EVER → 409 no_source_machine (the route does not emit/queue on !ok)
✔ station_uuid required, and it must be the caller's station
✔ handoff grab: stream:start with NO fresh source keeps the client's target when it is a live device
✔ handoff grab refused with an unknown / deauthorized device → 400 unknown_target_machine
✔ stream:start with a FRESH source ignores the client's target — the source is the target
✔ stream:start with no fresh source and NO client target falls back to the last sourcer (a plain GO ON AIR)
✔ non-station commands are untouched and never refused
✔ the request body is never mutated in place
ℹ pass 11  ℹ fail 0
```
`node --check src/index.js` ok; existing `src/slug.test.js` 8/8 still pass. No DB touched (the
decision is pure; the route's queries are reads).

**Step 5 — what the dashboard shows on a 409/400 today (not changed in this slice):**
`api.ts:49-51` turns any non-2xx into `ApiError(status, data.error)`; `StationControls.tsx:36-37
fire()` catches it and toasts **"<label> failed: no_source_machine"** for 3.2 s — an error, not a
false success (raw code, no words; slice 5 gives it words). Same in `restart()` (`:42-50`) and
`HandoffModal.tsx:40-46`. **Silent today:** the Up Next drag-reorder (`StationDetail.tsx:99
.catch(() => {})` — the reordered view stays on screen while nothing was sent) and Library's
A/B/C/Q buttons (`LibraryPanel.tsx:341-344 .catch(() => {})`). Those two show nothing on refusal
until slice 5.

**Not done here:** deploy (Jeff GOs Railway separately), the desktop `machine_id` on the SSE connect
and targeted delivery (slice 2), the shared-list test, any dashboard change.

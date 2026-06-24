# EtherCast multi-station — handoff (2026-06-24, 8:37am)

Status snapshot for the architecture/planning chat. Written after an overnight build session that
shipped v4.4.14 → v4.4.16, recovered a corrupted DB, and exposed several real multi-station gaps.

---

## 1. Where things stand right now

- **One install, one account (OV)** — license 19, key `ETH-STN-1D73-7E88-C4E6`, `jensj@opportunityvillage.org`.
- **Three stations**, all under OV's account:
  - **Opportunity Village** — local id 1, **local uuid `92e8c81c…` (WRONG — see Risk A)**, backend id 15 / uuid `21606342…`.
  - **HalloVeen** — local id 10, uuid `e7041ae5…`, backend id 21. owner correct.
  - **Magical Forest** — local id 11, uuid `ad84dafd…`, backend id 22 (registered 06-24). Local owner still `ETHER-OWNER-2026` (djdeniro's — wrong; fixed automatically by the v4.4.16 reconcile once it runs).
- **Backend** (Railway, Postgres) has all three under `license_key_id = 19`.
- **DB schema_version = 22**; v4.4.16 ships migration **v23** (categories per-station) → bumps to 23 on launch.
- **Data is clean** — `PRAGMA integrity_check = ok` after recovery; zero row loss.

## 2. What shipped (v4.4.14 → v4.4.16)

- **v4.4.14** — per-station playout isolation: AUTO + ON-AIR badge are per-station; daemon deck/queue/
  playstart events filtered by stationId (no more one station's deck bleeding into another's now-playing).
  Lifetime-safe trial gate.
- **v4.4.15** — **per-station monitor mixer**: native `audio_set_monitor_volume(station_id, vol)` scales the
  LOCAL speaker output only (program bus → Icecast untouched); `StationMonitorMixer` UI replaced the routing
  dropdown. Rotation-NULL fix (newly-added songs count as in-rotation). **See Risk B.**
- **v4.4.16** — **universal station register + owner self-heal**: the ~20s account reconcile now also runs
  local→cloud — stamps every station with the account's real license and registers any local station the
  cloud doesn't know yet via the new idempotent `POST /account/register-station` (no seat consumed).
  Removed a buggy startup self-heal that mis-tagged owners. **Categories codes now unique PER STATION**
  (migration v23 — was a global `UNIQUE(code)` that silently blocked category creation on a 2nd station).
  MIC-column layering clip.

## 3. Open RISKS / known issues (read before planning)

**Risk A — OV's local uuid is wrong, and the v4.4.16 reconcile will CHURN on it.**
OV local (id 1) carries uuid `92e8c81c…`, which the backend never issued (backend OV = `21606342…`). The
v4.4.16 reconcile assumes local uuids are canonical, so it will: (a) cloud→local, see `21606342` "missing"
and recreate the empty OV **stub**; (b) local→cloud, see `92e8c81c` "missing" and register a **second**
backend OV. → duplicate churn BOTH directions.
- **Mitigation (one-time, app-closed):** realign — delete the stub, `UPDATE stations SET uuid='21606342…'
  WHERE id=1`, then OV local==backend and the reconcile is quiet. **Do this before trusting the reconcile on
  this install.**
- **Real fix (planning):** the reconcile should reconcile a local↔cloud **identity mismatch** (same station,
  different uuid) by adopting the cloud uuid, instead of blindly registering the local one as new. Heuristic
  candidates: match unregistered-local against unmatched-cloud by name/callsign before registering.

**Risk B — monitor mixer on a single sound card is unproven at 3 stations.**
Each station opens its OWN cpal output stream; 3 streams contending on one Realtek device is the suspected
cause of jumpy VU / choppy local audio (though the corrupted DB confounded last night's symptoms — the
mixer code itself only scales the local tap and CANNOT affect broadcasts). Shipped in v4.4.16 unchanged.
- **Needs:** an on-box listen on a CLEAN DB. If still flaky, the proper design is **sum all stations into
  ONE device output** (per-station gains feeding a single mixed monitor bus) rather than N competing streams
  — a real native refactor that touches the same callback that drives the program bus, so build + ear-test
  before shipping.

**Risk C — shared library vs per-station programming.** Songs are a single install-scoped library; each song
has ONE `category_id` → a song belongs to exactly one station's category. So a second/third station cannot
have its own categorized rotation from the shared pool — Magical Forest fell back to random picks (pulled
OV's Christmas songs) because its categories had no songs of their own. **This is the core unsolved
multi-station design question:** per-station song categorization (song↔category many-to-many, scoped by
station) or per-station libraries. Needs an architectural decision before multi-station is real.

## 4. Hard constraints / lessons (do not relearn)

- **NEVER write the live `openair.db` from an external script while Ether OR `ether-engine.exe` is running** —
  two SQLite engines on one WAL file corrupts it (it happened; recovered via `sqlite3 .recover`). Diagnostics
  read-only; real writes only after Jeff fully closes Ether AND the daemon. Schema/data changes belong in
  app-run migrations, not live external surgery.
- The **audio daemon outlives the UI** — closing the window does not release the DB; `ether-engine.exe` keeps
  it open + writing (play log, scheduler).
- Build tooling: VS 2022 C++ Build Tools are now installed → the native engine builds locally
  (`cmd /c vcvars64.bat && cargo build --release`, then copy `target/release/ether_audio.dll` →
  `native/ether-audio.node`). `sqlite3.exe` (winget SQLite.SQLite) available for `.recover`.
- Release flow: bump `package.json`, push `main`, push `v*` tag → CI "Build Ether" rebuilds native + renderer
  and publishes; a poller posts operator-facing GitHub notes; wiki `Releases` gets an entry.

## 5. Suggested next steps

1. **Install v4.4.16**, then do the **one-time OV uuid realign** (Risk A) app-closed so the reconcile stops
   churning. Verify all 3 stations publish.
2. **Decide the per-station library/categorization model** (Risk C) — biggest blocker to real multi-station.
3. **Ear-test the monitor mixer** on a clean DB; decide keep-as-is vs single-bus rebuild (Risk B).
4. Reconcile identity-mismatch handling (Risk A real fix) so no install can churn duplicates.

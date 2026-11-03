# Announcement catch-up + afterSign fix — local build and how to test it

**Date:** 2026-10-05 · **Branch:** `fix/aftersign-announce-catchup` (from `main` `5068390`) · **Not pushed, no tag, no
version bump** (process change, Jeff 2026-10-05: version/tag/CI only after Jeff tests and says publish).

## Commits on the branch

| Commit | What |
|---|---|
| `217558a` | afterSign signature check runs `pwsh`, or `powershell` with the inherited PSModulePath removed (the 4.6.59 CI failure) |
| `923e256` | CLAUDE.md: remote/dashboard domain is `app.ether-cast.com` |
| `90c5f44` | CLAUDE.md: licensing rulings (lifetime never modified; platform-created licenses outside tiers; B7 cancelled) |
| `549d207` | Announcement catch-up: 5 s window, never twice, misses reported (`electron/announce-catchup.js`) |
| `b5323c9` | afterSign: helper must be signed **only when the app is** (afterSign also runs on unsigned builds — found by the first local build) |
| `e7e65fd` | **Upcoming announcements in Up Next** (time + live countdown + state) and the **heads-up strip** (Preferences → Announcement heads-up, default 60 s); one read path `announcements:upcoming` |
| `dd4f113` | **Stacked announcements play in order** — never cut each other; a line due while another plays waits (row: NEXT — after current) |
| `6f54afe` | **"Play ×N" runs (October 4 rule kept):** a line due mid-run → the play on air finishes, remaining repeats cancelled (logged), the new line plays next |

## The local build (CURRENT — 2026-10-06 18:18)

- **File:** `C:\openair\dist-electron\Ether Setup 4.6.59.exe`
- **Built from:** `6f54afe`, 2026-10-06 18:18:13 PDT, **215,912,724 bytes**
- **sha256:** `0efb3b70e858c3c528138db5c31d446a8eaf7ea8eff66b884c532fbd8434d858`
- **This REPLACES three earlier builds of the same file name:** `dd4f113` (`f2b67942…`, stacked lines waited for a
  whole ×N run), `e7e65fd` (`65f7c9cb…`, no ordered play), `b5323c9` (`7ca55980…`). If the sha256 of the file you
  install doesn't start `0efb3b70`, it's an old one.
- Packaged gate: **failed once** right after packaging ("packaged daemon did not respond"), then **passed 3 times in
  a row** on the same artifact. The daemon's code did not change in this round; the cause of the one failure is
  UNVERIFIED (a slow cold start of the freshly written Ether.exe is the likely one). The packaged `main.js` contains
  the repeat-run rule (`repeatStarted`).
- **Unsigned** (local build). Windows SmartScreen will warn: "More info → Run anyway".
- **The filename says 4.6.59 only because `package.json` still does.** 4.6.59 will never be published (its tag and draft
  are deleted); on GO the version is set to 4.6.58. Identify this build by the sha256 above, not the name.
- **Packaged gate:** `node audiod/verify-packaged.js` → `✅ RELEASE GATE PASS` (packaged daemon pings; every require
  resolves; staging complete). `app.asar` contains `electron/announce-catchup.js`.
- Build log: `[engine-pack] unsigned build (Ether.exe NotSigned) — HA helper signature not required`.

## What changed for operators (announcements)

- A scheduled announcement still fires on its second. If Ether was busy at that exact second, it now plays as soon as
  Ether is free, **up to 5 seconds late**, and the log says "CAUGHT UP n s late".
- It **never plays twice** for the same scheduled time — not across a restart either.
- If Ether was held up for **more than 5 seconds**, it does not play late; instead the log says **MISSED … NOT played**,
  and the Health Monitor shows an amber **Announce missed** row. (Before-closing lines also show the amber "skipped"
  mark in the Announcements list, as they already did when the closing time moved.)
- **Stacked announcements play in order** (ruling 2026-10-06; this replaces "only the latest plays"). If several
  come due during one hold-up, **all** of them play, one after the other in time order. A line that comes due while
  another announcement is still playing **waits**, then plays 0.5 s after that play ends. If the one playing is a
  "Play ×N" line, the play on air finishes, its **remaining repeats are cancelled** (logged), and the new line plays
  next (the October 4 rule, re-affirmed 2026-10-06).
  Announcements never cut each other off. While it waits, its Up Next row reads **NEXT — after current** (or
  **WAITING #2**…). The log line says how late it started and why.

## How to test it yourself — dev, on a machine that is NOT on air

You need a way to make Ether "busy" at an exact second. Windows can **freeze a process** and unfreeze it: that is
exactly a main-process stall, and it doesn't touch the audio daemon (a separate process), so audio keeps playing.

### Setup (once)
1. In a terminal: `cd C:\openair` then `git switch fix/aftersign-announce-catchup` then `npm run electron:dev`.
   Keep this terminal visible — every announcement line prints there as `[STARTUP] [announce] …`
   (the same lines go to `%APPDATA%\Ether\ether-startup.log`).
2. On the board, press **+** and choose **Announcement** for one channel; fader up, channel ON.
3. Open **Announcements**, add a short announcement audio file (a 3–5 s clip is easiest).
4. Find the **main process id** — in PowerShell:
   ```
   Get-CimInstance Win32_Process -Filter "name='electron.exe'" | Where-Object { $_.CommandLine -match 'electron/main.js' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId
   ```
   (The daemon's command line contains `ether-audiod.js`; the renderers contain `--type=renderer`. You want the one
   that is neither.)
5. Open **Resource Monitor** (`resmon`) → **CPU** tab → find that PID → right-click gives **Suspend Process** and
   **Resume Process**. That is the stall.

For each test, schedule a fixed-time line for **today** in the Announcements schedule board, with seconds, about
1–2 minutes ahead. Watch a clock with seconds (Windows clock, or the Ether header).

| # | Test | Do this | Expect |
|---|---|---|---|
| 1 | **On time** | Do nothing | Plays on its second. Log: `scheduled fire station N "…" at HH:MM:SS (absolute)` — no "CAUGHT UP" |
| 2 | **Late, within the window** | Suspend ~2 s before it is due; Resume ~3 s after | Plays the moment you resume. Log: `… — played 3s late (the scheduler was held up; window 5s)`. Health Monitor: green **Announce caught up** |
| 3 | **Late, beyond the window** | Suspend ~2 s before; Resume ~10 s after | **Does not play.** Log: `[announce] MISSED station N "…" due HH:MM:SS — the scheduler did not reach it until 10s late (catch-up window 5s). NOT played.` Health Monitor: amber **Announce missed** |
| 4 | **No double fire** | Let a line play on time (test 1), then watch for 30 s | Exactly one fire line; it does not play again |
| 5 | **Several in one stall — play in order** | Two lines due 2 s apart (e.g. :00 and :02), clips a few seconds long. Suspend 1 s before the first; Resume 4 s after the first | **Both play, first then second**, the second starting ~0.5 s after the first ends, never over it. Log: `scheduled fire … "first" … played 4s late (the scheduler was held up …)`, then `QUEUED … "second" … plays next in line (#1)`, then `scheduled fire … "second" … played Ns late (waited for the announcement before it)` |
| 6 | **Restart after it played** | Let a line play; fully quit Ether (tray → Quit, then stop `npm run electron:dev` with Ctrl+C); start it again | It does **not** play again after the relaunch |
| 7 | **Restart while it was due** | Quit Ether ~5 s before a line is due; start again right away | Relaunch takes longer than 5 s, so expect `MISSED … NOT played` (it came due while Ether was off, within the 10-minute look-back) — not a late play. Restarting inside the 5 s window itself is covered by the unit test (`announce-catchup.test.js` "restart mid-window") because a real relaunch is slower than that |

Health Monitor: hamburger → Health Monitor → timeline. The rows are `Announce caught up` (green), `Announce missed`
(amber), `Announce fire failed` (red).

**UNVERIFIED until you run it:** whether freezing the main process for ~10 s makes anything else complain (the daemon
connection, the watchdog). In dev the watchdog does not run. If the board shows a daemon reconnect after Resume, note it —
it's a side effect of the freeze method, not of this change.

### Testing the installer instead of dev
Same steps on a non-air machine after installing `Ether Setup 4.6.59.exe` (unsigned — SmartScreen "Run anyway").
The process to freeze is `Ether.exe` (the one whose command line has no `--type=`), and the log is
`%APPDATA%\Ether\ether-startup.log`.

## Testing the Up Next announcements and the heads-up (added 2026-10-06)

Same setup as above (dev or the installer, a machine NOT on air, an Announcement channel patched). Open the
**Up Next** window too (menu bar **Tools → Monitors → Queue / Up Next**) so you can check both places.

| # | Test | Do this | Expect |
|---|---|---|---|
| 8 | **Listed with time + countdown** | Add a fixed-time line for today ~5 min ahead, and a **before-closing** line (set tonight's closing time so it lands ~8 min ahead) | Both appear in Up Next (main window and Up Next window) **among the songs at the place they land**, each with the megaphone, the word **ANNOUNCEMENT**, the time, and **"in m:ss"** counting down every second. The before-closing line shows too (it didn't before) |
| 9 | **Edits show at once** | Change the fixed line's time, or delete it | The row moves or disappears within a second or two (not 30 s) |
| 10 | **Heads-up at 60 s** | Wait for the line | At 60 s before: a strip at the top of the main window **and** the Up Next window: ANNOUNCEMENT · countdown · title · time. Keep typing in a text box while it appears: **focus doesn't move**, no dialog, and clicks on whatever is under the strip still work. At its second it reads **DUE NOW**, then disappears once it has played |
| 11 | **Dismiss** | Press the strip's ✕ | It goes for that announcement; the next one still gets its own heads-up |
| 12 | **The lead is a setting** | ☰ → Preferences → **Announcement heads-up** → 120, Enter | "Now: 120 s". The next strip appears 2 minutes ahead. Set **0** → no strip at all, but Up Next still lists the rows. Set back to 60 |
| 13 | **Playing late** | Repeat test 2 (freeze ~2 s before, resume ~3 s after) | The row reads **PLAYING LATE +3s** (amber) while it plays, then leaves the list |
| 14 | **Missed** | Repeat test 3 (freeze ~2 s before, resume ~10 s after) | The row stays, **red and struck through**: **MISSED — not played**. It drops off 10 minutes later. A before-closing line reads **SKIPPED — not played** |
| 15 | **Stacked on time — no cutting off** | A line with a ~20 s clip due at :00, a second line due at :05 (no freezing) | The first plays its full 20 s. The second **waits** (its row reads **NEXT — after current**, the heads-up stays up), then plays at ~:20.5. Log: `QUEUED … plays next in line (#1)` and `… played 15s late (waited for the announcement before it)`. Health Monitor: green **Announce waited** |
| 16 | **A line due during a "Play ×3" run** | A line set to play ×3 with a ~4 s clip at :00; another line at :05 (it comes due during the 2nd play) | The 2nd play **finishes** (nothing is cut mid-play), the 3rd play does **not** happen, and the new line plays ~0.5 s after the 2nd play ends. Log: `… "…" play ×3: remaining 1 repeat(s) CANCELLED — "…" is due; the play on air finishes, then it plays`, then `QUEUED …` and `… played Ns late (waited for the announcement before it)`. With nothing else due, a ×3 line plays all three times |
| 17 | **Hand-fire while one waits** | While a line shows **NEXT — after current**, press Fire on a different announcement in the Announcements panel | The hand-fired one plays at once (your call); the waiting line plays after it ends |
| 18 | **No extra load** | With Up Next open in both places, open `http://127.0.0.1:3400/health` a few times over a minute | `eventLoopLagPeakMs` no higher than with the Up Next window closed. (Countdowns run in the window; main is read every 30 s and on each announcement event, not every second) |

## Proof already run (on this machine)
- **afterSign:** under a CI-like environment carrying pwsh's PSModulePath, the OLD call reproduces the CI error; the
  NEW call gives `Valid` for the CI-signed `Ether.exe` and `NotSigned` for the unsigned `ha-setup.exe`, via both
  `pwsh` and `powershell`. The full rule: signed app + signed helper → checked; signed app + unsigned helper → FAIL;
  unsigned app → unsigned-build (skip).
- **Catch-up rule:** 19 unit tests (on time, late in window, beyond window, no double fire in flight / after stamp,
  several in one stall, restart mid-window before and after the fire).
- **Gates:** `tsc --noEmit` 0 errors · vitest 86 files / 784 tests · test:announce 28/28 · test:closing 40/40 ·
  undefined-calls, window-station, ipc-contract, preload-bridge PASS · packaged release gate PASS.
- **Upcoming view + display rules:** 5 tests on main's view (upcoming / due / missed / skipped / played, look-back)
  and 15 on the renderer rules (countdown, every state's words, playing-late only while its length says it's playing,
  heads-up lead / 0 = off / dismissed). Gates on `e7e65fd`: tsc 0 · vitest 87 files / 804 · test:sync 49/49 ·
  leak-guard 13 = baseline · smokes PASS · packaged release gate PASS; packaged `main.js` contains
  `announcements:upcoming`.
- **Runtime behaviour of the catch-up, the list and the heads-up in the running app: UNVERIFIED** — your tests 1–18
  are the receipt.

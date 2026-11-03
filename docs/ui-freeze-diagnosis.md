# UI freeze when opening/closing panels while on air — diagnosis

**Date:** 2026-10-05 · **Type:** READ-ONLY. Static analysis only; nothing was run or profiled. Items marked **UNVERIFIED** need the performance trace in §4.
**Tree:** `C:\openair` `main` @ `5068390` (4.6.59).
**Symptom (Jeff, live at OV, dual monitors):** while on air, opening or closing panels and windows makes Ether stall briefly. The first click is unreliable, and he has to wait for the cursor to come back.
**Method:** a read-only search agent swept the code. The four load-bearing claims below were re-checked by hand (✔).

---

## 1. What opens during live operation, and what each does

| Surface | How it opens | What it does on open | Cost |
|---|---|---|---|
| **Any hamburger item** | **A pop-out**: every drawer item is one (`App.tsx:2975-2995`) | A **new BrowserWindow** loads the whole app: `dist/index.html#popout/<panel>`, a single **3.34 MB** JS chunk with no code splitting (`main.js:7308-7309`). It runs `Sentry.init`, `stations.list`/`getActive`, then the panel's own loads (`main.tsx:58-110`). It does a synchronous `readFileSync` of `popout-bounds.json` (`main.js:7147`). No `show:false` or ready-to-show, so a blank window appears and then boots (`main.js:7254-7270`). **Closing destroys it**, so the next open pays everything again (no hide-on-close except StudioPro, `:7280-7286`) | High, on every open |
| **Carts** (`BoutiqueCartWall`, pop-out `carts`) | pop-out | Loads `cartSlots.list` once. Then `setVu(l.cart)` on **every levels frame from every station, with no station filter** (`DeckConfigurator.tsx:820-822`), plus a 200 ms interval (`:823-840`) | Continuous while open |
| **Announcements / announcement schedule** | pop-out | Three list calls on mount (`Announcements.tsx:808-843`); no polling | Low |
| **Song requests (Jukebox)** | pop-out (fullscreen) | Polls deck state every 1 s, requests every 3 s, KV every 4 s, deck_configs every 5 s, and the lobby every 5 s (`Jukebox.tsx:383-748`). `setRequests(rows)` always passes a new array (`:652`), which re-runs the lookahead, drive and publish effects about every 3 s | Medium, continuous |
| **Closing time** | Not a panel. It lives inside the Announcements ScheduleBoard (`Announcements.tsx:493`, `:602-611`); Park Ops is the hosted page | — | Low |
| **Up Next** (pop-out `upnext`) | pop-out | **Remounts on every `queue:sync`** ✔ `<UpNext key={rev}>` (`PopoutRenderer.tsx:46-61`). Each remount re-runs about 6 main-process calls (`UpNext.tsx:138-322`): `getActiveShowClock`, `announcement_schedule:list` plus an assets query, `schedule:sweeper-placements` (two `generated_schedule` queries **plus a synchronous `fs.existsSync` per jingle/sweeper row in the next 4 h**, `main.js:9562-9620`), `library-health:queue-lint`, `schedule:playhead-view` | **High**: about 6+ synchronous main calls per second while open |
| **Library dock** (main window, `progPanel==="library"`) | in-window panel | Loads every song (`App.tsx:5243`). Re-filters and re-sorts with `localeCompare` **on every render** (`:5425-5434`, `:5515-5524`). Renders **every row, not virtualized** (`:5966`) | **High** on every App render |
| **Switching main panels** | `setPanel` (`App.tsx:672`; branches `:3123-3239`) | Full App re-render. `panel==="live"` **unmounts LivePanel** when another panel opens and fully remounts it on return, re-running its mount loads | Medium–high |

---

## 2. What can block the renderer thread or the main process (receipts)

**A. The whole App re-renders about once a second, with no memoization** ✔
- `engine.on` does `setDeckA({...st})` / `setDeckB` / `setDeckC` / `setQueueLen` on every deck event, and always creates a new object (`App.tsx:2044-2048`).
- The daemon sends deck events on every status, title or whole-second position change (`audiod/engine.js:906-915`, from its 250 ms poll at `:665`). That's at least 1/s per playing deck, and 2/s in a segue.
- `App.tsx` runs from line 588 to 3595 with about 156 `useState` hooks, and contains **zero** `React.memo` / `memo(` ✔. So every second the live board, header and any docked panel (the Library above all) are fully reconciled.
- `MasterOutput.tsx:495-496` already moved the master level out of App "so the library table doesn't re-render at 30Hz". The same idea was never applied to deck state.
- **Effect on clicks:** a long React commit that happens to land when you click delays the click's handler, so the "first click is unreliable".

**B. The full queue goes to every window on every deck event** ✔
- `App.tsx:2170-2173` emits `ether:broadcast {channel:"queue:sync", data:{len, items: engine.getQueue()}}` on each deck event.
- `main.js:7594-7596` relays it to every other window (a structured clone per window).
- Combined with the Up Next `key={rev}` remount above, that's the main-process query storm.

**C. Main-process synchronous work** (every window's IPC waits behind it)
- Generic `db:query` and `db:execute` are synchronous better-sqlite3 (`main.js:6130-6137`, `6178-6203`).
- **Every 60 s in the main window, `push()` runs** (`App.tsx:1054-1068`, interval `:1085`):
  - `pushLibrary`: the full-library JOIN `ORDER BY title COLLATE NOCASE`, about 5,600 rows and 1–1.5 MB by its own comment (`src/lib/ccData.ts:377-417`), cloned to the renderer and then `JSON.stringify`'d.
  - Plus 5 × `pushCcTable`, `pushJukeboxPool` and `pushOpsData`.
  - **A once-a-minute stall that coincides with a click is a strong candidate** for "sometimes the first click doesn't take". UNVERIFIED.
- `syncCloud` every 20 s (`App.tsx:1157-1163`); `runLibrarySync` every 30 s (`main.js:3266-3281`); the link-state poll every 2 s with a DB query (`main.js:5882-5885`).
- **Schedule generation** (auto-extend every 30 min, `main.js:11359`, plus manual Generate) runs on main in synchronous hour slices (`main.js:9999-10012`). Slice timings go to `health-events.jsonl` as `generate-timing`.
- Renderer warnings are written with `appendFileSync` per line (`main.js:2630-2635`, `logStartup` `:291-297`), so a burst of warnings means synchronous disk writes on main.
- Pop-out bounds: a `readFileSync` plus `writeFileSync` on **every** `moved`/`resized` event (`main.js:7149-7154`, `:7273-7275`). Dragging a window to monitor 2 hammers main. UNVERIFIED magnitude.
- **No `ipcRenderer.sendSync` anywhere in app code** (grep: only `scripts/` and `watchdog/`).

**D. High-rate broadcasts to every window, multiplied by each open pop-out** (`sendToAllWindows`, `main.js:8190-8200`; forwarder `main.js:847-996`)
- Rates: `audio:levels` 10 Hz per station (about 54 keys plus `decks[]`; `audiod/ether-audiod.js:803-810`); `audio:proc-meters` 10 Hz while processing; `audio:meters` 30 Hz per subscribed station; `audio:rta` about 21 Hz while leased; `audio:daemon-deck` ≥1 Hz per playing deck.
- Main parses each line once, then clones once per window, so the cost grows with stations × windows. UNVERIFIED magnitude.
- **PopoutFaders** (the Decks pop-out) does `setDecks({...})` every 250 ms whether or not anything changed (`PopoutRenderer.tsx:143-156`).
- Side bug: that pop-out's engine never calls `init()`, so its deck state may not update at all (cf. `App.tsx:2030`).
- The meter bus itself is done right: meterStore keeps frames outside React and draws with requestAnimationFrame.

---

## 3. Is audio isolated from these stalls?

**Rotation playout: yes.**
- The daemon is a **separate process**: `ether-engine.exe`, spawned with `ELECTRON_RUN_AS_NODE=1`, detached in packaged builds (`electron/audio-daemon-client.js:141-152`, `:38-45`).
- It talks over the named pipe `\\.\pipe\ether-audiod` (`:20-28`), and its broadcast writes don't block on a stalled main (`ether-audiod.js:155`).
- **It owns the queue, advance, preload, end-detection, refill and segue** (`audiod/engine.js:1-14`): a 250 ms poll (`:536`), `poll()` (`:621-700`), and advances serialized in `_advance` (`:1008`).
- The renderer engine only mirrors state in daemon mode: `checkEndByPosition` returns early when `daemonDriven` (`engine-rodio.ts:814`; gate `:767`), and preload/refill are no-ops (`:920`, `:940`, `:957`).
- **The daemon writes the play log.**

**Not isolated (these do depend on UI responsiveness):**
1. **Fixed-time announcements fire from the MAIN process, with an exact-second match** ✔
   - `announceTick` runs every 250 ms and skips unless `due === hhmmss` (`main.js:4932`). Repeats run on main `setTimeout`s (`:4969-4986`).
   - **If main is blocked through the entire due second, that announcement is missed and never retried.** A ≥1 s main stall is enough: a 60 s `push()`, a generation slice, a burst of synchronous queries.
   - **This is the one item where a UI stall can change what goes to air.** High priority. Whether it has actually happened at OV is UNVERIFIED; the log line to look for is an announcement with no "fired" entry at its time.
2. **The Jukebox's next pick is made in the jukebox pop-out's renderer** (`Jukebox.tsx:595-644`, 1 s poll `:563`). A stall, or Chromium throttling a covered or minimised window (`backgroundThrottling` is left at its default), lengthens gaps between jukebox songs. UNVERIFIED for the covered-window case.
3. **Park Ops phone cart fires and web-remote commands** go through the main window's renderer (`App.tsx:1789-1792`, cart `:1594+`), so they wait out a stall.
4. **Operator clicks** (deck ON, cart, AUTO) go renderer → main → pipe, and are delayed by whichever is stalled.
5. **In-process fallback:** if the daemon isn't attached, the renderer *is* the playout driver (`App.tsx:2055-2059`). Check `rotation.log` for "daemon-driven: local advance DISABLED".
6. **The shared database:** the daemon uses synchronous `node:sqlite` with `busy_timeout = 5000` (`ether-audiod.js:190-191`). A long write transaction in main (a generation commit, a library sync) could block the daemon's loop, and so its poll and segue timing, for up to 5 s. UNVERIFIED.

---

## 4. Measure it yourself (a machine that is NOT on air)

**Setup:** install the same build OV runs. Load a station with a realistic library (OV's size, about 5,600 songs). Start automation so decks are playing. Put the second monitor in place.

**A. Built-in main-process lag meter (no tools needed)**
1. In a browser on the same machine, open `http://127.0.0.1:3400/health`.
2. Note `eventLoopLagMs` and `eventLoopLagPeakMs` (`main.js:3962-3963`; the peak is the worst in the last ~60 s).
3. Open and close each pop-out (Carts, Announcements, Jukebox, Up Next, Decks), drag one to monitor 2, wait a minute, and refresh `/health`. A peak above ~100 ms means main is stalling; above 1000 ms means an announcement could be missed.

**B. DevTools Performance trace (renderer)**
1. In the main window press **F12** (Toggle DevTools, `main.js:2864`), then open the **Performance** tab.
2. Tick **Screenshots**. Under ⚙ set **CPU: No throttling**.
3. Press **Record** (●), then, ~3 s apart:
   - open the Library dock
   - open the Carts pop-out
   - close it
   - open Up Next
   - close it
   - open Announcements
   - switch the main panel away from Live and back
4. Press **Stop** after ~30 s.
5. **What to look for:**
   - **Long tasks**: red-cornered bars in the Main track, over 50 ms.
   - Click one and check **Bottom-Up / Call Tree** for React commit functions (`commitRoot`, `performSyncWorkOnRoot`), `localeCompare`, `JSON.parse`/`structuredClone`, or `ipcRenderer` callbacks.
   - Regular ~1 s spikes while nothing is clicked point to cause 2A.
   - A spike every 60 s points to cause 2C (`push()`).
6. **Export:** right-click in the timeline, or use the ⤓ **Save profile** button → `ether-trace-<panel>.json`. Send the file (it opens in any Chrome DevTools).
7. **Pop-out windows:** focus the pop-out and press **F12** in it (F12 targets the focused window, `main.js:2864-2867`), then record the same way. That shows its own boot cost and the Up Next remount loop.

**C. React re-render check (optional)**
- In DevTools ⚙ → Rendering, tick **Paint flashing**. With decks playing, the whole board flashing about once a second confirms 2A.

**D. The Up Next effect, without tools**
1. With decks playing and Up Next **closed**, read `/health` `eventLoopLagPeakMs` twice, a minute apart.
2. Open the Up Next pop-out, wait a minute, and read it again.
3. A clearly higher peak with Up Next open confirms cause #2.
4. For the call count itself, F12 inside the Up Next window → **Performance**, record 5 s, and look for one remount per second.

**E. Generation slices**
- Open `%LOCALAPPDATA%\Ether\…\health-events.jsonl` (the Health Monitor ledger) and find `generate-timing`. Look at `max` / `p95`.

---

## 5. Likely causes, ranked, with fixes and blast radius

| # | Cause | Confidence | Fix (not applied) | Blast radius |
|---|---|---|---|---|
| **0** | **A missed announcement during a main stall** (on-air, not cosmetic) | Mechanism ✔; occurrence UNVERIFIED | Give `announceTick` a **catch-up window**: fire if `due` is within the last N seconds and not yet played, keyed on the existing `last_played_at` guard. Later, move announcement firing into the daemon | Small and local to `main.js:4869-4957`, covered by the existing announce smoke tests. **Recommend first.** |
| 1 | The whole App re-renders on every deck event, with no memo (2A) | High ✔ (cost UNVERIFIED) | Move deck and queue state out of App into a store read via `useSyncExternalStore`. `React.memo` LivePanel, the docks and the header. Only setState when a field actually changed | Medium: App.tsx structure. Pure UI, no engine contact. Needs a careful regression pass of the live board |
| 2 | The Up Next pop-out remounts every second, plus the queue broadcast (2B / §1) | High ✔ | Drop `key={rev}`; update the queue in place. Send `queue:sync` only when the queue actually changed, and throttle it. Cache `sweeper-placements` | Small: `PopoutRenderer.tsx`, `UpNext.tsx`, one emit in App |
| 3 | The Library dock re-sorts and re-renders thousands of rows every render | High (when docked) | `useMemo` the filter and sort; virtualize with the existing `grid/DataGrid.tsx` | Small–medium: library dock only |
| 4 | Pop-out cold boot: a new full renderer per open, destroyed on close | High for the "on open" stall | `show:false` + ready-to-show. **Hide instead of destroy** for live-assist panels (or pre-create them hidden). Split the bundle so pop-outs don't load all of App | Medium: `main.js` pop-out lifecycle. Hidden windows still receive broadcasts, so pair this with #5 |
| 5 | Broadcast fan-out to every window (levels from all stations, 250 ms PopoutFaders ticks, the unfiltered cart VU) | Medium (UNVERIFIED magnitude) | Station-filter the cart wall's `setVu`; only setState on change in PopoutFaders; let windows subscribe to the channels they need (like the meter lease already does) | Small per component |
| 6 | The 60 s `push()` library snapshot + synchronous DB on main | Medium (fits "sometimes") | Push the library only when it changed (hash), or move the snapshot to a worker or the daemon. Async/batched queries for the bulk lists | Medium: the cloud-mirror path. Must keep the Control Center mirror correct |
| 7 | Synchronous bounds file I/O on every move/resize | Low–medium | Debounce `savePopoutBounds` (e.g. 500 ms after the last move); keep the bounds in memory | Tiny |
| 8 | Generation slices on main | Low (only while generating) | Already sliced. Move to a worker or the daemon later | Larger, separate arc |

**Suggested first batch** (low risk, likely the most of the perceived stall): **#0, #2, #5, #7**, and the `setDeck` "only on change" part of #1. That's all small and UI-local, except #0, which is the on-air fix. Then #3 and #4. Then the larger #1 restructure and #6.

---

**Temporary tooling:** none. Nothing was run.

**Stop.** Awaiting Jeff's review and GO.

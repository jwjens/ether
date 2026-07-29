# Show+ — one place at a time: popout OR deck slot (design of record, 2026-07-29, rev 3)

> ### ⚠ REV 3 — FALSE PREMISE CORRECTED. Read `docs/showplus-popout-premise-correction-2026-07-29.md` first.
>
> Rev 1 and rev 2 asserted that **Window → Monitors → Show+ (`main.js:1863`) is "a door onto a wall"** that renders
> *"Unknown pop-out panel."* **That was never verified at runtime** — it was inferred from a grep of `PopoutRenderer`.
> It is marked **UNVERIFIED** throughout and must not be built against until checked.
>
> Established since (tree receipts, §3 of the correction):
> - **Tools → Show+ (`main.js:1846`) is NOT a popout.** It sends `nav:videostudio` → `App.tsx:972` → the full
>   right-panel surface at `App.tsx:2615`, **inside the main window**. That is the full working Show+ Jeff uses.
> - Two different menu items are both labelled "Show+" (`main.js:1846` Tools, `:1863` Window → Monitors) on two
>   different mechanisms. They were conflated.
> - **Sequencing constraint this creates:** §1.1 lists the full right-panel surface for deletion — and that surface
>   *is* Tools → Show+. It cannot be deleted until a popout that genuinely renders Show+ exists and `main.js:1846` is
>   repointed. See §7.
>
> **Product corrections, treat as requirements:** the SOURCES list is deliberate behaviour (screen-only shows, camera
> optional, sources added/removed at will, more than one local camera); **`+ Camera` is not a defect and is neither
> removed nor restricted**; the only defect is the *silent* collision when the same physical camera is opened twice.
> The end state is **one open shared by reference** (`docs/showplus-device-layer-design-2026-07-27.md`), **not
> refusals**. Phase 1's refusal message is a **stopgap** — labelled as such in §2.

**STATUS: DESIGN ONLY — build nothing from this doc yet.** Written after the read-only trace in
`docs/showplus-host-outbound-and-two-surfaces-trace-2026-07-29.md` established that Show+ is currently two
independent implementations that actively fight each other. This supersedes and extends that trace's §10.

**Requirement, taken as given:** Show+ is ONE thing with multiple mounting points, never a copy. Same rule as
`ether-audiod` — one owner, thin front-ends.

> ### REV 2 — 2026-07-29. Jeff's decision, supersedes the deck-slot-as-view model
>
> **Show+ is live in exactly ONE place at a time — the deck slot OR the popout. The user picks. Never both.**
>
> - Whichever surface is open **IS** Show+: full stage, full quality, all controls. There is **no mirror, no
>   thumbnail, no second copy, and no pixel pipe across processes.**
> - The surface that is not active shows an honest state — *"Show+ is open in the pop-out window"* / *"…in the deck"* —
>   with a button to switch to it or bring it to front.
> - Opening Show+ where it is not currently live **prompts first**: moving it ends the current session. Same
>   confirmation logic as closing — **reused, not a second dialog**.
> - **Deleted from this design by rev 2:** the ownership model, the election, any handoff, the thumbnail pipe, and all
>   cross-process stage transport. §4 and §5 below are rewritten to say so; the earlier options survive only as a
>   record of what was rejected and why.
> - Unchanged by rev 2: the full-panel deletion (§1), the Phase-1 camera work (§2, now built), the popout plumbing
>   (§3), and the close confirmation (§6).

**Decisions already made, not re-opened here:**

- The full right-panel Show+ surface (`App.tsx:2615`) is **deleted**.
- Two mounting points remain: the **POPOUT** (primary operating surface, second monitor) and the **DECK SLOT**
  (`App.tsx:3912`). **Exactly one is live at any moment.**
- Whichever surface is live owns the WebRTC session, camera acquisition, and the video engine — because it is the only
  one that exists. There is nothing to arbitrate between.
- **NO HANDOFF.** Closing the live surface — or moving Show+ to the other one — ends the video session and drops
  guests. Intended. No ownership trading, no device release/re-acquire, no reconnection machinery — that is the hazard
  class parked as the shadow-daemon handoff (`docs/backlog.md`, PARKED INDEFINITELY).
- The inactive surface shows an honest state with a button, never a dead black stage.

---

## 1. Deletion list

### 1.1 The full-panel mount and its tree

| What | Where | Note |
|---|---|---|
| The mount | `App.tsx:2614-2616` — the always-mounted `<div style={{display: panel === "videostudio" ? "flex" : "none"}}>` wrapper + `<VideoStudio active={panel === "videostudio"} />` | Also delete the stale comment at `:2612-2613` ("always mounted so WebRTC state stays alive") — that rationale dies with it |
| Its `HostCamera` mount | `ShowPlus.tsx:2696-2708` — the `display:none` wrapper + `<HostCamera>` | **This is the second camera opener.** See §2 |
| The whole full-panel return | `ShowPlus.tsx:2678-2808` | Not deleted so much as **relocated**: this subtree becomes the popout's body (§3) |
| Nav entry to the panel | `main.js:1846` `{ label: "Show+", click: () => send("nav:videostudio") }` (Tools) | Repoint to the popout, or remove — see §3 |
| The `videostudio` panel route | `App.tsx` panel switch (the `panel === "videostudio"` key) | Any remaining reference to that panel id |

**Not deleted — relocated into the popout:** `DestinationsSection` (`:2742`), `ShowPlusPanel` (`:2314`, used `:2743`),
`VideoEnginePanel` (`:2766`), `SourcesPanelWithEngine` (`:2769`), `EncoderSection` (`:2781`), `StatusBar` (`:2787`),
`CaptionsOverlay` (`:2800`), `VideoEngineCanvas` (`:2691`), `GuestEngineSync` (`:2495`, mounted `:2679`). These are the
popout's content. Deleting the *mount* must not delete the *rooms*.

### 1.2 The per-instance session machinery that stops being per-instance

| What | Where | Why it goes |
|---|---|---|
| Second `useWebRTCGuests` call | one per `ShowPlus` instance, `ShowPlus.tsx:2586` | With one owner there is one call, one socket |
| Second WebSocket | `ShowPlus.tsx:425` (per instance) | Two sockets on one token is the eviction bug (§2) |
| Module-level session token | `ShowPlus.tsx:29-33` `SHARED_SESSION_TOKEN` / `SHARED_ROOM_CODE` | **Keep the constant, but its cross-instance hazard disappears.** UNKNOWN whether a popout in a *separate renderer process* re-evaluates this module and mints a *different* token — it will, because each BrowserWindow is its own JS context. That is fine with one owner, and fatal with two. Note it as a constraint, not a bug to fix now |

### 1.3 Duplicate markup in `EmbeddedStudio` (replaced by shared components)

| Duplicate | Where | Replaced by |
|---|---|---|
| Inline guest tile | `ShowPlus.tsx:2129` | `GuestGridTile` `:2212` |
| Pending-guest card | `:2114-2123` | shared with `:2410-2425` |
| TURN status line + Accept gate | `:2101-2113`, `:2118-2120` | one copy (removes the duplication introduced in 4.4.97) |
| Invite block (link/Copy/room code/QR/e-mail) | `:2085-2097` | one extracted `InviteBlock` |
| Inline teleprompter (textarea + sliders) | `:2142`+ | `TeleprompterPanel` `:1211` |
| Its `HostCamera` mount | `:2034` | none — the deck slot stops acquiring devices entirely (§2) |
| Its `AudioPanel` mount | `:2180` | **keep** — already one component, two mounts (`:2180`, `:2470`). The pattern to copy |

### 1.4 Dead code to remove while in there

| What | Where | Evidence |
|---|---|---|
| `GuestTile` | `ShowPlus.tsx:1000` | Only caller is `GuestSidebar` |
| `GuestSidebar` | `ShowPlus.tsx:1136` (guest lists `:1188`, `:1197`) | No call site — `grep "<GuestSidebar"` → 0 |
| `GuestVideoPanel.tsx` | whole file | No importer — `grep -rl GuestVideoPanel src/` returns only the file itself |

Both dead tiles carry the missing-`muted` autoplay trap; deleting them removes a trap as well as bytes.
`ShowPlus.tsx` is 2,810 lines today; §1.3 + §1.4 remove roughly 400 of them without touching behaviour.

---

## 2. Does deleting the full panel end the recvonly bug by itself?

**Partly — and the honest answer is NO, not on its own.** It ends two of the three mechanisms. The third is the one
the evidence actually points at.

| Mechanism | Ended by the deletion? | Receipts |
|---|---|---|
| **(a) Two `HostCamera` mounts fight over one camera** | **YES.** Deleting `ShowPlus.tsx:2696-2708` leaves one opener | `:2034` vs `:2698`; single-open camera per `VideoEngineContext.tsx:489-495` |
| **(b) Two sockets on one token → server evicts one** | **YES.** One owner, one socket | `:425`; server closes the incumbent: `if (session.hostWs && session.hostWs !== ws) session.hostWs.close(1000,'Replaced')` |
| **(c) `HostCamera` vs the `+ Camera` engine source** | **NO. Untouched.** | `VideoEngineContext.tsx:507-510` performs its own `getUserMedia({audio:false, video:{deviceId:{exact}}})` |

**Why (c) is the one that matters here.** The trace established that the camera visible on the canvas cannot have been
the host stream: `GuestEngineSync` skips registering `"host"` whenever `hostStream` is null
(`ShowPlus.tsx:2505-2512`), and the recvonly log proves it was null. So the visible camera was an engine `+ Camera`
source — which means that source held the physical device, which is precisely what makes `HostCamera`'s open throw at
`ShowPlus.tsx:769`/`:771` → `catch` at `:781` → `onStream(null)` → recvonly at `:559-562`.

**Therefore Phase 1 is the deletion PLUS two small things** (sized in §7):

1. **Make the failure speak.** `ShowPlus.tsx:781` currently does `catch { setError(e.message); onStream(null); }` with
   **no console output**, and the error UI it writes to is inside the `display:none` wrapper (`:2696`) added by 4.4.94
   (`debbc9c`). Every future diagnosis of this class is blind until that line logs and the state is surfaced.
2. **Resolve host camera vs `+ Camera` on the same device — STOPGAP ONLY (rev 3).** The 4.4.95 guard
   (`VideoEngineContext.tsx:496-506`) blocks the reverse direction, but only by matching a registered `"host"` source,
   which does not exist while `hostStream` is null. Phase 1 (built) adds an ordering claim so the host camera acquires
   first, and **refuses** a `+ Camera` add for the same device (`VideoEngineContext.tsx:514-528`).
   > **This refusal is a stopgap and must not be mistaken for the design.** The SOURCES list is deliberate product
   > behaviour — screen-only shows, camera optional, sources added and removed at will, more than one local camera —
   > and **`+ Camera` is neither a defect nor a thing to restrict.** The only defect is the *silent* collision when the
   > same physical camera is opened twice and Windows grants one. **The end state is ONE open, shared by reference to
   > every consumer** — the acquisition service in `docs/showplus-device-layer-design-2026-07-27.md`. A refusal trades
   > a silent failure for a visible "no"; the product wants "yes, same handle." Correct the guard's code comment when
   > that file is next legitimately open.
   >
   > **It also cannot work across windows.** The claim is a module-level variable
   > (`VideoEngineContext.tsx:236-256`); a popout is a separate renderer process with its own module instance, so two
   > windows have two unrelated claims. Cross-process device arbitration needs the acquisition service, not a flag.

Also worth stating plainly: **the deletion alone cannot restore host audio even if the camera opens**, because the
only outbound audio path is the mic track inside `hostStream` (`ShowPlus.tsx:552-558`), and MIC VOL never reaches it
(`:1853-1859`, monitor-only). Camera fixed → audio follows automatically, because both ride the same stream.

**Size:** small. One mount deleted, one `catch` given a voice, ordering established. No new components, no IPC, no
transport. This is a day, not a week — and it is the whole of "get the host transmitting again".

---

## 3. The popout — how it is created and registered

### The precedent (ride it, do not invent)

| Piece | Where | What it does |
|---|---|---|
| `window:popout` IPC + `openPopoutWindow(panel)` | `main.js:3888`, loads `#popout/<panel>` (`:3938-3939`) | Frameless `BrowserWindow`, deduped by title (`:3889`), placed on the secondary monitor if present (`:3975-3977`) |
| `POPOUT_SIZES` | `main.js:3858` | **Already has `"videostudio": { width: 1024, height: 640 }`** |
| Bounds persistence | `main.js:3865-3871`, `:3923` | Remembers size/position per panel |
| `PopoutShell` | `src/components/PopoutShell.tsx` | Frameless titlebar + close X (`:76` → `window.close()`); exports `PopoutBtn` |
| `PopoutRenderer` | `src/components/PopoutRenderer.tsx` | Routes `#popout/<panel>` → component; title map `:50-59`; cases `:102-144` |
| Menu | `main.js:1861` Monitors submenu; **`:1863` `{ label: "Show+", click: () => popout("videostudio") }` already exists** | |
| Cross-window relay | `main.js:3983` `ipcMain.on("ether:broadcast", …)` → fans to all other windows | Small JSON only |

### The `videostudio` popout route — UNVERIFIED (rev 3)

**What the tree says:** `main.js:1863` opens a `videostudio` popout loading `#popout/videostudio`
(`:1791-1792`) → `main.tsx:59, 96` → `PopoutRenderer`, which has no `case "videostudio"`, no title-map entry
(`:50-59`), **no import of `ShowPlus`/`VideoStudio` at all** (`grep -c` → 0, imports at `:4-19`), and no
`React.lazy`/dynamic `import()`. Its default branch (`:145-149`) renders *"Unknown pop-out panel: …"*.

**What the tree cannot say: what the operator sees.** Rev 1/2 asserted this was a dead door. **That was never run.**
Jeff reports a popout containing the full working Show+ — but his check was **Tools → Show+ (`main.js:1846`), which
is a panel switch inside the main window, not this route** (see the rev-3 banner). The two entries are both named
"Show+".

**STATUS: UNVERIFIED. One check settles it —** open **Window → Monitors → Show+** specifically and report what
appears. Until then this design assumes nothing about it, and §7 branches on the answer. If it does render Show+,
some route exists that `PopoutRenderer.tsx` cannot account for, and that route must be found before anything is built
on top of it.

**Separately, and independent of the answer:** two menu items with the same label doing different things
(`main.js:1846` vs `:1863`) is its own product defect. Filed here; not fixed.

### Do popouts share state today?

**No — and this is the load-bearing constraint.** Each popout is a separate `BrowserWindow` with its own renderer
process and its own JS context; `src/main.tsx boot()` routes `#popout/*` to `<PopoutRenderer>` **only, never `<App>`**
(`main.tsx:95`, per `docs/studiopro-popout-window-design-2026-07-20.md`). Nothing is shared by reference: not React
state, not refs, and **not `MediaStream` objects**. The only channels are IPC (`ether:broadcast`, `main.js:3983`) and
the database. The `StudioPro` popout is the working precedent for "owns its own thing, talks over IPC"
(`PopoutRenderer.tsx:142`, `StudioProPopout` `:63`).

Consequence for this design: the popout owning the engine is not a preference, it is forced. Whichever window holds
the `MediaStream`s is the only window that can composite them.

---

## 4. The stage does not cross the process boundary — because it never has to

**REV 2 supersedes this section's earlier content.** With Show+ live in exactly one place, there is no second surface
rendering a stage, so there is nothing to transport. The live surface composites locally at full quality and full
frame rate, whether it is the popout or the deck slot. **Latency and quality are non-issues by construction, not by
optimisation.**

Deleted from the design, recorded here only so the decision is not re-litigated:

| Rejected | Why it is gone |
|---|---|
| Low-fps bitmap preview into the inactive surface | There is no inactive *stage* — the inactive surface shows a sentence and a button |
| Local WebRTC loopback between windows | A second peer-connection lifecycle inside the app, for a picture nobody needs |
| Encoded chunk relay (`MediaRecorder` → `MediaSource`) | 1-3 s latency, and moot |
| Native `BrowserView` overlay on the deck region | Fights panel scroll/resize/z-order, and moot |

**The one constraint that made all of that hard still holds and is worth keeping written down:** `MediaStream` is not
structured-cloneable and cannot cross an Electron IPC boundary; only pixels or encoded bytes can. That is precisely
*why* one-place-at-a-time is the right call rather than a compromise — it removes the constraint instead of paying it.

**`VideoEngineContext.tsx:654,660`** (`buildRecorder`, canvas capture track + one source audio track) remains what it
always was: the feed for **local** recording and RTMP inside whichever surface is live. It was never a bridge and is
not one now.

---

## 5. What crosses between the surfaces

**Almost nothing — one fact, plus commands.**

| Payload | Shape | Direction | Source of truth |
|---|---|---|---|
| **Where Show+ is live** | `{live: "popout" \| "deck" \| null, since}` | main → all windows | **Main process** (§5.1) |
| **Live-work state** (for confirmations) | `{recording, dests:[{id,name,status}], guests:N}` | live surface → main, on change | live surface + main (§6) |
| **Commands** | `showplus:open-here`, `showplus:focus`, `showplus:close` | inactive surface / menu → main → live surface | — |

**What no longer crosses at all:** stage pixels, any `MediaStream`, guest video or audio tracks, the guest roster, the
scene/layer geometry, `turnState`. The inactive surface does not render guests, so it does not need to know about
them. The rev-1 mirroring table is deleted.

### 5.1 Where "which surface is live" lives

**The main process, and only there.** It is the one participant that outlives every window, already creates and
dedupes popout windows (`main.js:3888`, dedupe by title `:3889`), and already fans state to all windows
(`sendToAllWindows`, e.g. `:648`). A renderer cannot hold this: the deck slot's copy would be wrong the moment the
popout crashes, and the popout's copy dies with it.

Shape: a single module-level value in main, `_showPlusLive: "popout" | "deck" | null`, with

- `ipcMain.handle("showplus:claim", (e, where) => …)` — returns `{ok:true}` or `{ok:false, live:"popout"}` so the
  caller can prompt (§6.2);
- `ipcMain.handle("showplus:release", …)` — the live surface relinquishing on close;
- `sendToAllWindows("showplus:live", {live, since})` on every change — drives every honest-state panel;
- `ipcMain.handle("showplus:where", …)` — a cold read for a surface that just mounted.

**Crash safety, and the reason main must own it:** the popout window's `close`/`closed` handler in main clears the
claim unconditionally. If the popout dies without a clean release, the claim still clears, and the deck slot's Open
button works on the next click rather than being locked out by a stale flag. Same for a renderer reload in dev.

**This is not an election and not a handoff.** Nothing negotiates, nothing migrates, no device is released and
re-acquired for a running session. It is one flag saying which window may mount Show+, plus a prompt when the answer
would change.

---

## 6. Confirmations and honest state

### 6.1 Closing — read live state, not remembered state

| Consequence | Where the truth lives | Note |
|---|---|---|
| **Live stream to a destination** | Renderer: `dests[]` with `status:"live"` (`ShowPlus.tsx:1321`, updated `:1339-1372`). Main: the ffmpeg child behind `studio:rtmp:start` (`main.js:4455`), `:chunk` (`:4534`), `:stop` (`:4539`) | **Prefer main.** Renderer state dies with the window being closed; main's process state is the fact |
| **Recording** | Renderer `isRecording`; main's writer behind `studio:record:start` (`main.js:4553`), `:chunk` (`:4561`), `:stop` (`:4566`) | Same reasoning |
| **Guests connected** | `guests.filter(g => g.status === "accepted").length` (`ShowPlus.tsx:2358`) | Count only |
| **Icecast — the reassurance** | `stream:status:global` `{anyLive, liveCount}` (`main.js:648`), from the **audio daemon**, fanned by `sendToAllWindows` | Entirely independent of any renderer window. Closing the popout cannot touch it |

Two defects this must design around, both cited rather than fixed here:

- **`studio:rtmp:start` (`main.js:4455`) destructures only `{url, key}` and `studio:rtmp:stop` (`:4539`) takes no
  arguments**, while the renderer passes `destId` (`ShowPlus.tsx:1343`, `:1359`). The multi-destination UI
  (`:1309-1321`) is not matched by multi-destination main-process state. **UNKNOWN how many concurrent RTMP sessions
  main actually supports** — reading it, exactly one. The dialog can only name what main can report.
- **`studio:rtmp:stopped` is sent to `mainWindow` only** (`main.js:4514`, `:4524`). Once Show+ lives in a popout, that
  event never arrives. Must become `sendToAllWindows` or a targeted send.

### The dialog

**If nothing is active — no dialog. Close immediately.** Training the operator to click through a prompt is how the
prompt stops working on the day it matters.

Otherwise, built from live state, **ordered by severity, naming only what is actually true**:

```
┌──────────────────────────────────────────────────────────────┐
│  Close Show+?                                                │
│                                                              │
│  ⛔  Your live stream to YouTube will END.                    │
│      Viewers will see the stream stop.                       │
│                                                              │
│  ⏺  Recording will stop and be saved.                        │
│                                                              │
│  👥  2 guests will be disconnected.                          │
│                                                              │
│  ✓  Your Icecast audio stream keeps running. The station     │
│     stays on the air, mics stay live, and listeners hear     │
│     no change. Only the video side ends.                     │
│                                                              │
│              [ Keep Show+ open ]   [ Close Show+ ]           │
└──────────────────────────────────────────────────────────────┘
```

Rules:

- **Severity order is fixed:** live stream → recording → guests. A live stream is a public, irreversible event; guests
  can rejoin from the same link.
- **Only live rows appear.** No destination live → no stream row. Not recording → no recording row. No guests → no
  guest row. The Icecast reassurance line **always** appears when the dialog appears.
- **Name the destination** ("live stream to YouTube"), from `dests[].name` (`ShowPlus.tsx:1317-1321`). Multiple live →
  list them.
- **Never the bare word "broadcast."** In Ether that reads as the station. Use "live stream to <destination>" and
  "video". The guest page's own `<h1>Join the broadcast</h1>` is a separate surface and out of scope here.
- **Default is the safe action** — "Keep Show+ open" focused; destructive button never the default.

### 6.2 Moving Show+ — the SAME dialog, one verb changed

Opening Show+ where it is not currently live is the same event with the same consequences, so it is the **same code
path**: build the live-state rows, decide whether anything is active, and either proceed silently or prompt. **Do not
write a second dialog.**

One function, two call sites:

```
confirmEndVideoSession(reason: "close" | "move", target?: "popout" | "deck")
  → reads live state (§6.1)
  → nothing active?  resolve(true) immediately, NO prompt
  → otherwise render the rows, severity-ordered, plus the Icecast reassurance
```

Only the title and the action verb differ:

| | Close | Move |
|---|---|---|
| Title | `Close Show+?` | `Move Show+ to the pop-out window?` / `Move Show+ to the deck?` |
| Buttons | `[ Keep Show+ open ] [ Close Show+ ]` | `[ Stay where it is ] [ Move Show+ ]` |
| Rows | identical — stream, recording, guests, Icecast line | identical |
| Nothing active | close immediately | move immediately |

The move wording adds one clause to the lead row, because "ends" is what actually happens — the session does not
travel:

> ⛔ Your live stream to YouTube will END. Moving Show+ starts a fresh session; the stream does not move with it.

**Sequence for a move** (main is the arbiter, §5.1): requesting surface calls `showplus:claim` → main answers
`{ok:false, live:"popout"}` → requesting surface runs `confirmEndVideoSession("move", …)` → on confirm, main tells the
live surface to shut down (same teardown as a close) → main clears the claim → main grants it → the new surface
mounts Show+ cold. **No device is handed over and no session migrates**: the old surface fully tears down before the
new one acquires. That ordering is what keeps this out of the parked handoff hazard class.

### 6.3 The honest state on the surface that is not live

Driven by `showplus:live` (§5.1), never by a guess:

| State | Deck slot shows | Popout shows |
|---|---|---|
| Live here | Show+, in full | Show+, in full |
| Live in the other surface | *"Show+ is open in the pop-out window."* + `[ Bring it to front ]` + `[ Move it here ]` | *"Show+ is open in the deck."* + `[ Go to the deck ]` + `[ Move it here ]` |
| Not live anywhere | *"Show+ isn't running."* + `[ Open Show+ here ]` | (the popout would not be open) |

`[ Bring it to front ]` is a plain focus call on the existing window — `main.js:3889` already finds a popout by title;
focusing it needs no claim change and no prompt. `[ Move it here ]` is §6.2. **Never a dead black stage**, and never a
control that silently does nothing.

### 6.4 Every close path gets the same guard

| Path | Where | Guard |
|---|---|---|
| Window **X** | `PopoutShell.tsx:76` → `window.close()` | A React-only guard **cannot** catch this reliably. The guard belongs on the `BrowserWindow` `close` event in main (`preventDefault()`, ask the renderer, close on reply) — the same window created at `main.js:3888` |
| WINDOWS → Monitors → Show+ | `main.js:1863` (dedupes by title, `:3889`) | Focuses the existing window; if it ever becomes a toggle, route through the same guard |
| In-app control (deck slot, menu) | new | Sends a request to the popout; the popout runs the same dialog. Never closes the window directly |
| App quit / `window-all-closed` | `main.js:2468` | Out of scope for this dialog, but must not silently bypass it — **UNKNOWN** interaction, flag before build |

One guard implementation in main, one dialog in the popout, three entry points. No second copy.

---

## 7. Phasing (rev 2)

**Phase 1 — get the host transmitting again. ✅ BUILT 2026-07-29, not yet shipped.**
`[HOSTCAM]` logging on every acquisition attempt, host-camera-first claim, and an acquisition ladder that relaxes
audio as well as video. See `docs/build-report-showplus-phase1-host-camera-2026-07-29.md`. Note the full-panel
*deletion* moved out of Phase 1 into Phase 2 — Phase 1 shipped as camera work only.

**Phase 2 — one place at a time.** Everything below is one phase now that the transport work is gone.

> **Step 0 — SETTLE THE POPOUT QUESTION FIRST (rev 3).** Open **Window → Monitors → Show+** (not Tools → Show+) and
> report what appears. Nothing below is safe to start until that is answered, because steps 1-2 and step 6 branch on
> it. This is a one-minute check, not an investigation.

1. **The popout route — branches on step 0.**
   - *If it renders "Unknown pop-out panel":* add `case "videostudio"` to `PopoutRenderer` (`:102-144`) plus a
     title-map entry (`:50-59`). `POPOUT_SIZES` (`main.js:3858`) and bounds persistence already exist.
   - *If it renders a working Show+:* the route exists by some mechanism not visible in `PopoutRenderer.tsx` —
     **find and cite it before touching anything**, then this step becomes de-duplication (one mount definition), not
     construction.
2. **Mount Show+ there** — the tree currently at `ShowPlus.tsx:2678-2808`, unchanged in substance. If step 0 shows it
   is already mounted, this step is already done and the work is making it the *only* mount.
3. **The one-place-at-a-time claim** in main (§5.1): `showplus:claim` / `:release` / `:where`, `showplus:live` fanned
   to all windows, cleared unconditionally on popout `close`.
4. **The honest state** on whichever surface is not live (§6.3), plus `[ Bring it to front ]` / `[ Move it here ]`.
5. **The confirmations** (§6.1 close, §6.2 move) — one `confirmEndVideoSession` function, two call sites, plus the
   `BrowserWindow` `close` guard in main, since `PopoutShell.tsx:76` calls `window.close()`.
6. **Delete the full right-panel surface** (§1.1) — **LAST, and only after steps 1-2 are proven** (rev 3): the mount
   at `App.tsx:2614-2616`, its `HostCamera` (`ShowPlus.tsx:2696-2708`), the `videostudio` panel route, and the Tools
   entry at `main.js:1846`.
   > **Ordering is not cosmetic here.** `main.js:1846` (Tools → Show+) *is* that panel — the surface Jeff operates
   > from today. Deleting it before a popout demonstrably renders Show+ removes the working surface and leaves the
   > operator with nothing. Repoint `main.js:1846` to the popout **in the same change** that deletes the panel, never
   > before it works, and never after. Rev 2 listed both in one phase with no stated order; that was a trap.
   >
   > Also resolve the duplicate label: `main.js:1846` and `:1863` are both "Show+". End with one door, or two doors
   > with distinct names.

**Phase 3 — de-duplicate the markup.** §1.3: one `GuestGridTile`, one pending card, one TURN line, one `InviteBlock`,
one `TeleprompterPanel`; delete the dead components in §1.4. This is where "one thing, two mounting points" becomes
literally true in the file. *(Was Phase 4 in rev 1; the old Phase 3 — deck-slot-as-view — no longer exists.)*

**Prerequisites that Phase 2 step 5 depends on**, both real and filed, neither fixed here: `studio:rtmp:start`
(`main.js:4455`) ignoring `destId`, and `studio:rtmp:stopped` being sent to `mainWindow` only (`:4514`, `:4524`) — the
latter *must* be fixed for Phase 2, since Show+ will no longer be in the main window.

**After this merge, not part of it: the Show+ mic bus.** Multiple mic inputs, per-mic faders, mixed to one track to
guests. It lands **after Phase 3**, in whichever surface is live: it replaces the single `hostStream` mic track at
`ShowPlus.tsx:554` with a mixed track, and it is the natural home for the MIC VOL control that today reaches only the
monitor (`:1853-1859`). Not designed here.

---

## Open questions / UNKNOWN

1. Whether host-camera-first ordering alone resolves the `+ Camera` contention, or whether the full acquisition service
   (`docs/showplus-device-layer-design-2026-07-27.md`) is required first. Real-device question; not decidable
   statically. Phase 1 is built but unproven on a live call.
2. How many concurrent RTMP destinations the main process actually supports (`main.js:4455`, `:4539` suggest one).
3. Whether app-quit paths (`main.js:2468`) can bypass the close guard.
4. **Where Show+ opens by default on a cold start** — deck slot, popout, or neither until asked. Rev 2 makes this a
   real product question rather than an implementation detail; not decided here.
5. **Whether a video deck slot that the operator has configured should auto-claim on app start.** Auto-claiming would
   silently take the device on every launch; not claiming leaves a configured slot showing an empty state until
   clicked. Needs a decision before step 3.

## Architecture compliance

- **One owner, thin front-ends** — the `ether-audiod` rule Jeff named. Rev 2 takes it further than rev 1 did: there is
  not one owner and one subscriber, there is **one instance and one signpost**. `AudioPanel` (`ShowPlus.tsx:2180`,
  `:2470`) remains the in-file proof that one component with two mount points works.
- **`CLAUDE.md` — "Correct minimal solution."** Rev 2 deletes more than it adds: no transport, no mirror, no election,
  no handoff. The remaining new mechanism is one flag in main and one prompt reused twice.
- **`CLAUDE.md` — "BUILD THE SENSE, NOT THE SCAFFOLD."** Phase 1 made an existing silent failure speak (`:781`, built).
  The confirmations are built from observed live state, never remembered state, and the inactive surface states where
  Show+ actually is rather than showing a dead frame.
- **`CLAUDE.md` — "DOORS BEFORE ROOMS."** Two menu items share the label "Show+" (`main.js:1846`, `:1863`) and lead to
  different places; whether the second leads anywhere is UNVERIFIED (§3). Phase 2 ends with one door, or two clearly
  distinct ones. The
  inactive surface's signpost is the same principle — a door that says where the room went.
- **`docs/showplus-device-layer-design-2026-07-27.md`** — consistent with, and a step toward, the acquisition service.
  Rev 2 helps here too: with one live surface there is only ever one `HostCamera`, so the host-vs-host collision pair
  cannot occur at all. The host-vs-`+ Camera` pair remains, and remains the acquisition service's job.
- **`docs/backlog.md` shadow-daemon handoff (PARKED)** — still out of that hazard class, and further out than rev 1.
  A move is a full teardown followed by a cold mount (§6.2); nothing migrates, nothing reconnects, no device changes
  hands while live.

## Revision history

- **rev 1 (2026-07-29)** — popout as sole owner; deck slot as a live view fed by a low-fps thumbnail over
  `ether:broadcast`; roster/turnState/scene mirrored between windows.
- **rev 2 (2026-07-29)** — Jeff's decision: Show+ is live in exactly one place at a time. Ownership model, election,
  handoff, thumbnail pipe, and all cross-process stage transport **deleted**. §4 and §5 rewritten; §6 gains the move
  confirmation (§6.2) and the honest state (§6.3); §7 re-phased.
- **rev 3 (2026-07-29, this document)** — **false premise corrected.** The "dead door" claim about `main.js:1863` was a
  runtime assertion resting on a grep and is now **UNVERIFIED** pending one check (§3, §7 step 0). Established that
  **Tools → Show+ (`main.js:1846`) is a panel switch, not a popout**, and that two menu items share the label "Show+".
  Added the deletion-ordering trap (§7 step 6). Labelled Phase 1's `+ Camera` refusal a **stopgap** and recorded the
  product requirements it must not violate (§2). Full audit of every unverified claim, and the new evidence rule, in
  `docs/showplus-popout-premise-correction-2026-07-29.md` and `CLAUDE.md:121`.

## Scope note

Design only. The only file written is this document. No source file was modified, nothing was committed, and nothing
on the Lightsail box was touched. No patch is proposed and no code was written for this revision.

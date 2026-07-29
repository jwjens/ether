# Correction — the Show+ popout premise, and an audit of every unverified claim

**Date:** 2026-07-29 · **Mode:** READ-ONLY. Nothing built, nothing fixed. Two docs updated
(`showplus-one-owner-popout-design-2026-07-29.md`, `CLAUDE.md`); no source file touched.

**What went wrong:** I wrote *"`main.js:1863` is a door onto a wall"* — a statement about what the running app does —
on the strength of `grep -c videostudio src/components/PopoutRenderer.tsx` → 0. That is a claim about the tree
presented as a claim about the product. It went into a design of record and shaped a phase plan. The rule is now in
`CLAUDE.md:121`.

---

## 1. How Tools → Show+ actually creates its surface

**It does not create a window at all. It switches a panel inside the main window.**

```
electron/main.js:1846   { label: "Show+",  click: () => send("nav:videostudio") }
electron/main.js:1765-1768   const send = (cmd) => { … win.webContents.send("menu-action", cmd); }
src/App.tsx:972         "nav:videostudio":"videostudio"   (menu-action → panel name map)
src/App.tsx:2612-2615   {/* VideoStudio is always mounted so WebRTC state stays alive. */}
                        <div style={{ display: panel === "videostudio" ? "flex" : "none", … }}>
                          <VideoStudio active={panel === "videostudio"} />
```

`send()` posts a `menu-action` IPC to the focused window; `App.tsx:972` maps it to the panel name; the panel's
container flips from `display:none` to `flex`. **No `BrowserWindow`, no `window.open`, no hash route.** The surface
that appears is the full right-panel Show+ — the same tree at `App.tsx:2615` that this design proposed deleting.

So Jeff's runtime observation is right, and it describes **the panel**: Tools → Show+ shows the full working Show+
surface. My "dead door" claim was about a **different menu item on a different mechanism**:

| Menu path | Receipt | Mechanism |
|---|---|---|
| **Tools → Show+** | `main.js:1846` | `send("nav:videostudio")` → panel switch **inside the main window** |
| **Window → Monitors → Show+** | `main.js:1863` | `popout("videostudio")` → **new `BrowserWindow`** (`:1769-1792`) loading `#popout/videostudio` |

Two different entries, two different code paths, both labelled "Show+". That is almost certainly how I conflated
them — and it is also a real product hazard worth noting on its own: two menu items with the same name that do
different things.

### What the tree says about the second path — and what it cannot say

`#popout/videostudio` → `src/main.tsx:59, 96` (`isPopout` → `<PopoutRenderer panel="videostudio" />`).
`PopoutRenderer.tsx` imports 14 panel components (lines 4-19) — **none of them is `ShowPlus`/`VideoStudio`**
(`grep -c "ShowPlus\|VideoStudio"` → **0**), there is **no `React.lazy` and no dynamic `import()`** in the file, and
its `switch` has cases for `decks, master, mic, phone, voicetrack, upnext, health, carts, shows, clocks, categories,
calendar, library, studiopro` with a default at `:145-149` rendering *"Unknown pop-out panel: …"*.

A component that is never imported cannot be rendered by that file. That is as far as static analysis can honestly
go. **Whether Window → Monitors → Show+ actually shows the Unknown panel at runtime is UNVERIFIED** — I have not run
it, and I am not going to assert it a second time. **The one check that settles it: open Window → Monitors → Show+
specifically (not Tools → Show+) and say what appears.**

If it renders Show+, then something outside `PopoutRenderer` is serving that hash and I have not found it — and I want
to be told so, because it would mean a route exists that the file cannot explain.

## 2. Is the popout content a third mount?

**UNVERIFIED, and dependent on §1.** Two cases:

- **If Window → Monitors → Show+ shows the Unknown panel** (what the tree implies): there is **no third mount**. Live
  mounts today are two — the panel (`App.tsx:2615`) and the deck slot (`App.tsx:3912`) — exactly as the trace said.
- **If it shows a working Show+**: then it is a **third independent mount**, with its own `HostCamera`, its own
  `useWebRTCGuests` (`ShowPlus.tsx:2586`), and its own WebSocket (`:425`).

### What a third mount would do (stated so the answer is ready either way)

**Camera contention — worse, and in a new way.** Each mount runs `HostCamera.start()`, and a physical camera is
single-open on Windows. Three mounts, one camera: one wins, two land in the failure path. The Phase-1 claim
(`VideoEngineContext.tsx:236-256`) does **not** help here — it is module-level, and **a popout is a separate renderer
process with its own JS module instances**, so the popout's claim and the main window's claim are two unrelated
variables. Cross-process device arbitration is not something a module-level flag can do.

**Session eviction — certain, not probabilistic.** `SHARED_SESSION_TOKEN` (`ShowPlus.tsx:29-33`) is
`Math.random()`-derived at **module evaluation time**. Two mounts in the *same* renderer share one module instance and
therefore one token. A popout is a different process, so it evaluates the module afresh and gets a **different**
token. Consequences differ by pairing:

| Pair | Token | Result |
|---|---|---|
| Panel + deck slot (same window) | **same** token | Both sockets claim one host session; the server closes the incumbent — `if (session.hostWs && session.hostWs !== ws) session.hostWs.close(1000,'Replaced')`. One surface's guests silently vanish |
| Popout + either (different windows) | **different** tokens | Two *separate* host sessions, each with its own room code and invite link. No eviction — instead, **two live invite links**, and a guest who used the wrong one never reaches the operator who is looking for them |

The second row is arguably worse than eviction, because nothing fails loudly: both surfaces look fine, and the guest
simply never appears. **UNVERIFIED** — it depends entirely on §1's answer.

## 3. Audit — every runtime assertion in the design that rests only on a grep

| # | Claim in the design | Basis | Status |
|---|---|---|---|
| 1 | Window → Monitors → Show+ renders "Unknown pop-out panel" (the "dead door") | grep of `PopoutRenderer` | **UNVERIFIED — and challenged by Jeff.** §1 |
| 2 | Tools → Show+ needs repointing to the popout | menu + panel map | **VERIFIED as tree fact** (`main.js:1846` → `App.tsx:972` → `:2615`); it is a panel switch, no window |
| 3 | The deck slot mounts a second `ShowPlus` with `active` defaulting true | `App.tsx:3912` has no `active` prop; default at the signature | **VERIFIED as tree fact.** Whether any deck slot is *configured* as `deckType === "video"` on Jeff's machine is **UNVERIFIED** |
| 4 | Two `HostCamera` instances fight over one camera | follows from #3 | **UNVERIFIED at runtime** — requires a configured video deck slot to be true today |
| 5 | The panel and deck slot evict each other's signalling session | server code read on the box + shared module token | **Server side VERIFIED** (read from `/opt/ether-signal/server.js`). **Whether both sockets are ever open at once is UNVERIFIED** — `guestsEnabled` defaults `false` per instance (`ShowPlus.tsx:421`) |
| 6 | The camera visible on the canvas was a `+ Camera` source, not `hostStream` | inference from Jeff's recvonly log (a real runtime receipt) + `:2505-2512` | **PARTIALLY VERIFIED.** The inference is sound but was never confirmed against the actual sources list |
| 7 | Main supports only one concurrent RTMP destination | reading `main.js:4455`, `:4539` | **UNVERIFIED at runtime** |
| 8 | `studio:rtmp:stopped` never reaches a popout | `main.js:4514`, `:4524` send to `mainWindow` | **VERIFIED as tree fact**; runtime effect unobserved |
| 9 | Popouts share no JS state | `main.tsx:96` routing + Electron's process model | **VERIFIED** (platform behaviour + routing receipt) |
| 10 | Phase 1's claim closes the host-vs-`+ Camera` window | the code as written | **UNVERIFIED** — built, never run. It also cannot work cross-process (§2) |
| 11 | `GuestSidebar` / `GuestTile` / `GuestVideoPanel` are dead | no call sites / no importers | **VERIFIED as tree fact** — absence of a reference is a tree property, which is what grep is actually good for |

The pattern in the failures is consistent: greps are sound for **absence in the tree** (#11) and unsound the moment
they are used to predict **what a user sees** (#1).

## 4. Corrections to the product model

Three requirements from Jeff that the design must stop working against:

1. **The SOURCES list is deliberate product behaviour.** Screen-only (a tutorial), camera or no camera, sources added
   and removed at will, more than one local camera. This is a feature, not an accident to be tidied away.
2. **`+ Camera` is not a defect.** It is not removed and not restricted.
3. **The only defect is the silent collision** — the *same physical camera* opened through both `HostCamera` and a
   `+ Camera` source, where Windows grants one and the other fails with nothing shown. **The end state is one open,
   shared by reference to every consumer** — the acquisition service in
   `docs/showplus-device-layer-design-2026-07-27.md` — **not refusals, and not fewer sources.**

**Consequence for Phase 1, which is already built.** Its `addCameraSource` guard (`VideoEngineContext.tsx:514-528`)
*refuses* the add with "already in use as the host camera." Under requirement 3 that is a **stopgap**, not the design:
it trades a silent failure for a visible refusal, which is better than today but is still a "no" where the product
wants a "yes, sharing the same handle." The design has been updated to label it as such (§2 of the design doc), and
the code comment should be corrected the next time that file is legitimately open. The `[HOSTCAM]` logging half of
Phase 1 stands unchanged and unaffected.

## 5. What actually remains of Phase 2

Rewritten in the design doc. In short:

- **Step 1 ("wire the half-built popout") is now conditional on §1.** If the popout route already renders Show+, the
  step is deletion-of-duplication rather than construction. If it renders the Unknown panel, the step stands as
  written. **Jeff's one check decides which.**
- **A sequencing constraint that the previous revision got dangerously wrong:** the design lists the full right-panel
  surface (`App.tsx:2614-2616`) for deletion. That panel **is** Tools → Show+ — Jeff's actual working surface today
  (§1). It cannot be deleted until a popout that genuinely renders Show+ exists and `main.js:1846` is repointed to it.
  Under the previous phase plan those were the same phase with no stated ordering. They are now ordered explicitly.
- **The two same-named menu entries** (`main.js:1846` Tools, `:1863` Window → Monitors) should end as one door, or two
  doors with distinct names. Filed in the design, not built.

---

## The rule, now in `CLAUDE.md:121`

> **A claim about what the running app does requires a runtime receipt — a log line, a screenshot, or Jeff's word. A
> grep is a claim about the tree, never about the product.** Say what the code says, then mark the runtime behaviour
> UNVERIFIED and name the one check that would settle it. Never promote "I grepped and found no case for X" into "X is
> broken/dead/missing."

Applied retroactively in §3: every runtime assertion in the design of record is now labelled, and the ones that were
doing real work in the phase plan (#1, #4, #5) are the ones that were never verified.

## Scope note

Read-only with respect to source. Files written: this report, `docs/showplus-one-owner-popout-design-2026-07-29.md`
(rev 3), and `CLAUDE.md` (the new rule, at Jeff's instruction). No source file modified, nothing committed, nothing
built, nothing on the Lightsail box touched.

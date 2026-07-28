# Build report — pre-Accept ICE candidate queue (Show+ guests)

**Date:** 2026-07-28 · **Branch:** `log-reader-flip` · **File touched:** `src/components/ShowPlus.tsx` (only)
**Diff:** 42 insertions, 1 deletion, 1 file.
**Status:** built + typechecked. **No version bump, no commit, no tag, no push, no installer, no install.** Awaiting GO.

---

## What was fixed

The one defect in §7.1 of `docs/showplus-guest-tile-black-video-trace-2026-07-28.md`: remote ICE candidates arriving
before the operator clicks Accept were dropped on the floor. The peer connection does not exist until `acceptGuest`
inserts it into `peersRef`, so the `if (pc && payload)` guard discarded every candidate trickled in the window between
the guest's offer and the human click — the PC then started with zero remote candidates and no media ever flowed.

Confirmed by live console: four `[WEBRTC] Remote ICE candidate` lines before `[WEBRTC] PC created`, none after; no
ICE-connection-state or connection-state line ever printed; canvas `readyState=0` indefinitely.

The fix buffers those candidates per guest id and flushes them once the remote description is set.

---

## Changes, with receipts

All line numbers are post-patch, `src/components/ShowPlus.tsx`.

### 1. The buffer — `ShowPlus.tsx:406-412`
New `pendingIceRef: useRef<Map<string, RTCIceCandidateInit[]>>` declared immediately after `peersRef`
(`ShowPlus.tsx:405`), **keyed by the same guest id as `peersRef`** as required. Comment block at
`ShowPlus.tsx:406-411` records why the buffer exists so the next reader does not re-derive it.

### 2. Queue instead of drop — `ShowPlus.tsx:449-464` (replaces the old one-line guard)
The removed line was `if (pc && payload) try { await pc.addIceCandidate(payload); } catch {}`.

- `ShowPlus.tsx:449-450` — a null `payload` (end-of-candidates marker) is neither added nor queued.
- `ShowPlus.tsx:451-453` — PC exists **and** has a remote description → add immediately.
- `ShowPlus.tsx:454-463` — otherwise buffer it, appending to that guest's queue (`ShowPlus.tsx:456-458`).

**One deliberate widening of the stated condition, called out for review:** the branch tests
`pc && pc.remoteDescription` (`ShowPlus.tsx:451`), not merely `pc`. A candidate that lands after the PC is created but
before `setRemoteDescription` resolves throws exactly as the pre-Accept ones did — the trace says so at §7.2
("Candidates delivered before `setRemoteDescription` completes throw and vanish here"), and the requirement itself
states "candidates added earlier throw." Queuing that window closes the same hole rather than converting a silent drop
into a logged failure. The `reason` field in the queue log (`ShowPlus.tsx:460`) distinguishes the two cases
(`"no peer connection yet"` vs `"no remote description yet"`) so the two windows stay separable in the console.

No interleaving risk between the two windows: the flush reads the map synchronously in the same task in which
`setRemoteDescription` resolves (`ShowPlus.tsx:574-579`), so a candidate cannot be queued after the flush has read but
before it deletes; any candidate arriving after that point sees `pc.remoteDescription` set and takes the direct path.

### 3. Flush after `setRemoteDescription` — `ShowPlus.tsx:576-587`
Placed immediately after `await pc.setRemoteDescription(guest.offer)` (`ShowPlus.tsx:574`) and **before**
`createAnswer` (`ShowPlus.tsx:589`) — i.e. at the earliest point `addIceCandidate` is legal, as required.

- `ShowPlus.tsx:578-579` — read the guest's queue, then delete the entry (flush is one-shot; nothing lingers).
- `ShowPlus.tsx:580-584` — apply each candidate, counting successes; **each candidate is individually caught**, so one
  bad candidate cannot abort the loop or skip `createAnswer`.
- `ShowPlus.tsx:585-587` — the required flush log: `queued`, `applied`, `dropped` per guest id.

### 4. `addIceCandidate` failures are now logged, never swallowed
The empty `catch {}` is gone. Both call sites use the existing `[WEBRTC]` prefix:
- `ShowPlus.tsx:452` — `[WEBRTC] addIceCandidate failed for guest` (live path).
- `ShowPlus.tsx:583` — `[WEBRTC] Queued addIceCandidate failed for guest` (flush path).

### 5. Queue cleared on every exit path — cannot leak
- `ShowPlus.tsx:467` — guest sends `leave`.
- `ShowPlus.tsx:480` — hook teardown / guests disabled: whole map cleared alongside `peersRef.current.clear()`.
- `ShowPlus.tsx:567` — `connectionState` goes `failed` / `closed` (the same branch that already dropped the guest).
- `ShowPlus.tsx:602` — `denyGuest`.
- `ShowPlus.tsx:609` — `removeGuest` (kick).
- `ShowPlus.tsx:579` — the flush itself deletes the entry on the success path.

Every path that removes a guest from `peersRef` or from `guests` state now also removes its queue. There is no path
that deletes a peer without deleting its queue.

---

## Typecheck gate

```
npx tsc --noEmit
src/components/OnboardingFlow.tsx(2039,42): error TS2366: ...
src/components/PhoneDesk.tsx(777,21): error TS2345: ...
```

**PASS — exactly the 2 standing baseline errors, both in `OnboardingFlow.tsx` + `PhoneDesk.tsx`. Zero new errors, and
none in `ShowPlus.tsx`.**

---

## Architecture compliance

- **`CLAUDE.md` — "BUILD THE SENSE, NOT THE SCAFFOLD … honest state (observed, never claimed)."** The fix ships with
  its own observability in v1, not bolted on later: the queue depth and reason at `ShowPlus.tsx:459-462`, the
  applied/dropped flush counts at `ShowPlus.tsx:585-587`, and two real failure logs at `ShowPlus.tsx:452` /
  `ShowPlus.tsx:583`. The trace named silent failure here as what made this bug undiagnosable; the console now states
  what happened to every candidate. No watcher, poller, or scheduled task was created — nothing temporary is armed on
  this machine.
- **`CLAUDE.md` — "Correct minimal solution … name what you're deliberately NOT building."** One file, 42 lines, no
  refactor. Explicitly not built this release: TURN / `iceServers` (`ShowPlus.tsx:494-496`, backlog), late-track
  re-attach (§7.4), the tile's honest-state gap (§7.7), the impure `setGuests` updater (§7.8), and the dead
  `GuestTile` / `GuestSidebar` / `GuestVideoPanel.tsx`.
- **`CLAUDE.md` — "ARCHITECTURE BEFORE CODE."** Governing docs located and read before editing:
  `docs/showplus-guest-tile-black-video-trace-2026-07-28.md` §7.1/§7.2 (the receipts implemented here) and
  `docs/showplus-device-layer-design-2026-07-27.md` (Show+ design of record). **No conflict:** the device-layer design
  governs local physical-device acquisition (`showplus-device-layer-design-2026-07-27.md:76-81`), not the WebRTC
  signaling path; it is `DESIGN ONLY — build nothing from this doc yet` (line 3), and nothing here builds from it.
- **Nothing in the code contradicted the trace's receipts.** Every line cited in §7.1 was found exactly as recorded,
  so no STOP condition was triggered.
- **Help entry:** none required — this is a defect fix inside an existing feature with no new user-facing surface,
  no new control, and no new door. The GUESTS panel's affordances are unchanged.

---

## What this fix does and does not promise

**Does:** the PC now starts with the guest's real remote candidates instead of none, so ICE has actual pairs to check
rather than depending on peer-reflexive discovery.

**Does not:** guarantee connection for a guest behind symmetric NAT or a restrictive corporate firewall — that needs
TURN (`ShowPlus.tsx:494-496`), which is explicitly out of scope for this release and remains the open backlog item
first noted in commit `8db0925`.

**Verification is a live guest join, not a typecheck.** Per `CLAUDE.md`, the only valid test is the real app.

### Live verification — PASSED (2026-07-28, operator-run)

Observed on a real guest join, in order:

1. `[WEBRTC] Queued remote ICE candidate` (`ShowPlus.tsx:459`) — queue depth climbed to **4** while the guest sat
   pending. Under the old code these four candidates were the ones silently discarded.
2. `[WEBRTC] Flushed queued ICE candidates for guest … {queued: 4, applied: 4, dropped: 0}` (`ShowPlus.tsx:585`) on
   Accept. **All four applied, none dropped** — the flush ordering after `setRemoteDescription` (`ShowPlus.tsx:574`)
   is correct, and no `addIceCandidate` error fired from `ShowPlus.tsx:583`.
3. `[WEBRTC] ICE state … checking` (`ShowPlus.tsx:537`) and `[WEBRTC] Connection state … connecting`
   (`ShowPlus.tsx:540`) — **lines that had never printed at all before this fix.**

That is the exact sequence predicted above. The defect in §7.1 of the trace is closed: the peer connection now starts
with the guest's real remote candidates instead of zero, and ICE actually runs candidate checks.

### Known remaining failure — out of scope, already filed

ICE proceeds `checking → disconnected → failed`. That is the **TURN gap** (§7.3 of the trace): with STUN-only
`iceServers` (`ShowPlus.tsx:494-496`) there is no relay candidate, so a guest whose path requires relaying still
cannot complete. `iceServers` was **not touched in this release** per instruction; it remains the open backlog item
first recorded in commit `8db0925`. This fix was never expected to resolve it — it makes ICE able to run at all,
which is the precondition for TURN to help.

---

## Release actions taken

- **Version:** `package.json` bumped `4.4.95` → `4.4.96` (`package.json:70`).
- **Commit:** `43b9baa` — `fix(showplus) 4.4.96: queue pre-Accept guest ICE candidates (black guest tile)`.
  Staged files only: `package.json`, `src/components/ShowPlus.tsx`,
  `docs/showplus-guest-tile-black-video-trace-2026-07-28.md`, and this report. Five unrelated untracked items (two
  other design docs, three `native/*.bak` / `.new` binaries) were deliberately left unstaged.
- **Pre-commit `verify:schema` hook:** PASSED — `schema_version` 34, transformer coverage v2→v34 (33 migrations).
- **Renderer:** `npm run build` — built in 11.0s.
- **Installer:** `npm run electron:build:win -- --publish never` → **`C:\openair\dist-electron\Ether Setup 4.4.96.exe`**
  (202,692,950 bytes), signed via signtool, blockmap generated. `--publish never` — nothing pushed to any GitHub
  release by the build.
- **Pushed:** branch `log-reader-flip` → `origin` (`github.com/jwjens/ether`). **No tag was created**, so the
  tag-only CI in `build.yml` did not fire and no client auto-update was triggered.
- **Not installed.** The operator installs manually.

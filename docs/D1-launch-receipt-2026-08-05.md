# D1 — launch receipt, 4.4.142

**Written:** 2026-08-05 · **For:** Jeff / Claude Desktop / the next session
**Supersedes §3.0 of** `docs/D1-handoff-2026-08-05.md` — the "launch it and find out" step is now DONE.
**Status:** observed on a real launch. **No code written. No version bump. No installer.**

---

## 0 · What was run

- **Installed / running:** `4.4.142.0`, renderer bundle `index-PUsnHRS6.js`
  (4.4.141 was `index-Be1Jn4Xy.js` — the new hash confirms D1's §1 code is actually live, not a stale
  install). Jeff installed and launched it himself.
- **Source:** `%APPDATA%\Ether\ether-startup.log`, 287 new lines from `15:45:58` to `15:49:31`,
  cleanly separated from history by a pre-launch baseline of 338,183 lines.

---

## 1 · THE HEADLINE — the two symptoms ARE separable, as §3.0 suspected

| Symptom | Verdict |
|---|---|
| **The bounce** (second sign-in screen) | **No evidence of it.** One auth boundary, no gate re-entry. |
| **The pre-auth leak** (§2.1) | **CONFIRMED PRESENT at runtime.** Not inferred — logged. |

**§1.1's gate hold is not what fixes the leak, and §2.1 is not what fixed the bounce.** Two defects, two
causes. Building §2.1 and calling the bounce fixed would have been claiming an unproven cause — which is
exactly what §3.0 was written to prevent.

---

## 2 · Against §3.1's four criteria

### ✅ 1 · `AUTH COMPLETE` exactly once — PASS
`AUTH COMPLETE` count = **1**. `SIGN-IN COMPLETE` count = **1**. The phase label flips
`PRE-AUTH ·` → `post-auth ·` at `15:46:23.133` and never flips back.

### ❌ 2 · Engine construction AFTER auth — FAIL, decisively
Every line below is stamped `PRE-AUTH`, ~24 seconds **before** the auth boundary:

```
15:45:58.828  getEngine(1) PRE-AUTH (existing instance) ← C7
15:45:58.911  engine.init() station=1 — 250ms poll + daemon detect START
15:45:58.930  ENGINE CONSTRUCTED station=4 ← C7
15:45:58.937  engine.init() station=4 — 250ms poll + daemon detect START
15:45:59.701  attachDaemonEvents station=1
15:45:59.746  attachDaemonEvents station=4
      …
15:46:23.133  SIGN-IN COMPLETE
```

**Two engines (stations 1 and 4) constructed, initialised and attached to the daemon before anyone
signed in.** 57 pre-auth BOOTSEQ lines in total. This is §2.1, unbuilt, now with a runtime receipt —
and it is the mechanism behind the Christmas-station audio Jeff heard at the PIN screen on 2026-08-03.

### ❌ 3 · `STATION ADOPTED … (post-auth)` after auth — FAIL — **and a correction is owed**

```
15:45:58.905  PRE-AUTH · STATION ADOPTED station=1 — first adoption (post-auth)
```

The **new wording is live**, which proves §1.2's code shipped. **The ordering did not change.**

Removing the `getActiveStationIdSync()` seed from the `useRef` initialiser only moved the adoption: the
`[stationId]` effect then adopted pre-auth instead, because `useActiveStation()` resolves a station
regardless of auth state.

**§1.2 did NOT achieve "no station adopted before auth."** The previous session's handoff claimed it as
DONE. That claim was wrong and this file corrects it.

Secondary defect introduced by that same change: the log text hardcodes the string `(post-auth)` in a
message that has no way to know the phase — so the line now reads
`PRE-AUTH · … (post-auth)`, contradicting itself. **The phase must come from the phase tagger, never
from a literal in the message.** Fix that wording as part of §2.1.

### ✅ 4 · No second sign-in — PASS (on the log)
One auth boundary, no re-entry. `OnboardingFlow` and `UserLogin` each appear **0** times in the launch
window, so neither gate screen re-rendered.

---

## 3 · Corrected status of D1

| Item | Handoff said | Launch shows |
|---|---|---|
| §1.1 gate hole closed | DONE (unverified) | **Holds** — no bounce in the log. Needs Jeff's eyes (§4). |
| §1.2 no pre-auth station adoption | DONE (unverified) | **NOT achieved** — adoption merely moved. |
| §1.3 one canonical BOOTSEQ line | DONE (unverified) | **Confirmed** — exactly one. |
| §2.1 engine-construction deferral | NOT DONE | **NOT DONE, now proven live.** |
| §2.2 "Continue as \<account\>" | NOT DONE | not started |

**D1 is NOT done.** Per §0 of the handoff: no version bump, no installer, until §3.1 passes — and
criteria 2 and 3 fail.

---

## 4 · TWO QUESTIONS FOR JEFF — the log cannot answer these

1. **Did the sign-in screen appear ONCE or TWICE?** The log shows a single auth boundary and no gate
   re-render, but the bounce is a *screen* symptom and Jeff's eyes are the gate.
2. **Did any station's audio start at the PIN screen?** The log strongly implies yes — engines were
   live and daemon-attached 24 seconds early — but audio starting is only confirmable by ear.

Answering these completes §3.0 and decides whether §1.1 can be considered settled.

---

## 5 · What the next session builds (§2.1), with the receipt in hand

Nothing account-derived may run until sign-in + PIN complete. The launch names the exact offenders:

- `getEngine()` / `ENGINE CONSTRUCTED` ← tagged `C7` in the log — find that call site
- `engine.init()` — fired for stations 1 and 4 pre-auth
- `attachDaemonEvents` — fired for stations 1 and 4 pre-auth
- the `[stationId]` adoption effect — must not adopt until auth completes (§1.2's real fix)

```
git grep -n "engine.init()\|attachDaemonEvents\|getEngine(" -- src/
git grep -n "accountSignedIn" -- src/App.tsx
```

The neighbouring effects already carry the guard (`if (!accountSignedIn) return;`), so the rule exists in
the codebase — these sites never had it applied.

**Do not gate the daemon.** Broadcast does not wait for login; the APP does. Four stations air through
it.

**Re-verify with the same method:** launch, pull the BOOTSEQ block, and require zero `PRE-AUTH` lines for
engine construction, init, attach and station adoption.

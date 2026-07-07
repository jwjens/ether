# Bugfix — "t.onSpeaking is not a function" UI crash on v4.4.37

## Symptom (receipt: user screenshot, 2026-07-07)
On a v4.4.37 install the renderer threw `t.onSpeaking is not a function` → the error boundary caught it
("Ether encountered an issue… audio engine continues running — your broadcast is safe"). Audio/daemon
unaffected (air-safety held); the **UI** needed Restart Interface.

## Root cause
`IrisBadge.tsx` called `iris.onConnected(...)` / `iris.onSpeaking(...)` / `iris.onReply(...)` **without
guards**. The source preload (`electron/preload.js:54`) DOES expose `iris.onSpeaking`, and the preload
ships normally (`"main": "electron/main.js"` → `electron/` included by electron-builder default). So the
missing method was a **renderer/preload version skew during auto-update** — the renderer JS bundle for
v4.4.37 loaded against a preload that (in that update session) didn't yet expose the iris method. The
renderer then called a method the loaded preload lacked → throw.

The defect on our side: the **presence surface could crash the broadcast UI.** That violates the
air-safety principle — an Iris hiccup must never take down the app.

## Fix (`IrisBadge.tsx`)
- Bail if the core method is absent: `if (!iris || typeof iris.onConnected !== "function") return;`
- Optional-chain every iris call: `iris.onSpeaking?.(...)`, `iris.onReply?.(...)`, `iris.chatSend?.(...)`.
- Result: a missing/skewed preload method leaves the badge **offline**, never a crash.

Receipt: `vite build ✓ 10.62s`.

## Ship
Rolls into **v4.4.38**. The guard means even an auto-update into v4.4.38 is crash-safe regardless of
preload/renderer swap order; a clean install is consistent by construction. Blast-radius check: other new
renderer→main calls (`SchedulerHealthPanel`, `BroadcastCalendar` generate) already sit in try/catch and
degrade gracefully — `IrisBadge` was the only unguarded path.

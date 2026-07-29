# Why the mixer mic picker is empty — traced, not theorised

**Date:** 2026-07-29 · **Mode:** READ-ONLY. No edits, no builds. Nothing in the tree changed by this document.

---

## Answer first

**Windows currently has no microphone present.** Not "blocked", not "hidden by a permission" — **not connected.**

`Get-PnpDevice -Class AudioEndpoint` on this machine, filtered to endpoints that are actually present:

```
Status FriendlyName
------ ------------
OK     VA24D (3- HD Audio Driver for Display Audio)
OK     Speakers (2- Realtek(R) Audio)
```

**Two endpoints present. Both are outputs. Zero capture endpoints present.**

Every capture endpoint on the box reports `Present: False`:

```
Status  Present FriendlyName
Unknown   False Analogue 1 + 2 (Focusrite USB Audio)      ← the interface input
Unknown   False Microphone (iPhone Hands-Free HF Audio)
Unknown   False Headset (AL Nanobuds Sport Hands-Free)
Unknown   False Speakers (iPhone Hands-Free HF Audio)
```

And the interface itself:

```
Status  Class           FriendlyName
Unknown MEDIA           Focusrite USB Audio          ← not present
Unknown Focusrite Audio Scarlett 4i4 4th Gen         ← not present
OK      Focusrite Audio Focusrite USB Audio Root     ← driver stack only
OK      Focusrite Audio Focusrite Thunderbolt Audio Root
```

The Focusrite **driver roots** are installed and OK; the **device** (`Scarlett 4i4 4th Gen`, `Focusrite USB Audio`) is
not present. That is the signature of an interface that is powered off, unplugged, or on a disconnected
Thunderbolt/USB link — the drivers stay registered, the endpoints go to `Present: False`.

So Ether is reporting the machine honestly: **4 outputs, 0 microphones**, because that is what Windows has right now.
Your privacy screenshot is also consistent — permission is granted (Ether is listed, last accessed 6/9/2026); permission
is not what is missing, the hardware is.

---

## 1. Where the mixer's mic list comes from

`src/components/MicChannel.tsx:29-34` — one call, one filter:

```js
const load = () => navigator.mediaDevices.enumerateDevices()
  .then(ds => setDevices(ds.filter(d => d.kind === "audioinput")))
  .catch(() => {});
load();
navigator.mediaDevices.addEventListener?.("devicechange", load);
```

It renders from that array at `MicChannel.tsx:110`:

```js
{devices.length === 0 ? <div …>No inputs found</div> : devices.map(d => ( … ))}
```

and the closed-state label at `:94` (`"Pick input ▾"` when nothing is selected). Nothing else feeds it — no daemon
list, no DB, no cache. `enumerateDevices()` returning zero `audioinput` entries is the whole explanation for the empty
picker.

**Unchanged this session** — `git diff HEAD -- src/components/MicChannel.tsx` is empty; its last commits are
`dc9e68c` and `52d33bb`, both from before this session.

## 2. Can we currently see what enumerate returned? **No.**

`MicChannel.tsx:30` ends in **`.catch(() => {})`** — an empty catch. There is no `console.log` of the result and no
log of a failure anywhere in that effect. So today:

- a successful enumerate that returns **zero** inputs, and
- an enumerate that **throws**

produce the identical UI ("No inputs found") and identical console output (nothing). **From the mixer alone you cannot
tell "there are no mics" from "the lookup failed."** That is a real honest-state defect in that component, independent
of the hardware situation — flagged, not fixed.

## 3. Settings → Audio Devices — the SAME call, different handling

`SettingsPanel.tsx:2039-2064`. One `enumerateDevices()` supplies **both** lists; they are split by `kind` in `apply`
at `:2040-2047`:

```js
all.filter(d => d.kind === "audioinput" || d.kind === "audiooutput")
```

Then `:2051-2055` enumerates **first** and **logs failures** (`console.error("[SettingsPanel] enumerateDevices failed:", e)`),
and only afterwards does a best-effort `getUserMedia({audio:true})` to unlock labels before re-enumerating
(`:2058-2064`). The "No microphones found" string is `:2381`.

**So it is the same call, returning `inputs: 0` and `outputs: 4`** — not a different code path, and not a permission
difference. Two independent components asking Windows the same question and getting the same answer is the
corroboration: this is the machine's state, not one component's bug.

Notably, this is exactly the shape the 4.4.95 fix (`9708bc3`) put into `AudioDevices.tsx` and `SettingsPanel` —
enumerate unconditionally, grant separately — which is why outputs survive here while inputs are absent.
`MicChannel` never got that treatment and still has the silent catch.

## 4. How to SEE the raw result, once, changing nothing

**DevTools is reachable even though the native menu bar is not drawn** — the `F12` accelerator is registered on the
application menu at `electron/main.js:1823` (`{ label: "Toggle DevTools", accelerator: "F12", … }`), and accelerators
fire on a frameless window.

Press **F12** in the Ether window, then paste this one line into the Console:

```js
(await navigator.mediaDevices.enumerateDevices()).map(d => ({ kind: d.kind, label: d.label, id: d.deviceId.slice(0,8) }))
```

It is a pure read — no capture, no permission prompt, no state change. It prints exactly what Windows hands Ether.

Expected right now, given the PnP evidence: several `audiooutput` rows and **no `audioinput` rows at all**. If instead
it throws, that is the case the empty catch has been hiding and we would finally see it.

A second, equally read-only check for the same answer from outside the app:

```powershell
Get-PnpDevice -Class AudioEndpoint | Where-Object { $_.Present -eq $true } | Select-Object Status,FriendlyName
```

That is the command whose output is quoted at the top of this document.

---

## What this does and does not explain

**Explains:** the empty mixer picker, "No microphones found" in Settings, and — on the Show+ side — why
`acquireMic` fails and why `[HOSTCAM]` cannot get an audio track. All four are the same absent hardware.

**Does not explain and is not excused by it:** the Show+ startup crash
(`createMediaStreamSource: MediaStream has no audio track`). That is mine — I made `hostStream` able to be video-only
without guarding `useLevelMeter` (`ShowPlus.tsx:702-710`), which throws on such a stream. The missing mic is what
*triggers* it; the crash itself is my code. Left unfixed per your instruction.

**Also worth knowing:** with no capture device present, the mic path in Show+ cannot succeed by any code route. Any
version — before this session or after — would find no microphone.

## Scope note

Read-only. No file in `C:\openair` modified, nothing committed, nothing built, nothing on the Lightsail box touched.
The two PowerShell commands quoted are read-only queries.

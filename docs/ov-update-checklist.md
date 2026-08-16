---
feature: ov-update
title: OV update checklist — 4.4.220
summary: The order to update the OV transmitter in, and the one log line that must be read before anything else.
audience: operator
---

# OV update checklist — 4.4.220

**The stream stays on the old build until step 2 passes.** Every step below is reversible up to the
point where you sign in; nothing destructive happens before that.

---

## 0. Before you leave the desk

- [ ] Installer in hand: `Ether Setup 4.4.220.exe`
- [ ] OV is **off air** or on a filler source — step 3 restarts the audio engine
- [ ] You know OV's account email and can sign in

---

## 1. Install

- [ ] **Close Ether completely on OV** — including the audio engine in the system tray.
      A directory move cannot complete while the daemon holds `openair.db` open, and the
      migration will refuse (loudly, safely) if it is running.
- [ ] Run `Ether Setup 4.4.220.exe`
- [ ] Launch it

---

## 2. THE IDENTITY RECEIPT — read this before touching anything else

On first launch, 4.4.220 writes ONE line naming exactly who the install woke up as. Find it in the
startup log (`%APPDATA%\Ether\ether-startup.log`) or the console:

```
[identity] profile=ETH-STN-… pending=false pointer=ETH-STN-… machineId=… db=…\profiles\ETH-STN-…\openair.db packaged=true migration=…
```

- [ ] `profile=` is **OV's license key** — the one OV has always used
- [ ] `pending=false` — a `true` here means no profile resolved and it is sitting on the scratch
      profile
- [ ] `pointer=` matches `profile=`
- [ ] `machineId=` is a stable UUID, **not** empty and not newly minted
- [ ] `migration=` reads `migrated` (first run after the update) or `already-migrated` (subsequent runs)

> ### If any of those is wrong — STOP.
> Do not sign in. Do not generate. Do not go on air.
> Close Ether, reinstall the previous build, and the stream continues on it untouched.
> **Nothing is lost but a lunch break.** The profile directory is still on disk under
> `%LOCALAPPDATA%\Ether\profiles\` — the data is not gone, the app simply did not resolve to it.

This step exists because the laptop rehearsal on 2026-08-16 produced exactly this failure class: an
install that came up as *itself* on the pointer but re-keyed its stations underneath, and the only
way to tell early was to read what it thought it was.

---

## 3. Verify the world is whole

- [ ] All of OV's stations are listed — count them against what OV had before
- [ ] Open a clock: its slots are there
- [ ] Shows, categories and rotation rules are populated — **not** an empty list beside a full
      library. A full track count with empty everything-else is the orphaned-station signature;
      **stop and report it** rather than working around it.
- [ ] Library track count matches

---

## 4. UUID identity — leave it OFF

- [ ] Settings ▸ Backup & Restore ▸ Multi-Machine Sync: **`sync_uuid_identity` = false**

**Do not enable it on OV.** It is off by default and must stay off for this update. Enabling it is
what re-keyed the laptop's stations. 4.4.220 fixes the underlying merge behaviour
(`electron/sync/merge-engine.js` — resolve the local id by uuid and preserve it), but that fix has
not yet been proven against a second real machine, and OV is not the place to prove it.

---

## 5. Clear pending — ORDER MATTERS

Only if OV's pending count is large and you have been asked to clear it:

- [ ] Settings ▸ Backup & Restore ▸ Multi-Machine Sync ▸ **CLEAR PENDING (SET BASELINE)**
- [ ] Confirm the dialog

The button sets the baseline watermark **and then** wipes, in one transaction. That order is
load-bearing: wiping first leaves a window with an empty journal and no watermark, and anything that
re-journals in that window refills it. **Never wipe by hand — always use the button**, which cannot
get the order wrong.

- [ ] PREFLIGHT reads 0
- [ ] Restart Ether — PREFLIGHT still reads 0

> Expect it to climb again after a **Generate**. `generated_schedule` rows are journaled as they are
> written, and no watermark gates that. This is known, not a fault.

---

## 6. Back on air

- [ ] Generate the day
- [ ] Confirm the log is populated
- [ ] Station on air, audio confirmed at the monitor

---

## Rollback, at any point

The previous installer is in `C:\openair\dist-electron\`. Profile data lives at
`%LOCALAPPDATA%\Ether\profiles\<licenseKey>\` and is **not** touched by installing or uninstalling —
an older build reads the same directory. Retired profiles are renamed, never deleted, and appear as
`<name>.retired-<date>`.

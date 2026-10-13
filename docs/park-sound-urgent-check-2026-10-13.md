# Park sound — "URGENT fix" check against installer 17c3aac7 / ee2d98b (2026-10-13)

## Jeff's question (verbatim)

> Before I install: the URGENT fix isn't mentioned in this installer report. Is it in 17c3aac7 / ee2d98b? Answer in plain words for each:
> 1. Ether's MONITOR fader and MUTE always bring the park back after a Park page turned it down or muted.
> 2. The board shows Park page changes with who and when.
> 3. The "Park page control: ON/OFF" lock switch in Ether.
> 4. One level and one mute per station, no per-device state. Tested: mute from Park page A, log A out, unmute from Ether and separately from Park page B.
> If any of these is missing, build it now into this same installer before I install. That fix comes before Listen.

## Finding

The request never reached this session; the only mention of it in the session transcript is the message above. Nothing
of it was built. What the code in the installer actually does (source read; runtime UNVERIFIED unless stated):

- **How the Park fader works today** (`src/App.tsx` `ops:set-level` / `ops:set-mute`): it sets the station's own strip
  under **Station Monitors** (`monitor_volume`), NOT the big MONITOR fader in Master Out. MUTE = that strip at 0, with
  the level before it kept in `park_unmute_level`.
1. **Not met.** The big MONITOR fader multiplies with the station strip, so raising it does not bring the park back
   after a Park mute (0 × anything = 0). Ether has no MUTE button for the park at all; the strip only shows the word
   "MUTE" when it is at 0. Moving the station strip does bring it back, but:
2. **Not met.** The station strip reads its level only when the panel opens (`StationMonitorMixer.tsx` load effect), so
   after a Park page change Ether keeps showing the old level. Who/when is written on the server (`park_audit` table,
   `ether-backend` `parkAudit`) and shown nowhere: not in Ether, not on the Park page.
3. **Missing.** No such switch exists anywhere (searched `src`, `electron`, `ether-park/src`, `ether-backend/src`).
4. **Met in the code, never tested.** Level and mute live only in the station's `monitor_volume` / `park_unmute_level`;
   nothing is kept per device or per login. The A/B/log-out test has not been run.

## Waiting on Jeff before building

- Item 1: which Ether control must bring the park back (big MONITOR fader, the station's strip, or both), and where
  Ether's MUTE goes.
- Item 2: what "the board" means here and where the who/when shows.
- Item 3: what OFF locks (fader + MUTE only, or carts, closing time and Listen too) and where the switch sits.

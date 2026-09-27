# Held help-audit items 15, 18, 19, 20 — one-line proposals (2026-09-27)

For one ruling on all four. No code has been written. Each line gives the sense, surface or door; where it lives;
and the one screen check that proves it works.

| # | Proposal (what · where · screen check) |
|---|---|
| **15** Sweeper sense | **What:** a SWEEPERS row per station — placed / fired / skipped today, each skip with its reason (no fit, no file, off-hours) and the live state (SCHEDULED → ARMED → FIRING), fed by the daemon's existing sweeper-state events and written to the ledger. **Where:** Health Monitor → each station card, beside Runway; red when the station has sweepers assigned but none fired in the last hour of air. **Check:** assign a pool, Fill Day, let one seam pass; the row goes ARMED → FIRING and "fired" becomes 1. |
| **18** Pick reasons | **What:** the reason recorded on each generated row (`generated_schedule.pick_reason`), shown as "Why this song". **Where:** Program Log → click a music row → one line under the title (docked and pop-out); Rotation Analytics links there instead of saying "the Program Log does not show them yet". **Check:** Fill Day, click any music row; a reason appears, and it matches the Rotation Analytics count for that category. |
| **19** AUTO ON | **What:** the per-station auto-generate switch (`auto_generate_enabled`) out of the Canary panel and into the place runway is read. **Where:** Program Log header, beside Fill Day ("Keep the log filled: ON/OFF"); Health Monitor's Runway row links to it; the Canary panel keeps a read-only mirror until the flip ships. **Check:** switch it in the Program Log; the Canary panel shows the same state, and Runway stops decaying overnight. |
| **20** Designation bypass | **What:** a door to `kill_designation` (local-only), for when this machine must generate even though another holds the designation. **Where:** Health Monitor → the existing Designation row, behind the admin PIN, with a red banner on every screen while it is on and a ledger event recording who and when. **Check:** turn it on with the PIN; the banner appears and the ledger shows the event; turn it off and the banner goes. |

# Dead controls and the four builds — status (2026-10-31)

Source list: `docs/dead-controls-and-four-builds-proposal-2026-10-30.md` (items 1–45). All work is local commits on
`release/1019`; nothing pushed, tagged or deployed. Receipts: `docs/on-screen-checks-halloveen-2026-10-31.md`.

## The four builds
| Build | Commit(s) | Seen on screen |
|---|---|---|
| A Stream Manager | e74524f, c372210 (error reason + Stop while retrying), dd3cfce (Listen live), 2559730 (server's own port) | Start/Stop on /halloween both doors, listeners, Listen live. Error text + port: unit-tested, UNVERIFIED on screen |
| B Stream Metadata Outputs (+RDS, serialport) | b60fad5 | webhook + real /halloween title, automatic on song start. RDS: port list loads (COM8/COM9), no encoder to send to — UNVERIFIED |
| C Remote Access & Website | f0fcf70, d37546f (photo proxy) | 4242, code gate, Skip / Stop all / AUTO on / off. From another device: UNVERIFIED (Windows Firewall prompt) |
| D Voice-tracking mic | 185834f | saved mic used in the pop-out; fallback message |

## Items fixed
| # | What | Commit | On screen |
|---|---|---|---|
| 1, 2 | Save/Export files (DAW, Play Log CSV) | 988dde1 | UNVERIFIED (needs the native Save window) |
| 3 | Voice Tracker → Send to Deck | f5a03db | yes (Deck B) |
| 11 | Song analysis text / no -14 LUFS promise | 62c0d0a | — |
| 12 | Master Out Stream row | d37546f | UNVERIFIED (block collapsed) |
| 17 | Deck artist photos via 4242 | d37546f | route yes; deck drawing UNVERIFIED (layout without that deck) |
| 20 | EAS local time; stream port from address | f22e9e6, 2559730 | EAS yes |
| 22, 25, 43 | window.confirm → Ether's confirm window | 1de19dc (yesterday) | yes (EAS) |
| 26 (text) | Up Next empty text | c02ca86 | — |
| 27 | Shortcut sheet; cart keys win while open | c02ca86 | one overlay, yes |
| 28 | Check for Updates always answers | b76cb4e | UNVERIFIED (native Help menu) |
| 29 | About text, What's New from real notes, legal footer | b76cb4e, 9bebbd2 | yes (real AboutPanel mounted) |
| 30 | Reload keeps sign-in | 0eb025e (yesterday) | yes |
| 34, 38, 40, 42 | Scan Durations, Shows delete, Normalize, spot audio | yesterday | yes (today's six checks) |
| 36 | STRICT/SOFT + max in a row (5b/6c) | de49409 | gate on a copy of the live DB |
| 41 | Cue Editor I/N/O/U | c02ca86 | — |
| 45 | EAS ☰ door | 6ea9e95 | yes |
| (new) | Voice Tracker ☰ door | 185834f | yes |

## Waiting on a decision from Jeff (built nothing — would contradict a design or needs his call)
- **33 Smart Scheduler.** Its rules include *news at top*, *spot breaks* and *IDs every N songs* — the clock decides
  those ("clock is law", the one-scheduler model). Making Generate obey them puts a second scheduler beside the clock.
  Options: (a) keep only energy / BPM / genre per daypart as a filter inside the one pick (new schema step; the AI button
  needs a key path through Ether's backend); (b) retire the screen into Clocks + rotation rules; (c) other.
- **37 Create Show wizard category.** Shows have no category. Options: (a) if no clock is chosen, create a clock for the
  show whose music slots use that category; (b) set every music slot of the chosen clock to it; (c) remove the step.
- **Gate ratchet T15 17 → 18** (item 36): update the ratchet, or build the settings registry T15 asks for.
- **About legal text**: replaced "free and open-source software … MIT License" with the copyright line — confirm the
  wording you want.

## Not done yet (remaining)
4 Phone Desk targets · 5 Show+ teleprompter / lower thirds / brand / AI cut / clip / mic vol / + Screen · 6 Imaging
RULES tab · 7 Cloud Log Backup fields / auto-backup / restore · 8 Ether2Go pairing · 9 Station Duplicate (touches
seats/licenses? — check before building) · 10 Beta Program & Feedback backend routes · 13 stream format always MP3 ·
14 processor target loudness · 15 SRT→UDP fallback · 16 jukebox donations · 18 web dashboard users / clone ·
19 listener page left rail · 20c old plan names (dashboard, backup, platform) · 21 / 32 / 44 plan gates on old tiers
(entitlement code — not a license change, but checked with Jeff first) · 23 View → Deck toggles · 24 board sources
(Announcement, Network, Purpose, Guest meter) · 26 Up Next reorder snapping back (UNVERIFIED claim) · 31 new-station
layout choice · 35 CHAIN STP/SEG · 39 Spotify / NexGen imports with no audio.

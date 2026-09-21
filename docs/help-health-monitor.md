---
feature: health-monitor
title: Health Monitor
summary: One screen that says whether the station is healthy — runway, levels, rotation, breaks and the event ledger — with panels you can rearrange and collapse.
where: Menu → Tools → Health Monitor (also available as a pop-out window for a wall display)
since: 4.4.208
audience: operator
tour: true
---

# Health Monitor

## What it is

The Health Monitor is the **one screen that answers "is my station OK right now?"** It gathers every
measured reading EtherCast has — how much log is left, what the audio is doing, whether rotation is
hitting its targets, whether breaks are firing on time — and puts them in one place.

Everything on it is **measured, never assumed**. If a reading has not been taken, the panel says so
rather than showing a reassuring green. "Not measured" and "measured and fine" are different states
and they never look alike.

## When to use it

- **Every morning**, as a thirty-second check before the day gets going.
- **When something sounds wrong** on air and you want to know what changed.
- **On a wall display** in the studio, left up all day. Pop it out into its own window and
  full-screen it.

## The top half — at a glance

Four cards across the top, then four panels below them.

- **Runway** — how many days of log this station has left before it runs out. Click it to open the
  Program Log.
- **Designated generator** — which machine builds this station's log. Click to jump to the controls.
- **Rotation health** — your declared rotation goals against what the clocks actually call. Click to
  open Schedule Manager.
- **Queue** — how many items are waiting behind what is on air, and roughly how much time that buys.

Below the cards:

- **Runway trend** — the last 7 days of runway as a chart, so you can see it falling *before* it
  becomes a problem. Gaps in the line are gaps in the data, not zeros.
- **Audio levels** — the decks in dBFS and the program loudness in LUFS. Two different measurements
  on two different scales, labelled as such.
- **Rotation goals** — one bar per category: the target you declared against what actually aired in
  the last 24 hours. If the station was only on air for part of that window, it says so.
- **Live events** — the health ledger, read back. What actually happened, newest first.

### When a station shows "play refused" or "unplayable row skipped"

The station's card turns red for about a minute and names it — *play refused on deck B — <song> ·
17:33:12* — and the line stays under the card until the next one. It means the engine was asked to
play a deck that had nothing loaded (or a queued song whose file is missing) and **refused**, and
playout moved on to the next queued song instead. Nothing was aired from the refused deck.

- It is counted in **Library & Rotation → skipped this hour** (red on any skip) and written to the
  health ledger with the station, deck, song, file and time, so you can see it in **Live events** and
  find it later.
- One or two in a day after a re-cue is the engine protecting air. A run of them, or the same song
  every time, means a file is missing or a deck is being emptied and not re-cued — open **Live
  Activity**, filter **Warnings**, and read the lines around it.
- If the card says *unplayable row skipped*, the song's file could not be found on this machine:
  check the library entry and whether the file has been fetched from the cloud.

## The bottom half — the detail

- **Audio Processing** — the loudness chain. IN and OUT loudness lead as figures, then meters for the
  level before and after, the **ride gain** (which moves both ways from centre — right is boosting,
  left is cutting) and the limiter.
- **Spot Schedule** — where your breaks fall in this hour and the next. One lane per hour, so a
  marker's position across the lane **is** its minute. **Hollow markers are still to come, solid ones
  have aired.** The bright vertical line is now. Hover any marker for its exact times.
  Underneath, a **drift bar** per break: centre is on time, right is late. Green within 15 seconds,
  amber within a minute, red beyond. A break that is *going* to be late turns amber **before** it
  misses, not after.
- **Core Systems**, **High Availability**, **Library & Rotation**, **Designation Activity**, the
  **Log-Reader** panels and **DMCA Play Log Export** — the underlying detail behind the cards above.

### High Availability — what the rows mean

- **Watchdog Process** — whether a watchdog (the "Keep My Station On Air" supervisor) is running.
- **Supervising This App** — whether that watchdog is actually watching **this** copy of Ether. The
  watchdog checks in every 5 seconds and signs its check-in; this row shows the last one. *Yes · pid N*
  is the only reading that means you are covered. *STOPPED* means it used to check in and no longer
  does. *Not observed* means no watchdog has ever checked in on this launch — either there is none, or
  it is from an older build that does not sign its check-ins.
- **Crash-Loop Alarm** — the watchdog gives up after 5 restarts in 5 minutes and leaves a marker on
  disk. The row shows **when** it tripped. While it is tripped, auto-restart is off — and if *Supervising
  This App* is not *Yes*, this copy of Ether is running with **no** supervision at all.
- **App uptime** in the header is how long the Ether process itself has been running (with its
  process id) — not how long this panel has been open.

### Clearing a crash-loop alarm

1. Open the Health Monitor and find **Crash-Loop Alarm** under **High Availability**.
2. Press **CLEAR & RE-SUPERVISE**.
3. Ether removes the marker, stops the halted watchdog if one is still sitting there, and starts a fresh
   watchdog that adopts the running app. The row's small print reports exactly what happened
   (*marker removed · halted watchdog pid N stopped · supervised by watchdog pid M*).
4. Within a few seconds **Supervising This App** should read *Yes · pid M* and the banner should leave
   red. If it does not, the small print says why.

Nothing is restarted and nothing goes off air: the running app is adopted, not relaunched.

## Rearranging the panels

Every panel on this screen can be moved and hidden, so you can make the top of the screen show what
*your* station worries about.

1. **To move a panel**, click and hold its **header bar** — the strip with the title and the ⠿ handle
   — and drag it up or down. A green edge shows where it will land. Release to drop it.
2. **To collapse a panel**, click its **title** (or the ▾ arrow next to it). The panel folds down to
   just its header. Click again to open it.
3. **It sticks.** Your order and whatever you collapsed are remembered on this machine and come back
   next time you open the panel — you do not have to arrange it again tomorrow.

Two things worth knowing:

- **Drag by the header only.** The body of a panel holds real controls — switches, REFRESH NOW, the
  export button — so dragging from inside a panel would make those unusable.
- **The top four and the sections below are two separate groups.** You can reorder within each group,
  but not move a panel from one into the other. They are laid out differently — the top four sit
  side by side on a wide screen, the ones below stack — so a panel moved across would land in a
  layout it was not built for.

## Putting it back

There is no "reset layout" button. To start over, collapse nothing and drag the panels back into the
order you want — or clear the app's saved settings for this machine, which resets the layout along
with other local preferences.

## Troubleshooting

- **A panel says "not measured" or shows a dash.** That reading has not been taken yet for this
  station. It is not an error and it is not zero — give it a poll cycle (about 30 seconds).
- **Rotation goals says no goals are set.** Set **spins per hour** on a category in Categories. Until
  you do, the bars have nothing to measure against, so the panel tells you what is currently busiest
  instead.
- **Audio levels sit at the floor.** The meters read the live audio engine. If nothing is playing,
  they are correctly showing nothing.
- **Audio Processing says "off on both paths."** Loudness processing is switched off for this
  station, so quiet tracks stay quiet. Turn it on in Preferences if you want the ride and limiter.
- **I dragged a panel and it went back.** The drop only takes effect when you release the pointer
  **over another panel**. Release over the gap between panels and nothing moves.
- **The banner says ALARM but the station is playing fine.** The alarm is a marker left by a watchdog
  that gave up earlier (the row shows when). It does not mean the app is failing now — it means
  auto-restart is off. Read **Supervising This App**: if it is not *Yes*, press **CLEAR & RE-SUPERVISE**
  to put supervision back. If it *is* Yes, the marker is stale and the same button just removes it.
- **Live Activity shows hours-old lines and says STALE.** The feed is honest: the engine has not
  written anything for that long. If the station should be playing, look at the decks and the
  Audio Output row before assuming the feed is broken.

## Related

- [Audio Processing](help-audio-processing.md) — the loudness chain itself, and its settings
- [Rotation Goals](help-rotation-goals.md) — declaring the targets the goal bars measure against
- [Designated Generator](help-designated-generator.md) — which machine builds the log
- [Live Activity](help-live-activity.md) — the running activity feed
- [Spots](help-spots.md) — scheduling the breaks the Spot Schedule projects
